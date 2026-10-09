// Dumps candidate download URLs found on a page.
import fs from "node:fs";

const [page, outFile] = process.argv.slice(2);
const response = await fetch(page);
const html = await response.text();
if (outFile) fs.writeFileSync(outFile, html);

console.log(`${page} -> ${response.status}, ${html.length} bytes`);
const matches = [...html.matchAll(/[^"'\s]*(?:\.zip|download)[^"'\s]*/gi)]
  .map((match) => match[0])
  .filter((value) => value.length < 200);
for (const value of [...new Set(matches)].slice(0, 30)) {
  console.log(`    ${value}`);
}
