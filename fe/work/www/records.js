// YiJian game-record protocol.
// This file is intentionally independent from the UI and engine so the same
// format can later be reused by the cloud API and import/export tools.
(function (root) {
  "use strict";

  var FORMAT = "yijian.game";
  var VERSION = 2;
  var INITIAL_FEN = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";
  var FILES = "abcdefghi";
  var RESULTS = { ongoing: true, win: true, draw: true };
  var MODES = { local: true, online: true, "ai-vs-ai": true, replay: true };

  function cleanText(value, limit) {
    var text = value === undefined || value === null ? "" : String(value);
    text = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    return text.slice(0, limit || 120);
  }

  function validDate(value, fallback) {
    var time = Date.parse(String(value || ""));
    return new Date(isFinite(time) ? time : fallback).toISOString();
  }

  function finiteNumber(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? number : fallback;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function sideOf(value) {
    return value === "b" || value === "black" ? "b"
      : value === "r" || value === "red" ? "r" : "";
  }

  function moveToIccs(move) {
    var from = Number(move && move.from);
    var to = Number(move && move.to);
    if (from < 0 || from > 89 || to < 0 || to > 89) return "";
    var square = function (index) {
      return FILES.charAt(index % 9) + String(9 - Math.floor(index / 9));
    };
    return square(from) + square(to);
  }

  function parseIccs(token) {
    var clean = String(token || "").toLowerCase().replace(/-/g, "");
    var match = /^([a-i])([0-9])([a-i])([0-9])$/.exec(clean);
    if (!match) throw new Error("着法格式不正确：" + token);
    return {
      from: (9 - Number(match[2])) * 9 + FILES.indexOf(match[1]),
      to: (9 - Number(match[4])) * 9 + FILES.indexOf(match[3])
    };
  }

  function parseIccsMoves(text) {
    var tokens = String(text || "").trim().split(/[\s,]+/).filter(Boolean);
    return tokens.map(function (token) {
      var move = parseIccs(token);
      move.iccs = moveToIccs(move);
      return move;
    });
  }

  function boardToFen(board, side, halfmoveClock) {
    var rows = [];
    for (var row = 0; row < 10; row += 1) {
      var line = "";
      var empty = 0;
      for (var col = 0; col < 9; col += 1) {
        var piece = board[row * 9 + col];
        if (!piece) {
          empty += 1;
          continue;
        }
        if (empty) {
          line += String(empty);
          empty = 0;
        }
        var letter = piece.type;
        line += piece.side === "r" ? letter.toUpperCase() : letter.toLowerCase();
      }
      if (empty) line += String(empty);
      rows.push(line);
    }
    return rows.join("/") + " " + (side === "b" ? "b" : "w") + " - - "
      + Math.max(0, Number(halfmoveClock) || 0) + " 1";
  }

  // A compact integrity check for accidental edits and truncated files. This
  // is deliberately not presented as a security signature.
  function checksumOf(record) {
    var copy = clone(record);
    delete copy.checksum;
    var text = JSON.stringify(copy);
    var hash = 2166136261;
    for (var index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      hash >>>= 0;
    }
    return "fnv1a:" + ("00000000" + hash.toString(16)).slice(-8);
  }

  function seal(record) {
    record.checksum = checksumOf(record);
    return record;
  }

  function normalizeResult(value) {
    var source = value && typeof value === "object" ? value : {};
    var type = RESULTS[source.type] ? source.type : "ongoing";
    var winner = sideOf(source.winner);
    if (type === "win" && !winner) type = "ongoing";
    if (type !== "win") winner = null;
    var pattern = null;
    if (source.pattern) {
      if (typeof source.pattern === "string") {
        pattern = { name: cleanText(source.pattern, 32), key: "" };
      } else {
        pattern = {
          name: cleanText(source.pattern.name, 32),
          key: cleanText(source.pattern.key, 32)
        };
      }
      if (!pattern.name) pattern = null;
    }
    return {
      type: type,
      winner: winner,
      reason: cleanText(source.reason, 40),
      pattern: pattern
    };
  }

  function normalizePlayer(value, fallbackName) {
    var source = value && typeof value === "object" ? value : {};
    var kind = source.kind === "ai" ? "ai" : source.kind === "remote" ? "remote" : "human";
    return {
      kind: kind,
      name: cleanText(source.name, 40) || fallbackName,
      level: cleanText(source.level, 32) || null
    };
  }

  function normalizeMove(value, index) {
    var source = value && typeof value === "object" ? value : {};
    var coords = null;
    if (isFinite(Number(source.from)) && isFinite(Number(source.to))) {
      coords = { from: Number(source.from), to: Number(source.to) };
    } else if (source.iccs) {
      coords = parseIccs(source.iccs);
    }
    if (!coords || coords.from < 0 || coords.from > 89 || coords.to < 0 || coords.to > 89) {
      throw new Error("第 " + (index + 1) + " 手缺少有效的起点或终点");
    }
    var side = sideOf(source.side);
    var quality = source.quality;
    if (quality && typeof quality === "object") quality = quality.label;
    return {
      i: index,
      from: coords.from,
      to: coords.to,
      iccs: moveToIccs(coords),
      side: side || null,
      notation: cleanText(source.notation, 32),
      ms: Math.max(0, finiteNumber(source.ms, 0)),
      quality: cleanText(quality, 18),
      winRed: source.winRed === null || source.winRed === undefined
        ? null : finiteNumber(source.winRed, null),
      evalRed: source.evalRed === null || source.evalRed === undefined
        ? null : finiteNumber(source.evalRed, null)
    };
  }

  function recordId(value) {
    var id = cleanText(value, 64).replace(/[^A-Za-z0-9_-]/g, "");
    if (id.length >= 6) return id;
    return "g" + Date.now().toString(36)
      + Math.random().toString(36).slice(2, 8);
  }

  function normalize(input, options) {
    if (!input || typeof input !== "object") throw new Error("棋谱内容不是对象");
    var source = clone(input);
    if (source.format && source.format !== FORMAT) {
      throw new Error("不认识的棋谱格式：" + cleanText(source.format, 40));
    }
    var now = Date.now();
    var version = Number(source.version) || 1;
    var playersSource = source.players || {
      red: source.red,
      black: source.black
    };
    var players = {
      red: normalizePlayer(playersSource.red, "红方"),
      black: normalizePlayer(playersSource.black, "黑方")
    };
    var rules = source.rules && typeof source.rules === "object" ? source.rules : {};
    var initialFen = cleanText(rules.initialFen, 220) || INITIAL_FEN;
    var createdAt = validDate(source.createdAt, now);
    var endedAt = source.endedAt ? validDate(source.endedAt, now) : null;
    var moves = Array.isArray(source.moves) ? source.moves : [];
    if (moves.length > 5000) throw new Error("棋谱超过 5000 手，拒绝载入");
    var normalizedMoves = moves.map(normalizeMove);
    var mode = MODES[source.mode] ? source.mode : "local";
    var meta = source.meta && typeof source.meta === "object" ? source.meta : {};
    var clocks = source.clocks && typeof source.clocks === "object" ? source.clocks : {};
    var fallbackDuration = endedAt
      ? Math.max(0, Date.parse(endedAt) - Date.parse(createdAt))
      : null;
    var record = {
      format: FORMAT,
      version: VERSION,
      id: recordId(source.id),
      createdAt: createdAt,
      updatedAt: new Date(now).toISOString(),
      endedAt: endedAt,
      mode: mode,
      rules: {
        variant: "xiangqi",
        initialFen: initialFen
      },
      players: players,
      result: normalizeResult(source.result),
      clocks: {
        durationMs: Math.max(0, finiteNumber(clocks.durationMs, fallbackDuration || 0)),
        halfmoveClock: Math.max(0, finiteNumber(clocks.halfmoveClock, 0))
      },
      moves: normalizedMoves,
      analysis: source.analysis && typeof source.analysis === "object"
        ? source.analysis : null,
      meta: {
        app: cleanText(meta.app, 40),
        engine: cleanText(meta.engine, 40),
        importedFrom: cleanText(
          options && options.importedFrom ? options.importedFrom : meta.importedFrom,
          80
        ),
        sourceVersion: version
      }
    };
    return seal(record);
  }

  function fromIccs(text, options) {
    var moves = parseIccsMoves(text);
    var now = new Date().toISOString();
    return normalize({
      format: FORMAT,
      version: VERSION,
      id: "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      createdAt: now,
      endedAt: null,
      mode: "replay",
      rules: { initialFen: INITIAL_FEN },
      players: {
        red: { kind: "human", name: "红方" },
        black: { kind: "human", name: "黑方" }
      },
      result: { type: "ongoing", winner: null, reason: "导入棋谱" },
      moves: moves,
      meta: { app: "import", engine: "", importedFrom: options && options.name }
    }, options);
  }

  function read(text, options) {
    var input = String(text || "").trim();
    if (!input) throw new Error("没有可导入的内容");
    if (input.charAt(0) === "{") {
      var parsed;
      try {
        parsed = JSON.parse(input);
      } catch (error) {
        throw new Error("JSON 解析失败：" + (error && error.message || "格式错误"));
      }
      return normalize(parsed, options);
    }
    return fromIccs(input, options);
  }

  function summary(record) {
    var result = record && record.result ? record.result : {};
    var resultText = "进行中";
    if (result.type === "draw") {
      resultText = "和棋" + (result.reason ? " · " + result.reason : "");
    } else if (result.type === "win") {
      var pattern = result.pattern && result.pattern.name;
      resultText = (result.winner === "r" ? "红方胜" : "黑方胜")
        + (result.reason ? " · " + result.reason : "")
        + (pattern ? " · " + pattern : "");
    }
    return {
      id: record.id,
      title: record.players.red.name + " 对 " + record.players.black.name,
      redName: record.players.red.name,
      blackName: record.players.black.name,
      resultText: resultText,
      winner: result.winner || null,
      moveCount: record.moves.length,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      endedAt: record.endedAt,
      durationMs: record.clocks.durationMs,
      mode: record.mode,
      checksum: record.checksum
    };
  }

  function exportText(record) {
    return JSON.stringify(normalize(record), null, 2);
  }

  var api = {
    FORMAT: FORMAT,
    VERSION: VERSION,
    INITIAL_FEN: INITIAL_FEN,
    boardToFen: boardToFen,
    moveToIccs: moveToIccs,
    parseIccs: parseIccs,
    parseIccsMoves: parseIccsMoves,
    checksum: checksumOf,
    seal: seal,
    normalize: normalize,
    read: read,
    fromIccs: fromIccs,
    summary: summary,
    exportText: exportText
  };

  root.XiangqiRecords = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
