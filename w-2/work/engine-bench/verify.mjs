// Correctness + performance verification for the optimised engine.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine, applyMove, runPerft, formatPerft, RED, BLACK } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const engine = loadEngine(path.join(HERE, "..", "xiangqi-capacitor", "www", "app.js"));
const fmt = (n) => n.toLocaleString("en-US");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures += 1;
};

console.log("== perft ==");
const perftRows = runPerft(engine, 4);
console.log(formatPerft(perftRows));
check("perft matches known node counts", perftRows.every((r) => r.ok !== false));

// --- sharded worker path ----------------------------------------------------
console.log("== sharded search (worker path) ==");
function midgame() {
  let board = engine.initialBoard();
  let side = RED;
  for (const [from, to] of [[60, 51], [1, 20], [70, 67], [25, 24], [67, 31]]) {
    board = applyMove(board, { from, to });
    side = side === RED ? BLACK : RED;
  }
  return { board, side };
}
{
  const { board, side } = midgame();
  const legal = engine.generateLegalMoves(board, side);
  const ordered = engine.orderedMoves(board, legal);
  const settings = { depth: 4, timeMs: 1500, nodeLimit: 300000, pvs: true, nullMove: true, checkExtension: true, lmr: true };
  const shardCount = 4;
  const shards = Array.from({ length: shardCount }, () => []);
  ordered.forEach((move, index) => shards[index % shardCount].push(move));
  const results = shards.map((moves) => engine.searchMoveSubset(board, side, moves, settings));
  const total = results.reduce((sum, r) => sum + r.ranked.length, 0);
  const codes = new Set(results.flatMap((r) => r.ranked.map((e) => e.move.from * 90 + e.move.to)));
  check("every shard searched its moves", total === legal.length, `${total}/${legal.length}`);
  check("shard scores cover all moves", codes.size === legal.length, `${codes.size}/${legal.length}`);
  check("board unchanged after search", engine.perft(board, side, 1) === legal.length);
  const best = results.flatMap((r) => r.ranked).sort((a, b) => b.score - a.score)[0];
  const single = engine.analyzePosition(board, side, settings);
  console.log(`  sharded best score ${best.score}, single-thread best score ${single.score}`);
  const agree = best.move.from === single.bestMove.from && best.move.to === single.bestMove.to;
  console.log(`  sharded/single-thread best move ${agree ? "agree" : "differ (expected: heuristics are order dependent)"}`);
}

// --- AI levels --------------------------------------------------------------
console.log("== AI levels (configured time budget) ==");
const { board, side } = midgame();
for (const [key, level] of Object.entries(engine.AI_LEVELS)) {
  const workBoard = board.map((p) => (p ? { ...p } : null));
  const started = performance.now();
  const result = engine.analyzePosition(workBoard, side, {
    depth: level.depth,
    timeMs: level.timeMs,
    nodeLimit: level.nodeLimit,
    candidates: level.candidateCount,
    nullMove: level.nullMove,
    pvs: level.pvs,
    checkExtension: level.checkExtension,
    lmr: level.lmr,
  });
  const ms = performance.now() - started;
  console.log(`  ${key.padEnd(6)} depth ${result.depth}/${level.depth} | ` +
    `${fmt(result.nodes)} nodes | ${ms.toFixed(0)}ms | ${fmt(Math.round(result.nodes / (ms / 1000)))} nps | score ${result.score}`);
  check(`${key} reached at least depth 2`, result.depth >= 2 || level.depth < 2);
}

// --- opening / escape robot smoke -------------------------------------------
console.log("== opening book ==");
{
  const result = engine.analyzePosition(engine.initialBoard(), RED, { depth: 4, timeMs: 1200, nodeLimit: 200000 });
  console.log(`  initial best: ${result.bestNotation} depth ${result.depth} nodes ${fmt(result.nodes)}`);
  check("initial position has a best move", Boolean(result.bestMove));
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
