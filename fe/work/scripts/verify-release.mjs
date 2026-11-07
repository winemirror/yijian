import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(workDir, "..", "..");
const legacyDebugCertificate =
  "33C29CFDC5EB48421C8A27E235B304050EB3575A0A4522157B1B90314334A581";
const failures = [];

function fail(message) {
  failures.push(message);
}

function runTool(command, args) {
  const isWindows = process.platform === "win32";
  const isBatch = isWindows && /\.(bat|cmd)$/i.test(command);
  const runViaCmd = () => execFileSync(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/s", "/c", "call", command, ...args],
    { encoding: "utf8" }
  );
  if (isBatch) return runViaCmd();
  try {
    return execFileSync(command, args, { encoding: "utf8" });
  } catch (error) {
    if (isWindows && ["EACCES", "EPERM"].includes(error.code)) {
      return runViaCmd();
    }
    throw error;
  }
}

function read(relativePath) {
  return readFileSync(path.join(workDir, relativePath), "utf8");
}

const appSource = read("www/app.js");
const androidGradle = read("android/app/build.gradle");
const packageJson = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));
const capacitorConfig = JSON.parse(read("capacitor.config.json"));

const assetMatch = appSource.match(/APP_ASSET_VERSION\s*=\s*"([^"]+)"/);
const versionNameMatch = androidGradle.match(/versionName\s+"([^"]+)"/);
const versionCodeMatch = androidGradle.match(/versionCode\s+(\d+)/);
const assetVersion = assetMatch && assetMatch[1];
const versionName = versionNameMatch && versionNameMatch[1];
const versionCode = versionCodeMatch && Number(versionCodeMatch[1]);
const expectedPackage = process.env.YIJIAN_APPLICATION_ID || capacitorConfig.appId;

if (!assetVersion || !/^\d+\.\d+\.\d+-\d{8}$/.test(assetVersion)) {
  fail("www/app.js does not contain a dated APP_ASSET_VERSION");
}
if (!versionName) fail("Android versionName was not found");
if (!Number.isInteger(versionCode) || versionCode <= 0) {
  fail("Android versionCode is not a positive integer");
}
if (assetVersion && versionName && !assetVersion.startsWith(`${versionName}-`)) {
  fail(`Web asset version ${assetVersion} does not match Android ${versionName}`);
}
if (packageJson.version !== versionName) {
  fail(`package.json ${packageJson.version} does not match Android ${versionName}`);
}

const rootLock = packageLock.packages && packageLock.packages[""];
if (packageLock.lockfileVersion !== 3 || !rootLock) {
  fail("package-lock.json must be npm lockfile v3 with a root package");
} else {
  for (const group of ["dependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(packageJson[group] || {})) {
      if (!rootLock[group] || rootLock[group][name] !== version) {
        fail(`package-lock root ${group} mismatch: ${name}`);
      }
    }
  }
}

for (const relativePath of [
  "android/app/yijian-debug.keystore",
  "../../w-2/work/xiangqi-capacitor/android/app/yijian-debug.keystore"
]) {
  if (existsSync(path.resolve(workDir, relativePath))) {
    fail(`Legacy debug keystore still exists: ${relativePath}`);
  }
}

const ignoreRules = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
for (const pattern of ["*.keystore", "*.jks", "*.p12", "*.pfx"]) {
  if (!ignoreRules.split(/\r?\n/).includes(pattern)) {
    fail(`.gitignore must exclude signing material: ${pattern}`);
  }
}

const artifactIndex = process.argv.indexOf("--apk");
if (artifactIndex !== -1) {
  const artifact = process.argv[artifactIndex + 1];
  if (!artifact || !existsSync(artifact)) {
    fail("--apk requires an existing APK path");
  } else {
    const apksigner = process.env.APKSIGNER;
    const expectedCertificate = (process.env.YIJIAN_RELEASE_CERT_SHA256 || "")
      .replace(/[^0-9a-f]/gi, "")
      .toUpperCase();
    if (!apksigner) {
      fail("APKSIGNER is required when verifying an APK");
    } else if (!expectedCertificate) {
      fail("YIJIAN_RELEASE_CERT_SHA256 is required when verifying an APK");
    } else {
      try {
        const certOutput = runTool(
          apksigner,
          ["verify", "--print-certs", artifact]
        );
        const certMatch = certOutput.match(/certificate SHA-256 digest:\s*([0-9a-f]+)/i);
        const actualCertificate = certMatch ? certMatch[1].toUpperCase() : "";
        if (actualCertificate === legacyDebugCertificate) {
          fail("APK is still signed with the exposed legacy debug certificate");
        }
        if (actualCertificate !== expectedCertificate) {
          fail(`APK certificate mismatch: ${actualCertificate || "unknown"}`);
        }
      } catch (error) {
        fail(`apksigner failed: ${error.message}`);
      }
    }

    const aapt2 = process.env.AAPT2;
    if (!aapt2) {
      fail("AAPT2 is required when verifying an APK");
    } else {
      try {
        const badging = runTool(aapt2, ["dump", "badging", artifact]);
        const packageMatch = badging.match(
          /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/
        );
        if (!packageMatch) {
          fail("Unable to parse APK package metadata");
        } else {
          if (packageMatch[1] !== expectedPackage) {
            fail(`APK package ${packageMatch[1]} does not match ${expectedPackage}`);
          }
          if (Number(packageMatch[2]) !== versionCode) {
            fail(`APK versionCode ${packageMatch[2]} does not match ${versionCode}`);
          }
          if (packageMatch[3] !== versionName) {
            fail(`APK versionName ${packageMatch[3]} does not match ${versionName}`);
          }
        }
        if (/application-debuggable/.test(badging)) {
          fail("Release artifact is debuggable");
        }
      } catch (error) {
        fail(`aapt2 failed: ${error.message}`);
      }
    }
  }
}

if (failures.length) {
  for (const message of failures) console.error(`FAIL: ${message}`);
  process.exit(1);
}

console.log(
  `RELEASE CHECKS PASSED: ${packageJson.name} ${versionName} (${versionCode}), `
    + `asset ${assetVersion}`
);
