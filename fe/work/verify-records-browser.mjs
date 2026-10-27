// End-to-end check for the local record library using Chrome's CDP endpoint.
// This intentionally uses only Node built-ins so it works in the repo without
// adding a Playwright dependency.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = 9327;
const profile = path.join(os.tmpdir(), `yijian-record-browser-${process.pid}`);
const appUrl = process.env.APP_URL || "http://127.0.0.1:4291/index.html";
const problems = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) problems.push(label);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await wait(120);
  }
  throw new Error("timed out");
}

const child = spawn(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank"
], { stdio: "ignore", windowsHide: true });

let socket;
try {
  const version = await waitFor(async () => {
    try {
      return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      return null;
    }
  });
  const target = await (await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`,
    { method: "PUT" }
  )).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      const exception = details.exception || {};
      exceptions.push(exception.description || exception.value || details.text);
    }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text);
    }
    return response.result.value;
  };

  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  await evaluate("location.href");
  await waitFor(() => evaluate("document.readyState === 'complete'"));
  await waitFor(() => evaluate("typeof XiangqiLocal === 'object' && typeof XiangqiRecords === 'object'"));

  console.log("== runtime ==");
  check("record protocol module is loaded", await evaluate("typeof XiangqiRecords === 'object'"));
  check("records tab is present", await evaluate("Boolean(document.querySelector('[data-tab=records]'))"));

  console.log("== quality commentary + brilliant banner ==");
  check("traditional move term is displayed",
    await evaluate("XiangqiLocal.qualityDisplayLabel({ label: '失误' }) === '无理手'"));
  await evaluate("XiangqiLocal.showBrilliantBanner('r')");
  check("red brilliant banner is visible",
    await evaluate("document.querySelector('#brilliantBanner').hidden === false"));
  check("brilliant banner names the side",
    await evaluate("document.querySelector('#brilliantBannerText').textContent === '红方妙手'"));
  const brilliantShot = await cdp("Page.captureScreenshot", { format: "png" });
  const brilliantPath = path.join("outputs", "brilliant-banner-check.png");
  fs.writeFileSync(brilliantPath, Buffer.from(brilliantShot.data, "base64"));
  console.log(`  screenshot ${brilliantPath}`);
  await evaluate("XiangqiLocal.hideBrilliantBanner()");

  console.log("== save to IndexedDB ==");
  await evaluate("XiangqiLocal.reset()");
  await evaluate(`(() => {
    const g = XiangqiLocal.game();
    const a = g.play(60, 51);
    XiangqiLocal.markMoveTiming(a);
    const b = g.play(1, 20);
    XiangqiLocal.markMoveTiming(b);
    XiangqiLocal.state.startedAt = Date.now() - 30000;
    XiangqiLocal.saveCurrentRecord();
  })()`);
  await waitFor(() => evaluate("document.querySelector('#recordCount').textContent !== '0 盘'"));
  check("manual save adds a library summary",
    await evaluate("document.querySelectorAll('#recordList .record-card').length === 1"));
  check("library summary shows two plies",
    await evaluate("document.querySelector('#recordList .record-card-meta').textContent.includes('2 手')"));

  console.log("== import and replay ==");
  await evaluate(`(() => {
    const text = XiangqiRecords.exportText(XiangqiLocal.buildGameExport());
    const input = document.querySelector('#recordImportText');
    input.value = text;
    document.querySelector('#recordImportTextButton').click();
  })()`);
  await waitFor(() => evaluate("XiangqiLocal.state.replay.active === true"));
  check("import opens read-only replay", await evaluate("XiangqiLocal.state.live === false"));
  check("replay starts at the initial position", await evaluate("XiangqiLocal.state.reviewPly === 0"));
  check("review panel is active",
    await evaluate("document.querySelector('#panel-review').classList.contains('active')"));
  check("replay notice is visible", await evaluate("document.querySelector('#replayNotice').hidden === false"));

  await evaluate("document.querySelector('#replayPlay').click()");
  await wait(1200);
  check("replay playback advances one ply",
    await evaluate("XiangqiLocal.state.reviewPly >= 1"));
  await evaluate("document.querySelector('#liveMode').click()");
  await wait(100);
  check("leaving replay restores the live game",
    await evaluate("XiangqiLocal.state.replay.active === false && XiangqiLocal.game().history.length === 2"));

  console.log("== finished-game auto archive ==");
  await evaluate(`(() => {
    XiangqiLocal.state.game.result = { type: "win", winner: "r", reason: "测试绝杀" };
    XiangqiLocal.state.endedAt = Date.now();
    XiangqiLocal.state.finishedRecordQueued = false;
    XiangqiLocal.toggleBoardFlip();
  })()`);
  await waitFor(() => evaluate("document.querySelector('#recordList .record-card-meta').textContent.includes('红方胜')"));
  check("finished game updates the saved summary automatically",
    await evaluate("document.querySelector('#recordList .record-card-meta').textContent.includes('测试绝杀')"));
  await evaluate("XiangqiLocal.toggleBoardFlip()");

  await evaluate("document.querySelector('[data-tab=records]').click()");
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join("outputs", "record-library-check.png");
  fs.writeFileSync(shotPath, Buffer.from(screenshot.data, "base64"));
  console.log(`  screenshot ${shotPath}`);
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  });
  await wait(150);
  check("mobile records layout has no horizontal overflow",
    await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"),
    await evaluate("document.documentElement.scrollWidth + '/' + innerWidth"));
  await evaluate("document.querySelector('#panel-records').scrollIntoView({block:'start'})");
  const mobileShot = await cdp("Page.captureScreenshot", { format: "png" });
  const mobilePath = path.join("outputs", "record-library-mobile.png");
  fs.writeFileSync(mobilePath, Buffer.from(mobileShot.data, "base64"));
  console.log(`  screenshot ${mobilePath}`);
  check("no runtime exception during record flow", exceptions.length === 0, exceptions.join("; "));
} finally {
  try { if (socket) socket.close(); } catch {}
  try { child.kill(); } catch {}
  await wait(300);
  const resolved = path.resolve(profile);
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (resolved.startsWith(tempRoot) && fs.existsSync(resolved)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

if (problems.length) {
  console.log(`PROBLEMS: ${problems.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("BROWSER RECORD CHECKS PASSED");
}
