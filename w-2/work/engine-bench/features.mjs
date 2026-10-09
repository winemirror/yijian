// How do the individual search features affect nodes and value?
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine, applyMove, RED, BLACK } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const engine = loadEngine(path.join(HERE, "..", "xiangqi-capacitor", "www", "app.js"));

const LINES = {
  start: [],
  tactical5: [[60, 51], [1, 20], [70, 67], [25, 24], [67, 31]],
};

function build(line) {
  let board = engine.initialBoard();
  let side = RED;
  for (const [from, to] of line) {
    board = applyMove(board, { from, to });
    side = side === RED ? BLACK : RED;
  }
  return { board, side };
}

const COMBOS = [
  ["all on", { nullMove: true, lmr: true, pvs: true, checkExtension: true }],
  ["no null", { nullMove: false, lmr: true, pvs: true, checkExtension: true }],
  ["no lmr", { nullMove: true, lmr: false, pvs: true, checkExtension: true }],
  ["neither", { nullMove: false, lmr: false, pvs: true, checkExtension: true }],
  ["plain ab", { nullMove: false, lmr: false, pvs: false, checkExtension: false }],
];

const depth = Number(process.argv[2] || 5);
for (const [name, line] of Object.entries(LINES)) {
  const { board, side } = build(line);
  console.log(`\n[${name}] depth ${depth}, side ${side}`);
  for (const [label, flags] of COMBOS) {
    const started = performance.now();
    const r = engine.analyzePosition(board.map((p) => (p ? { ...p } : null)), side, {
      depth, timeMs: 120000, nodeLimit: 50000000, candidates: 1, ...flags,
    });
    const ms = performance.now() - started;
    console.log(`  ${label.padEnd(8)} score ${String(r.score).padStart(6)} | d${r.depth} | ` +
      `${r.nodes.toLocaleString("en-US").padStart(10)} nodes | ${ms.toFixed(0).padStart(6)}ms | ${r.bestNotation}`);
  }
}
