// Verifies traditional move commentary labels and brilliant-move detection.
import fs from "node:fs";
import path from "node:path";
import { loadEngine, RED, BLACK } from "./harness.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const engine = loadEngine(path.join(here, "www", "app.js"));
const html = fs.readFileSync(path.join(here, "www", "index.html"), "utf8");
const css = fs.readFileSync(path.join(here, "www", "styles.css"), "utf8");

const problems = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

const expectedTerms = {
  "最佳": "正着",
  "神准": "妙手",
  "优秀": "好着",
  "良好": "正着",
  "稳健": "稳着",
  "一般": "俗手",
  "欠佳": "软招",
  "失误": "无理手",
  "严重失误": "漏招",
  "败着": "恶手"
};

console.log("== move commentary terms ==");
{
  check("ten internal grades map to terms",
    Object.keys(engine.QUALITY_TERMS).length === 10);
  for (const [label, term] of Object.entries(expectedTerms)) {
    check(`${label} displays as ${term}`,
      engine.qualityDisplayLabel({ label }) === term,
      engine.qualityDisplayLabel({ label }));
  }
  check("unanalysed move has no forced term",
    engine.qualityDisplayLabel(null) === "");
}

console.log("== brilliant swing ==");
{
  const good = { label: "最佳" };
  check("red comeback is brilliant", engine.isBrilliantMove({
    side: RED,
    quality: good,
    analysis: { winRed: 40 },
    afterAnalysis: { winRed: 70 }
  }));
  check("already-winning move is not a comeback", !engine.isBrilliantMove({
    side: RED,
    quality: good,
    analysis: { winRed: 55 },
    afterAnalysis: { winRed: 85 }
  }));
  check("small improvement is not brilliant", !engine.isBrilliantMove({
    side: RED,
    quality: good,
    analysis: { winRed: 40 },
    afterAnalysis: { winRed: 60 }
  }));
  check("black comeback uses black perspective", engine.isBrilliantMove({
    side: BLACK,
    quality: good,
    analysis: { winRed: 70 },
    afterAnalysis: { winRed: 35 }
  }));
  check("poor move cannot be brilliant", !engine.isBrilliantMove({
    side: RED,
    quality: { label: "失误" },
    analysis: { winRed: 40 },
    afterAnalysis: { winRed: 70 }
  }));
}

console.log("== gold banner ==");
{
  check("banner markup exists",
    html.includes('id="brilliantBanner"')
    && html.includes('id="brilliantBannerText"'));
  check("banner uses gold styling",
    /\.brilliant-banner span\s*\{[^}]*#f6d978/.test(css)
    && /\.brilliant-banner span\s*\{[^}]*#d8a83c/.test(css));
  check("banner has entrance animation",
    /@keyframes\s+brilliant-banner-in/.test(css)
    && /\.brilliant-banner\.show span/.test(css));
}

console.log("");
if (problems.length === 0) {
  console.log("QUALITY CHECKS PASSED");
  process.exitCode = 0;
} else {
  console.log(`PROBLEMS: ${problems.join("; ")}`);
  process.exitCode = 1;
}
