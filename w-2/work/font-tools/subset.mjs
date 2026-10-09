// Builds the bundled calligraphy subset for the board pieces and UI.
//
// The source font must cover BOTH the simplified and traditional piece glyphs
// (车/車, 马/馬, 炮/砲, 将/將 ...). The previous source (Windows STLiti) only
// covered simplified, so the black pieces silently fell back to another font -
// invisible on Windows, obvious on Android. LXGW WenKai is used instead: it
// covers 46k+ codepoints and is SIL OFL licensed, so bundling it is fine.
import fs from "node:fs";
import path from "node:path";
import subsetFont from "subset-font";
import { readSfnt, readCodepoints } from "./fontlib.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const webRoot = path.resolve(here, "..", "xiangqi-capacitor", "www");
const source = path.join(here, "LXGWWenKai-Regular.ttf");
const target = path.join(webRoot, "xiangqi-kai.woff2");

if (!fs.existsSync(source)) {
  throw new Error(`missing source font: ${source}`);
}

const pageFiles = ["index.html", "app.js", "ai-data.js"].map((file) =>
  path.join(webRoot, file)
);
const pageText = pageFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");

// CJK ideographs plus the CJK punctuation the UI actually uses.
const pageGlyphs = [...pageText].filter(
  (character) =>
    /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(character)
);
// Both piece name sets, spelled out so a future rename cannot drop them.
const pieceGlyphs = [..."车马象士将帅相仕炮兵卒車馬象士將砲卒"];
const brandGlyphs = [..."弈鉴红黑楚河漢界"];
// The move list renders notation like "炮8平7" in this same font, so keep the
// ASCII digits and letters in the subset too.
const basicGlyphs = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"];
const characters = [
  ...new Set([...pageGlyphs, ...pieceGlyphs, ...brandGlyphs, ...basicGlyphs]),
].join("");

const output = await subsetFont(fs.readFileSync(source), characters, {
  targetFormat: "woff2",
});

const previous = fs.existsSync(target) ? fs.statSync(target).size : 0;
fs.writeFileSync(target, output);

// Fail loudly if the subsetter dropped anything, instead of shipping a font
// that silently falls back on some devices.
const covered = readCodepoints(await readSfnt(target));
const missing = [...characters].filter((character) => !covered.has(character.codePointAt(0)));

// Embed the font in styles.css as well. Android WebView serves packaged assets
// with a sniffed MIME type which is not guaranteed to be a font type, and a
// data: URI removes that (plus path and CORS) from the equation entirely. The
// packaged .woff2 stays as a fallback source.
const cssPath = path.join(webRoot, "styles.css");
const css = fs.readFileSync(cssPath, "utf8");
const srcPattern = /(@font-face\s*\{[^}]*?src:\s*)[^;]+;/;
if (!srcPattern.test(css)) {
  throw new Error("could not locate the @font-face src declaration in styles.css");
}
const embedded = `url("data:font/woff2;base64,${output.toString("base64")}") format("woff2"),
    url("xiangqi-kai.woff2") format("woff2");`;
fs.writeFileSync(cssPath, css.replace(srcPattern, `$1${embedded}`));

console.log(`source     : ${path.basename(source)}`);
console.log(`characters : ${characters.length}`);
console.log(`output     : ${target}`);
console.log(`size       : ${previous} -> ${output.length} bytes`);
if (missing.length > 0) {
  console.error(`MISSING GLYPHS (${missing.length}): ${missing.join(" ")}`);
  process.exit(1);
}
console.log("coverage   : all requested glyphs present");
