import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.YIJIAN_URL || "http://127.0.0.1:4391/index.html";
const artifactDir = process.env.ARTIFACT_DIR || os.tmpdir();
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const problems = [];
const browserErrors = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

async function waitForRecommendation(page) {
  await page.waitForFunction(() => (
    window.XiangqiLocal
    && window.XiangqiLocal.state.recommendation.status === "ready"
    && document.querySelectorAll(".piece[data-recommend-tier]").length > 0
  ), null, { timeout: 20000 });
}

async function exerciseViewport(browser, name, viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    reducedMotion: "no-preference"
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(`${name}: ${error.message}`));
  page.on("console", (message) => {
    if (
      message.type() === "error"
      && !message.text().includes("Failed to load resource")
    ) {
      browserErrors.push(`${name}: ${message.text()}`);
    }
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await waitForRecommendation(page);

  const state = await page.evaluate(() => {
    const actionButtons = [...document.querySelectorAll(".topbar-actions .action-button")];
    const actionMetrics = actionButtons.map((button) => {
      const rect = button.getBoundingClientRect();
      const label = button.querySelector(".button-label");
      return {
        text: label ? label.textContent : "",
        top: rect.top,
        height: rect.height,
        fontSize: label ? getComputedStyle(label).fontSize : "",
        fontFamily: label ? getComputedStyle(label).fontFamily : ""
      };
    });
    const sideSelects = ["redSetup", "blackSetup"].map((id) => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return { id, top: rect.top, height: rect.height };
    });
    const firstPiece = document.querySelector(".piece");
    return {
      status: window.XiangqiLocal.state.recommendation.status,
      moves: window.XiangqiLocal.state.recommendation.legalCount,
      depth: window.XiangqiLocal.state.recommendation.depth,
      markedPieces: document.querySelectorAll(".piece[data-recommend-tier]").length,
      topPieces: document.querySelectorAll('.piece[data-recommend-top="1"]').length,
      legendHidden: document.getElementById("recommendationLegend").hidden,
      practiceText: document.getElementById("recommendationToggle").textContent.trim(),
      topbarHeight: document.querySelector(".topbar").getBoundingClientRect().height,
      boardBottom: document.getElementById("board").getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
      pieceFontSize: firstPiece ? getComputedStyle(firstPiece).fontSize : "",
      actionMetrics,
      sideSelects
    };
  });
  check(`${name}: initial ranking is ready`, state.status === "ready", state.status);
  check(`${name}: all initial legal moves are covered`, state.moves === 44, String(state.moves));
  check(`${name}: analysis has depth`, state.depth >= 1, String(state.depth));
  check(`${name}: current-side pieces have rings`, state.markedPieces >= 10, String(state.markedPieces));
  check(`${name}: one best piece has a badge`, state.topPieces === 1, String(state.topPieces));
  check(`${name}: legend is visible`, state.legendHidden === false);
  check(`${name}: toggle is named practice`, state.practiceText.includes("练习"));
  if (name === "desktop" || name === "laptop") {
    check(`${name}: topbar remains compact`, state.topbarHeight <= 60, String(state.topbarHeight));
    check(`${name}: complete board fits in the viewport`,
      state.boardBottom <= state.viewportHeight,
      `${state.boardBottom}/${state.viewportHeight}`);
    const firstAction = state.actionMetrics[0];
    check(`${name}: all toolbar buttons align`,
      state.actionMetrics.length === 8
        && state.actionMetrics.every((entry) => Math.abs(entry.top - firstAction.top) < 1),
      JSON.stringify(state.actionMetrics));
    check(`${name}: side selectors align with toolbar buttons`,
      state.sideSelects.length === 2
        && state.sideSelects.every((entry) => (
          Math.abs(entry.top - firstAction.top) < 1
          && Math.abs(entry.height - firstAction.height) < 1
        )),
      JSON.stringify({ selectors: state.sideSelects, action: firstAction }));
    check(`${name}: all toolbar actions share height and type scale`,
      state.actionMetrics.every((entry) => (
        Math.abs(entry.height - 32) < 1
        && entry.fontSize === "12px"
        && entry.fontFamily === firstAction.fontFamily
      )),
      JSON.stringify(state.actionMetrics));
    check(`${name}: piece glyphs remain 29px`, state.pieceFontSize === "29px",
      state.pieceFontSize);
  }

  const pikafishMarkers = await page.evaluate(() => {
    const local = window.XiangqiLocal;
    const recommendation = local.state.recommendation;
    const entry = recommendation.moves[2];
    recommendation.pikafishBest = {
      move: entry.move,
      score: entry.score,
      evalRed: entry.evalRed,
      winRed: entry.winRed,
      depth: 12,
      localRank: entry.rank,
      tier: entry.tier
    };
    local.state.selected = entry.move.from;
    local.state.legalMoves = local.generateLegalMoves(
      local.state.game.board,
      local.state.game.sideToMove
    ).filter((move) => move.from === entry.move.from);
    local.renderPieces();
    local.updateRecommendationUI();
    return {
      pieces: document.querySelectorAll(".pikafish-best-marker").length,
      hints: document.querySelectorAll(".hint[data-pikafish-best='1']").length,
      legendVisible: document.getElementById("pikafishLegend").hidden === false
    };
  });
  check(`${name}: Pikafish first choice renders on piece and target`,
    pikafishMarkers.pieces === 1
      && pikafishMarkers.hints >= 1
      && pikafishMarkers.legendVisible,
    JSON.stringify(pikafishMarkers));
  if (name === "desktop") {
    const pikafishScreenshot = path.join(artifactDir, "yijian-pikafish-marker-desktop.png");
    await page.screenshot({ path: pikafishScreenshot, fullPage: false });
    console.log(`  Pikafish marker screenshot: ${pikafishScreenshot}`);
  }
  await page.evaluate(() => {
    window.XiangqiLocal.state.recommendation.pikafishBest = null;
    window.XiangqiLocal.state.selected = null;
    window.XiangqiLocal.state.legalMoves = [];
    window.XiangqiLocal.renderPieces();
    window.XiangqiLocal.updateRecommendationUI();
  });

  await page.locator(".topbar-more summary").click();
  if (name === "desktop") {
    const menuScreenshot = path.join(artifactDir, "yijian-practice-menu-desktop.png");
    await page.screenshot({ path: menuScreenshot, fullPage: false });
    console.log(`  menu screenshot: ${menuScreenshot}`);
  }
  await page.locator("#practiceDepth").selectOption("deep");
  await page.waitForFunction(() => window.XiangqiLocal.state.practiceLevel === "deep");
  await page.waitForFunction(() => window.XiangqiLocal.state.recommendation.status === "ready");
  const practice = await page.evaluate(() => ({
    level: window.XiangqiLocal.state.practiceLevel,
    stored: localStorage.getItem("xiangqi.practice.level"),
    depth: window.XiangqiLocal.state.recommendation.depth
  }));
  check(`${name}: deep practice mode is applied`,
    practice.level === "deep"
      && practice.stored === "deep"
      && practice.depth >= 3,
    JSON.stringify(practice));
  check(`${name}: practice menu closes after selection`,
    await page.evaluate(() => document.querySelector(".topbar-more").open === false));

  const targetSelection = await page.evaluate(() => {
    const state = window.XiangqiLocal.state;
    const moves = window.XiangqiLocal.generateLegalMoves(
      state.game.board,
      state.game.sideToMove
    );
    const counts = new Map();
    for (const move of moves) {
      counts.set(move.from, (counts.get(move.from) || 0) + 1);
    }
    const square = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    document.querySelector(`.piece[data-square="${square}"]`).click();
    return { square, count: counts.get(square) };
  });
  await page.waitForFunction(
    (square) => window.XiangqiLocal.state.selected === square,
    targetSelection.square
  );
  await page.waitForTimeout(250);
  const targetDebug = await page.evaluate(() => ({
    selected: window.XiangqiLocal.state.selected,
    legalMoves: window.XiangqiLocal.state.legalMoves.map((move) => ({
      from: move.from,
      to: move.to,
      code: move.from * 90 + move.to
    })),
    recommendationStatus: window.XiangqiLocal.state.recommendation.status,
    recommendationSide: window.XiangqiLocal.state.recommendation.side,
    recommendationKeys: Object.keys(window.XiangqiLocal.state.recommendation.moveByCode || {}),
    rankedHints: document.querySelectorAll(".hint[data-recommend-rank]").length,
    allHints: document.querySelectorAll(".hint").length
  }));
  const targetSummary = `selected=${targetDebug.selected} legal=${targetDebug.legalMoves.length} hints=${targetDebug.rankedHints}`;
  check(`${name}: selected piece exposes legal targets`,
    targetDebug.legalMoves.length === targetSelection.count
      && targetDebug.legalMoves.length >= 2,
    targetSummary);
  check(`${name}: recommendation contains those target moves`,
    targetDebug.legalMoves.every((move) => (
      targetDebug.recommendationKeys.includes(String(move.code))
    )), targetSummary);
  check(`${name}: selected targets are rendered`,
    targetDebug.rankedHints >= 2, targetSummary);
  const selected = await page.evaluate(() => {
    const hints = [...document.querySelectorAll(".hint[data-recommend-rank]")];
    const ranks = hints.map((node) => Number(node.dataset.recommendRank)).sort((a, b) => a - b);
    return {
      count: hints.length,
      colors: hints.map((node) => getComputedStyle(node).borderTopColor),
      ranks,
      selected: window.XiangqiLocal.state.selected,
      overflow: document.documentElement.scrollWidth - window.innerWidth
    };
  });
  check(`${name}: selected piece shows its legal targets`,
    selected.count === targetSelection.count, String(selected.count));
  check(`${name}: selected target ranks are local and contiguous`,
    selected.ranks.every((rank, index) => rank === index + 1),
    selected.ranks.join(","));
  check(`${name}: target ranks use more than one colour`,
    new Set(selected.colors).size >= 2, selected.colors.join(" | "));
  check(`${name}: no horizontal page overflow`, selected.overflow <= 1, String(selected.overflow));
  check(`${name}: selected piece remains active`,
    selected.selected === targetSelection.square, String(selected.selected));

  const screenshot = path.join(artifactDir, `yijian-recommendations-${name}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(`  screenshot: ${screenshot}`);

  await page.locator("#flipBoard").click();
  const flipped = await page.evaluate(() => ({
    flipped: window.XiangqiLocal.state.flipped,
    marked: document.querySelectorAll(".piece[data-recommend-tier]").length
  }));
  check(`${name}: recommendation survives board flip`,
    flipped.flipped === true && flipped.marked >= 10, JSON.stringify(flipped));

  await page.locator("#recommendationToggle").click();
  const disabled = await page.evaluate(() => ({
    enabled: window.XiangqiLocal.state.recommendationEnabled,
    stored: localStorage.getItem("xiangqi.practice.enabled"),
    marked: document.querySelectorAll(".piece[data-recommend-tier]").length
  }));
  check(`${name}: toggle clears recommendation rings`, disabled.marked === 0, String(disabled.marked));
  check(`${name}: toggle persists off`, disabled.enabled === false && disabled.stored === "0");

  await page.reload({ waitUntil: "networkidle" });
  const reloaded = await page.evaluate(() => ({
    enabled: window.XiangqiLocal.state.recommendationEnabled,
    marked: document.querySelectorAll(".piece[data-recommend-tier]").length,
    legendHidden: document.getElementById("recommendationLegend").hidden
  }));
  check(`${name}: disabled preference survives reload`,
    reloaded.enabled === false
      && reloaded.marked === 0
      && reloaded.legendHidden === true,
    JSON.stringify(reloaded));

  await context.close();
}

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--disable-gpu"]
});
try {
  await exerciseViewport(browser, "desktop", { width: 1280, height: 900 });
  await exerciseViewport(browser, "laptop", { width: 1366, height: 768 });
  await exerciseViewport(browser, "mobile", { width: 390, height: 844 });
} finally {
  await browser.close();
}

check("browser reports no page or console errors",
  browserErrors.length === 0, browserErrors.join(" | "));

console.log("");
if (problems.length === 0) {
  console.log("RECOMMENDATION BROWSER CHECKS PASSED");
  process.exitCode = 0;
} else {
  console.log(`PROBLEMS: ${problems.join("; ")}`);
  process.exitCode = 1;
}
