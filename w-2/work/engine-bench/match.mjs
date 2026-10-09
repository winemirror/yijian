// Equal-time self-play match between the baseline and the optimised engine.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine, playGame, randomOpening, RED } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const baseline = loadEngine(path.join(HERE, "app.baseline.js"));
const candidate = loadEngine(path.join(HERE, "..", "xiangqi-capacitor", "www", "app.js"));

const games = Number(process.argv[2] || 8);
const timeMs = Number(process.argv[3] || 250);
const maxPlies = Number(process.argv[4] || 120);
const openingPlies = Number(process.argv[5] || 8);

console.log(`baseline vs candidate | ${games} games | ${timeMs}ms/move | max ${maxPlies} plies | ` +
  `${openingPlies}-ply random openings`);

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

const started = performance.now();
const result = { aWins: 0, bWins: 0, draws: 0, detail: [] };
let gameIndex = 0;
// Play each opening twice with colours reversed so opening bias cancels out.
for (let index = 0; index < games; index += 1) {
  const rng = makeRng(0xC0FFEE + index * 2654435761);
  const opening = randomOpening(baseline, rng, openingPlies);
  for (const aIsRed of [true, false]) {
    gameIndex += 1;
    const red = aIsRed ? baseline : candidate;
    const black = aIsRed ? candidate : baseline;
    const gameStarted = performance.now();
    const game = playGame(red, black, {
      timeMs,
      depth: 8,
      nodeLimit: 4000000,
      maxPlies,
      startBoard: opening.board,
      startSide: opening.side,
    });
    const ms = performance.now() - gameStarted;
    let aResult;
    if (game.winner === null) { result.draws += 1; aResult = "draw"; }
    else if ((game.winner === RED) === aIsRed) { result.aWins += 1; aResult = "win"; }
    else { result.bWins += 1; aResult = "loss"; }
    result.detail.push({ game: gameIndex, aIsRed, aResult, winner: game.winner, reason: game.reason, plies: game.plies, ms });
  }
}
const elapsed = (performance.now() - started) / 1000;

for (const game of result.detail) {
  console.log(`  game ${String(game.game).padStart(2)} | A=${game.aIsRed ? "red " : "black"} ` +
    `${game.aResult.padEnd(4)} | winner ${game.winner ?? "draw"} | ${game.reason} | ${game.plies} plies | ${(game.ms / 1000).toFixed(1)}s`);
}
console.log(`baseline(A) wins ${result.aWins} | candidate(B) wins ${result.bWins} | draws ${result.draws}`);
console.log(`total ${elapsed.toFixed(1)}s`);
