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
      win.localStorage.setItem("xiangqi.practice.enabled", "0");
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
  check("toggle is presented as practice mode",
    /id="recommendationToggle"[^>]*>[\s\S]*?练习/.test(html));
  check("practice strength control exists", html.includes('id="practiceDepth"'));
  check("appearance controls moved into a compact menu",
    html.includes('class="topbar-more"')
    && html.includes('id="redColor"')
    && html.includes('id="autoSpeed"'));
  check("all toolbar actions use icon and label spans",
    (html.match(/class="button-icon"/g) || []).length === 8
    && (html.match(/class="button-label"/g) || []).length === 8);
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
  check("topbar is compact",
    /\.topbar\s*\{[^}]*min-height:\s*54px/.test(css));
  check("toolbar buttons share one size and type scale",
    /\.topbar \.btn,[\s\S]*?height:\s*32px;[\s\S]*?font-size:\s*12px;/.test(css)
    && /\.topbar \.button-label\s*\{[^}]*font-size:\s*12px/.test(css));
  check("desktop piece glyphs keep the original 29px size",
    /\.piece\s*\{[^}]*font-size:\s*29px/.test(css));
  check("board width responds to viewport height",
    /\.board\s*\{[^}]*calc\(\(100vh - 154px\) \* \.9\)/.test(css));
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

console.log("== practice strength and Pikafish hybrid ==");
{
  engine.state.recommendationEnabled = true;
  engine.state.busy = true;
  engine.setPracticeLevel("deep");
  check("deep practice level is stored",
    engine.state.practiceLevel === "deep"
    && engine.__window.localStorage.getItem("xiangqi.practice.level") === "deep");
  check("deep level uses its own analysis budget",
    engine.practiceAnalysisLevel().depth === 4
    && engine.practiceAnalysisLevel().timeMs > engine.RECOMMENDATION_LEVEL.timeMs);

  const board = engine.initialBoard();
  const localAnalysis = syntheticAnalysis(board, RED, { step: 90 });
  const recommendation = engine.buildRecommendation(
    board,
    RED,
    localAnalysis,
    "hybrid-test",
    0
  );
  const preferred = localAnalysis.moveScores[4];
  engine.state.displayAnalysis = {
    side: RED,
    engine: "pikafish",
    cloud: true,
    depth: 12,
    moveScores: [{
      move: preferred.move,
      score: preferred.score,
      evalRed: preferred.evalRed,
      winRed: preferred.winRed,
      depth: 12
    }]
  };
  engine.attachPikafishBest(recommendation, board, RED, 0);
  check("Pikafish first choice is attached without replacing local ranking",
    recommendation.pikafishBest
    && recommendation.pikafishBest.move.from === preferred.move.from
    && recommendation.pikafishBest.move.to === preferred.move.to
    && recommendation.moves.length === localAnalysis.moveScores.length);

  engine.state.recommendation = recommendation;
  const pieces = engine.__document.getElementById("pieces");
  pieces.children.length = 0;
  engine.renderPieces();
  const marker = flatten(pieces).find((node) => node.dataset.pikafishBest === "1");
  check("Pikafish first choice has a separate marker", !!marker);
  engine.state.busy = false;
  engine.state.selected = preferred.move.from;
  engine.state.legalMoves = engine.generateLegalMoves(board, RED)
    .filter((move) => move.from === preferred.move.from);
  const hints = engine.__document.getElementById("moveHints");
  hints.children.length = 0;
  engine.renderPieces();
  const preferredHint = flatten(hints)
    .find((node) => node.dataset && node.dataset.pikafishBest === "1");
  check("Pikafish first choice is marked on its target", !!preferredHint);
  engine.state.selected = null;
  engine.state.legalMoves = [];

  engine.setPracticeLevel("standard");
  engine.state.displayAnalysis = null;
  check("standard practice level restores default budget",
    engine.practiceAnalysisLevel().depth === 3
    && engine.__window.localStorage.getItem("xiangqi.practice.level") === "standard");
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

  engine.state.live = false;
  engine.state.reviewPly = 0;
  engine.state.selected = null;
  engine.state.legalMoves = [];
  engine.selectPiece(legal[0].from);
  check("practice mode can inspect a historical position",
    engine.state.selected === legal[0].from
      && engine.state.legalMoves.length > 0);
  engine.state.live = true;
  engine.state.selected = null;
  engine.state.legalMoves = [];

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
  const legacyEngine = loadEngine(
    path.join(here, "www", "app.js"),
    path.join(here, "ai-data.js"),
    {
      beforeEngine(sandbox, win) {
        win.localStorage.setItem("xiangqi.recommendation.enabled", "0");
      }
    }
  );
  check("legacy recommendation preference migrates to practice mode",
    legacyEngine.state.recommendationEnabled === false);

  engine.state.recommendationEnabled = true;
  engine.state.busy = true;
  engine.toggleRecommendation();
  check("toggle writes disabled preference",
    engine.__window.localStorage.getItem("xiangqi.practice.enabled") === "0");
  engine.toggleRecommendation();
  check("toggle writes enabled preference",
    engine.__window.localStorage.getItem("xiangqi.practice.enabled") === "1");

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
