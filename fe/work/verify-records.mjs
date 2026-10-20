// Verifies the versioned local game-record format, import compatibility and
// deterministic replay reconstruction.
import fs from "node:fs";
import path from "node:path";
import { loadEngine } from "./harness.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const engine = loadEngine(path.join(here, "www", "app.js"));
const Records = engine.Records;
const html = fs.readFileSync(path.join(here, "www", "index.html"), "utf8");

const problems = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

console.log("== local record UI ==");
{
  check("records tab exists", html.includes('data-tab="records"'));
  check("records panel exists", html.includes('id="panel-records"'));
  check("IndexedDB library list exists", html.includes('id="recordList"'));
  check("file and text import controls exist",
    html.includes('id="recordFile"') && html.includes('id="recordImportText"'));
  check("replay playback controls exist",
    html.includes('id="replayPlay"')
    && html.includes('id="replaySpeed"')
    && html.includes('id="replayExit"'));
}

console.log("== v2 export ==");
let exported;
{
  engine.reset();
  engine.state.startedAt = Date.now() - 65000;
  engine.state.turnStartedAt = Date.now() - 4200;
  const first = engine.state.game.play(60, 51);
  engine.markMoveTiming(first);
  engine.state.turnStartedAt = Date.now() - 2300;
  const second = engine.state.game.play(1, 20);
  engine.markMoveTiming(second);
  exported = engine.buildGameExport();
  check("format is yijian.game", exported.format === "yijian.game", exported.format);
  check("version is 2", exported.version === 2, String(exported.version));
  check("initial FEN is explicit", /^rnbakabnr\/9\//.test(exported.rules.initialFen));
  check("players carry kind and strength",
    exported.players.red.kind === "human"
    && exported.players.black.kind === "ai"
    && exported.players.black.level === "medium",
    JSON.stringify(exported.players));
  check("moves keep coordinates, ICCS and timing",
    exported.moves.length === 2
    && exported.moves[0].iccs === "g3g4"
    && exported.moves[0].ms >= 4000
    && exported.moves[1].iccs === "b9c7",
    JSON.stringify(exported.moves));
  check("duration and checksum are present",
    exported.clocks.durationMs > 0
    && /^fnv1a:[0-9a-f]{8}$/.test(exported.checksum),
    exported.checksum);
}

console.log("== JSON import and replay reconstruction ==");
{
  const text = Records.exportText(exported);
  const parsed = Records.read(text);
  const replay = engine.gameFromRecord(parsed);
  check("export text parses back to v2", parsed.version === 2);
  check("replay rebuilds the full move history", replay.history.length === 2);
  check("replay keeps the first move", replay.history[0].notation === exported.moves[0].notation);
  check("replay restores move timing", replay.history[1].moveTimeMs >= 2000);
  check("summary exposes result and move count",
    Records.summary(parsed).moveCount === 2
    && Records.summary(parsed).resultText.length > 0);
}

console.log("== v1 and ICCS compatibility ==");
{
  const v1 = Records.normalize({
    format: "yijian.game",
    version: 1,
    id: "legacy-record",
    createdAt: "2026-10-01T10:00:00.000Z",
    red: { name: "红方甲" },
    black: { name: "黑方乙" },
    result: { type: "draw", winner: null, reason: "和棋" },
    moves: [
      { from: 60, to: 51, side: "r", notation: "兵三进一" },
      { from: 1, to: 20, side: "b", notation: "马2进3" }
    ]
  });
  check("v1 upgrades to v2", v1.version === 2);
  check("v1 player objects migrate", v1.players.red.name === "红方甲");
  check("v1 replay remains valid", engine.gameFromRecord(v1).history.length === 2);

  const iccs = Records.read("g3g4 b9c7");
  check("ICCS parses into a replay record", iccs.moves.length === 2);
  check("ICCS generates canonical coordinates",
    iccs.moves[0].from === 60
    && iccs.moves[0].to === 51
    && iccs.moves[1].from === 1
    && iccs.moves[1].to === 20,
    JSON.stringify(iccs.moves));
  check("ICCS replay reconstructs the game", engine.gameFromRecord(iccs).history.length === 2);
}

console.log("== invalid import protection ==");
{
  let message = "";
  try {
    engine.gameFromRecord(Records.normalize({
      format: "yijian.game",
      version: 2,
      id: "bad-record",
      createdAt: new Date().toISOString(),
      rules: { initialFen: Records.INITIAL_FEN },
      moves: [{ from: 0, to: 1, side: "r" }]
    }));
  } catch (error) {
    message = String(error && error.message || error);
  }
  check("illegal imported move is rejected", /不合法/.test(message), message);

  let formatMessage = "";
  try {
    Records.read('{"format":"not-yijian","moves":[]}');
  } catch (error) {
    formatMessage = String(error && error.message || error);
  }
  check("unknown format is rejected", /不认识的棋谱格式/.test(formatMessage), formatMessage);
}

console.log("");
if (problems.length === 0) {
  console.log("RECORD CHECKS PASSED");
  process.exitCode = 0;
} else {
  console.log(`PROBLEMS: ${problems.join("; ")}`);
  process.exitCode = 1;
}
