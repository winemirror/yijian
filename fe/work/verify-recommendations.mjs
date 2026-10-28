import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine, RED, BLACK } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = loadEngine(
  path.join(here, "www", "app.js"),
  path.join(here, "ai-data.js"),
  {
    beforeEngine(sandbox, win) {
      win.localStorage.setItem("xiangqi.recommendation.enabled", "0");
    }
  }
);
const html = fs.readFileSync(path.join(here, "www", "index.html"), "utf8");
const css = fs.readFileSync(path.join(here, "www", "styles.css"), "utf8");

const problems = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

function moveCode(move) {
  return move.from * 90 + move.to;
}

function syntheticAnalysis(board, side, options = {}) {
  const legal = engine.generateLegalMoves(board, side);
  const step = options.step ?? 70;
  const start = options.start ?? 180;
  return {
    side,
    depth: 3,
    engine: options.engine || "local",
    terminal: false,
    moveScores: legal.map((move, index) => {
      const score = start - index * step;
      return {
        move,
        score,
        evalRed: side === RED ? score : -score,
        winRed: side === RED
          ? Math.max(1, 55 - index * 0.8)
          : Math.min(99, 45 + index * 0.8)
      };
    }),
    candidates: legal.slice(0, 5),
    bestMove: legal[0] || null
  };
}

function flatten(root) {
  const out = [];
  const walk = (nodes) => (nodes || []).forEach((node) => {
    out.push(node);
    if (node.children) walk(node.children);
  });
  walk(root.children);
  return out;
}

console.log("== markup and controls ==");
{
  check("recommendation toggle exists", html.includes('id="recommendationToggle"'));
  check("recommendation legend exists", html.includes('id="recommendationLegend"'));
  check("legend has five tiers",
    (html.match(/recommendation-swatch/g) || []).length === 5);
  check("pieces receive recommendation rings",
    /\.piece\.recommend-tier-0::before/.test(css)
    && /\.piece\.recommend-tier-4::before/.test(css));
  check("move targets receive recommendation colours",
    /\.hint\.recommend-tier-0/.test(css)
    && /\.hint\.recommend-tier-4/.test(css));
  check("target ranks use a text label", /data-recommend-rank/.test(css));
  check("recommendation layer stays above pieces",
    /\.move-hints\s*\{[^}]*z-index:\s*4/.test(css));
}

console.log("== complete ranking ==");
{
  engine.reset();
  const board = engine.initialBoard();
  const analysis = syntheticAnalysis(board, RED, { step: 100 });
  const legal = engine.generateLegalMoves(board, RED);
  check("synthetic analysis covers all legal moves",
    engine.analysisCoversAllMoves(board, RED, analysis));
  check("missing candidates are detected",
    !engine.analysisCoversAllMoves(board, RED, Object.assign({}, analysis, {
      moveScores: analysis.moveScores.slice(1)
    })));

  const result = engine.buildRecommendation(board, RED, analysis, "test-position", 0);
  console.log(`  ${result.moves.length} moves, ${Object.keys(result.pieces).length} pieces`);
  check("every legal move receives a rank", result.moves.length === legal.length);
  check("best move is rank one", result.moves[0].rank === 1);
  check("best move is tier zero", result.moves[0].tier === 0);
  check("worst move reaches tier four", result.moves.at(-1).tier === 4);
  check("ranks are unique and ordered",
    result.moves.every((entry, index) => entry.rank === index + 1));
  check("piece score uses its best move",
    Object.values(result.pieces).some((piece) => (
      piece.bestMove && result.moveByCode[moveCode(piece.bestMove)].score === piece.score
    )));
  check("piece ranks start at one",
    Math.min(...Object.values(result.pieces).map((piece) => piece.rank)) === 1);
  check("analysis result is marked complete", result.complete === true);
}

console.log("== threshold and perspective handling ==");
{
  const board = engine.initialBoard();
  const red = engine.buildRecommendation(
    board,
    RED,
    syntheticAnalysis(board, RED, { start: 100, step: 10 })
  );
  check("small red-side losses stay in the best tiers",
    red.moves.slice(0, 3).every((entry) => entry.tier <= 1));

  const blackAnalysis = syntheticAnalysis(board, BLACK, { start: 120, step: 80 });
  const black = engine.buildRecommendation(board, BLACK, blackAnalysis);
  check("black ranking uses black perspective",
    black.side === BLACK && black.moves[0].sideWin >= black.moves.at(-1).sideWin);
}

console.log("== render integration ==");
{
  engine.reset();
  const board = engine.initialBoard();
  const legal = engine.generateLegalMoves(board, RED);
  const result = engine.buildRecommendation(
    board,
    RED,
    syntheticAnalysis(board, RED, { step: 100 })
  );
  engine.state.displayAnalysis = syntheticAnalysis(board, RED, { step: 100 });
  engine.state.recommendation = result;
  engine.state.recommendationEnabled = true;
  engine.syncRecommendationFromAvailableData();

  const pieces = engine.__document.getElementById("pieces");
  pieces.children.length = 0;
  engine.renderPieces();
  const pieceNodes = flatten(pieces).filter((node) => node.dataset && node.dataset.square);
  const topPiece = pieceNodes.find((node) => node.dataset.recommendTop === "1");
  check("current-side pieces receive tier data",
    pieceNodes.some((node) => node.dataset.recommendTier === "0"));
  check("best piece receives a rank marker", !!topPiece);
  check("piece aria label names its recommendation",
    topPiece && String(topPiece.attributes?.["aria-label"] || "").includes("推荐"));

  engine.state.selected = legal[0].from;
  engine.state.legalMoves = legal.filter((move) => move.from === legal[0].from);
  const hints = engine.__document.getElementById("moveHints");
  hints.children.length = 0;
  engine.renderPieces();
  const hintNodes = flatten(hints)
    .filter((node) => node.dataset && node.dataset.recommendRank);
  check("selected piece targets receive ranks",
    hintNodes.length === engine.state.legalMoves.length
    && hintNodes.every((node) => node.dataset.recommendRank));
  check("selected target ranks run from one to the local move count",
    hintNodes
      .map((node) => Number(node.dataset.recommendRank))
      .sort((a, b) => a - b)
      .every((rank, index) => rank === index + 1));

  engine.state.flipped = true;
  engine.renderPieces();
  const flippedPieces = flatten(pieces).filter((node) => node.dataset && node.dataset.square);
  const flippedTop = flippedPieces.find((node) => node.dataset.recommendTop === "1");
  check("flip keeps recommendation data",
    flippedTop && flippedTop.dataset.recommendTier === "0");
  engine.state.flipped = false;
  engine.state.selected = null;
  engine.state.legalMoves = [];
}

console.log("== persistence and multiplayer policy ==");
{
  engine.state.recommendationEnabled = true;
  engine.state.busy = true;
  engine.toggleRecommendation();
  check("toggle writes disabled preference",
    engine.__window.localStorage.getItem("xiangqi.recommendation.enabled") === "0");
  engine.toggleRecommendation();
  check("toggle writes enabled preference",
    engine.__window.localStorage.getItem("xiangqi.recommendation.enabled") === "1");

  engine.state.net.active = true;
  check("multiplayer hides recommendations", engine.recommendationVisible() === false);
  engine.state.net.active = false;
  engine.state.busy = false;
  check("local play shows recommendations", engine.recommendationVisible() === true);
}

console.log("");
if (problems.length === 0) {
  console.log("RECOMMENDATION CHECKS PASSED");
  process.exitCode = 0;
} else {
  console.log(`PROBLEMS: ${problems.join("; ")}`);
  process.exitCode = 1;
}
