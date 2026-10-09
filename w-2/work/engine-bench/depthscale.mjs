// Time and node cost as a function of search depth, to pick good level caps.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine, applyMove, RED, BLACK } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const engine = loadEngine(path.join(HERE, "..", "xiangqi-capacitor", "www", "app.js"));

const LINES = {
  start: [],
  midgame: [[60, 51], [1, 20], [70, 67], [25, 24], [67, 31]],
};

for (const [name, line] of Object.entries(LINES)) {
  let board = engine.initialBoard();
  let side = RED;
  for (const [from, to] of line) {
    board = applyMove(board, { from, to });
    side = side === RED ? BLACK : RED;
  }
  console.log(`\n[${name}] side ${side}`);
  for (let depth = 2; depth <= 10; depth += 1) {
    const started = performance.now();
    const r = engine.analyzePosition(board.map((p) => (p ? { ...p } : null)), side, {
      depth, timeMs: 60000, nodeLimit: 20000000, candidates: 1,
      nullMove: true, pvs: true, checkExtension: true, lmr: true,
    });
    const ms = performance.now() - started;
    console.log(`  depth ${String(depth).padStart(2)} | ${r.nodes.toLocaleString("en-US").padStart(11)} nodes | ` +
      `${ms.toFixed(0).padStart(7)}ms | ${(r.nodes / Math.max(1, ms / 1000)).toFixed(0).padStart(6)} nps | ` +
      `${String(r.score).padStart(6)} | ${r.bestNotation}`);
    if (ms > 45000) break;
  }
}
