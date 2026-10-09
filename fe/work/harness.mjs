// Headless harness for the Xiangqi engine.
//
// The engine ships as a browser IIFE that touches the DOM at load time, so we
// run it inside a `vm` context with tiny DOM stubs. That lets us reuse the
// exact production file (no copy/paste of engine logic) for perft checks,
// benchmarks and self-play matches.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AI_DATA_PATH = path.join(HERE, "ai-data.js");

export const RED = "r";
export const BLACK = "b";

function makeElement() {
  const styleProps = {};
  const children = [];
  const el = {
    value: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    scrollTop: 0,
    scrollHeight: 0,
    offsetWidth: 0,
    isConnected: true,
    tabIndex: 0,
    dataset: {},
    style: {
      props: styleProps,
      setProperty(name, value) { styleProps[name] = String(value); },
      removeProperty(name) { delete styleProps[name]; },
    },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    children,
    appendChild(child) { children.push(child); return child; },
    append(...nodes) { for (const node of nodes) children.push(node); },
    replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 1000 }; },
    setAttribute() {},
    removeAttribute() {},
    remove() {},
    cloneNode() { return makeElement(); },
    closest() { return null; },
  };
  return el;
}

export function loadEngine(jsPath, aiDataPath = AI_DATA_PATH, options = {}) {
  const elementsById = new Map();
  const storage = new Map();
  const doc = {
    documentElement: makeElement(),
    body: makeElement(),
    getElementById(id) {
      if (!elementsById.has(id)) elementsById.set(id, makeElement());
      return elementsById.get(id);
    },
    createElement() { return makeElement(); },
    createDocumentFragment() { return makeElement(); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  // The engine reads these selects at startup; seed sane values so loading the
  // file gives the usual "human plays red, AI plays black" setup instead of an
  // all-AI game that would immediately start searching.
  doc.getElementById("redSetup").value = "human";
  doc.getElementById("blackSetup").value = "ai:medium";
  doc.getElementById("autoSpeed").value = "normal";
  // Legacy selectors, still read by the frozen baseline copy used for diffing.
  doc.getElementById("sideSelect").value = "r";
  doc.getElementById("difficulty").value = "medium";

  const win = {
    matchMedia() { return { matches: false }; },
    location: { search: options.search ?? "" },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    // Deliberately inert: a live interval would keep the test process alive.
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => setTimeout(() => fn(0), 0),
    document: doc,
    navigator: { hardwareConcurrency: 4 },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
      clear() { storage.clear(); },
      __store: storage,
    },
    performance,
    URLSearchParams,
  };
  win.window = win;

  const sandbox = {
    window: win,
    self: win,
    document: doc,
    navigator: win.navigator,
    performance,
    URLSearchParams,
    console,
    Math,
    JSON,
    Date,
    Map,
    Set,
    Promise,
    Array,
    Object,
    Number,
    String,
    Boolean,
    Int32Array,
    Uint32Array,
    Float64Array,
    isNaN,
    parseInt,
    parseFloat,
    setTimeout,
    clearTimeout,
    Infinity,
    NaN,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(aiDataPath, "utf8"), sandbox, { filename: aiDataPath });
  // Lets a test inject extra globals (e.g. a stub XiangqiNet) before the app
  // file is evaluated, mirroring how the real page loads net.js first.
  if (typeof options.beforeEngine === "function") {
    options.beforeEngine(sandbox, win);
  }
  vm.runInContext(fs.readFileSync(jsPath, "utf8"), sandbox, { filename: jsPath });

  const api = win.XiangqiLocal;
  if (!api) throw new Error(`Engine at ${jsPath} did not export XiangqiLocal`);
  api.__document = doc;
  api.__window = win;
  return api;
}

export function applyMove(board, move) {
  const next = board.map((p) => (p ? { type: p.type, side: p.side } : null));
  next[move.to] = next[move.from];
  next[move.from] = null;
  return next;
}

export function stateKey(board, side) {
  let key = side;
  for (const piece of board) key += piece ? `${piece.side}${piece.type}` : ".";
  return key;
}

function fmtInt(value) {
  return value.toLocaleString("en-US");
}

const EXPECTED_PERFT = [44, 1920, 79666, 3290240];

export function runPerft(engine, maxDepth = 4) {
  const out = [];
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const board = engine.initialBoard();
    const started = performance.now();
    const nodes = engine.perft(board, RED, depth);
    const ms = performance.now() - started;
    const ok = depth <= EXPECTED_PERFT.length ? nodes === EXPECTED_PERFT[depth - 1] : null;
    out.push({ depth, nodes, ms, nps: nodes / (ms / 1000), ok });
  }
  return out;
}

// Cheap opening-ish position set so benchmarks are not all about the start pos.
const PROBE_LINES = [
  [],
  [[60, 51], [1, 20]],
  [[60, 51], [1, 20], [70, 67], [25, 24], [67, 31]],
  [[60, 51], [1, 20], [70, 67], [25, 24], [67, 31], [20, 29], [31, 30]],
];

export function probePositions(engine) {
  return PROBE_LINES.map((line) => {
    let board = engine.initialBoard();
    let side = RED;
    for (const [from, to] of line) {
      board = applyMove(board, { from, to });
      side = side === RED ? BLACK : RED;
    }
    return { board, side, plies: line.length };
  });
}

// Play a few randomised legal opening moves to reach a distinct, still-balanced
// starting position. Used to decorrelate self-play games.
export function randomOpening(engine, rng, plies) {
  let board = engine.initialBoard();
  let side = RED;
  for (let ply = 0; ply < plies; ply += 1) {
    const legal = engine.generateLegalMoves(board, side);
    if (legal.length === 0) break;
    const move = legal[Math.floor(rng() * legal.length)];
    board = applyMove(board, move);
    side = side === RED ? BLACK : RED;
  }
  return { board, side };
}

export function benchSearch(engine, probe, settings) {
  const started = performance.now();
  const result = engine.analyzePosition(probe.board, probe.side, settings);
  const ms = performance.now() - started;
  return {
    plies: probe.plies,
    side: probe.side,
    bestMove: result.bestMove,
    score: result.score,
    winRed: result.winRed,
    depth: result.depth,
    nodes: result.nodes,
    ms,
    nps: result.nodes / (ms / 1000),
  };
}

export function formatPerft(rows) {
  return rows
    .map((r) => `  perft ${r.depth}: ${fmtInt(r.nodes)} nodes in ${r.ms.toFixed(0)}ms ` +
      `(${fmtInt(Math.round(r.nps))} nps) ${r.ok === null ? "" : r.ok ? "OK" : "FAIL"}`)
    .join("\n");
}

// --- Self-play -------------------------------------------------------------

const MAX_PLIES = 240;

function terminalScore(board, side) {
  // side has no legal moves -> side loses (either checkmate or stalemate; in
  // Xiangqi stalemate is also a loss).
  return side === RED ? -1 : 1;
}

export function playGame(engineRed, engineBlack, opts) {
  const depth = opts.depth ?? 4;
  const timeMs = opts.timeMs ?? 1200;
  const nodeLimit = opts.nodeLimit ?? 400000;
  const maxPlies = opts.maxPlies ?? MAX_PLIES;
  let board = opts.startBoard ? opts.startBoard.map((p) => (p ? { ...p } : null)) : engineRed.initialBoard();
  let side = opts.startSide ?? RED;
  const counts = new Map();
  const moves = [];
  let halfmove = 0;

  counts.set(stateKey(board, side), 1);

  for (let ply = 0; ply < maxPlies; ply += 1) {
    const engine = side === RED ? engineRed : engineBlack;
    const legal = engine.generateLegalMoves(board, side);
    if (legal.length === 0) return { winner: side === RED ? BLACK : RED, reason: "no-moves", plies: ply, moves };

    const result = engine.analyzePosition(board, side, {
      depth, timeMs, nodeLimit, candidates: 1,
    });
    let move = result.bestMove;
    if (!move) return { winner: side === RED ? BLACK : RED, reason: "no-move-found", plies: ply, moves };

    const captured = board[move.to];
    board = applyMove(board, move);
    halfmove = captured || board[move.to]?.type === "p" ? 0 : halfmove + 1;
    side = side === RED ? BLACK : RED;
    moves.push(move);

    const key = stateKey(board, side);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (counts.get(key) >= 3) return { winner: null, reason: "repetition", plies: ply + 1, moves };
    if (halfmove >= 120) return { winner: null, reason: "60-move", plies: ply + 1, moves };
  }
  return { winner: null, reason: "max-plies", plies: maxPlies, moves };
}

export function playMatch(engineA, engineB, opts) {
  const games = opts.games ?? 10;
  const results = { aWins: 0, bWins: 0, draws: 0, detail: [] };
  for (let i = 0; i < games; i += 1) {
    const aIsRed = i % 2 === 0;
    const red = aIsRed ? engineA : engineB;
    const black = aIsRed ? engineB : engineA;
    const started = performance.now();
    const game = playGame(red, black, opts);
    const ms = performance.now() - started;
    let aResult;
    if (game.winner === null) { results.draws += 1; aResult = "draw"; }
    else if ((game.winner === RED) === aIsRed) { results.aWins += 1; aResult = "win"; }
    else { results.bWins += 1; aResult = "loss"; }
    results.detail.push({ game: i + 1, aIsRed, aResult, winner: game.winner, reason: game.reason, plies: game.plies, ms });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const enginePath = process.argv[2] || path.join(HERE, "app.baseline.js");
  const engine = loadEngine(enginePath);
  console.log(`engine: ${enginePath}`);
  console.log(formatPerft(runPerft(engine, 4)));
  console.log("--- search bench (depth 4, 600ms, 150k nodes) ---");
  for (const probe of probePositions(engine)) {
    const r = benchSearch(engine, probe, { depth: 4, timeMs: 600, nodeLimit: 150000 });
    console.log(`  ply ${r.plies}: nodes ${fmtInt(r.nodes)} depth ${r.depth} ` +
      `${r.ms.toFixed(0)}ms ${fmtInt(Math.round(r.nps))} nps score ${r.score}`);
  }
}
