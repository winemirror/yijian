import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, name), "utf8");
const html = read("www/index.html");
const app = read("www/app.js");
const client = read("www/pikafish.js");
const service = read("pikafish-engine/engine-service.mjs");
const launcher = read("xiangqi-exe/Launcher.cs");
const build = read("xiangqi-exe/build.ps1");

const checks = [];
function check(label, ok) {
  checks.push({ label, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
}

console.log("== pikafish 3.16b ==");
check("page is marked 3.16b", /3\.16\.0b\d+-2026\d{4}/.test(html));
check("pikafish client is loaded before app", html.indexOf("pikafish.js") < html.lastIndexOf("app.js"));
check("both sides expose three cloud levels", (html.match(/pikafish:(fast|standard|deep)/g) || []).length === 6);
check("setup parser accepts pikafish levels", app.includes('value.startsWith("pikafish:")'));
check("local AI remains selectable", app.includes("AI_LEVELS[level]"));
check("mixed games enable cloud analysis", app.includes("gameUsesPikafish()"));
check("cloud analysis maps MultiPV moves", app.includes("findUciMove(board, side, raw.pv && raw.pv[0])"));
check("cloud move validation rejects illegal replies", app.includes("皮卡鱼返回非法着法"));
check("chosen move can use post-move evaluation", app.includes("derivedFromAfter"));
check("review mode cancels stale AI work", app.includes("Pikafish.cancelActive()"));
check("returning live restarts the AI driver", app.includes("function resumeLiveGame()") && app.includes("restartAIDriverFromState()"));
check("continuous playback keeps infinite moves", app.includes("if (state.playing && aiTurn) runAIDriver()"));
check("client can cancel the active cloud request", client.includes("function cancelActive()"));
check("relay service handles cancellation", service.includes('data.t === "pf.cancel"') && service.includes("function cancelRequest"));
check("relay room code is valid", client.includes('"PKAFST"') && service.includes('"PKAFST"'));
check("relay service keeps the server compute-free", service.includes("wss://c.syjnb.top/ws"));
check("desktop launcher embeds pikafish client", launcher.includes("YiJian.pikafish.js"));
check("desktop build embeds pikafish client", build.includes("YiJian.pikafish.js"));

const failed = checks.filter((item) => !item.ok);
if (failed.length) {
  console.error(`PROBLEMS: ${failed.map((item) => item.label).join("; ")}`);
  process.exit(1);
}
console.log("PIKAFISH UI CHECKS PASSED");
