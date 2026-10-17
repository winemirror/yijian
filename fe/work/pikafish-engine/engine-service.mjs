import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const HOME = os.homedir();
const ENGINE_PATH =
  process.env.PIKAFISH_BIN || path.join(HOME, "pikafish", "Pikafish-Android-arm64-universal");
const ENGINE_DIR = path.dirname(ENGINE_PATH);
const SIGNAL_URL = process.env.PIKAFISH_SIGNAL_URL || "wss://c.syjnb.top/ws";
const ROOM_ID = (process.env.PIKAFISH_ROOM || "PKAFST").toUpperCase();
const THREADS = clamp(Number(process.env.PIKAFISH_THREADS || 4), 1, 8);
const HASH_MB = clamp(Number(process.env.PIKAFISH_HASH || 256), 16, 1024);
const LOG_PATH = path.join(HOME, "pikafish", "engine-service.log");

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    // The relay can still run when the log file cannot be written.
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class UciEngine {
  constructor(binaryPath, workDir) {
    this.binaryPath = binaryPath;
    this.workDir = workDir;
    this.child = null;
    this.lines = null;
    this.uciWaiters = [];
    this.search = null;
    this.version = "Pikafish";
  }

  async start() {
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`Pikafish binary not found: ${this.binaryPath}`);
    }

    this.child = spawn(this.binaryPath, [], {
      cwd: this.workDir,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.on("exit", (code, signal) => {
      log(`engine exited code=${code} signal=${signal || ""}`);
      if (this.search) {
        this.search.reject(new Error(`Pikafish exited: ${code || signal}`));
        this.search = null;
      }
      for (const waiter of this.uciWaiters.splice(0)) {
        waiter.reject(new Error("Pikafish exited"));
      }
    });
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) log(`engine stderr: ${text}`);
    });

    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.onLine(line));

    this.send("uci");
    await this.waitFor((line) => line === "uciok", 10000);
    this.send(`setoption name Threads value ${THREADS}`);
    this.send(`setoption name Hash value ${HASH_MB}`);
    this.send("setoption name UCI_ShowWDL value true");
    this.send("isready");
    await this.waitFor((line) => line === "readyok", 15000);
    log(`engine ready threads=${THREADS} hash=${HASH_MB} path=${this.binaryPath}`);
  }

  waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: null, reject: null };
      const timer = setTimeout(() => {
        const index = this.uciWaiters.indexOf(waiter);
        if (index >= 0) this.uciWaiters.splice(index, 1);
        reject(new Error("UCI timeout"));
      }, timeoutMs);
      waiter.resolve = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.uciWaiters.push(waiter);
    });
  }

  send(command) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("Pikafish stdin is not available");
    }
    this.child.stdin.write(`${command}\n`);
  }

  onLine(line) {
    if (line.startsWith("id name ")) this.version = line.slice(8).trim();
    for (let index = 0; index < this.uciWaiters.length; index += 1) {
      if (this.uciWaiters[index].predicate(line)) {
        this.uciWaiters.splice(index, 1)[0].resolve(line);
        break;
      }
    }
    if (!this.search) return;

    if (line.startsWith("info ")) {
      const parsed = parseInfoLine(line);
      if (parsed && parsed.pv.length > 0) {
        const current = this.search.candidates.get(parsed.multipv);
        if (!current || parsed.depth >= current.depth) {
          this.search.candidates.set(parsed.multipv, parsed);
        }
      }
      return;
    }

    if (line.startsWith("bestmove ")) {
      const bestmove = line.split(/\s+/)[1] || "";
      const candidates = [...this.search.candidates.values()]
        .sort((a, b) => a.multipv - b.multipv);
      const resolve = this.search.resolve;
      this.search = null;
      resolve({ bestmove, candidates, engine: this.version });
    }
  }

  searchPosition({ moves, timeMs, multiPv }) {
    if (this.search) throw new Error("Pikafish is already searching");
    return new Promise((resolve, reject) => {
      this.search = { resolve, reject, candidates: new Map() };
      try {
        this.send(`setoption name MultiPV value ${multiPv}`);
        const suffix = moves.length ? ` moves ${moves.join(" ")}` : "";
        this.send(`position startpos${suffix}`);
        this.send(`go movetime ${timeMs}`);
      } catch (error) {
        this.search = null;
        reject(error);
      }
    });
  }

  stop() {
    if (!this.search) return;
    try {
      this.send("stop");
    } catch {
      // The process exit handler will reject the pending search.
    }
  }

  close() {
    try {
      this.send("quit");
    } catch {
      // Already stopped.
    }
  }
}

function parseInfoLine(line) {
  const multipv = numberAfter(line, / multipv (\d+)/);
  const depth = numberAfter(line, / depth (\d+)/);
  const nodes = numberAfter(line, / nodes (\d+)/);
  const elapsed = numberAfter(line, / time (\d+)/);
  const scoreCp = numberAfter(line, / score cp (-?\d+)/);
  const mate = numberAfter(line, / score mate (-?\d+)/);
  const wdlMatch = line.match(/ wdl (\d+) (\d+) (\d+)/);
  const pvIndex = line.indexOf(" pv ");
  const pv = pvIndex >= 0 ? line.slice(pvIndex + 4).trim().split(/\s+/).filter(Boolean) : [];
  if (!multipv || depth === null || pv.length === 0) return null;
  return {
    multipv,
    depth,
    nodes: nodes || 0,
    timeMs: elapsed || 0,
    scoreCp,
    mate,
    wdl: wdlMatch
      ? [Number(wdlMatch[1]), Number(wdlMatch[2]), Number(wdlMatch[3])]
      : null,
    pv
  };
}

function numberAfter(text, pattern) {
  const match = text.match(pattern);
  return match ? Number(match[1]) : null;
}

const engine = new UciEngine(ENGINE_PATH, ENGINE_DIR);
let relay = null;
let reconnectTimer = null;
let heartbeat = null;
let jobChain = Promise.resolve();
let shuttingDown = false;

function enqueue(job) {
  const next = jobChain.then(job, job);
  jobChain = next.catch(() => {});
  return next;
}

function normalizeMoves(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((move) => String(move || "").toLowerCase())
    .filter((move) => /^[a-i][0-9][a-i][0-9]$/.test(move))
    .slice(0, 240);
}

async function handleEngineRequest(message) {
  const data = message && message.data;
  if (!data || data.t !== "pf.request" || !message.from) return;
  const id = String(data.id || "");
  if (!id) return;

  const moves = normalizeMoves(data.moves);
  const kind = data.kind === "analyze" ? "analyze" : "move";
  const timeMs = clamp(
    Number(data.timeMs || (kind === "analyze" ? 1800 : 700)),
    kind === "analyze" ? 200 : 100,
    kind === "analyze" ? 12000 : 6000
  );
  const multiPv = kind === "analyze" ? clamp(Number(data.multiPv || 3), 1, 5) : 1;
  const startedAt = Date.now();

  log(`request ${id} kind=${kind} moves=${moves.length} time=${timeMs} multipv=${multiPv}`);
  try {
    const result = await enqueue(() => engine.searchPosition({ moves, timeMs, multiPv }));
    relay.sendSignal(message.from, {
      t: "pf.result",
      id,
      kind,
      elapsedMs: Date.now() - startedAt,
      bestmove: result.bestmove,
      engine: result.engine,
      candidates: result.candidates
    });
    log(`result ${id} best=${result.bestmove} pv=${result.candidates.length}`);
  } catch (error) {
    relay.sendSignal(message.from, {
      t: "pf.error",
      id,
      message: (error && error.message) || String(error)
    });
    log(`error ${id}: ${(error && error.message) || String(error)}`);
  }
}

class RelayClient {
  constructor(url, roomId) {
    this.url = url;
    this.roomId = roomId;
    this.socket = null;
    this.selfId = "";
    this.hostId = "";
    this.room = "";
  }

  connect() {
    if (shuttingDown || this.socket) return;
    log(`relay connect ${this.url} room=${this.roomId}`);
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.send({ t: "hello", proto: 1, name: "皮卡鱼测试节点" });
    });
    socket.addEventListener("message", (event) => {
      let message = null;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.onMessage(message);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      this.selfId = "";
      this.hostId = "";
      this.room = "";
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (!shuttingDown) scheduleReconnect(3000);
    });
    socket.addEventListener("error", () => {
      log("relay socket error");
    });
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  sendSignal(to, data) {
    if (!to) return false;
    return this.send({ t: "signal", to, data });
  }

  onMessage(message) {
    if (!message || typeof message.t !== "string") return;
    if (message.t === "welcome") {
      this.selfId = message.clientId || "";
      this.send({
        t: "room.create",
        name: "皮卡鱼测试节点",
        visibility: "private",
        preferredId: this.roomId
      });
      return;
    }
    if (message.t === "room.joined") {
      this.selfId = message.self && message.self.id || this.selfId;
      this.hostId = message.room && message.room.hostId || "";
      this.room = message.room && message.room.id || "";
      if (this.room !== this.roomId) {
        log(`room collision: requested=${this.roomId} got=${this.room}`);
        this.send({ t: "room.leave" });
        try {
          this.socket.close();
        } catch {
          // Reconnect handles it.
        }
        return;
      }
      log(`relay ready room=${this.room} self=${this.selfId}`);
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = setInterval(() => this.send({ t: "ping", at: Date.now() }), 20000);
      return;
    }
    if (message.t === "peer.join") {
      log(`peer joined ${message.peer && message.peer.id || ""}`);
      return;
    }
    if (message.t === "peer.leave") {
      log(`peer left ${message.peerId || ""}`);
      engine.stop();
      return;
    }
    if (message.t === "signal") {
      void handleEngineRequest(message);
      return;
    }
    if (message.t === "room.closed") {
      log("relay room closed");
      return;
    }
    if (message.t === "error") {
      log(`relay error ${message.code || ""}: ${message.message || ""}`);
      if (message.code === "room_full" || message.code === "no_room") {
        scheduleReconnect(5000);
      }
    }
  }

  close() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    try {
      this.socket && this.socket.close();
    } catch {
      // Already closed.
    }
    this.socket = null;
  }
}

function scheduleReconnect(delayMs) {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    relay.connect();
  }, delayMs);
}

async function main() {
  log("starting Pikafish relay service");
  await engine.start();
  relay = new RelayClient(SIGNAL_URL, ROOM_ID);
  relay.connect();
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  relay && relay.close();
  engine.close();
  await wait(100);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("uncaughtException", (error) => log(`uncaught: ${error.stack || error.message}`));
process.on("unhandledRejection", (error) => log(`unhandled: ${error && error.stack || error}`));

main().catch((error) => {
  log(`fatal: ${error.stack || error.message}`);
  process.exit(1);
});
