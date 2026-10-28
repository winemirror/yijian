import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "../harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK_ROOT = path.resolve(HERE, "..");
const DEFAULT_INPUT = path.join(
  HERE,
  "data",
  "extracted",
  "xqdb_masters_40711_UCI_games.pgn"
);
const DEFAULT_OUTPUT = path.join(HERE, "data", "game-library");
const SOURCE = {
  id: "wukong-xiangqi",
  name: "Wukong Xiangqi Master Games",
  repository: "https://github.com/maksimKorzh/wukong-xiangqi",
  archive: "https://raw.githubusercontent.com/maksimKorzh/wukong-xiangqi/main/xqdb/xqdb/xqdb_masters_40711_UCI_games.pgn.zip",
  license: "MIT (repository), upstream data attributed to wxf.ca",
  prefix: "WK"
};

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") out.input = path.resolve(argv[++index]);
    else if (arg === "--output-dir") out.outputDir = path.resolve(argv[++index]);
    else if (arg === "--limit") out.limit = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--prefix") out.prefix = String(argv[++index] || "WK").toUpperCase();
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

function usage() {
  return [
    "usage: node build-game-library.mjs [options]",
    "",
    "  --input <pgn>         输入的多局 UCI/ICCS PGN",
    "  --output-dir <dir>    输出 catalog.json / games.ndjson",
    "  --limit <n>           只导入前 n 局，用于测试",
    "  --prefix <XX>         两位棋谱号前缀，默认 WK"
  ].join("\n");
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function iccsToMove(token) {
  const match = /^([a-i])([0-9])([a-i])([0-9])$/i.exec(String(token).replace(/-/g, ""));
  if (!match) return null;
  return {
    from: (9 - Number(match[2])) * 9 + (match[1].toLowerCase().charCodeAt(0) - 97),
    to: (9 - Number(match[4])) * 9 + (match[3].toLowerCase().charCodeAt(0) - 97)
  };
}

function parsePgnBlocks(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n(?=\[Event\s+")/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function parseHeaders(block) {
  const headers = {};
  const re = /^\[([A-Za-z0-9_]+)\s+"([^"]*)"\]\s*$/gm;
  let match;
  while ((match = re.exec(block))) headers[match[1]] = match[2];
  return headers;
}

function bodyMoves(block) {
  const body = block.replace(/^\[[^\]]+\]\s*$/gm, " ");
  return body.match(/\b[a-i][0-9][a-i][0-9]\b/gi) || [];
}

function yearFromEvent(event) {
  const match = String(event || "").match(/\b(18|19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const input = args.input || DEFAULT_INPUT;
  const outputDir = args.outputDir || DEFAULT_OUTPUT;
  const prefix = args.prefix || SOURCE.prefix;
  if (!/^[A-Z]{2}$/.test(prefix)) throw new Error(`Invalid prefix: ${prefix}`);
  if (!fs.existsSync(input)) throw new Error(`PGN not found: ${input}`);

  fs.mkdirSync(outputDir, { recursive: true });
  const tempCatalog = path.join(outputDir, "catalog.json.tmp");
  const tempGames = path.join(outputDir, "games.ndjson.tmp");
  const tempManifest = path.join(outputDir, "manifest.json.tmp");
  const gamesFd = fs.openSync(tempGames, "w");

  const engine = loadEngine(
    path.join(WORK_ROOT, "www", "app.js"),
    path.join(WORK_ROOT, "ai-data.js"),
    {
      beforeEngine(sandbox, win) {
        win.localStorage.setItem("xiangqi.practice.enabled", "0");
      }
    }
  );
  const Game = engine.game().constructor;
  const initialFen = engine.__window.XiangqiRecords.INITIAL_FEN;
  const blocks = parsePgnBlocks(fs.readFileSync(input, "utf8"));
  const limit = args.limit > 0 ? Math.min(args.limit, blocks.length) : blocks.length;
  const catalog = [];
  const seenHashes = new Set();
  const failures = [];
  let accepted = 0;
  let duplicates = 0;
  let truncated = 0;
  let offset = 0;

  try {
    for (let sourceIndex = 0; sourceIndex < limit; sourceIndex += 1) {
      const headers = parseHeaders(blocks[sourceIndex]);
      const tokens = bodyMoves(blocks[sourceIndex]).map((token) => token.toLowerCase());
      if (!tokens.length) {
        failures.push({ sourceOrder: sourceIndex + 1, reason: "no_moves" });
        continue;
      }
      const game = new Game();
      let invalid = "";
      let truncatedAt = null;
      for (let moveIndex = 0; moveIndex < tokens.length; moveIndex += 1) {
        if (game.result.type !== "ongoing") {
          truncatedAt = moveIndex;
          break;
        }
        const move = iccsToMove(tokens[moveIndex]);
        if (!move) {
          invalid = `bad_token:${tokens[moveIndex]}`;
          break;
        }
        try {
          game.play(move.from, move.to);
        } catch (error) {
          invalid = `move_${moveIndex + 1}:${error && error.message || "illegal"}`;
          break;
        }
      }
      if (invalid) {
        failures.push({ sourceOrder: sourceIndex + 1, reason: invalid });
        continue;
      }
      if (truncatedAt !== null) {
        tokens.length = truncatedAt;
        truncated += 1;
      }

      const moveText = tokens.join(" ");
      const contentHash = sha256(`${initialFen}\n${moveText}`);
      if (seenHashes.has(contentHash)) {
        duplicates += 1;
        continue;
      }
      seenHashes.add(contentHash);

      const sourceOrder = sourceIndex + 1;
      const code = `${prefix}${String(sourceOrder).padStart(5, "0")}`;
      const event = String(headers.Event || "").trim();
      const red = String(headers.Red || "红方").trim();
      const black = String(headers.Black || "黑方").trim();
      const year = yearFromEvent(event);
      const gameRecord = {
        code,
        source: SOURCE.id,
        sourceOrder,
        event,
        red,
        black,
        year,
        result: "*",
        moveCount: tokens.length,
        initialFen,
        moves: moveText,
        contentHash
      };
      const line = `${JSON.stringify(gameRecord)}\n`;
      const length = Buffer.byteLength(line);
      fs.writeSync(gamesFd, line, null, "utf8");
      catalog.push({
        code,
        source: SOURCE.id,
        sourceOrder,
        event,
        red,
        black,
        year,
        result: "*",
        moveCount: tokens.length,
        offset,
        length
      });
      offset += length;
      accepted += 1;
    }
  } finally {
    fs.closeSync(gamesFd);
  }

  const generatedAt = new Date().toISOString();
  const dataDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date()).replace(/\//g, "-");
  const manifest = {
    schema: 1,
    dataVersion: `wukong-uci-${dataDate}`,
    generatedAt,
    source: SOURCE.name,
    sourceRepository: SOURCE.repository,
    sourceArchive: SOURCE.archive,
    sourceArchiveSha256: "E3EB0BF1BB7242AEBBAD49461469FD5FA3F869EDD083E1E56D0B36F7553A3186",
    license: SOURCE.license,
    prefix,
    attempted: limit,
    accepted,
    duplicates,
    truncated,
    rejected: failures.length,
    catalogBytes: 0,
    gamesBytes: offset,
    catalogSha256: "",
    gamesSha256: ""
  };
  fs.writeFileSync(tempCatalog, `${JSON.stringify(catalog)}\n`, "utf8");
  fs.writeFileSync(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(tempCatalog, path.join(outputDir, "catalog.json"));
  fs.renameSync(tempGames, path.join(outputDir, "games.ndjson"));

  manifest.catalogBytes = fs.statSync(path.join(outputDir, "catalog.json")).size;
  manifest.catalogSha256 = sha256(fs.readFileSync(path.join(outputDir, "catalog.json")));
  manifest.gamesSha256 = sha256(fs.readFileSync(path.join(outputDir, "games.ndjson")));
  fs.writeFileSync(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(tempManifest, path.join(outputDir, "manifest.json"));

  console.log(JSON.stringify({
    input,
    outputDir,
    attempted: limit,
    accepted,
    duplicates,
    truncated,
    rejected: failures.length,
    gamesBytes: manifest.gamesBytes,
    catalogBytes: manifest.catalogBytes
  }, null, 2));
  if (failures.length) {
    console.log(`REJECTED_SAMPLE=${JSON.stringify(failures.slice(0, 10))}`);
  }
}

main();
