// Differential test: walk pseudo-random games and assert the optimised engine
// produces exactly the same legal-move sets as the untouched baseline. This
// catches regressions in the fast isInCheck / legal-move rewrites.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine, applyMove, RED, BLACK } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const baseline = loadEngine(path.join(HERE, "app.baseline.js"));
const candidate = loadEngine(path.join(HERE, "..", "xiangqi-capacitor", "www", "app.js"));

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

function codes(moves) {
  return moves.map((m) => m.from * 90 + m.to).sort((a, b) => a - b);
}

function describe(moves) {
  return moves.map((m) => `${m.from}-${m.to}`).sort().join(" ");
}

const games = Number(process.argv[2] || 400);
const maxPlies = Number(process.argv[3] || 80);
let positions = 0;
let mismatches = 0;

for (let game = 0; game < games; game += 1) {
  const rng = makeRng(0x1234 + game * 2654435761);
  let board = baseline.initialBoard();
  let side = RED;

  for (let ply = 0; ply < maxPlies; ply += 1) {
    const baseMoves = baseline.generateLegalMoves(board, side);
    const candMoves = candidate.generateLegalMoves(board, side);
    positions += 1;

    const a = codes(baseMoves);
    const b = codes(candMoves);
    if (a.length !== b.length || a.some((value, index) => value !== b[index])) {
      mismatches += 1;
      if (mismatches <= 5) {
        console.log(`MISMATCH game ${game} ply ${ply} side ${side}`);
        console.log(`  baseline : ${describe(baseMoves)}`);
        console.log(`  candidate: ${describe(candMoves)}`);
      }
      break;
    }
    if (baseMoves.length === 0) break;

    // Bias toward captures so tactical positions (checks, pins, exchanges) show up.
    const captures = baseMoves.filter((m) => board[m.to]);
    const pool = captures.length > 0 && rng() < 0.45 ? captures : baseMoves;
    const move = pool[Math.floor(rng() * pool.length)];
    board = applyMove(board, move);
    side = side === RED ? BLACK : RED;
  }
}

console.log(`positions compared: ${positions}`);
console.log(mismatches === 0 ? "PASS: move generation is identical" : `FAIL: ${mismatches} mismatches`);
process.exit(mismatches === 0 ? 0 : 1);
