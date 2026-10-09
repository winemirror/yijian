// Checks the Windows A/B/C and Android P0/P1/P2 compatibility work.
//   Windows: browser fallback chain, writable-data fallback, diagnostics.
//   Android: ES5 guard, CSS fallbacks, modern-syntax removal.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const acorn = require("./acorn.js");

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const read = (name) => fs.readFileSync(path.join(here, name), "utf8");

const app = read("www/app.js");
const css = read("www/styles.css");
const html = read("www/index.html");
const launcher = fs.readFileSync(
  path.join(here, "xiangqi-exe", "Launcher.cs"),
  "utf8"
);
const buildScript = fs.readFileSync(
  path.join(here, "xiangqi-exe", "build.ps1"),
  "utf8"
);

const problems = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

function parseAt(source, edition) {
  try {
    acorn.parse(source, { ecmaVersion: edition, sourceType: "script" });
    return true;
  } catch (error) {
    return false;
  }
}

// Each CSS rule block, used to reason about declaration fallbacks.
function cssBlocks(text) {
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(text))) {
    blocks.push({
      selector: match[1].trim(),
      body: match[2],
      start: match.index,
    });
  }
  return blocks;
}

console.log("== android p0: es5 guard ==");
{
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  check("index.html has an inline guard", inline.length >= 1);
  const guard = inline.length ? inline[0][1] : "";
  check("guard parses as ES5", parseAt(guard, 5));
  check("guard checks Promise", /Promise/.test(guard));
  check("guard checks Object.assign", /Object\.assign/.test(guard));
  check("guard checks Worker", /Worker/.test(guard));
  check("guard checks padStart", /padStart/.test(guard));
  check("guard is placed before app.js", html.indexOf("Promise") < html.indexOf("app.js"));
  check("noscript fallback exists", /<noscript>/.test(html));
}

console.log("== android p1: css fallbacks ==");
{
  check("no clamp without a fallback declared first", (() => {
    for (const block of cssBlocks(css)) {
      const lines = block.body.split(/[;\n]/).map((l) => l.trim()).filter(Boolean);
      const seen = {};
      for (const line of lines) {
        const decl = /^([a-zA-Z-]+)\s*:\s*(.+)$/.exec(line);
        if (!decl) continue;
        const [, prop, value] = decl;
        if (value.includes("clamp(")) {
          if (!seen[prop]) return false;
        }
        if (!value.includes("clamp(")) {
          seen[prop] = true;
        }
      }
    }
    return true;
  })());
  check("no inset shorthand", !/[^-]inset\s*:/.test(css));
  check("no place-items", !/place-items/.test(css));
  check("no aspect-ratio", !/aspect-ratio\s*:/.test(css));
  check("board keeps the padding-top spacer", /\.board::before\s*\{[^}]*padding-top:\s*111\.1111%/.test(css));
  check("board sides set individually", /\.board-art\s*\{[^}]*top:\s*0;[^}]*left:\s*0/.test(css));
}

console.log("== android p2: modern syntax + flex gap ==");
{
  const code = app.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("no optional chaining", !/\?\./.test(code));
  check("no nullish coalescing", !/\?\?/.test(code));
  check("no Array.prototype.at", !/\.at\(/.test(code));
  check("no replaceChildren", !/replaceChildren/.test(code));
  check("app.js parses at ES2017 or lower", parseAt(app, 2017));

  check("every remaining gap has a grid-gap twin", (() => {
    for (const block of cssBlocks(css)) {
      if (/\bgap\s*:/.test(block.body) && !/grid-gap\s*:/.test(block.body)) {
        console.log(`      gap without grid-gap in: ${block.selector}`);
        return false;
      }
    }
    return true;
  })());
  check("flex rows use child margins", /\.topbar > \* \+ \*/ .test(css)
    && /\.game-meta > \*/.test(css)
    && /\.chat-message > \* \+ \*/.test(css));
}

console.log("== windows a: browser fallback chain ==");
{
  const order = ["msedge.exe", "chrome.exe", "brave.exe", "vivaldi.exe", "opera.exe", "360se.exe", "QQBrowser.exe"];
  let previous = -1;
  let ordered = true;
  for (const name of order) {
    const at = launcher.indexOf(name);
    if (at === -1 || at < previous) ordered = false;
    previous = Math.max(previous, at);
  }
  check("browser engines are tried in order", ordered);
  check("reads App Paths registry", /App Paths/.test(launcher) && /Registry\.LocalMachine/.test(launcher));
  check("falls back to the system default browser", /OpenWithSystemDefault/.test(launcher) && /UseShellExecute\s*=\s*true/.test(launcher));
  check("tracks the launched browser's process", /ProcessName/.test(launcher) && /GetProcessesByName\(processName\)/.test(launcher));
  check("resolves a default-browser process name", /ProcessNameOf\(/.test(launcher));
}

console.log("== windows b: writable data folder ==");
{
  check("resolves a portable root before writing", /ResolvePortableRoot\(\)/.test(launcher));
  check("probes writability", /IsWritable\(/.test(launcher) && /write-probe/.test(launcher));
  check("falls back to LocalAppData", /LocalApplicationData/.test(launcher));
}

console.log("== windows c: diagnostics ==");
{
  check("diagnose path exists", /private static void Diagnose\(/.test(launcher));
  check("copies the url to the clipboard", /Clipboard\.SetText\(url\)/.test(launcher));
  check("diagnose writes to the launcher log", /Log\(portableRoot,\s*"diagnose/.test(launcher));
}

console.log("== launcher source encoding ==");
{
  check("compiler reads the source as utf-8", /\/codepage:65001/.test(buildScript));
}

console.log("");
if (problems.length === 0) {
  console.log("COMPAT CHECKS PASSED");
  process.exitCode = 0;
} else {
  console.log(`PROBLEMS: ${problems.join("; ")}`);
  process.exitCode = 1;
}
