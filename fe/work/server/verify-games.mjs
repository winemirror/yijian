import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.GAME_LIBRARY_DIR = process.env.GAME_LIBRARY_DIR
  || path.join(here, "data", "game-library");

const { listen, close } = await import("./server.mjs");
const problems = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

const port = await listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${port}`;
try {
  const healthResponse = await fetch(`${base}/api/games/health`);
  const health = await healthResponse.json();
  check("game API health", healthResponse.ok && health.ok === true, JSON.stringify(health));
  check("game API reports full catalog", health.games === 40249, JSON.stringify(health));
  check("game API reports current data version",
    health.dataVersion === "wukong-uci-2026-10-29", JSON.stringify(health));
  check("game API enables CORS",
    healthResponse.headers.get("access-control-allow-origin") === "*");

  const directResponse = await fetch(`${base}/api/games/search?q=wk223`);
  const direct = await directResponse.json();
  check("short code normalizes to WK00223",
    direct.total === 1 && direct.games[0].code === "WK00223",
    JSON.stringify(direct));

  const playerResponse = await fetch(`${base}/api/games/search?q=Lv%20Qin&limit=2`);
  const player = await playerResponse.json();
  check("player search returns ranked games",
    playerResponse.ok && player.total > 100 && player.games.length === 2,
    JSON.stringify({ total: player.total, games: player.games }));

  const chinesePlayerResponse = await fetch(
    `${base}/api/games/search?q=${encodeURIComponent("吕钦")}&limit=1`
  );
  const chinesePlayer = await chinesePlayerResponse.json();
  check("Chinese player aliases search romanized records",
    chinesePlayerResponse.ok
      && chinesePlayer.total > 100
      && /Lv Qin/i.test(`${chinesePlayer.games[0].red} ${chinesePlayer.games[0].black}`),
    JSON.stringify(chinesePlayer));

  const eventResponse = await fetch(
    `${base}/api/games/search?event=World%20Xiangqi%20Championships%202015&limit=2`
  );
  const event = await eventResponse.json();
  check("event filter works",
    eventResponse.ok
      && event.total > 0
      && event.games.every((game) => game.event.includes("World Xiangqi Championships 2015")),
    JSON.stringify(event));

  const gameResponse = await fetch(`${base}/api/games/WK00223`);
  const game = await gameResponse.json();
  check("single game lookup returns complete record",
    gameResponse.ok
      && game.game.code === "WK00223"
      && game.game.moveCount === 58
      && game.game.moves.split(/\s+/).length === 58,
    JSON.stringify(game.game && {
      code: game.game.code,
      moves: game.game.moveCount
    }));

  const missing = await fetch(`${base}/api/games/WK99999`);
  check("missing game returns 404", missing.status === 404);
  const invalid = await fetch(`${base}/api/games/not-a-code`);
  check("invalid game code returns 400", invalid.status === 400);
} finally {
  await close();
}

console.log("");
if (problems.length === 0) {
  console.log("GAME LIBRARY API CHECKS PASSED");
  process.exitCode = 0;
} else {
  console.log(`PROBLEMS: ${problems.join("; ")}`);
  process.exitCode = 1;
}
