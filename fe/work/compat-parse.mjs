// Reports the lowest ECMAScript version each script parses at, which maps to a
// minimum Chromium/WebView version. Uses a locally vendored acorn build.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const acorn = require("./acorn.js");
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

// ECMAScript edition -> first Chromium version with the syntax.
const EDITIONS = [
  [5, "ES5", "Chrome 23"],
  [2015, "ES2015 (let/const, arrow, class, template)", "Chrome 49-51"],
  [2016, "ES2016", "Chrome 52"],
  [2017, "ES2017 (async/await)", "Chrome 55"],
  [2018, "ES2018 (spread properties)", "Chrome 60"],
  [2019, "ES2019 (catch binding, Array.flat)", "Chrome 66"],
  [2020, "ES2020 (?., ??, BigInt)", "Chrome 80"],
  [2021, "ES2021 (logical assignment)", "Chrome 85"],
  [2022, "ES2022 (.at, class fields)", "Chrome 92"],
];

function report(name, source) {
  const result = floorForSource(source);
  console.log(`${name.padEnd(24)} lowest parse level: ${result.label}  (~${result.chrome})`);
  if (result.error) console.log(`    ${result.error.message}`);
  return result;
}

function floorForSource(source) {
  for (const [edition, label, chrome] of EDITIONS) {
    try {
      acorn.parse(source, { ecmaVersion: edition, sourceType: "script" });
      return { edition, label, chrome, error: null };
    } catch (error) {
      // keep climbing
    }
  }
  try {
    acorn.parse(source, { ecmaVersion: "latest", sourceType: "script" });
  } catch (error) {
    return { edition: null, label: "unparseable", chrome: "?", error };
  }
  return { edition: null, label: "beyond ES2022", chrome: ">Chrome 92", error: null };
}

for (const name of ["app.js", "ai-worker-bootstrap.js"]) {
  const file = path.join(here, "www", name);
  if (!fs.existsSync(file)) continue;
  report(name, fs.readFileSync(file, "utf8"));
}

// The inline guard in index.html has to stay ES5 so it survives on the very
// WebViews it is meant to warn about.
const html = fs.readFileSync(path.join(here, "www", "index.html"), "utf8");
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
inline.forEach((match, index) => {
  report(`index.html inline#${index + 1}`, match[1]);
});
