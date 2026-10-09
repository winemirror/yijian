// Side-by-side sanity comparison of baseline vs optimised search on identical
// positions, to catch search/eval regressions hidden by self-play results.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine, applyMove, RED, BLACK } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const baseline = loadEngine(path.join(HERE, "app.baseline.js"));
const candidate = loadEngine(path.join(HERE, "..", "xiangqi-capacitor", "www", "app.js"));

const LINES = {
  start: [],
  tactical5: [[60, 51], [1, 20], [70, 67], [25, 24], [67, 31]],
  open6: [[60, 51], [1, 20], [70, 67], [25, 24], [67, 31], [20, 29]],
};

function build(line) {
  let board = baseline.initialBoard();
  let side = RED;
  for (const [from, to] of line) {
    board = applyMove(board, { from, to });
    side = side === RED ? BLACK : RED;
  }
  return { board, side };
}

function run(engine, board, side, depth, timeMs = 8000) {
  const started = performance.now();
  const r = engine.analyzePosition(board.map((p) => (p ? { ...p } : null)), side, {
    depth, timeMs, nodeLimit: 20000000, candidates: 3, nullMove: true, pvs: true,
    checkExtension: true, lmr: true,
  });
  return { score: r.score, best: r.bestNotation, depth: r.depth, nodes: r.nodes, ms: performance.now() - started };
}

for (const [name, line] of Object.entries(LINES)) {
  const { board, side } = build(line);
  console.log(`\n[${name}] side to move = ${side}`);
  for (const depth of [3, 4, 5]) {
    const b = run(baseline, board, side, depth);
    const c = run(candidate, board, side, depth);
    console.log(`  depth ${depth} | baseline ${String(b.score).padStart(6)} (${b.best}, d${b.depth}, ` +
      `${Math.round(b.ms)}ms) | candidate ${String(c.score).padStart(6)} (${c.best}, d${c.depth}, ${Math.round(c.ms)}ms)`);
  }
}
