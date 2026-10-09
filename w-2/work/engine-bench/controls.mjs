// Headless checks for per-side ownership/levels, the "auto next move" button,
// the "xia ji ba xia" level, AI-vs-AI play and taking over either side.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEngine, RED, BLACK, applyMove, stateKey } from "./harness.mjs";
import { readSfnt, readCodepoints } from "../font-tools/fontlib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const engine = loadEngine(path.join(HERE, "..", "xiangqi-capacitor", "www", "app.js"));

const problems = [];
process.on("unhandledRejection", (error) => {
  problems.push(`unhandled rejection: ${error && error.message ? error.message : error}`);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (board) => board.map((p) => (p ? { ...p } : null));

function snapshot() {
  const state = engine.state;
  return {
    control: { ...state.control },
    levels: { ...state.levels },
    playing: state.playing,
    plies: state.game.history.length,
    side: state.game.sideToMove,
    result: state.game.result.type,
  };
}

async function waitFor(predicate, timeoutMs = 60000, tickMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(tickMs);
  }
  return false;
}

function replayLegal(history) {
  let board = engine.initialBoard();
  let side = RED;
  for (const record of history) {
    const legal = engine.generateLegalMoves(board, side);
    if (!legal.some((m) => m.from === record.from && m.to === record.to)) return false;
    board = applyMove(board, { from: record.from, to: record.to });
    side = side === RED ? BLACK : RED;
  }
  return true;
}

console.log("== levels ==");
console.log(`  level keys: ${Object.keys(engine.AI_LEVELS).join(", ")}`);
if (!engine.AI_LEVELS.idiot) problems.push("idiot level missing");
if (engine.AI_LEVELS.idiot && engine.AI_LEVELS.idiot.label !== "瞎几把下") {
  problems.push("idiot level label mismatch");
}
if (engine.AI_LEVELS.idiot && engine.AI_LEVELS.idiot.useBook) {
  problems.push("idiot level should not use the opening book");
}

console.log("== per-side setup ==");
engine.applySetup(RED, "ai:hard");
engine.applySetup(RED, "human");        // taking over keeps the AI level on record
engine.applySetup(BLACK, "ai:idiot");
{
  const now = snapshot();
  console.log(`  control=${JSON.stringify(now.control)} levels=${JSON.stringify(now.levels)}`);
  if (now.control[RED] !== "human") problems.push("red should be human");
  if (engine.levelFor(RED) !== "hard") problems.push("red should remember its AI level");
  if (engine.levelFor(BLACK) !== "idiot") problems.push("black level not applied");
  if (engine.setupValue(BLACK) !== "ai:idiot") problems.push("setup value mismatch");
}

console.log("== auto next move plays the human side ==");
engine.onSetupChange(RED, "human");
engine.onSetupChange(BLACK, "ai:medium");
engine.reset();
{
  const before = snapshot();
  await engine.playAutoStep();
  const after = snapshot();
  console.log(`  before=${JSON.stringify(before)}`);
  console.log(`  after =${JSON.stringify(after)}`);
  if (after.plies <= before.plies) problems.push("auto step did not play a move");
  if (!replayLegal(engine.state.game.history)) problems.push("auto step produced an illegal move");
  if (after.side !== RED) problems.push("auto step should leave it on the human's turn");
  const humanMove = engine.state.game.history[0];
  const aiMove = engine.state.game.history[1];
  console.log(`  human move ${humanMove.notation}, AI reply ${aiMove ? aiMove.notation : "(none)"}`);
  if (!aiMove) problems.push("AI opponent did not reply after the auto step");
  if (engine.state.playing) problems.push("human play should not need the play button");
}

console.log("== play button gates AI vs AI ==");
engine.onSetupChange(RED, "ai:easy");
engine.onSetupChange(BLACK, "ai:easy");
engine.reset();
{
  await sleep(1500);
  const idle = snapshot();
  console.log(`  while paused: ${JSON.stringify(idle)}`);
  if (engine.state.playing) problems.push("should start paused");
  if (idle.plies !== 0) problems.push(`AI moved while paused (${idle.plies} plies)`);
}

console.log("== press play ==");
engine.togglePlay();
{
  const sides = new Set();
  const grew = await waitFor(() => {
    const last = engine.state.game.history.at(-1);
    if (last) sides.add(last.side);
    return engine.state.game.history.length >= 30 || engine.state.game.result.type !== "ongoing";
  }, 90000);
  const now = snapshot();
  console.log(`  playing: ${JSON.stringify(now)} colours=${[...sides].join(",")}`);
  if (!grew) problems.push("AI vs AI did not advance after play");
  if (!(sides.has(RED) && sides.has(BLACK))) problems.push("both colours should move");
  if (!replayLegal(engine.state.game.history)) problems.push("AI vs AI produced an illegal move");
}

console.log("== press pause ==");
engine.togglePlay();
await sleep(500);
const pausedAt = engine.state.game.history.length;
await sleep(1600);
const afterPause = engine.state.game.history.length;
console.log(`  plies ${pausedAt} -> ${afterPause}`);
if (engine.state.playing) problems.push("pause did not clear the playing flag");
if (afterPause !== pausedAt) {
  problems.push(`AI kept playing after pause (${pausedAt} -> ${afterPause})`);
}

console.log("== take over / hand back ==");
engine.togglePlay();
await waitFor(
  () => engine.state.game.sideToMove === BLACK || engine.state.game.result.type !== "ongoing",
  30000
);
engine.onSetupChange(BLACK, "human");
const taken = snapshot();
console.log(`  took over black: ${JSON.stringify(taken)}`);
if (taken.control[BLACK] !== "human") problems.push("black was not taken over");
{
  const plies = taken.plies;
  await sleep(1500);
  if (engine.state.game.sideToMove === BLACK && engine.state.game.history.length !== plies) {
    problems.push("AI kept moving for a side the user took over");
  }
}
const beforeHandBack = engine.state.game.history.length;
engine.onSetupChange(BLACK, "ai:easy");
const resumed = await waitFor(
  () => engine.state.game.history.length > beforeHandBack || engine.state.game.result.type !== "ongoing",
  25000
);
console.log(`  handed black back, resumed=${resumed}`);
if (!resumed) problems.push("play did not resume after handing a side back");

console.log("== the lowest level is genuinely bad ==");
{
  // Head to head: 瞎几把下 should lose to the weakest real level, 入门.
  function playLevelGame(redLevel, blackLevel, maxPlies = 140) {
    let board = engine.initialBoard();
    let side = RED;
    const counts = new Map([[stateKey(board, side), 1]]);
    for (let ply = 0; ply < maxPlies; ply += 1) {
      const legal = engine.generateLegalMoves(board, side);
      if (legal.length === 0) return side === RED ? BLACK : RED;
      const pick = engine.chooseAIMove(
        { board: clone(board), sideToMove: side, history: [] },
        side === RED ? redLevel : blackLevel
      );
      if (!pick) return side === RED ? BLACK : RED;
      board = applyMove(board, { from: pick.from, to: pick.to });
      side = side === RED ? BLACK : RED;
      const key = stateKey(board, side);
      counts.set(key, (counts.get(key) || 0) + 1);
      if (counts.get(key) >= 3) return null;
    }
    return null;
  }

  const games = 8;
  let idiotWins = 0;
  let easyWins = 0;
  let draws = 0;
  for (let index = 0; index < games; index += 1) {
    const idiotIsRed = index % 2 === 0;
    const winner = idiotIsRed
      ? playLevelGame("idiot", "easy")
      : playLevelGame("easy", "idiot");
    if (winner === null) draws += 1;
    else if ((winner === RED) === idiotIsRed) idiotWins += 1;
    else easyWins += 1;
  }
  console.log(`  vs 入门: 瞎几把下 ${idiotWins} 胜, 入门 ${easyWins} 胜, ${draws} 和 (共 ${games} 局)`);
  if (easyWins < games * 0.7) {
    problems.push(`lowest level is not weak enough (won by 入门 only ${easyWins}/${games})`);
  }
  if (idiotWins > games * 0.15) {
    problems.push(`lowest level wins too often (${idiotWins}/${games})`);
  }
}

console.log("");
console.log("== bundled piece font coverage ==");
{
  const fontPath = path.join(HERE, "..", "xiangqi-capacitor", "www", "xiangqi-kai.woff2");
  const covered = readCodepoints(await readSfnt(fontPath));
  // Both name sets: the black pieces use the traditional forms.
  const required = [..."车马象士将帅相仕炮兵卒車馬象士將砲卒弈鉴红黑楚河漢界"];
  const missing = required.filter((c) => !covered.has(c.codePointAt(0)));
  console.log(`  codepoints ${covered.size}, missing: ${missing.length ? missing.join(" ") : "(none)"}`);
  if (missing.length) problems.push(`bundled font is missing: ${missing.join(" ")}`);
}

console.log("== custom piece colours ==");
{
  const doc = engine.__document;
  const vars = () => doc.documentElement.style.props || {};
  const defaults = engine.DEFAULT_PIECE_COLORS;
  console.log(`  defaults: ${JSON.stringify(defaults)}`);
  if (!defaults || !defaults.red || !defaults.black) problems.push("missing default colours");

  const applied = engine.applyPieceColors({ red: "#1a66cc", black: "#f0c020" });
  console.log(`  applied ${JSON.stringify(applied)} -> vars ${JSON.stringify(vars())}`);
  if (vars()["--piece-red"] !== "#1a66cc") problems.push("--piece-red was not applied");
  if (vars()["--piece-black"] !== "#f0c020") problems.push("--piece-black was not applied");
  if (doc.getElementById("redColor").value !== "#1a66cc") {
    problems.push("red colour input was not synced");
  }
  if (doc.getElementById("blackColor").value !== "#f0c020") {
    problems.push("black colour input was not synced");
  }

  const fallback = engine.applyPieceColors({ red: "not-a-colour", black: "#12345" });
  console.log(`  invalid input -> ${JSON.stringify(fallback)}`);
  if (fallback.red !== defaults.red) problems.push("invalid red colour should fall back");
  if (fallback.black !== defaults.black) problems.push("invalid black colour should fall back");
  engine.applyPieceColors(defaults);

  const css = fs.readFileSync(
    path.join(HERE, "..", "xiangqi-capacitor", "www", "styles.css"),
    "utf8"
  );
  if (!/\.piece\.r\s*\{[^}]*var\(--piece-red\)/.test(css)) {
    problems.push("styles.css .piece.r does not use --piece-red");
  }
  if (!/\.piece\.b\s*\{[^}]*var\(--piece-black\)/.test(css)) {
    problems.push("styles.css .piece.b does not use --piece-black");
  }
}

console.log("");
if (problems.length === 0) {
  console.log("CONTROL / AUTOSTEP / LEVEL CHECKS PASSED");
} else {
  console.log("PROBLEMS:");
  for (const problem of problems) console.log(`  - ${problem}`);
}

// Hand both sides back to the human so no driver timers are still pending when
// Node tears down (otherwise libuv can assert on exit).
engine.onSetupChange(RED, "human");
engine.onSetupChange(BLACK, "human");
await sleep(1500);
process.exitCode = problems.length === 0 ? 0 : 1;
