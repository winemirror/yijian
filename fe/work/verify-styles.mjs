// Verifies the flat piece styling + colour handling on the writable copy.
// Reuses the read-only engine harness from the original workspace.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BENCH = "C:/Users/su/Documents/Codex/2026-10-08/w-2/work/engine-bench/harness.mjs";
const FONTLIB = "C:/Users/su/Documents/Codex/2026-10-08/w-2/work/font-tools/fontlib.mjs";
const { loadEngine, RED } = await import(pathToFileURL(BENCH).href);
const { readSfnt, readCodepoints } = await import(pathToFileURL(FONTLIB).href);

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const app = path.join(here, "www", "app.js");
const css = fs.readFileSync(path.join(here, "www", "styles.css"), "utf8");
const html = fs.readFileSync(path.join(here, "www", "index.html"), "utf8");

const problems = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

const engine = loadEngine(app);
const doc = engine.__document;
const vars = () => doc.documentElement.style.props || {};

console.log("== flat piece styling ==");
{
  const pieceBlock = /\.piece\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  check(".piece has no gradient fill", !pieceBlock.includes("radial-gradient"));
  check(".piece uses a solid fill variable", pieceBlock.includes("background: var(--piece-fill)"));
  check(".piece keeps an outline", /border:\s*2px solid var\(--piece-stroke\)/.test(pieceBlock));
  check(".piece glyph is bold", /font-weight:\s*700/.test(pieceBlock));

  const redBlock = /\.piece\.r\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  const blackBlock = /\.piece\.b\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  check("red piece fills with --piece-red", redBlock.includes("--piece-fill: var(--piece-red)"));
  check("red piece glyph uses --piece-red-text", redBlock.includes("--piece-glyph: var(--piece-red-text)"));
  check("black piece fills with --piece-black", blackBlock.includes("--piece-fill: var(--piece-black)"));
  check("black piece glyph uses --piece-black-text", blackBlock.includes("--piece-glyph: var(--piece-black-text)"));

  const captured = /\.captured-piece\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  check("captured pieces use the flat fill too", captured.includes("background: var(--piece-red)"));
}

console.log("== defaults ==");
{
  const applied = engine.applyPieceColors(engine.DEFAULT_PIECE_COLORS);
  console.log(`  ${JSON.stringify(applied)}`);
  check("red default fill is dark red", vars()["--piece-red"] === "#8b0000", vars()["--piece-red"]);
  check("black default fill", vars()["--piece-black"] === "#1f1d1a", vars()["--piece-black"]);
  check("red default glyph is white", applied.redText === "#ffffff", applied.redText);
  check("black default glyph is white", applied.blackText === "#ffffff", applied.blackText);
  check("css defaults are white too",
    /--piece-red-text:\s*#ffffff/.test(css) && /--piece-black-text:\s*#ffffff/.test(css));
}

console.log("== custom colours ==");
{
  const applied = engine.applyPieceColors({ red: "#d81b60", black: "#111111" });
  console.log(`  ${JSON.stringify(applied)}`);
  check("custom red applied to fill", vars()["--piece-red"] === "#d81b60");
  check("custom black applied to fill", vars()["--piece-black"] === "#111111");
  check("dark fills keep white glyphs",
    applied.redText === "#ffffff" && applied.blackText === "#ffffff");

  const light = engine.applyPieceColors({ red: "#ffe082", black: "#f5f5f5" });
  console.log(`  light fills -> ${JSON.stringify(light)}`);
  check("light fill switches to dark glyph", light.redText === "#1f1d1a", light.redText);
  engine.applyPieceColors(engine.DEFAULT_PIECE_COLORS);
}

console.log("== font coverage ==");
{
  const covered = readCodepoints(await readSfnt(path.join(here, "www", "xiangqi-kai.woff2")));
  const required = [..."车马象士将帅相仕炮兵卒車馬象士將砲卒弈鉴红黑楚河漢界0123456789"];
  const missing = required.filter((c) => !covered.has(c.codePointAt(0)));
  check("all piece glyphs present", missing.length === 0, missing.join(" ") || `${covered.size} codepoints`);
  check("fonts inlined in css", css.includes("data:font/woff2;base64,"));
  check("colour inputs present in page", html.includes("redColor") && html.includes("blackColor"));
}

console.log("== engine sanity ==");
{
  const nodes = engine.perft(engine.initialBoard(), RED, 3);
  check("perft(3) = 79666", nodes === 79666, String(nodes));
}

console.log("");
if (problems.length === 0) {
  console.log("STYLE CHECKS PASSED");
  process.exitCode = 0;
} else {
  console.log(`PROBLEMS: ${problems.join("; ")}`);
  process.exitCode = 1;
}
