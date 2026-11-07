import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checks = [
  ["--check", "www/app.js"],
  ["--check", "www/net.js"],
  ["--check", "www/pikafish.js"],
  ["--check", "www/records.js"],
  ["--check", "server/server.mjs"],
  ["--check", "server/game-library.mjs"],
  ["verify-mate.mjs"],
  ["verify-quality.mjs"],
  ["verify-records.mjs"],
  ["verify-styles.mjs"],
  ["verify-motion.mjs"],
  ["verify-compat.mjs"],
  ["verify-recommendations.mjs"],
  ["server/verify-server.mjs"]
];

for (const [script, ...args] of checks) {
  console.log(`\n==> node ${[script, ...args].join(" ")}`);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: workDir,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const gameManifest = path.join(
  workDir,
  "server",
  "data",
  "game-library",
  "manifest.json"
);
if (existsSync(gameManifest)) {
  console.log("\n==> node server/verify-games.mjs");
  const result = spawnSync(process.execPath, ["server/verify-games.mjs"], {
    cwd: workDir,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
} else {
  console.log("\nSKIP game-library API test: generated data is not present");
}

console.log("\nALL LOCAL CHECKS PASSED");
