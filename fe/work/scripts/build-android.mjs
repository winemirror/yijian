import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = (process.argv[2] || "debug").replace(/^--/, "");
const offline = process.argv.includes("--offline");

if (!new Set(["debug", "release"]).has(mode)) {
  console.error("Usage: node scripts/build-android.mjs [debug|release] [--offline]");
  process.exit(2);
}

const requiredReleaseKeys = [
  "YIJIAN_KEYSTORE_PATH",
  "YIJIAN_KEYSTORE_PASSWORD",
  "YIJIAN_KEY_ALIAS",
  "YIJIAN_KEY_PASSWORD"
];

if (mode === "release") {
  const missing = requiredReleaseKeys.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`Release signing is not configured. Missing: ${missing.join(", ")}`);
    process.exit(2);
  }
}

const capacitorCli = path.join(
  workDir,
  "node_modules",
  "@capacitor",
  "cli",
  "bin",
  "capacitor"
);
if (!existsSync(capacitorCli)) {
  console.error("Capacitor CLI is missing. Run `npm ci` in fe/work first.");
  process.exit(2);
}

function run(command, args, cwd) {
  const isWindowsBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
  const executable = isWindowsBatch
    ? (process.env.ComSpec || "cmd.exe")
    : command;
  const executableArgs = isWindowsBatch
    ? [
        "/d",
        "/s",
        "/c",
        "call",
        command,
        ...args
      ]
    : args;
  const result = spawnSync(executable, executableArgs, {
    cwd,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run(process.execPath, [capacitorCli, "sync", "android"], workDir);

const androidDir = path.join(workDir, "android");
const wrapper = process.env.YIJIAN_GRADLE
  || (process.platform === "win32" ? "gradlew.bat" : "./gradlew");
const task = mode === "release" ? "assembleRelease" : "assembleDebug";
const args = [task];
if (offline) args.push("--offline");
run(wrapper, args, androidDir);

const artifact = path.join(
  androidDir,
  "app",
  "build",
  "outputs",
  "apk",
  mode,
  mode === "release" ? "app-release.apk" : "app-debug.apk"
);
if (!existsSync(artifact)) {
  console.error(`Build finished but artifact was not found: ${artifact}`);
  process.exit(1);
}

console.log(artifact);
if (mode === "debug") {
  console.log("Debug APK only: never publish it.");
} else {
  console.log("Run scripts/verify-release.mjs --apk <artifact> before distribution.");
}
