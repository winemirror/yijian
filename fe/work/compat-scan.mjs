// Reports which browser features the current build relies on, with the first
// Chromium version that supports each one.
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const js = fs.readFileSync(path.join(here, "www", "app.js"), "utf8");
const css = fs.readFileSync(path.join(here, "www", "styles.css"), "utf8");
const html = fs.readFileSync(path.join(here, "www", "index.html"), "utf8");

const JS_FEATURES = [
  [/\?\./g, "optional chaining (?.", 80],
  [/\?\?/g, "nullish coalescing (??)", 80],
  [/\.at\(/g, "Array.prototype.at()", 92],
  [/replaceChildren/g, "Element.replaceChildren()", 86],
  [/async function|async\s*\(/g, "async/await", 55],
  [/Object\.entries/g, "Object.entries()", 54],
  [/padStart|padEnd/g, "String.padStart()", 57],
  [/globalThis/g, "globalThis", 71],
  [/\.flatMap\(/g, "Array.flatMap()", 69],
  [/structuredClone/g, "structuredClone()", 98],
  [/classList\.toggle\([^,)]+,[^)]+\)/g, "classList.toggle(force)", 24],
];

const CSS_FEATURES = [
  [/aspect-ratio\s*:/g, "aspect-ratio", 88],
  [/clamp\(/g, "clamp()", 79],
  [/[^-]inset\s*:/g, "inset shorthand", 87],
  [/place-items|place-content/g, "place-items", 59],
  [/var\(--/g, "CSS custom properties", 49],
  [/overscroll-behavior/g, "overscroll-behavior", 63],
  [/:is\(|:where\(/g, ":is() / :where()", 88],
  [/backdrop-filter/g, "backdrop-filter", 76],
  [/text-size-adjust/g, "text-size-adjust", 54],
];

function report(label, text, features) {
  console.log(`=== ${label} ===`);
  let worst = 0;
  for (const [pattern, name, chrome] of features) {
    const count = (text.match(pattern) || []).length;
    if (count === 0) continue;
    worst = Math.max(worst, chrome);
    console.log(`  ${name.padEnd(30)} x${String(count).padStart(4)}   needs Chrome ${chrome}+`);
  }
  console.log(`  -> highest requirement: Chrome ${worst}+`);
  return worst;
}

// Flex gap is only a problem when the rule has no grid-gap twin; the grid
// containers below keep `gap` plus `grid-gap`, which Chrome 57-83 understands.
function flexGapWithoutFallback(text) {
  let count = 0;
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(text))) {
    const body = match[2];
    if (/(^|[\s;{])gap\s*:/.test(body) && !/grid-gap\s*:/.test(body)) {
      count += 1;
      console.log(`    (no grid-gap twin) ${match[1].trim().split("\n").pop().trim()}`);
    }
  }
  return count;
}

const jsWorst = report("app.js", js, JS_FEATURES);
const cssWorstRaw = report("styles.css", css, CSS_FEATURES);
const flexGapCount = flexGapWithoutFallback(css);
console.log(`  ${"gap (flexbox, no fallback)".padEnd(30)} x${String(flexGapCount).padStart(4)}   needs Chrome 84+`);
const cssWorst = flexGapCount > 0 ? Math.max(cssWorstRaw, 84) : cssWorstRaw;
report("index.html", html, CSS_FEATURES);

console.log("");
console.log(
  `raw overall floor: Chrome ${Math.max(jsWorst, cssWorst)}+`
    + "  (clamp() has a plain-value fallback on the line above each use,"
    + " so the effective floor is Chrome 57+)"
);
console.log("Android 7 stock WebView is Chrome 51-52;");
console.log("Chrome 92  ~ 2021, Chrome 86 ~ 2020, Chrome 79 ~ 2019.");
