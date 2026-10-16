// Verifies mate-pattern classification against hand-built checkmates.
import path from "node:path";
import fs from "node:fs";
import { loadEngine, RED, BLACK } from "./harness.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const engine = loadEngine(path.join(here, "www", "app.js"));
const html = fs.readFileSync(path.join(here, "www", "index.html"), "utf8");
const data = fs.readFileSync(path.join(here, "www", "ai-data.js"), "utf8");

const problems = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

const piece = (square, type, side) => [square, type, side];

function build(pieces) {
  const board = Array(90).fill(null);
  for (const [square, type, side] of pieces) board[square] = { type, side };
  return board;
}

// index = row * 9 + col, row 0 = black's back rank.
const CASES = [
  {
    name: "马后炮",
    id: "horseCannon",
    pieces: [
      piece(4, "k", BLACK), piece(3, "a", BLACK), piece(5, "a", BLACK),
      piece(22, "c", RED), piece(13, "n", RED), piece(9, "r", RED),
    ],
  },
  {
    name: "重炮",
    id: "doubleCannon",
    pieces: [
      piece(4, "k", BLACK), piece(3, "a", BLACK), piece(5, "a", BLACK),
      piece(22, "c", RED), piece(13, "c", RED), piece(9, "r", RED),
    ],
  },
  {
    name: "卧槽马",
    id: "troughHorse",
    pieces: [
      piece(4, "k", BLACK), piece(3, "a", BLACK), piece(5, "a", BLACK),
      piece(15, "n", RED), piece(9, "r", RED),
    ],
  },
  {
    name: "挂角马",
    id: "cornerHorse",
    pieces: [
      piece(4, "k", BLACK), piece(3, "a", BLACK), piece(5, "a", BLACK),
      piece(21, "n", RED), piece(9, "r", RED),
    ],
  },
  {
    name: "双车错",
    id: "doubleRook",
    pieces: [
      piece(4, "k", BLACK), piece(5, "a", BLACK),
      piece(22, "r", RED), piece(0, "r", RED),
    ],
  },
  {
    name: "闷宫",
    id: "smotheredPalace",
    pieces: [
      piece(4, "k", BLACK), piece(5, "a", BLACK), piece(13, "a", BLACK),
      piece(8, "c", RED), piece(20, "n", RED),
    ],
  },
  {
    name: "铁门栓",
    id: "ironBolt",
    pieces: [
      piece(4, "k", BLACK),
      piece(31, "c", RED), piece(22, "p", RED), piece(20, "n", RED), piece(24, "n", RED),
    ],
  },
  {
    name: "天地炮",
    id: "skyEarthCannon",
    pieces: [
      piece(4, "k", BLACK),
      piece(8, "c", RED), piece(6, "p", RED), piece(31, "c", RED), piece(9, "r", RED),
    ],
  },
  {
    name: "二鬼拍门",
    id: "twinPawns",
    pieces: [
      piece(4, "k", BLACK),
      piece(12, "p", RED), piece(14, "p", RED), piece(22, "r", RED),
    ],
  },
  {
    name: "闷杀",
    id: "smother",
    pieces: [
      piece(13, "k", BLACK), piece(4, "r", BLACK), piece(12, "n", BLACK),
      piece(14, "n", BLACK), piece(22, "b", BLACK),
      piece(30, "n", RED),
    ],
  },
  {
    name: "对面笑",
    id: "flyingGeneral",
    pieces: [
      piece(4, "k", BLACK), piece(85, "k", RED),
      piece(20, "n", RED), piece(24, "n", RED),
    ],
  },
];

console.log(`== mate patterns (${CASES.length}) ==`);
for (const testCase of CASES) {
  const board = build(testCase.pieces);
  const legal = engine.generateLegalMoves(board, BLACK);
  const inCheck = engine.isInCheck(board, BLACK);
  const patterns = engine.classifyMate(board, RED);
  const ids = patterns.map((entry) => entry.id);
  const names = patterns.map((entry) => entry.name).join("/");

  if (legal.length !== 0 || !inCheck) {
    console.log(`  ${testCase.name}: NOT MATE (legal=${legal.length}, check=${inCheck})`);
    problems.push(`${testCase.name} position is not checkmate`);
    continue;
  }
  check(`${testCase.name} -> ${testCase.id}`, ids[0] === testCase.id,
    `matched: ${names || "(none)"}`);
}

console.log("== negatives ==");
{
  // A plain horse mate: the checking horse sits on an ordinary square, so it
  // must not be dressed up as one of the named patterns.
  const board = build([
    piece(22, "k", BLACK), piece(3, "a", BLACK), piece(5, "a", BLACK),
    piece(29, "n", RED), piece(40, "n", RED), piece(9, "r", RED),
  ]);
  const legal = engine.generateLegalMoves(board, BLACK);
  const inCheck = engine.isInCheck(board, BLACK);
  const patterns = engine.classifyMate(board, RED).map((entry) => entry.id);
  console.log(`  plain horse mate: legal=${legal.length} check=${inCheck} `
    + `patterns=${patterns.join("/") || "(none)"}`);
  check("plain horse mate is still a mate", legal.length === 0 && inCheck);
  check("plain horse mate reports no named pattern", patterns.length === 0,
    patterns.join("/"));

  const empty = engine.classifyMate(engine.initialBoard(), RED);
  check("initial position yields no pattern", empty.length === 0);
}

console.log("== sound wiring ==");
{
  const clips = [...data.matchAll(/data:audio\/mpeg;base64,([A-Za-z0-9+/=]+)/g)];
  console.log(`  embedded clips: ${clips.length}`);
  check("four clips are embedded", clips.length === 4, String(clips.length));
  check("pickup / place / capture / notify keys exist",
    /pickup: "data:audio/.test(data) && /place: "data:audio/.test(data)
    && /capture: "data:audio/.test(data) && /notify: "data:audio/.test(data));
  check("sound toggle exists in the page", html.includes('id="soundToggle"'));
  check("playSound is exported", typeof engine.playSound === "function");

  const appSource = fs.readFileSync(path.join(here, "www", "app.js"), "utf8");
  check("收到对手发言/催促时播提醒音",
    (appSource.match(/playSound\("notify"\)/g) || []).length >= 2);
  check("clips play at 50% volume", /SOUND_VOLUME = 0\.5\b/.test(appSource));
  check("one shared volume for every clip",
    (appSource.match(/\.volume = SOUND_VOLUME/g) || []).length === 1);

  engine.state.soundOn = false;
  check("muted playback is skipped", engine.playSound("place") === false);
  engine.state.soundOn = true;
  engine.toggleSound();
  check("toggle flips the setting", engine.state.soundOn === false);
  engine.toggleSound();
  check("toggle flips back", engine.state.soundOn === true);
}

console.log("== victory banner ==");
{
  const doc = engine.__document;
  const game = engine.state.game;
  const banner = doc.getElementById("resultBanner");
  const label = doc.getElementById("resultBannerText");

  // Drive the real updateResult path: inject the 马后炮 position as the live
  // game state and let the engine decide the result.
  game.history = [];
  game.board = build(CASES[0].pieces);
  game.sideToMove = BLACK;
  game.updateResult();
  console.log(`  result: ${game.result.type} / ${game.result.reason} / `
    + `${game.result.pattern ? game.result.pattern.name : "(none)"}`);
  check("updateResult attaches the mate pattern",
    Boolean(game.result.pattern) && game.result.pattern.id === "horseCannon");

  engine.renderResultBanner();
  console.log(`  banner: hidden=${banner.hidden} text="${label.textContent}" `
    + `fill=${banner.style.props["--banner-fill"]}`);
  check("banner is visible after a win", banner.hidden === false);
  check("banner names winner and mate",
    label.textContent === "红方胜，马后炮", label.textContent);
  check("banner uses the winner's colour",
    banner.style.props["--banner-fill"] === engine.DEFAULT_PIECE_COLORS.red,
    String(banner.style.props["--banner-fill"]));
  check("banner markup exists in the page", html.includes('id="resultBanner"'));
  check("banner animates in",
    /@keyframes\s+result-banner-in/.test(fs.readFileSync(
      path.join(here, "www", "styles.css"), "utf8"
    )));

  // Both 新对局 and 悔棋 leave an unfinished game, which must clear the banner.
  game.result = { type: "ongoing", winner: null, reason: "" };
  engine.renderResultBanner();
  check("banner hides once the game is ongoing again", banner.hidden === true);
  check("banner text is cleared", label.textContent === "", label.textContent);

  // A plain mate (no named pattern) still gets a banner.
  game.board = build([
    piece(22, "k", BLACK), piece(3, "a", BLACK), piece(5, "a", BLACK),
    piece(29, "n", RED), piece(40, "n", RED), piece(9, "r", RED),
  ]);
  game.sideToMove = BLACK;
  game.updateResult();
  engine.renderResultBanner();
  console.log(`  plain mate banner: "${label.textContent}"`);
  check("plain mate falls back to 绝杀",
    label.textContent === "红方胜，绝杀", label.textContent);
}

console.log("");
if (problems.length === 0) {
  console.log("MATE + SOUND CHECKS PASSED");
  process.exitCode = 0;
} else {
  console.log("PROBLEMS:");
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exitCode = 1;
}
