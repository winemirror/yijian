// Lists every rule that uses `gap`, with its selector, so a no-gap fallback can
// be written for each container.
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const css = fs.readFileSync(path.join(here, "www", "styles.css"), "utf8");

const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
let match;
const rows = [];
while ((match = rulePattern.exec(css)) !== null) {
  const selector = match[1].trim().replace(/\s+/g, " ");
  const body = match[2];
  const gap = /(?:^|;)\s*gap\s*:\s*([^;]+)/.exec(body);
  if (!gap) continue;
  const display = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(body);
  const wrap = /flex-wrap\s*:\s*([^;]+)/.exec(body);
  const dir = /flex-direction\s*:\s*([^;]+)/.exec(body);
  rows.push({
    selector,
    gap: gap[1].trim(),
    display: display ? display[1].trim() : "-",
    wrap: wrap ? wrap[1].trim() : "-",
    dir: dir ? dir[1].trim() : "row",
  });
}

for (const row of rows) {
  console.log(`${row.selector}`);
  console.log(`    gap:${row.gap}  display:${row.display}  wrap:${row.wrap}  dir:${row.dir}`);
}
console.log(`\ntotal: ${rows.length}`);
