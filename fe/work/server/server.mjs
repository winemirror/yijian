// 弈鉴 · 信令与房间服务
//
// 只做三件事：
//   1. 房间登记（建房 / 房间码 / 公开房间列表）
//   2. 信令中转（转发 offer / answer / ice 这些不透明 blob，服务端不解析）
//   3. 下发 ICE 配置（STUN + coturn REST 临时凭证的 TURN）
//
// 棋局数据一律走 WebRTC DataChannel，服务端不碰、不存。
//
// 零依赖：只用 Node 内置模块，WebSocket 按 RFC 6455 自己实现。
//
//   node server.mjs
//
// 环境变量：
//   PORT          监听端口，默认 8787
//   STUN_URL      形如 stun:turn.example.com:3478，留空则不下发 STUN（仅局域网可用）
//   TURN_URL      中继地址，逗号分隔可给多条，例如
//                 turn:1.2.3.4:3478?transport=udp,turn:1.2.3.4:3478?transport=tcp
//   TURN_SECRET   必须与 coturn 的 static-auth-secret 一致；留空则不下发 TURN
//   TURN_TTL      临时凭证有效期（秒），默认 600，会夹到 60 ~ 86400
//   MAX_ROOMS     同时存在的房间上限，默认 500
//   ROOM_TTL_MS   房间空闲多久后回收，默认 30 分钟

import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGameLibrary } from "./game-library.mjs";

let PORT = Number(process.env.PORT || 8787);
let HOST = process.env.HOST || "0.0.0.0";
let STUN_URL = (process.env.STUN_URL || "").trim();
// TURN_URL 支持逗号分隔多条，例如同时下发 udp 与 tcp 两种中继地址。
let TURN_URL = (process.env.TURN_URL || "").trim();
let TURN_SECRET = (process.env.TURN_SECRET || "").trim();
let TURN_TTL = Number(process.env.TURN_TTL || 600);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 30 * 60 * 1000);

const PROTO = 1;
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const gameLibrary = createGameLibrary({
  dataDir: process.env.GAME_LIBRARY_DIR
    || path.join(SERVER_DIR, "data", "game-library")
});
const MAX_FRAME = 128 * 1024;
const HEARTBEAT_MS = 25000;
const MAX_ROOMS_PER_CLIENT = 3;
const RATE_BURST = 40;             // 令牌桶容量
const RATE_PER_SEC = 20;           // 每秒补充

// 去混淆字符集：没有 0/O/1/I/L，方便口头念房间码
const ROOM_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ROOM_CODE_LEN = 6;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function makeRoomCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const bytes = crypto.randomBytes(ROOM_CODE_LEN);
    let code = "";
    for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error("room code space exhausted");
}

// ------------------------------------------------------------------ websocket
// 只实现我们用到的那一小部分 RFC 6455：握手、文本帧、分片、ping/pong/close。

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(clientKey) {
  return crypto.createHash("sha1").update(clientKey + WS_GUID).digest("base64");
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, data]);
}

// 客户端发来的帧一定带掩码。分片消息攒齐后再交给上层。
function feedFrames(state, chunk, onMessage, onClose) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  for (;;) {
    const buf = state.buffer;
    if (buf.length < 2) return;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < 4) return;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME)) return onClose(1009, "message too big");
      length = Number(big);
      offset = 10;
    }
    if (length > MAX_FRAME) return onClose(1009, "message too big");

    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + length) return;

    const payload = Buffer.from(buf.subarray(offset, offset + length));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index & 3];
      }
    }
    state.buffer = buf.subarray(offset + length);

    if (opcode === 0x8) return onClose(1000, "peer closed");
    if (opcode === 0x9) {
      state.socket.write(encodeFrame(payload, 0xa));
      continue;
    }
    if (opcode === 0xa) {
      state.alive = true;
      continue;
    }
    if (opcode === 0x0) {
      state.fragments.push(payload);
    } else if (!fin) {
      state.fragments = [payload];
      state.fragmentOpcode = opcode;
    } else {
      onMessage(payload);
      continue;
    }

    if (fin && state.fragments.length) {
      const whole = Buffer.concat(state.fragments);
      state.fragments = [];
      if (whole.length > MAX_FRAME) return onClose(1009, "message too big");
      onMessage(whole);
    }
  }
}

// ---------------------------------------------------------------------- state

const rooms = new Map();     // code -> room
const clients = new Map();   // socket -> client

function iceServers() {
  const servers = [];
  if (STUN_URL) servers.push({ urls: STUN_URL });
  const urls = turnUrls();
  if (urls.length && TURN_SECRET) {
    // coturn 的 REST 临时凭证：username 形如 "<过期unix时间戳>:<任意串>"，
    // credential = base64(HMAC-SHA1(static-auth-secret, username))。
    // 服务端即时计算、只在内存里存在，客户端拿到的是分钟级有效的一次性凭证。
    const username = `${Math.floor(Date.now() / 1000) + turnTtlSeconds()}:${crypto.randomBytes(6).toString("hex")}`;
    const credential = crypto
      .createHmac("sha1", TURN_SECRET)
      .update(username)
      .digest("base64");
    servers.push({ urls: urls.length === 1 ? urls[0] : urls, username, credential });
  }
  return servers;
}

// TURN_URL 允许多条（逗号分隔），一条时保持字符串形状。
function turnUrls() {
  return String(TURN_URL || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// 凭证有效期：coturn 只校验 username 里的时间戳，夹到 1 分钟 ~ 24 小时之间，
// 免得配错成 0（立刻过期）或过大（凭证长期有效）。
function turnTtlSeconds() {
  if (!Number.isFinite(TURN_TTL)) return 600;
  return Math.min(86400, Math.max(60, Math.floor(TURN_TTL)));
}

function send(client, message) {
  try {
    client.socket.write(encodeFrame(JSON.stringify(message)));
  } catch (error) {
    log("send failed", error.message);
  }
}

function sendError(client, code, message) {
  send(client, { t: "error", code, message });
  // 失败的请求也要留痕：以前只有成功的 join 会写日志，
  // 出问题时从服务端看不出"客户端到底有没有发过来"。
  log(`error ${code} -> ${client.id}`);
}

function peerInfo(client) {
  return { id: client.id, name: client.name, kind: client.kind };
}

function membersOf(room) {
  return [...room.members.values()];
}

function broadcast(room, message, exceptId) {
  for (const member of room.members.values()) {
    if (exceptId && member.id === exceptId) continue;
    send(member, message);
  }
}

function roomSummary(room) {
  const members = membersOf(room);
  return {
    id: room.id,
    name: room.name,
    players: members.filter((m) => m.kind === "player").length,
    spectators: members.filter((m) => m.kind === "spectator").length,
    private: room.visibility !== "public",
    locked: !!room.passwordHash
  };
}

// 房间密码只在内存里存哈希，不存明文。用房间码当盐，避免两个房间
// 用了同一个密码就得到同一个哈希。
function hashPassword(roomId, password) {
  return crypto
    .createHash("sha256")
    .update(`${roomId}\n${password}`)
    .digest("hex");
}

function passwordOf(message) {
  if (typeof message.password !== "string") return "";
  return message.password.trim().slice(0, 64);
}

function passwordMatches(room, password) {
  if (!room.passwordHash) return true;
  if (!password) return false;
  return hashPassword(room.id, password) === room.passwordHash;
}

function leaveRoom(client, reason) {
  const room = client.roomId ? rooms.get(client.roomId) : null;
  client.roomId = null;
  if (!room) return;

  room.members.delete(client.id);
  room.lastActiveAt = Date.now();

  // 房主离开就没有"枢纽"了，房间直接解散（对局本身也无法继续）
  if (room.hostId === client.id || room.members.size === 0) {
    for (const member of room.members.values()) {
      send(member, { t: "room.closed", roomId: room.id, reason: reason || "host-left" });
      member.roomId = null;
    }
    rooms.delete(room.id);
    log(`room ${room.id} closed (${reason || "host-left"})`);
    return;
  }

  broadcast(room, { t: "peer.leave", peerId: client.id });
  log(`room ${room.id} <- leave ${client.id}`);
}

function joinRoom(client, room, kind) {
  room.members.set(client.id, client);
  room.lastActiveAt = Date.now();
  client.roomId = room.id;
  client.kind = kind;

  send(client, {
    t: "room.joined",
    proto: PROTO,
    room: { id: room.id, name: room.name, hostId: room.hostId },
    self: { id: client.id, kind },
    peers: membersOf(room)
      .filter((member) => member.id !== client.id)
      .map(peerInfo)
  });
  broadcast(room, { t: "peer.join", peer: peerInfo(client) }, client.id);
  log(`room ${room.id} <- join ${client.id} (${kind})`);
}

// ------------------------------------------------------------------- protocol

function handleMessage(client, raw) {
  if (!takeToken(client)) return sendError(client, "rate_limited", "too many messages");

  let message;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    return sendError(client, "bad_json", "message is not JSON");
  }
  if (!message || typeof message.t !== "string") {
    return sendError(client, "bad_message", "missing type");
  }

  switch (message.t) {
    case "hello": {
      if (typeof message.name === "string" && message.name.trim()) {
        client.name = message.name.trim().slice(0, 20);
      }
      client.helloed = true;
      send(client, {
        t: "welcome",
        proto: PROTO,
        clientId: client.id,
        ice: { servers: iceServers() }
      });
      return;
    }

    case "ice": {
      send(client, { t: "ice", servers: iceServers() });
      return;
    }

    case "room.create": {
      if (!client.helloed) return sendError(client, "not_helloed", "send hello first");
      if (client.roomId) return sendError(client, "already_in_room", "leave the current room");
      if (rooms.size >= MAX_ROOMS) return sendError(client, "server_full", "too many rooms");
      if (client.roomsCreated >= MAX_ROOMS_PER_CLIENT) {
        return sendError(client, "too_many_rooms", "slow down");
      }
      // 固定房间码：客户端可请求复用上次分到的码；只有格式合法且当前空闲才给。
      const requested = String(message.preferredId || "").toUpperCase();
      const preferredOk = /^[2-9A-HJ-NP-Z]{6}$/.test(requested) && !rooms.has(requested);
      const id = preferredOk ? requested : makeRoomCode();
      const password = passwordOf(message);
      const room = {
        id,
        name: typeof message.name === "string" && message.name.trim()
          ? message.name.trim().slice(0, 24)
          : `房间 ${id}`,
        visibility: message.visibility === "public" ? "public" : "private",
        passwordHash: password ? hashPassword(id, password) : "",
        hostId: client.id,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        members: new Map()
      };
      rooms.set(id, room);
      client.roomsCreated += 1;
      joinRoom(client, room, "player");
      log(`room ${id} created by ${client.id}${password ? " (locked)" : ""}`
        + (preferredOk ? " [preferred]" : ""));
      return;
    }

    case "room.list": {
      const list = [...rooms.values()]
        .filter((room) => room.visibility === "public" && room.members.size > 0)
        .map(roomSummary);
      send(client, { t: "room.list", rooms: list });
      return;
    }

    case "room.join": {
      if (!client.helloed) return sendError(client, "not_helloed", "send hello first");
      if (client.roomId) return sendError(client, "already_in_room", "leave the current room");
      const wanted = String(message.roomId || "").toUpperCase();
      log(`room.join ${wanted} <- ${client.id}`);
      const room = rooms.get(wanted);
      if (!room) return sendError(client, "no_room", "房间不存在或已结束");
      if (!passwordMatches(room, passwordOf(message))) {
        return sendError(client, "bad_password", "房间密码不正确");
      }
      const kind = message.want === "spectate" ? "spectator" : "player";
      if (kind === "player") {
        const players = membersOf(room).filter((member) => member.kind === "player");
        if (players.length >= 2) {
          return sendError(client, "room_full", "已有两名棋手，可以改用观战");
        }
      }
      joinRoom(client, room, kind);
      return;
    }

    case "room.leave": {
      leaveRoom(client, "left");
      send(client, { t: "room.left" });
      return;
    }

    case "signal": {
      if (!client.roomId) return sendError(client, "not_in_room", "join a room first");
      const room = rooms.get(client.roomId);
      const target = room && room.members.get(String(message.to || ""));
      if (!target) return sendError(client, "no_peer", "对端不在房间里");
      // 服务端不解析 data，只负责转发
      send(target, { t: "signal", from: client.id, data: message.data });
      return;
    }

    case "ping": {
      send(client, { t: "pong", at: message.at });
      return;
    }

    default:
      sendError(client, "unknown_type", `unknown message type: ${message.t}`);
  }
}

function takeToken(client) {
  const now = Date.now();
  const elapsed = (now - client.tokenAt) / 1000;
  client.tokenAt = now;
  client.tokens = Math.min(RATE_BURST, client.tokens + elapsed * RATE_PER_SEC);
  if (client.tokens < 1) return false;
  client.tokens -= 1;
  return true;
}

// ---------------------------------------------------------------------- http

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname.startsWith("/api/games")) {
    handleGamesApi(request, response, url);
    return;
  }
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      ok: true,
      proto: PROTO,
      rooms: rooms.size,
      clients: clients.size,
      ice: iceServers().length,
      stun: STUN_URL ? 1 : 0,
      turn: turnUrls().length && TURN_SECRET ? turnUrls().length : 0,
      games: gameLibrary.health()
    }));
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("YiJian signalling server");
});

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(payload));
}

function handleGamesApi(request, response, url) {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  try {
    if (url.pathname === "/api/games/health") {
      const health = gameLibrary.health();
      sendJson(response, health.ok ? 200 : 503, health);
      return;
    }
    if (url.pathname === "/api/games/manifest") {
      sendJson(response, 200, { ok: true, manifest: gameLibrary.getManifest() });
      return;
    }
    if (url.pathname === "/api/games/search") {
      const params = Object.fromEntries(url.searchParams.entries());
      const result = gameLibrary.search(params);
      sendJson(response, 200, Object.assign({ ok: true }, result));
      return;
    }
    if (url.pathname === "/api/games/random") {
      const game = gameLibrary.random();
      if (!game) {
        sendJson(response, 404, { ok: false, error: "game_library_empty" });
        return;
      }
      sendJson(response, 200, { ok: true, game });
      return;
    }
    const match = /^\/api\/games\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const code = gameLibrary.normalizeCode(decodeURIComponent(match[1]));
      if (!code) {
        sendJson(response, 400, { ok: false, error: "invalid_game_code" });
        return;
      }
      const game = gameLibrary.get(code);
      if (!game) {
        sendJson(response, 404, { ok: false, error: "game_not_found", code });
        return;
      }
      sendJson(response, 200, { ok: true, game });
      return;
    }
    sendJson(response, 404, { ok: false, error: "not_found" });
  } catch (error) {
    sendJson(response, 503, {
      ok: false,
      error: "game_library_unavailable",
      message: error && error.message || String(error)
    });
  }
}

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  if (!key || (request.headers.upgrade || "").toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + "Sec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n"
  );
  socket.setNoDelay(true);

  const client = {
    id: crypto.randomBytes(8).toString("hex"),
    name: "棋友",
    kind: "player",
    socket,
    buffer: Buffer.alloc(0),
    fragments: [],
    fragmentOpcode: 0x1,
    alive: true,
    helloed: false,
    roomsCreated: 0,
    roomId: null,
    tokens: RATE_BURST,
    tokenAt: Date.now()
  };
  clients.set(socket, client);
  log(`+ ${client.id} (${clients.size} online)`);

  socket.on("data", (chunk) => {
    feedFrames(
      client,
      chunk,
      (payload) => handleMessage(client, payload.toString("utf8")),
      (code, reason) => {
        try {
          socket.write(encodeFrame(Buffer.from(reason), 0x8));
        } catch (error) { /* already gone */ }
        socket.destroy();
        void code;
      }
    );
  });

  const bye = () => {
    if (!clients.has(socket)) return;
    leaveRoom(client, "disconnected");
    clients.delete(socket);
    log(`- ${client.id} (${clients.size} online)`);
  };
  socket.on("close", bye);
  socket.on("error", bye);
});

// 心跳：超时没回 pong 的连接直接断开
const heartbeatTimer = setInterval(() => {
  for (const client of clients.values()) {
    if (!client.alive) {
      client.socket.destroy();
      continue;
    }
    client.alive = false;
    try {
      client.socket.write(encodeFrame(Buffer.alloc(0), 0x9));
    } catch (error) { /* gone */ }
  }
}, HEARTBEAT_MS);
heartbeatTimer.unref();

// 回收空闲房间
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const idle = now - room.lastActiveAt;
    if (idle > ROOM_TTL_MS || room.members.size === 0) {
      for (const member of room.members.values()) {
        send(member, { t: "room.closed", roomId: id, reason: "expired" });
        member.roomId = null;
      }
      rooms.delete(id);
      log(`room ${id} expired`);
    }
  }
}, 60000);
sweepTimer.unref();

export function listen(overrides = {}) {
  if (overrides.port !== undefined) PORT = overrides.port;
  if (overrides.host !== undefined) HOST = overrides.host;
  if (overrides.stunUrl !== undefined) STUN_URL = overrides.stunUrl;
  if (overrides.turnUrl !== undefined) TURN_URL = overrides.turnUrl;
  if (overrides.turnSecret !== undefined) TURN_SECRET = overrides.turnSecret;
  if (overrides.turnTtl !== undefined) TURN_TTL = overrides.turnTtl;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => {
      const address = server.address();
      log(`yijian signalling server listening on ${HOST}:${address.port}`);
      const turnCount = turnUrls().length && TURN_SECRET ? turnUrls().length : 0;
      log(`ice: stun=${STUN_URL ? 1 : 0} turn=${turnCount} ttl=${turnTtlSeconds()}s`);
      if (!STUN_URL) log("warning: no STUN configured - public play will fail");
      resolve(address.port);
    });
  });
}

export function close() {
  clearInterval(heartbeatTimer);
  clearInterval(sweepTimer);
  for (const client of clients.values()) {
    try {
      client.socket.removeAllListeners();
      client.socket.destroy();
    } catch (error) { /* gone */ }
  }
  clients.clear();
  rooms.clear();
  gameLibrary.close();
  return new Promise((resolve) => server.close(() => resolve()));
}

// 只有直接被 node server.mjs 运行时才自动监听；被测试 import 时不启动。
const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  listen().catch((error) => {
    log("failed to start: " + error.message);
    process.exit(1);
  });
}
