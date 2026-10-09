// Reports which codepoints a font actually contains, to catch missing glyphs.
import { readSfnt, readCodepoints } from "./fontlib.mjs";

const file = process.argv[2];
const sfnt = await readSfnt(file);
const codepoints = readCodepoints(sfnt);

console.log(`file      : ${file}`);
console.log(`sfnt bytes: ${sfnt.length}`);
console.log(`codepoints: ${codepoints.size}`);

const probe = [..."车马象士将帅相仕炮兵卒車馬將砲弈鉴红黑楚河漢界"];
const missing = probe.filter((c) => !codepoints.has(c.codePointAt(0)));
console.log("piece/UI glyphs missing:", missing.length ? missing.join(" ") : "(none)");

const cjk = [...codepoints].filter((cp) => cp >= 0x3400 && cp <= 0x9fff);
console.log(`CJK covered: ${cjk.length}`);
