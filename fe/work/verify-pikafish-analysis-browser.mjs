import { createRequire } from "node:module";
import os from "node:os";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const url = process.env.YIJIAN_URL || "http://127.0.0.1:4391/index.html";
const live = process.env.PIKAFISH_LIVE === "1";
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
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
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.XiangqiLocal);
  await page.evaluate(({ liveTest }) => {
    XiangqiLocal.onSetupChange("b", "human");
    window.__pikafishAnalysisCalls = 0;
    const originalAnalyze = XiangqiPikafish.analyze;
    XiangqiPikafish.analyze = async (...args) => {
      window.__pikafishAnalysisCalls += 1;
      if (window.__pikafishLiveTest) return originalAnalyze(...args);
      throw new Error("offline-test");
    };
    window.__pikafishLiveTest = liveTest;
    const toggle = document.getElementById("pikafishAnalysisToggle");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
  }, { liveTest: live });
  await page.waitForFunction(() => XiangqiLocal.state.pikafishAnalysisEnabled === true);
  await page.waitForFunction((liveTest) => {
    const analysis = XiangqiLocal.state.displayAnalysis;
    if (liveTest) return analysis && analysis.engine === "pikafish";
    return analysis
      && !analysis.engine
      && document.documentElement.dataset.pikafishAnalysisFallback === "offline-test";
  }, live, { timeout: live ? 30000 : 20000 });
  const immediate = await page.evaluate(() => ({
    engine: XiangqiLocal.state.displayAnalysis.engine || "local",
    hint: document.getElementById("chartHint").textContent
  }));
  check("enabling the option analyzes the current position immediately",
    (live ? immediate.engine === "pikafish" : immediate.engine === "local")
      && immediate.hint.includes(live ? "皮卡鱼" : "本机")
      && immediate.hint.includes("深度"),
    JSON.stringify(immediate));
  await page.evaluate(() => XiangqiLocal.selectPiece(60));
  await page.waitForFunction(() => (
    XiangqiLocal.state.selected === 60
    && document.querySelectorAll("#moveHints .hint").length > 0
  ));
  await page.locator("#moveHints .hint").first().click({ force: true });
  await page.waitForFunction(() => (
    XiangqiLocal.state.game.history.length === 1
    && XiangqiLocal.state.game.history[0].analysis
    && XiangqiLocal.state.game.history[0].afterAnalysis
  ), null, { timeout: live ? 30000 : 20000 });
  const state = await page.evaluate(() => ({
    calls: window.__pikafishAnalysisCalls,
    engine: XiangqiLocal.state.game.history[0].analysis.engine || "local",
    fallback: document.documentElement.dataset.pikafishAnalysisFallback,
    stored: localStorage.getItem("xiangqi.pikafish.analysis"),
    moves: XiangqiLocal.state.game.history.length
  }));
  check("Pikafish option requests cloud analysis first",
    state.calls >= 1, JSON.stringify(state));
  if (live) {
    check("live Pikafish analysis returns a complete cloud result",
      state.engine === "pikafish"
        && !state.fallback
        && state.moves === 1,
      JSON.stringify(state));
  } else {
    check("cloud failure returns a complete local analysis",
      state.engine === "local"
        && state.fallback === "offline-test"
        && state.moves === 1,
      JSON.stringify(state));
  }
  check("Pikafish analysis preference remains persisted",
    state.stored === "1", JSON.stringify(state));
  if (live) {
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => window.XiangqiLocal);
    await page.waitForFunction(() => (
      XiangqiLocal.state.pikafishAnalysisEnabled
      && XiangqiLocal.state.displayAnalysis
      && XiangqiLocal.state.displayAnalysis.engine === "pikafish"
    ), null, { timeout: 30000 });
    const reload = await page.evaluate(() => ({
      checked: document.getElementById("pikafishAnalysisToggle").checked,
      engine: XiangqiLocal.state.displayAnalysis.engine,
      hint: document.getElementById("chartHint").textContent
    }));
    check("saved preference analyzes automatically after reload",
      reload.checked === true
        && reload.engine === "pikafish"
        && reload.hint.includes("皮卡鱼"),
      JSON.stringify(reload));
  }
  check("browser reports no runtime errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
}

console.log("");
if (problems.length === 0) {
  console.log("PIKAFISH ANALYSIS BROWSER CHECKS PASSED");
  process.exitCode = 0;
} else {
  console.log(`PROBLEMS: ${problems.join("; ")}`);
  process.exitCode = 1;
}
