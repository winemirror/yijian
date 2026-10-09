// Runs the app's own in-page self-test block (index.html?selftest) headlessly
// and prints the JSON it publishes on <html data-selftest=...>.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const which = process.argv[2] || path.join(HERE, "..", "xiangqi-capacitor", "www", "app.js");
const engine = loadEngine(which, undefined, { search: "?selftest" });
const raw = engine.__document.documentElement.dataset.selftest;
if (!raw) {
  console.log("no selftest payload (did the block run?)");
  process.exit(1);
}
const data = JSON.parse(raw);
console.log(JSON.stringify(data, null, 2));
