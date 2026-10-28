import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const site = process.env.YIJIAN_URL || "http://127.0.0.1:4394/index.html";
const api = process.env.GAME_LIBRARY_API || "http://127.0.0.1:8790/api/games";
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const artifactDir = process.env.ARTIFACT_DIR || os.tmpdir();
const pageUrl = `${site}?gameApi=${encodeURIComponent(api)}`;

const problems = [];
const errors = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--disable-gpu"]
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
      errors.push(message.text());
    }
  });
  await page.goto(pageUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.XiangqiLocal);
  check("short game code auto-completion",
    await page.evaluate(() => XiangqiLocal.normalizeOnlineGameCode("wk223") === "WK00223"));

  await page.locator('[data-tab="records"]').click();
  await page.waitForFunction(() => (
    document.getElementById("onlineLibraryMeta").textContent.includes("40,249")
  ));
  check("online library manifest loads", true);

  await page.locator("#onlineGameQuery").fill("wk223");
  await page.locator("#onlineGameSearchForm").evaluate((form) => form.requestSubmit());
  await page.waitForFunction(() => (
    document.querySelector('.online-game-card [data-online-game-code="WK00223"]')
  ));
  const card = await page.evaluate(() => {
    const node = document.querySelector('.online-game-card [data-online-game-code="WK00223"]')
      .closest(".online-game-card");
    return {
      text: node.textContent,
      code: node.querySelector(".online-game-code").textContent,
      buttons: [...node.querySelectorAll("[data-online-game-action]")]
        .map((button) => button.dataset.onlineGameAction)
    };
  });
  check("code search returns WK00223", card.code === "WK00223", card.text);
  check("search input is normalized to the full game code",
    await page.locator("#onlineGameQuery").inputValue() === "WK00223");
  check("online card offers replay and continuation",
    card.buttons.includes("replay") && card.buttons.includes("continue"));
  const onlineFonts = await page.evaluate(() => ({
    query: getComputedStyle(document.getElementById("onlineGameQuery")).fontSize,
    filters: getComputedStyle(document.querySelector(".online-game-filters summary")).fontSize,
    code: getComputedStyle(document.querySelector(".online-game-code")).fontSize,
    players: getComputedStyle(document.querySelector(".online-game-players strong")).fontSize,
    meta: getComputedStyle(document.querySelector(".online-game-meta")).fontSize
  }));
  check("online library uses compact type scale",
    onlineFonts.query === "11px"
      && onlineFonts.filters === "10px"
      && onlineFonts.code === "11px"
      && onlineFonts.players === "11px"
      && onlineFonts.meta === "9px",
    JSON.stringify(onlineFonts));

  await page.locator('[data-online-game-code="WK00223"][data-online-game-action="replay"]').click();
  await page.waitForFunction(() => (
    XiangqiLocal.state.replay.active
    && XiangqiLocal.state.replay.record
    && XiangqiLocal.state.replay.record.id === "WK00223"
  ));
  const replay = await page.evaluate(() => ({
    active: XiangqiLocal.state.replay.active,
    moves: XiangqiLocal.state.game.history.length,
    ply: XiangqiLocal.state.reviewPly,
    title: document.getElementById("replayTitle").textContent
  }));
  check("WK00223 opens in review mode",
    replay.active === true && replay.moves === 58 && replay.ply === 0,
    JSON.stringify(replay));
  await page.screenshot({
    path: path.join(artifactDir, "yijian-online-game-replay.png"),
    fullPage: true
  });

  await page.locator("#replayExit").click();
  await page.locator('[data-tab="records"]').click();
  await page.locator("#onlineGameQuery").fill("wk223");
  await page.locator("#onlineGameSearchForm").evaluate((form) => form.requestSubmit());
  await page.waitForFunction(() => (
    document.querySelector('[data-online-game-code="WK00223"][data-online-game-action="continue"]')
  ));
  await page.locator('[data-online-game-code="WK00223"][data-online-game-action="continue"]').click();
  await page.waitForFunction(() => (
    XiangqiLocal.state.live
    && XiangqiLocal.state.sourceGameCode === "WK00223"
    && XiangqiLocal.state.game.history.length === 58
  ));
  const continued = await page.evaluate(() => ({
    live: XiangqiLocal.state.live,
    source: XiangqiLocal.state.sourceGameCode,
    moves: XiangqiLocal.state.game.history.length,
    red: XiangqiLocal.state.control.r,
    black: XiangqiLocal.state.control.b,
    status: document.getElementById("statusText").textContent
  }));
  check("WK00223 continues from its final position",
    continued.live === true
      && continued.moves === 58
      && continued.red === "human"
      && continued.black === "human",
    JSON.stringify(continued));
  check("continuation records the source game code",
    continued.source === "WK00223", JSON.stringify(continued));

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on("pageerror", (error) => errors.push(`mobile: ${error.message}`));
  await mobile.goto(pageUrl, { waitUntil: "networkidle" });
  await mobile.waitForFunction(() => window.XiangqiLocal);
  await mobile.locator('[data-tab="records"]').click();
  await mobile.locator("#onlineGameQuery").fill("wk1");
  await mobile.locator("#onlineGameSearchForm").evaluate((form) => form.requestSubmit());
  await mobile.waitForFunction(() => document.querySelector(".online-game-card"));
  const mobileState = await mobile.evaluate(() => ({
    code: document.querySelector(".online-game-code").textContent,
    input: document.getElementById("onlineGameQuery").value,
    overflow: document.documentElement.scrollWidth - window.innerWidth
  }));
  check("mobile online game search works",
    mobileState.code === "WK00001"
      && mobileState.input === "WK00001"
      && mobileState.overflow <= 1,
    JSON.stringify(mobileState));
  await mobile.screenshot({
    path: path.join(artifactDir, "yijian-online-library-mobile.png"),
    fullPage: true
  });
  await mobile.close();

  const direct = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  direct.on("pageerror", (error) => errors.push(`direct: ${error.message}`));
  await direct.goto(`${pageUrl}&game=wk223`, { waitUntil: "networkidle" });
  await direct.waitForFunction(() => (
    XiangqiLocal.state.replay.active
    && XiangqiLocal.state.replay.record
    && XiangqiLocal.state.replay.record.id === "WK00223"
  ));
  check("game link opens WK00223 replay directly", true);
  await direct.close();
  check("browser reports no runtime errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
}

console.log("");
if (problems.length === 0) {
  console.log("ONLINE GAME BROWSER CHECKS PASSED");
  process.exitCode = 0;
} else {
  console.log(`PROBLEMS: ${problems.join("; ")}`);
  process.exitCode = 1;
}
