import fs from "node:fs";
import path from "node:path";

const CODE_RE = /^([A-Z]{2})(\d{1,5})$/;
const PLAYER_ALIASES = new Map([
  ["杨官璘", "Yang GuanLin"],
  ["胡荣华", "Hu RongHua"],
  ["柳大华", "Liu DaHua"],
  ["李来群", "Li LaiQun"],
  ["吕钦", "Lv Qin"],
  ["徐天红", "Xu TianHong"],
  ["赵国荣", "Zhao GuoRong"],
  ["许银川", "Xu YinChuan"],
  ["于幼华", "Yu YouHua"],
  ["陶汉明", "Tao HanMing"],
  ["阎文清", "Yan WenQing"],
  ["张强", "Zhang Qiang"],
  ["刘殿中", "Liu DianZhong"],
  ["蒋全胜", "Jiang QuanSheng"],
  ["洪智", "Hong Zhi"],
  ["王天一", "Wang TianYi"],
  ["郑惟桐", "Zheng WeiTong"],
  ["蒋川", "Jiang Chuan"],
  ["赵鑫鑫", "Zhao XinXin"],
  ["汪洋", "Wang Yang"],
  ["孟辰", "Meng Chen"],
  ["孙勇征", "Sun YongZheng"],
  ["谢靖", "Xie Jing"]
]);

function cleanText(value, limit = 160) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function normalizeGameCode(value) {
  const compact = cleanText(value, 24).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const match = CODE_RE.exec(compact);
  if (!match) return "";
  return match[1] + match[2].padStart(5, "0");
}

function normalizedSearchText(value) {
  return cleanText(value, 240).toLocaleLowerCase();
}

function withPlayerAliases(value) {
  let text = String(value || "");
  for (const [chinese, romanized] of PLAYER_ALIASES) {
    if (text.includes(chinese)) text = text.split(chinese).join(romanized);
  }
  return text;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function entryScore(entry, terms, rawQuery) {
  const red = normalizedSearchText(entry.red);
  const black = normalizedSearchText(entry.black);
  const event = normalizedSearchText(entry.event);
  const code = entry.code.toLowerCase();
  const query = normalizedSearchText(rawQuery);
  let score = 0;
  if (code === query) score += 1000;
  if (red === query) score += 400;
  if (black === query) score += 400;
  if (event === query) score += 250;
  if (red.includes(query) || black.includes(query) || event.includes(query)) score += 60;
  for (const term of terms) {
    if (red.includes(term)) score += red.startsWith(term) ? 35 : 20;
    if (black.includes(term)) score += black.startsWith(term) ? 35 : 20;
    if (event.includes(term)) score += 12;
  }
  return score;
}

function publicEntry(entry) {
  return {
    code: entry.code,
    event: entry.event,
    red: entry.red,
    black: entry.black,
    year: entry.year,
    result: entry.result,
    moveCount: entry.moveCount,
    source: entry.source
  };
}

export function createGameLibrary(options = {}) {
  const dataDir = path.resolve(
    options.dataDir
      || process.env.GAME_LIBRARY_DIR
      || path.join(process.cwd(), "data", "game-library")
  );
  const catalogPath = path.join(dataDir, "catalog.json");
  const gamesPath = path.join(dataDir, "games.ndjson");
  const manifestPath = path.join(dataDir, "manifest.json");
  let catalog = null;
  let byCode = null;
  let manifest = null;
  let fd = null;

  function load() {
    if (catalog) return;
    const loadedCatalog = readJson(catalogPath);
    if (!Array.isArray(loadedCatalog)) {
      throw new Error(`棋库索引不存在：${catalogPath}`);
    }
    catalog = loadedCatalog;
    byCode = new Map();
    for (const entry of catalog) {
      if (entry && normalizeGameCode(entry.code) === entry.code) {
        byCode.set(entry.code, entry);
      }
    }
    manifest = readJson(manifestPath, {});
    fd = fs.openSync(gamesPath, "r");
  }

  function close() {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    catalog = null;
    byCode = null;
    manifest = null;
    fd = null;
  }

  function getManifest() {
    load();
    return Object.assign({}, manifest);
  }

  function search(params = {}) {
    load();
    const query = cleanText(withPlayerAliases(params.q || params.query), 80);
    const termText = normalizedSearchText(query);
    const terms = termText.split(/\s+/).filter(Boolean);
    const redFilter = normalizedSearchText(withPlayerAliases(params.red));
    const blackFilter = normalizedSearchText(withPlayerAliases(params.black));
    const eventFilter = normalizedSearchText(params.event);
    const yearFilter = Number(params.year) || null;
    const resultFilter = cleanText(params.result, 16);
    const page = Math.max(1, Math.min(100000, Number(params.page) || 1));
    const limit = Math.max(1, Math.min(50, Number(params.limit) || 20));

    let rows = catalog;
    if (redFilter) rows = rows.filter((entry) => normalizedSearchText(entry.red).includes(redFilter));
    if (blackFilter) rows = rows.filter((entry) => normalizedSearchText(entry.black).includes(blackFilter));
    if (eventFilter) rows = rows.filter((entry) => normalizedSearchText(entry.event).includes(eventFilter));
    if (yearFilter) rows = rows.filter((entry) => Number(entry.year) === yearFilter);
    if (resultFilter) rows = rows.filter((entry) => entry.result === resultFilter);

    const exactCode = normalizeGameCode(query);
    if (exactCode) {
      rows = rows.filter((entry) => entry.code === exactCode);
    } else if (terms.length) {
      const ranked = [];
      for (const entry of rows) {
        const score = entryScore(entry, terms, query);
        if (score > 0) ranked.push({ entry, score });
      }
      ranked.sort((a, b) => b.score - a.score || a.entry.sourceOrder - b.entry.sourceOrder);
      rows = ranked.map((item) => item.entry);
    }

    const total = rows.length;
    const start = (page - 1) * limit;
    const games = rows.slice(start, start + limit).map(publicEntry);
    return {
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      games
    };
  }

  function get(code) {
    load();
    const normalized = normalizeGameCode(code);
    if (!normalized) return null;
    const entry = byCode.get(normalized);
    if (!entry) return null;
    const buffer = Buffer.allocUnsafe(entry.length);
    const bytes = fs.readSync(fd, buffer, 0, entry.length, entry.offset);
    if (bytes !== entry.length) throw new Error(`棋谱数据读取不完整：${normalized}`);
    const game = JSON.parse(buffer.toString("utf8"));
    return Object.assign({}, game, {
      sourceOrder: entry.sourceOrder,
      source: entry.source,
      dataVersion: manifest.dataVersion || "",
      license: manifest.license || ""
    });
  }

  function health() {
    try {
      load();
      return {
        ok: true,
        games: byCode.size,
        dataVersion: manifest.dataVersion || "",
        source: manifest.source || ""
      };
    } catch (error) {
      return {
        ok: false,
        error: error && error.message || String(error)
      };
    }
  }

  return {
    dataDir,
    load,
    close,
    getManifest,
    search,
    get,
    health,
    normalizeCode: normalizeGameCode
  };
}
