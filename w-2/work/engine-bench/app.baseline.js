(() => {
  "use strict";

  const FILES = "abcdefghi";
  const RED = "r";
  const BLACK = "b";
  const MATE = 900000;
  const IS_WORKER = typeof window === "undefined";
  const GLOBAL_SCOPE = IS_WORKER ? self : window;
  const PIECE_NAMES = {
    r: "車",
    n: "馬",
    b: "象",
    a: "士",
    k: "將",
    c: "砲",
    p: "卒"
  };
  const PIECE_NAMES_RED = {
    r: "車",
    n: "馬",
    b: "相",
    a: "仕",
    k: "帥",
    c: "炮",
    p: "兵"
  };
  const PIECE_VALUES = {
    k: 60000,
    r: 1000,
    n: 440,
    b: 125,
    a: 125,
    c: 475,
    p: 85
  };
  const AI_LEVELS = {
    easy: {
      label: "入门",
      depth: 1,
      timeMs: 330,
      nodeLimit: 3500,
      randomness: 80,
      candidateCount: 6,
      blunderChance: 0.36,
      useBook: false,
      maxBookPly: 0
    },
    medium: {
      label: "初级",
      depth: 3,
      timeMs: 900,
      nodeLimit: 42000,
      randomness: 28,
      candidateCount: 3,
      blunderChance: 0.08,
      useBook: true,
      maxBookPly: 6
    },
    hard: {
      label: "中级",
      depth: 5,
      timeMs: 2600,
      nodeLimit: 190000,
      randomness: 8,
      candidateCount: 2,
      blunderChance: 0.01,
      useBook: true,
      maxBookPly: 12,
      nullMove: true,
      pvs: true,
      checkExtension: true,
      lmr: true
    },
    master: {
      label: "高级",
      depth: 7,
      timeMs: 6500,
      nodeLimit: 1200000,
      randomness: 0,
      candidateCount: 1,
      blunderChance: 0,
      useBook: true,
      maxBookPly: 20,
      nullMove: true,
      pvs: true,
      checkExtension: true,
      lmr: true
    }
  };
  const ANALYSIS_LEVEL = {
    depth: 4,
    timeMs: 2800,
    nodeLimit: 240000,
    candidates: 5,
    nullMove: true,
    pvs: true,
    checkExtension: true,
    lmr: true
  };
  const CURRENT_ANALYSIS_LEVEL = {
    depth: 3,
    timeMs: 1500,
    nodeLimit: 110000,
    candidates: 4,
    nullMove: true,
    pvs: true,
    checkExtension: true,
    lmr: true
  };
  const AI_DATA = GLOBAL_SCOPE.XiangqiAiData || {
    openingLines: [],
    endgamePatterns: []
  };

  const INITIAL_POSITION = createInitialBoard();

  function createInitialBoard() {
    const board = Array(90).fill(null);
    const put = (row, col, type, side) => {
      board[row * 9 + col] = { type, side };
    };

    put(0, 0, "r", BLACK);
    put(0, 1, "n", BLACK);
    put(0, 2, "b", BLACK);
    put(0, 3, "a", BLACK);
    put(0, 4, "k", BLACK);
    put(0, 5, "a", BLACK);
    put(0, 6, "b", BLACK);
    put(0, 7, "n", BLACK);
    put(0, 8, "r", BLACK);
    put(2, 1, "c", BLACK);
    put(2, 7, "c", BLACK);
    [0, 2, 4, 6, 8].forEach((col) => put(3, col, "p", BLACK));

    put(9, 0, "r", RED);
    put(9, 1, "n", RED);
    put(9, 2, "b", RED);
    put(9, 3, "a", RED);
    put(9, 4, "k", RED);
    put(9, 5, "a", RED);
    put(9, 6, "b", RED);
    put(9, 7, "n", RED);
    put(9, 8, "r", RED);
    put(7, 1, "c", RED);
    put(7, 7, "c", RED);
    [0, 2, 4, 6, 8].forEach((col) => put(6, col, "p", RED));
    return board;
  }

  function opposite(side) {
    return side === RED ? BLACK : RED;
  }

  function inside(row, col) {
    return row >= 0 && row < 10 && col >= 0 && col < 9;
  }

  function inPalace(side, row, col) {
    if (col < 3 || col > 5) return false;
    return side === RED ? row >= 7 && row <= 9 : row >= 0 && row <= 2;
  }

  function onOwnSide(side, row) {
    return side === RED ? row >= 5 : row <= 4;
  }

  function cloneBoard(board) {
    return board.map((piece) => (piece ? { type: piece.type, side: piece.side } : null));
  }

  function stateKey(board, side) {
    let key = side;
    for (const piece of board) {
      key += piece ? `${piece.side}${piece.type}` : ".";
    }
    return key;
  }

  function moveKey(move) {
    return `${move.from}-${move.to}`;
  }

  function pieceName(piece) {
    return piece.side === RED ? PIECE_NAMES_RED[piece.type] : PIECE_NAMES[piece.type];
  }

  function fileOf(col) {
    return FILES[col];
  }

  function squareName(square) {
    const row = Math.floor(square / 9);
    const col = square % 9;
    return `${fileOf(col)}${10 - row}`;
  }

  function squareFromName(name) {
    const col = FILES.indexOf(name[0]);
    const rank = Number(name.slice(1));
    if (col < 0 || !Number.isInteger(rank) || rank < 1 || rank > 10) return -1;
    return (10 - rank) * 9 + col;
  }

  function parseBookMove(token) {
    const parts = token.split("-");
    if (parts.length !== 2) return null;
    const from = squareFromName(parts[0]);
    const to = squareFromName(parts[1]);
    if (from < 0 || to < 0) return null;
    return { from, to };
  }

  function buildOpeningBook() {
    const book = new Map();
    for (const line of AI_DATA.openingLines || []) {
      let board = cloneBoard(INITIAL_POSITION);
      let side = RED;
      const lineWeight = Number(line.weight) || 1;
      for (let ply = 0; ply < line.moves.length; ply += 1) {
        const move = parseBookMove(line.moves[ply]);
        if (!move) break;
        const piece = board[move.from];
        if (!piece || piece.side !== side) break;
        const legal = generateLegalMoves(board, side)
          .some((candidate) => candidate.from === move.from && candidate.to === move.to);
        if (!legal) break;

        const key = stateKey(board, side);
        if (!book.has(key)) book.set(key, new Map());
        const positionBook = book.get(key);
        const keyMove = moveKey(move);
        const existing = positionBook.get(keyMove) || {
          move,
          weight: 0,
          lines: []
        };
        existing.weight += lineWeight * (1 + (line.moves.length - ply) / 40);
        existing.lines.push(line.name);
        positionBook.set(keyMove, existing);

        board = applyMove(board, move).board;
        side = opposite(side);
      }
    }
    return book;
  }

  const OPENING_BOOK = buildOpeningBook();

  function rankLabel(side, row) {
    return side === RED ? 10 - row : row + 1;
  }

  function columnLabel(side, col) {
    return side === RED ? 9 - col : col + 1;
  }

  function moveToNotation(board, move) {
    const piece = board[move.from];
    if (!piece) return "";
    const fromRow = Math.floor(move.from / 9);
    const fromCol = move.from % 9;
    const toRow = Math.floor(move.to / 9);
    const toCol = move.to % 9;
    const sameFile = [];

    for (let row = 0; row < 10; row += 1) {
      const index = row * 9 + fromCol;
      const candidate = board[index];
      if (candidate && candidate.side === piece.side && candidate.type === piece.type) {
        sameFile.push(row);
      }
    }

    let prefix;
    if (sameFile.length === 2) {
      const frontRow = piece.side === RED
        ? Math.min(...sameFile)
        : Math.max(...sameFile);
      prefix = `${fromRow === frontRow ? "前" : "后"}${pieceName(piece)}`;
    } else {
      prefix = `${pieceName(piece)}${columnLabel(piece.side, fromCol)}`;
    }

    if (fromRow === toRow) {
      return `${prefix}平${columnLabel(piece.side, toCol)}`;
    }

    const forward = piece.side === RED ? toRow < fromRow : toRow > fromRow;
    const direction = forward ? "进" : "退";
    if (piece.type === "n" || piece.type === "b" || piece.type === "a") {
      return `${prefix}${direction}${columnLabel(piece.side, toCol)}`;
    }
    return `${prefix}${direction}${Math.abs(toRow - fromRow)}`;
  }

  function addMove(moves, from, to) {
    moves.push({ from, to });
  }

  function pawnAttacks(row, col, side, targetRow, targetCol) {
    const forward = side === RED ? -1 : 1;
    if (row + forward === targetRow && col === targetCol) return true;
    if ((side === RED ? row <= 4 : row >= 5) && row === targetRow) {
      return Math.abs(col - targetCol) === 1;
    }
    return false;
  }

  function kingAttacks(row, col, side, targetRow, targetCol) {
    if (!inPalace(side, targetRow, targetCol)) return false;
    return Math.abs(row - targetRow) + Math.abs(col - targetCol) === 1;
  }

  function advisorAttacks(row, col, targetRow, targetCol) {
    return Math.abs(row - targetRow) === 1 && Math.abs(col - targetCol) === 1;
  }

  function elephantAttacks(board, row, col, side, targetRow, targetCol) {
    if (Math.abs(row - targetRow) !== 2 || Math.abs(col - targetCol) !== 2) return false;
    if (!onOwnSide(side, targetRow)) return false;
    const eyeRow = (row + targetRow) / 2;
    const eyeCol = (col + targetCol) / 2;
    return !board[eyeRow * 9 + eyeCol];
  }

  function horseAttacks(board, row, col, targetRow, targetCol) {
    const dr = targetRow - row;
    const dc = targetCol - col;
    let legRow = row;
    let legCol = col;
    if (Math.abs(dr) === 2 && Math.abs(dc) === 1) {
      legRow = row + dr / 2;
      legCol = col;
    } else if (Math.abs(dr) === 1 && Math.abs(dc) === 2) {
      legRow = row;
      legCol = col + dc / 2;
    } else {
      return false;
    }
    return !board[legRow * 9 + legCol];
  }

  function rookAttacks(board, row, col, targetRow, targetCol) {
    if (row !== targetRow && col !== targetCol) return false;
    const rowStep = Math.sign(targetRow - row);
    const colStep = Math.sign(targetCol - col);
    let nextRow = row + rowStep;
    let nextCol = col + colStep;
    while (nextRow !== targetRow || nextCol !== targetCol) {
      if (board[nextRow * 9 + nextCol]) return false;
      nextRow += rowStep;
      nextCol += colStep;
    }
    return true;
  }

  function cannonAttacks(board, row, col, targetRow, targetCol) {
    if (row !== targetRow && col !== targetCol) return false;
    const rowStep = Math.sign(targetRow - row);
    const colStep = Math.sign(targetCol - col);
    let nextRow = row + rowStep;
    let nextCol = col + colStep;
    let screen = false;
    while (nextRow !== targetRow || nextCol !== targetCol) {
      if (board[nextRow * 9 + nextCol]) {
        if (screen) return false;
        screen = true;
      }
      nextRow += rowStep;
      nextCol += colStep;
    }
    return screen;
  }

  function attacksSquare(board, from, target) {
    const piece = board[from];
    if (!piece) return false;
    const row = Math.floor(from / 9);
    const col = from % 9;
    const targetRow = Math.floor(target / 9);
    const targetCol = target % 9;

    if (piece.type === "p") return pawnAttacks(row, col, piece.side, targetRow, targetCol);
    if (piece.type === "k") return kingAttacks(row, col, piece.side, targetRow, targetCol);
    if (piece.type === "a") return advisorAttacks(row, col, targetRow, targetCol);
    if (piece.type === "b") return elephantAttacks(board, row, col, piece.side, targetRow, targetCol);
    if (piece.type === "n") return horseAttacks(board, row, col, targetRow, targetCol);
    if (piece.type === "r") return rookAttacks(board, row, col, targetRow, targetCol);
    if (piece.type === "c") return cannonAttacks(board, row, col, targetRow, targetCol);
    return false;
  }

  function findKing(board, side) {
    for (let index = 0; index < 90; index += 1) {
      const piece = board[index];
      if (piece && piece.side === side && piece.type === "k") return index;
    }
    return -1;
  }

  function generalsFace(board) {
    const redKing = findKing(board, RED);
    const blackKing = findKing(board, BLACK);
    if (redKing < 0 || blackKing < 0) return false;
    const redCol = redKing % 9;
    const blackCol = blackKing % 9;
    if (redCol !== blackCol) return false;
    const top = Math.min(Math.floor(redKing / 9), Math.floor(blackKing / 9));
    const bottom = Math.max(Math.floor(redKing / 9), Math.floor(blackKing / 9));
    for (let row = top + 1; row < bottom; row += 1) {
      if (board[row * 9 + redCol]) return false;
    }
    return true;
  }

  function isInCheck(board, side) {
    const king = findKing(board, side);
    if (king < 0) return true;
    const enemy = opposite(side);
    for (let index = 0; index < 90; index += 1) {
      const piece = board[index];
      if (piece && piece.side === enemy && attacksSquare(board, index, king)) {
        return true;
      }
    }
    return false;
  }

  function legalAfterMove(board, move, piece) {
    const next = cloneBoard(board);
    const target = next[move.to];
    if (target && target.type === "k") return null;
    next[move.to] = piece;
    next[move.from] = null;
    if (generalsFace(next) || isInCheck(next, piece.side)) return null;
    return next;
  }

  function generatePseudoMoves(board, side) {
    const moves = [];
    for (let from = 0; from < 90; from += 1) {
      const piece = board[from];
      if (!piece || piece.side !== side) continue;
      const row = Math.floor(from / 9);
      const col = from % 9;

      const addIfAvailable = (toRow, toCol) => {
        if (!inside(toRow, toCol)) return;
        const to = toRow * 9 + toCol;
        const target = board[to];
        if (target && target.side === side) return;
        if (target && target.type === "k") return;
        addMove(moves, from, to);
      };

      if (piece.type === "p") {
        addIfAvailable(row + (side === RED ? -1 : 1), col);
        if (side === RED ? row <= 4 : row >= 5) {
          addIfAvailable(row, col - 1);
          addIfAvailable(row, col + 1);
        }
      } else if (piece.type === "k") {
        [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1]
        ].forEach(([dr, dc]) => {
          const nextRow = row + dr;
          const nextCol = col + dc;
          if (inPalace(side, nextRow, nextCol)) addIfAvailable(nextRow, nextCol);
        });
      } else if (piece.type === "a") {
        [
          [-1, -1],
          [-1, 1],
          [1, -1],
          [1, 1]
        ].forEach(([dr, dc]) => {
          const nextRow = row + dr;
          const nextCol = col + dc;
          if (inPalace(side, nextRow, nextCol)) addIfAvailable(nextRow, nextCol);
        });
      } else if (piece.type === "b") {
        [
          [-2, -2],
          [-2, 2],
          [2, -2],
          [2, 2]
        ].forEach(([dr, dc]) => {
          const nextRow = row + dr;
          const nextCol = col + dc;
          if (!inside(nextRow, nextCol) || !onOwnSide(side, nextRow)) return;
          if (board[(row + dr / 2) * 9 + col + dc / 2]) return;
          addIfAvailable(nextRow, nextCol);
        });
      } else if (piece.type === "n") {
        [
          [-2, -1, -1, 0],
          [-2, 1, -1, 0],
          [2, -1, 1, 0],
          [2, 1, 1, 0],
          [-1, -2, 0, -1],
          [1, -2, 0, -1],
          [-1, 2, 0, 1],
          [1, 2, 0, 1]
        ].forEach(([dr, dc, lr, lc]) => {
          const nextRow = row + dr;
          const nextCol = col + dc;
          if (!inside(nextRow, nextCol)) return;
          if (board[(row + lr) * 9 + col + lc]) return;
          addIfAvailable(nextRow, nextCol);
        });
      } else if (piece.type === "r" || piece.type === "c") {
        const directions = [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1]
        ];
        directions.forEach(([dr, dc]) => {
          let nextRow = row + dr;
          let nextCol = col + dc;
          let screen = false;
          while (inside(nextRow, nextCol)) {
            const to = nextRow * 9 + nextCol;
            const target = board[to];
            if (piece.type === "r") {
              if (!target) {
                addIfAvailable(nextRow, nextCol);
              } else {
                if (target.side !== side && target.type !== "k") addMove(moves, from, to);
                break;
              }
            } else if (!screen) {
              if (!target) {
                addIfAvailable(nextRow, nextCol);
              } else {
                screen = true;
              }
            } else if (target) {
              if (target.side !== side && target.type !== "k") addMove(moves, from, to);
              break;
            }
            nextRow += dr;
            nextCol += dc;
          }
        });
      }
    }
    return moves;
  }

  function generateLegalMoves(board, side) {
    const legal = [];
    for (const move of generatePseudoMoves(board, side)) {
      const piece = board[move.from];
      if (legalAfterMove(board, move, piece)) legal.push(move);
    }
    return legal;
  }

  function applyMove(board, move) {
    const next = cloneBoard(board);
    const piece = next[move.from];
    const captured = next[move.to];
    next[move.to] = piece;
    next[move.from] = null;
    return { board: next, piece, captured };
  }

  function perft(board, side, depth) {
    if (depth === 0) return 1;
    let nodes = 0;
    for (const move of generateLegalMoves(board, side)) {
      const next = applyMove(board, move).board;
      nodes += perft(next, opposite(side), depth - 1);
    }
    return nodes;
  }

  class XiangqiGame {
    constructor(options = {}) {
      this.reset(options);
    }

    reset() {
      this.board = cloneBoard(INITIAL_POSITION);
      this.sideToMove = RED;
      this.history = [];
      this.positionCounts = Object.create(null);
      this.positionCounts[stateKey(this.board, this.sideToMove)] = 1;
      this.halfmoveClock = 0;
      this.result = {
        type: "ongoing",
        winner: null,
        reason: ""
      };
    }

    snapshot() {
      return {
        board: cloneBoard(this.board),
        sideToMove: this.sideToMove,
        history: this.history.map((record) => ({ ...record })),
        positionCounts: { ...this.positionCounts },
        halfmoveClock: this.halfmoveClock,
        result: { ...this.result }
      };
    }

    restore(snapshot) {
      this.board = cloneBoard(snapshot.board);
      this.sideToMove = snapshot.sideToMove;
      this.history = snapshot.history.map((record) => ({ ...record }));
      this.positionCounts = { ...snapshot.positionCounts };
      this.halfmoveClock = snapshot.halfmoveClock;
      this.result = { ...snapshot.result };
    }

    play(from, to) {
      if (this.result.type !== "ongoing") {
        throw new Error("对局已经结束");
      }
      const piece = this.board[from];
      if (!piece || piece.side !== this.sideToMove) {
        throw new Error("当前不能移动该棋子");
      }
      const legalMove = generateLegalMoves(this.board, this.sideToMove)
        .find((move) => move.from === from && move.to === to);
      if (!legalMove) {
        throw new Error("该着法不合法");
      }

      const notation = moveToNotation(this.board, legalMove);
      const positionBefore = stateKey(this.board, this.sideToMove);
      const applied = applyMove(this.board, legalMove);
      const movingSide = piece.side;
      this.board = applied.board;
      this.sideToMove = opposite(this.sideToMove);
      this.halfmoveClock = applied.captured || piece.type === "p"
        ? 0
        : this.halfmoveClock + 1;

      const positionAfter = stateKey(this.board, this.sideToMove);
      this.positionCounts[positionAfter] = (this.positionCounts[positionAfter] || 0) + 1;

      const record = {
        index: this.history.length,
        from,
        to,
        piece: { ...piece },
        captured: applied.captured ? { ...applied.captured } : null,
        side: movingSide,
        notation,
        moveNumber: Math.ceil((this.history.length + 1) / 2),
        positionBefore,
        positionAfter,
        analysis: null,
        chosen: null,
        quality: null
      };
      this.history.push(record);
      this.updateResult();
      return record;
    }

    updateResult() {
      const legal = generateLegalMoves(this.board, this.sideToMove);
      if (legal.length === 0) {
        this.result = {
          type: "win",
          winner: opposite(this.sideToMove),
          reason: isInCheck(this.board, this.sideToMove) ? "绝杀" : "困毙"
        };
        return;
      }

      const counts = countMaterial(this.board);
      if (!hasAttackingMaterial(counts[RED]) && !hasAttackingMaterial(counts[BLACK])) {
        this.result = {
          type: "draw",
          winner: null,
          reason: "双方无进攻子力"
        };
        return;
      }

      if (this.halfmoveClock >= 120) {
        this.result = {
          type: "draw",
          winner: null,
          reason: "六十回合未吃子"
        };
        return;
      }

      const key = stateKey(this.board, this.sideToMove);
      if ((this.positionCounts[key] || 0) >= 3) {
        this.result = {
          type: "draw",
          winner: null,
          reason: "三次重复局面"
        };
      }
    }

    undo(count = 1) {
      const kept = this.history.slice(0, Math.max(0, this.history.length - count));
      const preserved = kept.map((record) => ({
        analysis: record.analysis,
        afterAnalysis: record.afterAnalysis,
        chosen: record.chosen,
        winRedAfter: record.winRedAfter,
        evalRedAfter: record.evalRedAfter,
        quality: record.quality
      }));
      this.reset();
      kept.forEach((record) => {
        this.play(record.from, record.to);
      });
      preserved.forEach((meta, index) => {
        Object.assign(this.history[index], meta);
      });
      return Math.min(count, this.history.length + count);
    }
  }

  function sideValueFromPiece(piece) {
    return PIECE_VALUES[piece.type] || 0;
  }

  function countMaterial(board) {
    const counts = {
      [RED]: { r: 0, n: 0, b: 0, a: 0, k: 0, c: 0, p: 0 },
      [BLACK]: { r: 0, n: 0, b: 0, a: 0, k: 0, c: 0, p: 0 }
    };
    for (const piece of board) {
      if (piece) counts[piece.side][piece.type] += 1;
    }
    return counts;
  }

  function materialSignature(counts) {
    return ["r", "n", "c", "p", "a", "b"]
      .map((type) => type.repeat(counts[type]))
      .join("");
  }

  function hasAttackingMaterial(counts) {
    return counts.r + counts.n + counts.c + counts.p > 0;
  }

  function isEndgamePosition(counts) {
    const redAttackers = counts[RED].r + counts[RED].n + counts[RED].c + counts[RED].p;
    const blackAttackers = counts[BLACK].r + counts[BLACK].n + counts[BLACK].c + counts[BLACK].p;
    const totalPieces = Object.values(counts[RED]).reduce((sum, value) => sum + value, 0)
      + Object.values(counts[BLACK]).reduce((sum, value) => sum + value, 0);
    return totalPieces <= 14 || redAttackers + blackAttackers <= 7;
  }

  function endgameKnowledgeScore(board, side, knownCounts = null) {
    const counts = knownCounts || countMaterial(board);
    const own = materialSignature(counts[side]);
    const enemy = materialSignature(counts[opposite(side)]);
    let score = 0;
    let matchedPattern = false;

    for (const pattern of AI_DATA.endgamePatterns || []) {
      if (own === pattern.strong && enemy === pattern.weak) {
        score += pattern.bonus;
        matchedPattern = true;
      } else if (own === pattern.weak && enemy === pattern.strong) {
        score -= pattern.bonus;
        matchedPattern = true;
      }
    }

    if (matchedPattern) return score;

    const ownAttackers = hasAttackingMaterial(counts[side]);
    const enemyAttackers = hasAttackingMaterial(counts[opposite(side)]);
    if (!ownAttackers && !enemyAttackers) return 0;
    if (ownAttackers && !enemyAttackers) score += 260;
    if (!ownAttackers && enemyAttackers) score -= 260;
    return score;
  }

  function endgameAdjustment(board, side, counts) {
    let score = 0;
    for (let index = 0; index < 90; index += 1) {
      const piece = board[index];
      if (!piece) continue;
      const sign = piece.side === side ? 1 : -1;
      if (piece.type === "p") {
        score += sign * 42;
      } else if (piece.type === "n") {
        score += sign * 22;
      } else if (piece.type === "c") {
        const supports = counts[piece.side].a + counts[piece.side].b;
        score += sign * (18 + Math.min(4, supports) * 16);
      } else if (piece.type === "a" || piece.type === "b") {
        score -= sign * 15;
      }
    }
    return score;
  }

  function positionalBonus(piece, row, col, board) {
    const center = 4 - Math.abs(col - 4);
    let score = 0;

    if (piece.type === "p") {
      const advance = piece.side === RED ? 9 - row : row;
      score += advance * 11;
      if (piece.side === RED ? row <= 4 : row >= 5) score += 36;
      score += center * 3;
    } else if (piece.type === "n" || piece.type === "c") {
      score += center * 7;
      if (piece.type === "n") {
        score += piece.side === RED ? (9 - row) * 2 : row * 2;
      }
    } else if (piece.type === "r") {
      score += 12;
      let friendlyPawnsOnFile = 0;
      for (let r = 0; r < 10; r += 1) {
        const candidate = board[r * 9 + col];
        if (candidate && candidate.side === piece.side && candidate.type === "p") {
          friendlyPawnsOnFile += 1;
        }
      }
      if (friendlyPawnsOnFile === 0) score += 16;
    } else if (piece.type === "a" || piece.type === "b") {
      score += 8;
    }
    return score;
  }

  function evaluateBoard(board, side) {
    let score = 0;
    const counts = countMaterial(board);
    const endgame = isEndgamePosition(counts);
    for (let index = 0; index < 90; index += 1) {
      const piece = board[index];
      if (!piece) continue;
      const row = Math.floor(index / 9);
      const col = index % 9;
      const material = sideValueFromPiece(piece) + positionalBonus(piece, row, col, board);
      score += piece.side === side ? material : -material;
    }

    if (endgame) {
      score += endgameAdjustment(board, side, counts);
      score += endgameKnowledgeScore(board, side, counts);
    }

    const ownMobility = generatePseudoMoves(board, side).length;
    const enemyMobility = generatePseudoMoves(board, opposite(side)).length;
    score += (ownMobility - enemyMobility) * 2;
    if (isInCheck(board, opposite(side))) score += 32;
    if (isInCheck(board, side)) score -= 38;
    return score;
  }

  function orderedMoves(board, moves, context, ply = 0, ttMove = null) {
    const ttKey = ttMove ? moveKey(ttMove) : "";
    const killers = context?.killers?.[ply] || [];
    return moves.slice().sort((a, b) => {
      const aKey = moveKey(a);
      const bKey = moveKey(b);
      if (aKey === ttKey) return -1;
      if (bKey === ttKey) return 1;
      const aTarget = board[a.to];
      const bTarget = board[b.to];
      const aScore = aTarget ? sideValueFromPiece(aTarget) * 10 - sideValueFromPiece(board[a.from]) : 0;
      const bScore = bTarget ? sideValueFromPiece(bTarget) * 10 - sideValueFromPiece(board[b.from]) : 0;
      if (aScore !== bScore) return bScore - aScore;
      const aKiller = killers.includes(aKey) ? 1 : 0;
      const bKiller = killers.includes(bKey) ? 1 : 0;
      if (aKiller !== bKiller) return bKiller - aKiller;
      const aHistory = context?.history?.[a.from * 90 + a.to] || 0;
      const bHistory = context?.history?.[b.from * 90 + b.to] || 0;
      if (aHistory !== bHistory) return bHistory - aHistory;
      return a.from - b.from || a.to - b.to;
    });
  }

  function hasNullMoveMaterial(board, side) {
    let attackers = 0;
    for (const piece of board) {
      if (piece && (piece.side === side || piece.side === opposite(side))
        && (piece.type === "r" || piece.type === "n" || piece.type === "c" || piece.type === "p")) {
        attackers += 1;
      }
    }
    return attackers >= 6;
  }

  function createSearchContext(settings, startedAt) {
    return {
      nodes: 0,
      deadline: startedAt + settings.timeMs,
      nodeLimit: settings.nodeLimit,
      cache: new Map(),
      killers: Array.from({ length: 80 }, () => []),
      history: new Int32Array(90 * 90),
      aborted: false,
      nullMove: Boolean(settings.nullMove),
      pvs: Boolean(settings.pvs),
      checkExtension: Boolean(settings.checkExtension),
      lmr: Boolean(settings.lmr),
      qDepth: settings.qDepth ?? 3
    };
  }

  function storeKiller(context, ply, move) {
    if (!context.killers[ply]) context.killers[ply] = [];
    const key = moveKey(move);
    const killers = context.killers[ply];
    if (killers[0] === key) return;
    killers.unshift(key);
    if (killers.length > 2) killers.length = 2;
  }

  function quiescence(board, side, alpha, beta, ply, context, extraDepth) {
    context.nodes += 1;
    if (context.nodes >= context.nodeLimit || performance.now() >= context.deadline) {
      context.aborted = true;
      return evaluateBoard(board, side);
    }

    const checked = isInCheck(board, side);
    const legal = generateLegalMoves(board, side);
    if (legal.length === 0) return -MATE + ply;

    const standPat = checked ? -Infinity : evaluateBoard(board, side);
    const hardLimit = checked ? context.qDepth + 1 : context.qDepth;
    if (!checked) {
      if (extraDepth >= hardLimit) return standPat;
      if (standPat >= beta) return beta;
      alpha = Math.max(alpha, standPat);
    } else if (extraDepth >= hardLimit) {
      return evaluateBoard(board, side);
    }

    const candidates = orderedMoves(
      board,
      checked ? legal : legal.filter((move) => Boolean(board[move.to])),
      context,
      ply
    );
    if (candidates.length === 0) return standPat;

    let best = standPat;
    for (const move of candidates) {
      const applied = applyMove(board, move);
      const score = -quiescence(
        applied.board,
        opposite(side),
        -beta,
        -alpha,
        ply + 1,
        context,
        extraDepth + 1
      );
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  function negamax(board, side, depth, alpha, beta, ply, context, allowNull = true) {
    context.nodes += 1;
    if (context.nodes >= context.nodeLimit || performance.now() >= context.deadline) {
      context.aborted = true;
      return evaluateBoard(board, side);
    }

    const originalAlpha = alpha;
    const key = stateKey(board, side);
    const cached = context.cache.get(key);
    const ttMove = cached?.move || null;
    if (cached && cached.depth >= depth) {
      if (cached.flag === "exact") return cached.score;
      if (cached.flag === "lower") alpha = Math.max(alpha, cached.score);
      else if (cached.flag === "upper") beta = Math.min(beta, cached.score);
      if (alpha >= beta) return cached.score;
    }

    const checked = isInCheck(board, side);
    const searchDepth = checked && context.checkExtension ? depth + 1 : depth;
    if (searchDepth <= 0 && !checked) {
      return quiescence(board, side, alpha, beta, ply, context, 0);
    }

    const moves = orderedMoves(board, generateLegalMoves(board, side), context, ply, ttMove);
    if (moves.length === 0) return -MATE + ply;

    if (
      context.nullMove &&
      allowNull &&
      !checked &&
      searchDepth >= 3 &&
      ply > 0 &&
      beta < MATE &&
      beta > -MATE &&
      hasNullMoveMaterial(board, side)
    ) {
      const nullScore = -negamax(
        board,
        opposite(side),
        searchDepth - 3,
        -beta,
        -beta + 1,
        ply + 1,
        context,
        false
      );
      if (nullScore >= beta) return nullScore;
    }

    let best = -Infinity;
    let bestMove = null;
    let moveIndex = 0;

    for (const move of moves) {
      const applied = applyMove(board, move);
      const givesCheck = isInCheck(applied.board, opposite(side));
      const quiet = !applied.captured;
      let reduction = 0;
      if (
        context.lmr &&
        !checked &&
        searchDepth >= 3 &&
        moveIndex >= 4 &&
        quiet &&
        !givesCheck
      ) {
        reduction = 1;
      }

      let score;
      if (moveIndex === 0 || !context.pvs) {
        score = -negamax(
          applied.board,
          opposite(side),
          searchDepth - 1 - reduction,
          -beta,
          -alpha,
          ply + 1,
          context
        );
      } else {
        score = -negamax(
          applied.board,
          opposite(side),
          searchDepth - 1 - reduction,
          -alpha - 1,
          -alpha,
          ply + 1,
          context
        );
        if (score > alpha && score < beta) {
          score = -negamax(
            applied.board,
            opposite(side),
            searchDepth - 1,
            -beta,
            -alpha,
            ply + 1,
            context
          );
        }
      }

      if (score > best) {
        best = score;
        bestMove = move;
      }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        if (quiet) {
          storeKiller(context, ply, move);
          context.history[move.from * 90 + move.to] += searchDepth * searchDepth;
        }
        break;
      }
      moveIndex += 1;
    }

    const flag = best <= originalAlpha ? "upper" : best >= beta ? "lower" : "exact";
    context.cache.set(key, {
      depth: searchDepth,
      score: best,
      move: bestMove,
      flag
    });
    return best;
  }

  function fallbackRootRanking(board, side, moves) {
    return moves.map((move) => {
      const applied = applyMove(board, move);
      return {
        move,
        score: -evaluateBoard(applied.board, opposite(side))
      };
    }).sort((a, b) => b.score - a.score);
  }

  function searchRoot(board, side, settings, context) {
    const legal = generateLegalMoves(board, side);
    if (legal.length === 0) return { ranked: [], depth: 0, aborted: false };
    let ranked = fallbackRootRanking(board, side, legal);
    let completedDepth = 0;

    for (let depth = 1; depth <= settings.depth; depth += 1) {
      if (context.aborted || context.deadline - performance.now() < 45) break;
      const ordered = ranked.map((entry) => entry.move);
      const current = [];
      let iterationComplete = true;

      for (const move of ordered) {
        const applied = applyMove(board, move);
        const score = -negamax(
          applied.board,
          opposite(side),
          depth - 1,
          -Infinity,
          Infinity,
          1,
          context
        );
        current.push({ move, score });
        if (context.aborted) {
          iterationComplete = false;
          break;
        }
      }

      if (!iterationComplete) break;
      current.sort((a, b) => b.score - a.score);
      ranked = current;
      completedDepth = depth;
      if (ranked[0]?.score >= MATE - 1000) break;
    }

    return {
      ranked,
      depth: completedDepth || 1,
      aborted: context.aborted
    };
  }

  function searchMoveSubset(board, side, requestedMoves, settings) {
    const legal = generateLegalMoves(board, side);
    const requested = new Set(
      requestedMoves.map((move) => `${move.from}-${move.to}`)
    );
    const moves = legal.filter((move) => requested.has(moveKey(move)));
    if (moves.length === 0) return { ranked: [], depth: 0, nodes: 0, aborted: false };

    const context = createSearchContext(settings, performance.now());
    let ranked = fallbackRootRanking(board, side, moves);
    let completedDepth = 0;

    for (let depth = 1; depth <= settings.depth; depth += 1) {
      if (context.aborted || context.deadline - performance.now() < 45) break;
      const current = [];
      let iterationComplete = true;

      for (const entry of ranked) {
        const applied = applyMove(board, entry.move);
        const score = -negamax(
          applied.board,
          opposite(side),
          depth - 1,
          -Infinity,
          Infinity,
          1,
          context
        );
        current.push({ move: entry.move, score });
        if (context.aborted) {
          iterationComplete = false;
          break;
        }
      }

      if (!iterationComplete) break;
      current.sort((a, b) => b.score - a.score);
      ranked = current;
      completedDepth = depth;
      if (ranked[0]?.score >= MATE - 1000) break;
    }

    return {
      ranked,
      depth: completedDepth || 1,
      nodes: context.nodes,
      aborted: context.aborted
    };
  }

  function analyzePosition(board, side, options = {}) {
    const settings = {
      depth: options.depth ?? 4,
      candidates: options.candidates ?? 5,
      nodeLimit: options.nodeLimit ?? 240000,
      timeMs: options.timeMs ?? 2800,
      nullMove: options.nullMove,
      pvs: options.pvs,
      checkExtension: options.checkExtension,
      lmr: options.lmr,
      qDepth: options.qDepth
    };
    const moves = generateLegalMoves(board, side);
    if (moves.length === 0) {
      const redWin = isInCheck(board, side)
        ? (side === RED ? 0 : 100)
        : (side === RED ? 0 : 100);
      return {
        side,
        score: -MATE,
        evalRed: side === RED ? -MATE : MATE,
        winRed: redWin,
        bestMove: null,
        candidates: [],
        nodes: 0,
        depth: settings.depth,
        terminal: true
      };
    }

    const started = performance.now();
    const context = createSearchContext(settings, started);
    const search = searchRoot(board, side, settings, context);
    const ranked = search.ranked.map((entry) => ({
      ...entry,
      evalRed: side === RED ? entry.score : -entry.score,
      winRed: scoreToRedWin(entry.score, side)
    }));
    const bestScore = ranked[0]?.score ?? evaluateBoard(board, side);
    const evalRed = side === RED ? bestScore : -bestScore;
    return {
      side,
      score: bestScore,
      evalRed,
      winRed: clamp(scoreToRedWin(bestScore, side), 0.5, 99.5),
      bestMove: ranked[0]?.move ?? null,
      bestNotation: ranked[0] ? moveToNotation(board, ranked[0].move) : "",
      candidates: ranked.slice(0, settings.candidates),
      moveScores: ranked,
      nodes: context.nodes,
      depth: search.depth,
      elapsed: Math.round(performance.now() - started),
      terminal: false
    };
  }

  function scoreToRedWin(score, side) {
    const cp = side === RED ? score : -score;
    return cpToWin(cp);
  }

  function cpToWin(cp) {
    if (cp >= MATE - 10000) return 99.5;
    if (cp <= -MATE + 10000) return 0.5;
    const raw = 100 / (1 + Math.exp(-cp / 350));
    return clamp(raw, 0.5, 99.5);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function chooseOpeningBookMove(game, level, levelKey) {
    if (!level.useBook || game.history.length >= level.maxBookPly) return null;
    const entries = OPENING_BOOK.get(stateKey(game.board, game.sideToMove));
    if (!entries || entries.size === 0) return null;
    const legal = generateLegalMoves(game.board, game.sideToMove);
    const candidates = [...entries.values()].filter((entry) => (
      legal.some((move) => move.from === entry.move.from && move.to === entry.move.to)
    ));
    if (candidates.length === 0) return null;

    if (levelKey === "master" || levelKey === "hard") {
      candidates.sort((a, b) => b.weight - a.weight);
      return candidates[0].move;
    }

    const total = candidates.reduce((sum, entry) => sum + entry.weight, 0);
    let pick = Math.random() * total;
    for (const entry of candidates) {
      pick -= entry.weight;
      if (pick <= 0) return entry.move;
    }
    return candidates[0].move;
  }

  function chooseAIMove(game, levelKey) {
    const level = AI_LEVELS[levelKey] || AI_LEVELS.medium;
    const board = game.board;
    const side = game.sideToMove;
    const bookMove = chooseOpeningBookMove(game, level, levelKey);
    if (bookMove) return bookMove;

    const moves = generateLegalMoves(board, side);
    if (moves.length === 0) return null;

    const started = performance.now();
    const context = createSearchContext(level, started);
    const search = searchRoot(board, side, level, context);
    const ranked = search.ranked;
    if (ranked.length === 0) return moves[0];

    const poolSize = Math.min(ranked.length, Math.max(1, level.candidateCount));
    let pool = ranked.slice(0, poolSize);
    if (Math.random() < level.blunderChance) {
      pool = ranked.slice(0, Math.min(ranked.length, poolSize + 4));
    }

    const weights = pool.map((entry, index) => {
      const rankWeight = Math.max(1, pool.length - index);
      const noise = 1 + Math.random() * (level.randomness / 18);
      return rankWeight * noise;
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let pick = Math.random() * total;
    for (let index = 0; index < pool.length; index += 1) {
      pick -= weights[index];
      if (pick <= 0) return pool[index].move;
    }
    return pool[0].move;
  }

  function qualityForRecord(record, analysis) {
    if (!analysis || !analysis.candidates.length) {
      return {
        score: 0,
        label: "未分析",
        detail: "当前着法尚未完成分析。",
        css: "empty",
        bestRate: null,
        chosenRate: null
      };
    }
    const allScores = analysis.moveScores?.length ? analysis.moveScores : analysis.candidates;
    const best = allScores[0];
    const chosen = allScores.find((candidate) => (
      candidate.move.from === record.from && candidate.move.to === record.to
    ));
    if (!chosen) {
      return {
        score: 0,
        label: "未分析",
        detail: "没有找到该着法的搜索结果。",
        css: "empty",
        bestRate: analysis.winRed,
        chosenRate: null
      };
    }
    const bestRate = record.side === RED ? analysis.winRed : 100 - analysis.winRed;
    const chosenRedRate = chosen.winRed;
    const chosenRate = record.side === RED ? chosenRedRate : 100 - chosenRedRate;
    const loss = Math.max(0, bestRate - chosenRate);
    const score = clamp(100 - loss * 2.2, 0, 100);
    let label;
    let css;
    let detail = `相对最佳着法损失 ${loss.toFixed(1)} 个百分点。`;

    if (
      (chosen.move.from === best.move.from && chosen.move.to === best.move.to) ||
      loss <= 0.25
    ) {
      label = "最佳";
      css = "best";
      detail = "与引擎首选着法一致。";
    } else if (loss <= 1) {
      label = "神准";
      css = "excellent";
    } else if (loss <= 2.5) {
      label = "优秀";
      css = "good";
    } else if (loss <= 5) {
      label = "良好";
      css = "solid";
    } else if (loss <= 8) {
      label = "稳健";
      css = "stable";
    } else if (loss <= 12) {
      label = "一般";
      css = "okay";
    } else if (loss <= 18) {
      label = "欠佳";
      css = "inaccuracy";
    } else if (loss <= 28) {
      label = "失误";
      css = "mistake";
    } else if (loss <= 40) {
      label = "严重失误";
      css = "blunder";
    } else {
      label = "败着";
      css = "losing";
    }

    return {
      score,
      label,
      detail,
      css,
      bestRate,
      chosenRate,
      chosenRedRate
    };
  }

  function formatEval(cp) {
    if (cp >= MATE - 10000) return "胜势";
    if (cp <= -MATE + 10000) return "败势";
    const value = cp / 100;
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
  }

  function formatNotation(record) {
    return `${record.moveNumber}. ${record.side === RED ? "" : "…"}${record.notation}`;
  }

  function positionAtPly(history, ply) {
    let board = cloneBoard(INITIAL_POSITION);
    for (let index = 0; index < ply; index += 1) {
      board = applyMove(board, history[index]).board;
    }
    return board;
  }

  function setupEngineWorker() {
    self.onmessage = (event) => {
      const request = event.data;
      if (!request || request.type !== "search-shard") return;
      try {
        const settings = {
          depth: request.settings?.depth ?? 4,
          timeMs: request.settings?.timeMs ?? 1200,
          nodeLimit: request.settings?.nodeLimit ?? 120000,
          nullMove: Boolean(request.settings?.nullMove),
          pvs: Boolean(request.settings?.pvs),
          checkExtension: Boolean(request.settings?.checkExtension),
          lmr: Boolean(request.settings?.lmr),
          qDepth: request.settings?.qDepth
        };
        const result = searchMoveSubset(
          request.board,
          request.side,
          request.moves || [],
          settings
        );
        const ranked = result.ranked.map((entry) => ({
          move: entry.move,
          score: entry.score,
          evalRed: request.side === RED ? entry.score : -entry.score,
          winRed: scoreToRedWin(entry.score, request.side)
        }));
        self.postMessage({
          type: "search-result",
          id: request.id,
          ranked,
          depth: result.depth,
          nodes: result.nodes,
          aborted: result.aborted
        });
      } catch (error) {
        self.postMessage({
          type: "search-error",
          id: request.id,
          message: error?.message || String(error)
        });
      }
    };
    self.postMessage({ type: "worker-ready" });
  }

  if (IS_WORKER) {
    setupEngineWorker();
  } else {
  const WORKER_COUNT = Math.max(
    2,
    Math.min(4, (navigator.hardwareConcurrency || 4) - 1)
  );
  let enginePool = null;

  class EngineWorkerPool {
    constructor(size) {
      this.size = size;
      this.workers = [];
      this.idle = [];
      this.pending = new Map();
      this.queue = [];
      this.nextId = 1;
      this.failed = false;
      for (let index = 0; index < size; index += 1) {
        const worker = this.createWorker();
        this.workers.push(worker);
        this.idle.push(worker);
      }
    }

    createWorker() {
      const worker = new Worker("ai-worker-bootstrap.js", { name: "xiangqi-ai" });
      worker.onmessage = (event) => this.handleMessage(worker, event.data);
      worker.onerror = (event) => this.handleError(worker, event);
      worker.postMessage({ type: "warmup" });
      return worker;
    }

    handleMessage(worker, message) {
      if (!message) return;
      if (message.type === "bootstrap-error") {
        this.failed = true;
        const detail = [message.message, message.stack].filter(Boolean).join("\n");
        for (const pending of this.pending.values()) {
          pending.reject(new Error(detail || "Worker bootstrap failed"));
        }
        this.pending.clear();
        return;
      }
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.type === "search-result") pending.resolve(message);
        else pending.reject(new Error(message.message || "Worker search failed"));
      }
      if (!this.idle.includes(worker)) this.idle.push(worker);
      this.dispatch();
    }

    handleError(worker, event) {
      this.failed = true;
      const reason = event?.message
        || event?.error?.message
        || (event?.filename ? `${event.filename}:${event.lineno || 0}` : "Worker failed");
      for (const pending of this.pending.values()) {
        pending.reject(event?.error || new Error(reason));
      }
      this.pending.clear();
      this.idle = this.idle.filter((item) => item !== worker);
    }

    request(message) {
      if (this.failed) return Promise.reject(new Error("Worker pool failed"));
      return new Promise((resolve, reject) => {
        const id = this.nextId++;
        this.queue.push({ id, message: { ...message, id }, resolve, reject });
        this.dispatch();
      });
    }

    dispatch() {
      while (this.idle.length > 0 && this.queue.length > 0) {
        const worker = this.idle.shift();
        const task = this.queue.shift();
        this.pending.set(task.id, task);
        worker.postMessage(task.message);
      }
    }

    terminate() {
      for (const worker of this.workers) worker.terminate();
      this.workers = [];
      this.idle = [];
      this.pending.clear();
      this.queue = [];
    }
  }

  function getEnginePool() {
    if (enginePool === false) return null;
    if (enginePool) return enginePool;
    if (typeof Worker === "undefined") {
      enginePool = false;
      document.documentElement.dataset.workerCount = "0";
      return null;
    }
    try {
      enginePool = new EngineWorkerPool(WORKER_COUNT);
      document.documentElement.dataset.workerCount = String(WORKER_COUNT);
      return enginePool;
    } catch {
      enginePool = false;
      document.documentElement.dataset.workerCount = "0";
      return null;
    }
  }

  async function searchWithWorkers(board, side, moves, settings) {
    const pool = getEnginePool();
    if (!pool || moves.length === 0) return null;
    const shardCount = Math.min(pool.size, moves.length);
    const shards = Array.from({ length: shardCount }, () => []);
    moves.forEach((move, index) => {
      shards[index % shardCount].push(move);
    });
    try {
      const results = await Promise.all(
        shards.map((shard) => pool.request({
          type: "search-shard",
          board,
          side,
          moves: shard,
          settings
        }))
      );
      document.documentElement.dataset.workerBackend = "workers";
      return results.flatMap((result) => result.ranked || []);
    } catch (error) {
      document.documentElement.dataset.workerBackend = "fallback";
      document.documentElement.dataset.workerError = error?.message || String(error);
      if (enginePool && enginePool !== false) {
        enginePool.terminate();
        enginePool = false;
      }
      return null;
    }
  }

  async function analyzePositionScheduled(board, side, options) {
    const settings = {
      depth: options.depth ?? 4,
      timeMs: options.timeMs ?? 2800,
      nodeLimit: options.nodeLimit ?? 240000,
      nullMove: options.nullMove,
      pvs: options.pvs,
      checkExtension: options.checkExtension,
      lmr: options.lmr,
      qDepth: options.qDepth
    };
    const moves = generateLegalMoves(board, side);
    if (moves.length === 0) return analyzePosition(board, side, settings);
    const ordered = orderedMoves(board, moves);
    const ranked = await searchWithWorkers(board, side, ordered, settings);
    if (!ranked) return analyzePosition(board, side, settings);
    ranked.sort((a, b) => b.score - a.score);
    const bestScore = ranked[0]?.score ?? evaluateBoard(board, side);
    const evalRed = side === RED ? bestScore : -bestScore;
    return {
      side,
      score: bestScore,
      evalRed,
      winRed: clamp(scoreToRedWin(bestScore, side), 0.5, 99.5),
      bestMove: ranked[0]?.move ?? null,
      bestNotation: ranked[0] ? moveToNotation(board, ranked[0].move) : "",
      candidates: ranked.slice(0, options.candidates ?? 5),
      moveScores: ranked,
      nodes: 0,
      depth: settings.depth,
      elapsed: 0,
      terminal: false
    };
  }

  async function chooseAIMoveScheduled(game, levelKey) {
    const level = AI_LEVELS[levelKey] || AI_LEVELS.medium;
    const bookMove = chooseOpeningBookMove(game, level, levelKey);
    if (bookMove) return bookMove;
    const moves = generateLegalMoves(game.board, game.sideToMove);
    if (moves.length === 0) return null;
    const ordered = orderedMoves(game.board, moves);
    const ranked = await searchWithWorkers(
      game.board,
      game.sideToMove,
      ordered,
      level
    );
    if (!ranked) return chooseAIMove(game, levelKey);
    ranked.sort((a, b) => b.score - a.score);
    const poolSize = Math.min(ranked.length, Math.max(1, level.candidateCount));
    let pool = ranked.slice(0, poolSize);
    if (Math.random() < level.blunderChance) {
      pool = ranked.slice(0, Math.min(ranked.length, poolSize + 4));
    }
    const weights = pool.map((entry, index) => {
      const rankWeight = Math.max(1, pool.length - index);
      const noise = 1 + Math.random() * (level.randomness / 18);
      return rankWeight * noise;
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let pick = Math.random() * total;
    for (let index = 0; index < pool.length; index += 1) {
      pick -= weights[index];
      if (pick <= 0) return pool[index].move;
    }
    return pool[0].move;
  }

  const elements = {
    board: document.getElementById("board"),
    pieces: document.getElementById("pieces"),
    moveHints: document.getElementById("moveHints"),
    thinking: document.getElementById("thinking"),
    difficulty: document.getElementById("difficulty"),
    sideSelect: document.getElementById("sideSelect"),
    newGame: document.getElementById("newGame"),
    undoMove: document.getElementById("undoMove"),
    redLabel: document.getElementById("redLabel"),
    blackLabel: document.getElementById("blackLabel"),
    redCaptured: document.getElementById("redCaptured"),
    blackCaptured: document.getElementById("blackCaptured"),
    turnBadge: document.getElementById("turnBadge"),
    statusText: document.getElementById("statusText"),
    moveCounter: document.getElementById("moveCounter"),
    redWinValue: document.getElementById("redWinValue"),
    redWinBar: document.getElementById("redWinBar"),
    blackWinBar: document.getElementById("blackWinBar"),
    evalScore: document.getElementById("evalScore"),
    bestMoveText: document.getElementById("bestMoveText"),
    bestMatchRate: document.getElementById("bestMatchRate"),
    avgLoss: document.getElementById("avgLoss"),
    mistakeCount: document.getElementById("mistakeCount"),
    currentQuality: document.getElementById("currentQuality"),
    evalChart: document.getElementById("evalChart"),
    chartHint: document.getElementById("chartHint"),
    lastMoveText: document.getElementById("lastMoveText"),
    moveVerdict: document.getElementById("moveVerdict"),
    moveList: document.getElementById("moveList"),
    firstMove: document.getElementById("firstMove"),
    prevMove: document.getElementById("prevMove"),
    nextMove: document.getElementById("nextMove"),
    lastMove: document.getElementById("lastMove"),
    liveMode: document.getElementById("liveMode"),
    chatLog: document.getElementById("chatLog"),
    chatForm: document.getElementById("chatForm"),
    chatInput: document.getElementById("chatInput")
  };

  const state = {
    game: new XiangqiGame(),
    humanSide: RED,
    aiSide: BLACK,
    difficulty: "medium",
    selected: null,
    legalMoves: [],
    live: true,
    reviewPly: 0,
    displayAnalysis: null,
    busy: false,
    session: 0
  };
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function setStatus(text, tone) {
    elements.statusText.textContent = text;
    if (tone) elements.statusText.dataset.tone = tone;
  }

  function currentBoard() {
    if (state.live) return state.game.board;
    return positionAtPly(state.game.history, state.reviewPly);
  }

  function currentPly() {
    return state.live ? state.game.history.length : state.reviewPly;
  }

  function analysisForCurrentPly() {
    const ply = currentPly();
    if (ply === 0) {
      if (state.game.history.length === 0 && state.displayAnalysis) return state.displayAnalysis;
      return {
        evalRed: 0,
        winRed: 50,
        bestMove: null,
        candidates: [],
        depth: 0,
        nodes: 0
      };
    }
    const record = state.game.history[ply - 1];
    if (ply === state.game.history.length && state.displayAnalysis) {
      return state.displayAnalysis;
    }
    return record?.afterAnalysis || record?.analysis || state.displayAnalysis || {
      evalRed: 0,
      winRed: 50,
      bestMove: null,
      candidates: [],
      depth: 0,
      nodes: 0
    };
  }

  function render() {
    renderPieces();
    renderCaptured();
    renderStatus();
    renderAnalysis();
    renderMoveList();
    renderLabels();
  }

  function captureCapturedGhost(from, to) {
    const target = elements.pieces.querySelector(`.piece[data-square="${to}"]`);
    if (!target) return null;
    const ghost = target.cloneNode(true);
    ghost.classList.remove("playable", "selected", "last-move", "moving");
    ghost.classList.add("capture-ghost");
    ghost.style.removeProperty("--tx");
    ghost.style.removeProperty("--ty");
    ghost.style.removeProperty("--scale");
    ghost.style.removeProperty("--move-duration");
    ghost.style.removeProperty("transition");
    ghost.removeAttribute("aria-label");
    ghost.tabIndex = -1;
    return ghost;
  }

  function animateCapturedGhost(ghost) {
    if (!ghost || prefersReducedMotion) return;
    elements.pieces.appendChild(ghost);
    void ghost.offsetWidth;
    ghost.classList.add("capture-ghost-out");
    window.setTimeout(() => ghost.remove(), 260);
  }

  function animateMoveTransition(record, reverse = false) {
    if (!record || prefersReducedMotion) return 0;
    const sourceSquare = reverse ? record.to : record.from;
    const targetSquare = reverse ? record.from : record.to;
    const target = elements.pieces.querySelector(`.piece[data-square="${targetSquare}"]`);
    if (!target) return 0;

    const sourceRow = Math.floor(sourceSquare / 9);
    const sourceCol = sourceSquare % 9;
    const targetRow = Math.floor(targetSquare / 9);
    const targetCol = targetSquare % 9;
    const piecesRect = elements.pieces.getBoundingClientRect();
    const startX = (sourceCol - targetCol) * (piecesRect.width / 9);
    const startY = (sourceRow - targetRow) * (piecesRect.height / 10);
    const distance = Math.hypot(sourceCol - targetCol, sourceRow - targetRow);
    const duration = Math.min(420, 190 + distance * 28);

    target.classList.add("moving");
    target.style.transition = "none";
    target.style.setProperty("--tx", `${startX}px`);
    target.style.setProperty("--ty", `${startY}px`);
    target.style.setProperty("--scale", ".98");
    target.style.setProperty("--move-duration", `${duration}ms`);
    void target.offsetWidth;
    target.style.removeProperty("transition");
    window.requestAnimationFrame(() => {
      target.style.setProperty("--tx", "0px");
      target.style.setProperty("--ty", "0px");
      target.style.setProperty("--scale", "1");
    });
    window.setTimeout(() => {
      if (!target.isConnected) return;
      target.classList.remove("moving");
      target.style.removeProperty("--tx");
      target.style.removeProperty("--ty");
      target.style.removeProperty("--scale");
      target.style.removeProperty("--move-duration");
    }, duration + 30);
    return duration;
  }

  function renderMove(record, ghost) {
    render();
    const duration = animateMoveTransition(record);
    animateCapturedGhost(ghost);
    return duration;
  }

  function renderLabels() {
    elements.difficulty.value = state.difficulty;
    elements.sideSelect.value = state.humanSide;
    elements.redLabel.textContent = state.humanSide === RED ? "你" : `AI · ${AI_LEVELS[state.difficulty].label}`;
    elements.blackLabel.textContent = state.humanSide === BLACK ? "你" : `AI · ${AI_LEVELS[state.difficulty].label}`;
  }

  function renderPieces() {
    const board = currentBoard();
    const fragment = document.createDocumentFragment();
    const displayedPly = currentPly();

    for (let index = 0; index < 90; index += 1) {
      const piece = board[index];
      if (!piece) continue;
      const row = Math.floor(index / 9);
      const col = index % 9;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `piece ${piece.side}`;
      button.dataset.square = String(index);
      button.style.setProperty("--x", String(col));
      button.style.setProperty("--y", String(row));
      button.textContent = pieceName(piece);
      button.setAttribute("aria-label", `${piece.side === RED ? "红" : "黑"}${pieceName(piece)} ${fileOf(col)}${row + 1}`);

      if (state.selected === index) button.classList.add("selected");
      if (
        state.live &&
        !state.busy &&
        state.game.result.type === "ongoing" &&
        piece.side === state.humanSide &&
        state.game.sideToMove === state.humanSide
      ) {
        button.classList.add("playable");
      }

      const lastRecord = displayedPly > 0 ? state.game.history[displayedPly - 1] : null;
      if (lastRecord && (lastRecord.from === index || lastRecord.to === index)) {
        button.classList.add("last-move");
      }
      fragment.appendChild(button);
    }

    elements.pieces.replaceChildren(fragment);
    elements.moveHints.replaceChildren();
    if (!state.live || state.busy || state.game.result.type !== "ongoing") return;

    const hintFragment = document.createDocumentFragment();
    for (const move of state.legalMoves) {
      const target = board[move.to];
      const hint = document.createElement("span");
      hint.className = `hint${target ? " capture" : ""}`;
      hint.style.setProperty("--x", String(move.to % 9));
      hint.style.setProperty("--y", String(Math.floor(move.to / 9)));
      hintFragment.appendChild(hint);
    }
    elements.moveHints.replaceChildren(hintFragment);
  }

  function renderCaptured() {
    const capturedByRed = [];
    const capturedByBlack = [];
    for (const record of state.game.history) {
      if (!record.captured) continue;
      if (record.side === RED) capturedByRed.push(record.captured);
      else capturedByBlack.push(record.captured);
    }
    elements.redCaptured.replaceChildren(...capturedByRed.map(createCapturedPiece));
    elements.blackCaptured.replaceChildren(...capturedByBlack.map(createCapturedPiece));
  }

  function createCapturedPiece(piece) {
    const span = document.createElement("span");
    span.className = `captured-piece ${piece.side}`;
    span.textContent = pieceName(piece);
    return span;
  }

  function renderStatus() {
    const result = state.game.result;
    if (result.type !== "ongoing") {
      elements.turnBadge.textContent = result.type === "draw" ? "和棋" : "对局结束";
      elements.turnBadge.className = "turn-badge over";
      const winnerText = result.type === "draw"
        ? result.reason
        : `${result.winner === RED ? "红方" : "黑方"}胜 · ${result.reason}`;
      setStatus(winnerText);
    } else {
      const playingSide = state.game.sideToMove;
      elements.turnBadge.textContent = `${playingSide === RED ? "红方" : "黑方"}行棋`;
      elements.turnBadge.className = `turn-badge${playingSide === BLACK ? " black" : ""}`;
      if (!state.live) {
        setStatus(`复盘到第 ${state.reviewPly} 手`);
      } else if (state.busy) {
        setStatus("AI 正在计算");
      } else if (playingSide === state.humanSide) {
        setStatus(state.selected === null ? "请选择棋子" : "请选择落点");
      } else {
        setStatus("等待 AI 落子");
      }
    }
    elements.moveCounter.textContent = `第 ${Math.max(1, Math.ceil(currentPly() / 2))} 回合`;
  }

  function renderAnalysis() {
    const analysis = analysisForCurrentPly();
    const winRed = analysis.winRed ?? 50;
    elements.redWinValue.textContent = `${winRed.toFixed(1)}%`;
    elements.redWinBar.style.width = `${winRed}%`;
    elements.blackWinBar.style.width = `${100 - winRed}%`;
    elements.evalScore.textContent = formatEval(analysis.evalRed || 0);
    elements.evalScore.classList.toggle("negative", (analysis.evalRed || 0) < 0);
    elements.bestMoveText.textContent = analysis.bestMove
      ? `最佳着法：${analysis.bestNotation || moveLabel(currentBoard(), analysis.bestMove)}`
      : "最佳着法：--";
    elements.chartHint.textContent = analysis.depth ? `深度 ${analysis.depth}` : "每步更新";

    const records = state.game.history;
    const analyzed = records.filter((record) => record.quality);
    const bestMatches = analyzed.filter((record) => record.quality.label === "最佳").length;
    const averageLoss = analyzed.length
      ? analyzed.reduce((sum, record) => sum + (record.quality.bestRate - record.quality.chosenRate), 0) / analyzed.length
      : null;
    const problemLabels = new Set(["欠佳", "失误", "严重失误", "败着"]);
    const mistakes = analyzed.filter((record) => problemLabels.has(record.quality.label)).length;
    const currentRecord = currentPly() > 0 ? records[currentPly() - 1] : null;
    const playerRecord = analyzed.filter((record) => record.side === state.humanSide).at(-1) || null;
    const currentQuality = playerRecord?.quality;

    elements.bestMatchRate.textContent = analyzed.length
      ? `${Math.round((bestMatches / analyzed.length) * 100)}%`
      : "--";
    elements.avgLoss.textContent = averageLoss === null ? "--" : `${averageLoss.toFixed(1)} pp`;
    elements.mistakeCount.textContent = analyzed.length ? String(mistakes) : "--";
    elements.currentQuality.textContent = currentQuality ? currentQuality.label : "--";
    elements.currentQuality.style.color = currentQuality ? qualityColor(currentQuality) : "";

    if (!currentRecord) {
      elements.lastMoveText.textContent = "等待落子";
      elements.moveVerdict.className = "verdict empty";
      elements.moveVerdict.innerHTML = "尚未产生着法";
    } else {
      const actor = currentRecord.side === state.humanSide ? "你" : "AI";
      elements.lastMoveText.textContent = `${actor}：${formatNotation(currentRecord)}`;
      const quality = currentRecord.quality;
      if (!quality) {
        elements.moveVerdict.className = "verdict empty";
        elements.moveVerdict.innerHTML = "该步骤尚未分析";
      } else {
        elements.moveVerdict.className = `verdict ${quality.css}`;
        elements.moveVerdict.innerHTML = `
          <strong>${quality.label} · ${quality.score.toFixed(0)} 分</strong>
          <span>${quality.detail}</span>
        `;
      }
    }
    renderChart();
  }

  function qualityColor(quality) {
    const colors = {
      best: "#2d7a52",
      excellent: "#4f8a5b",
      good: "#709a4c",
      solid: "#89a15a",
      stable: "#9f9b64",
      okay: "#9b732f",
      inaccuracy: "#b8752e",
      mistake: "#b64039",
      blunder: "#a3302b",
      losing: "#7e2622"
    };
    return colors[quality.css] || "";
  }

  function renderChart() {
    const width = 640;
    const height = 220;
    const pad = 12;
    const points = [{ x: 0, y: 50 }];
    state.game.history.forEach((record, index) => {
      points.push({
        x: index + 1,
        y: record.quality?.chosenRedRate ?? record.winRedAfter ?? record.afterAnalysis?.winRed ?? record.analysis?.winRed ?? points[points.length - 1].y
      });
    });
    const maxX = Math.max(1, state.game.history.length);
    const rates = points.map((point) => point.y);
    const minRate = Math.min(...rates);
    const maxRate = Math.max(...rates);
    const padding = Math.max(2, (maxRate - minRate) * 0.25);
    const scaleMin = clamp(Math.floor(minRate - padding), 0, 48);
    const scaleMax = clamp(Math.ceil(maxRate + padding), 52, 100);
    const scaleRange = Math.max(1, scaleMax - scaleMin);
    const coords = points.map((point) => {
      const x = pad + (point.x / maxX) * (width - pad * 2);
      const y = pad + ((scaleMax - point.y) / scaleRange) * (height - pad * 2);
      return { x, y };
    });
    const referenceY = pad + ((scaleMax - 50) / scaleRange) * (height - pad * 2);
    const path = coords.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
    const area = `${path} L${coords[coords.length - 1].x.toFixed(1)},${height - pad} L${coords[0].x.toFixed(1)},${height - pad} Z`;
    elements.evalChart.dataset.points = JSON.stringify(points);
    elements.evalChart.dataset.scale = JSON.stringify({ min: scaleMin, max: scaleMax });
    elements.chartHint.textContent = `范围 ${scaleMin}% - ${scaleMax}%`;
    elements.evalChart.innerHTML = `
      <defs>
        <linearGradient id="ratingFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#bf3c37" stop-opacity=".26"/>
          <stop offset="1" stop-color="#bf3c37" stop-opacity=".02"/>
        </linearGradient>
      </defs>
      <line x1="${pad}" y1="${referenceY}" x2="${width - pad}" y2="${referenceY}" stroke="#8c887f" stroke-width="1" stroke-dasharray="4 5"/>
      <path d="${area}" fill="url(#ratingFill)"/>
      <path d="${path}" fill="none" stroke="#b43d37" stroke-width="3" vector-effect="non-scaling-stroke"/>
      <circle cx="${coords[coords.length - 1].x}" cy="${coords[coords.length - 1].y}" r="4.5" fill="#b43d37"/>
    `;
  }

  function moveLabel(board, move) {
    const piece = board[move.from];
    if (!piece) return squareName(move.from) + " → " + squareName(move.to);
    return `${pieceName(piece)}${squareName(move.from)} → ${squareName(move.to)}`;
  }

  function renderMoveList() {
    const history = state.game.history;
    if (!history.length) {
      elements.moveList.innerHTML = '<div class="empty-state">对局开始后，这里会显示棋谱和逐步分析。</div>';
      return;
    }
    const rows = [];
    for (let index = 0; index < history.length; index += 2) {
      const redRecord = history[index];
      const blackRecord = history[index + 1];
      rows.push(`
        <div class="move-row${currentPly() >= index + 1 && currentPly() <= index + 2 ? " active" : ""}">
          <div class="move-index">${redRecord.moveNumber}</div>
          ${moveCell(redRecord, index)}
          ${blackRecord ? moveCell(blackRecord, index + 1) : '<div class="move-cell"></div>'}
        </div>
      `);
    }
    elements.moveList.innerHTML = rows.join("");
  }

  function moveCell(record, index) {
    const quality = record.quality ? record.quality.label : "待分析";
    return `
      <div class="move-cell ${record.side === RED ? "red-side" : "black-side"}" data-ply="${index + 1}">
        <strong>${record.notation}</strong>
        <span>${quality}${record.analysis ? ` · 深度 ${record.analysis.depth}` : ""}</span>
      </div>
    `;
  }

  function renderThinking() {
    elements.thinking.hidden = !state.busy;
  }

  function selectPiece(square) {
    if (!state.live) {
      setStatus("复盘状态，请先回到当前局面");
      return;
    }
    if (state.busy || state.game.result.type !== "ongoing") return;
    if (state.game.sideToMove !== state.humanSide) {
      setStatus("还没轮到你");
      return;
    }
    const piece = state.game.board[square];
    if (!piece || piece.side !== state.humanSide) {
      state.selected = null;
      state.legalMoves = [];
      render();
      return;
    }
    state.selected = square;
    state.legalMoves = generateLegalMoves(state.game.board, state.humanSide)
      .filter((move) => move.from === square);
    render();
  }

  async function performHumanMove(from, to) {
    state.selected = null;
    state.legalMoves = [];
    const session = state.session;
    const ghost = captureCapturedGhost(from, to);
    const record = state.game.play(from, to);
    state.live = true;
    state.reviewPly = state.game.history.length;
    const animationDuration = renderMove(record, ghost);
    await wait(animationDuration + 20);
    if (session !== state.session) return;
    await analyzeAndAttach(record);
    if (session !== state.session) return;
    state.displayAnalysis = record.afterAnalysis || record.analysis;
    renderAnalysis();
    renderMoveList();
    renderStatus();

    if (state.game.result.type === "ongoing" && state.game.sideToMove === state.aiSide) {
      await runAITurn();
    }
  }

  async function analyzeAndAttach(record) {
    const boardBefore = positionAtPly(state.game.history, record.index);
    const analysis = await analyzePositionScheduled(
      boardBefore,
      record.side,
      ANALYSIS_LEVEL
    );
    record.analysis = analysis;
    record.chosen = (analysis.moveScores || analysis.candidates).find((candidate) => (
      candidate.move.from === record.from && candidate.move.to === record.to
    )) || null;
    record.winRedAfter = record.chosen?.winRed ?? analysis.winRed;
    record.evalRedAfter = record.chosen?.evalRed ?? analysis.evalRed;
    record.quality = qualityForRecord(record, analysis);
    const boardAfter = positionAtPly(state.game.history, record.index + 1);
    const sideAfter = opposite(record.side);
    record.afterAnalysis = await analyzePositionScheduled(
      boardAfter,
      sideAfter,
      CURRENT_ANALYSIS_LEVEL
    );
  }

  async function runAITurn() {
    if (state.game.result.type !== "ongoing") return;
    const session = state.session;
    state.busy = true;
    state.selected = null;
    state.legalMoves = [];
    renderThinking();
    render();
    await wait(90);
    if (session !== state.session) return;

    const move = await chooseAIMoveScheduled(state.game, state.difficulty);
    if (session !== state.session) return;
    if (!move) {
      state.busy = false;
      renderThinking();
      render();
      return;
    }

    const ghost = captureCapturedGhost(move.from, move.to);
    const record = state.game.play(move.from, move.to);
    state.reviewPly = state.game.history.length;
    elements.thinking.hidden = true;
    const animationDuration = renderMove(record, ghost);
    await wait(animationDuration + 20);
    if (session !== state.session) return;
    await analyzeAndAttach(record);
    if (session !== state.session) return;
    state.busy = false;
    renderThinking();
    state.displayAnalysis = record.afterAnalysis || record.analysis;
    render();
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function resetGame() {
    state.session += 1;
    state.game = new XiangqiGame();
    state.humanSide = elements.sideSelect.value;
    state.aiSide = opposite(state.humanSide);
    state.difficulty = elements.difficulty.value;
    state.selected = null;
    state.legalMoves = [];
    state.live = true;
    state.reviewPly = 0;
    state.displayAnalysis = null;
    state.busy = false;
    renderThinking();
    render();
    appendChat("对手", "新对局开始，请多指教。", false);
    if (state.game.sideToMove === state.aiSide) {
      runAITurn();
    }
  }

  function undo() {
    if (state.busy || state.game.history.length === 0) return;
    state.session += 1;
    state.game.undo(1);
    while (state.game.history.length > 0 && state.game.sideToMove === state.aiSide) {
      state.game.undo(1);
    }
    state.selected = null;
    state.legalMoves = [];
    state.live = true;
    state.reviewPly = state.game.history.length;
    const lastRecord = state.game.history.at(-1);
    state.displayAnalysis = lastRecord?.afterAnalysis || lastRecord?.analysis || null;
    renderThinking();
    render();
    if (state.game.result.type === "ongoing" && state.game.sideToMove === state.aiSide) {
      runAITurn();
    }
  }

  function appendChat(author, text, mine) {
    const wrapper = document.createElement("div");
    wrapper.className = `chat-message${mine ? " mine" : ""}`;
    const label = document.createElement("span");
    label.textContent = author;
    const message = document.createElement("p");
    message.textContent = text;
    wrapper.append(label, message);
    elements.chatLog.appendChild(wrapper);
    elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
  }

  function respondToChat(text) {
    let response = "这一局有意思，继续下吧。";
    if (text.includes("好棋") || text.includes("精彩")) response = "你的判断也不错，继续。";
    if (text.includes("承让")) response = "棋局未定，认真下完。";
    if (text.includes("再想")) response = "落子无悔。回去以后可以慢慢复盘。";
    if (text.includes("?") || text.includes("？")) response = "本地 AI 只能对局，不方便解释棋理。";
    window.setTimeout(() => appendChat("对手", response, false), 520);
  }

  function boardClick(event) {
    if (!state.live || state.busy || state.game.result.type !== "ongoing") return;
    const pieceElement = event.target.closest(".piece");
    if (pieceElement) {
      const square = Number(pieceElement.dataset.square);
      if (state.selected !== null && square !== state.selected) {
        const legal = state.legalMoves.find((move) => move.to === square);
        if (legal) {
          performHumanMove(state.selected, square);
          return;
        }
      }
      selectPiece(square);
      return;
    }
    if (state.selected === null) return;
    const targetSquare = pointToSquare(event);
    if (targetSquare === null) return;
    const legal = state.legalMoves.find((move) => move.to === targetSquare);
    if (legal) {
      performHumanMove(state.selected, targetSquare);
    } else {
      state.selected = null;
      state.legalMoves = [];
      render();
    }
  }

  function pointToSquare(event) {
    const rect = elements.board.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 900;
    const y = ((event.clientY - rect.top) / rect.height) * 1000;
    const col = Math.round((x - 50) / 100);
    const row = Math.round((y - 50) / 100);
    if (!inside(row, col)) return null;
    const distance = Math.hypot(x - (50 + col * 100), y - (50 + row * 100));
    if (distance > 46) return null;
    return row * 9 + col;
  }

  elements.board.addEventListener("click", boardClick);
  elements.newGame.addEventListener("click", resetGame);
  elements.undoMove.addEventListener("click", undo);
  elements.difficulty.addEventListener("change", () => {
    state.difficulty = elements.difficulty.value;
    renderLabels();
    if (state.game.history.length === 0 && state.game.sideToMove === state.aiSide && !state.busy) {
      runAITurn();
    }
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const panelId = `panel-${tab.dataset.tab}`;
      document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
      document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === panelId));
    });
  });

  elements.moveList.addEventListener("click", (event) => {
    const cell = event.target.closest("[data-ply]");
    if (!cell) return;
    const oldPly = currentPly();
    const nextPly = Number(cell.dataset.ply);
    state.live = false;
    state.reviewPly = nextPly;
    state.selected = null;
    state.legalMoves = [];
    render();
    if (nextPly === oldPly - 1) {
      animateMoveTransition(state.game.history[oldPly - 1], true);
    } else if (nextPly === oldPly + 1) {
      animateMoveTransition(state.game.history[nextPly - 1], false);
    }
  });

  elements.firstMove.addEventListener("click", () => {
    state.live = false;
    state.reviewPly = 0;
    render();
  });
  elements.prevMove.addEventListener("click", () => {
    const oldPly = currentPly();
    const nextPly = Math.max(0, oldPly - 1);
    state.live = false;
    state.reviewPly = nextPly;
    render();
    if (nextPly === oldPly - 1) {
      animateMoveTransition(state.game.history[oldPly - 1], true);
    }
  });
  elements.nextMove.addEventListener("click", () => {
    const oldPly = currentPly();
    const nextPly = Math.min(state.game.history.length, oldPly + 1);
    state.reviewPly = nextPly;
    state.live = state.reviewPly === state.game.history.length;
    render();
    if (nextPly === oldPly + 1) {
      animateMoveTransition(state.game.history[nextPly - 1], false);
    }
  });
  elements.lastMove.addEventListener("click", () => {
    state.live = true;
    state.reviewPly = state.game.history.length;
    render();
  });
  elements.liveMode.addEventListener("click", () => {
    state.live = true;
    state.reviewPly = state.game.history.length;
    render();
  });

  document.querySelectorAll(".quick-chat").forEach((container) => {
    container.addEventListener("click", (event) => {
      const button = event.target.closest("[data-chat]");
      if (!button) return;
      const text = button.dataset.chat;
      appendChat("你", text, true);
      respondToChat(text);
    });
  });

  elements.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = elements.chatInput.value.trim();
    if (!text) return;
    elements.chatInput.value = "";
    appendChat("你", text, true);
    respondToChat(text);
  });

  window.XiangqiLocal = {
    game: () => state.game,
    state,
    perft,
    initialBoard: () => cloneBoard(INITIAL_POSITION),
    generateLegalMoves,
    analyzePosition,
    chooseAIMove,
    reset: resetGame
  };

  document.documentElement.dataset.engineReady = "true";
  if (new URLSearchParams(window.location.search).has("selftest")) {
    const palaceBoard = Array(90).fill(null);
    palaceBoard[85] = { type: "k", side: RED };
    palaceBoard[4] = { type: "k", side: BLACK };
    palaceBoard[49] = { type: "p", side: RED };

    const mateBoard = Array(90).fill(null);
    mateBoard[85] = { type: "k", side: RED };
    mateBoard[3] = { type: "r", side: BLACK };
    mateBoard[4] = { type: "r", side: BLACK };
    mateBoard[76] = { type: "r", side: BLACK };
    mateBoard[84] = { type: "r", side: BLACK };

    const stalemateBoard = Array(90).fill(null);
    stalemateBoard[85] = { type: "k", side: RED };
    stalemateBoard[84] = { type: "a", side: RED };
    stalemateBoard[86] = { type: "a", side: RED };
    stalemateBoard[76] = { type: "a", side: RED };
    stalemateBoard[4] = { type: "r", side: BLACK };

    const faceBoard = Array(90).fill(null);
    faceBoard[85] = { type: "k", side: RED };
    faceBoard[4] = { type: "k", side: BLACK };
    faceBoard[49] = { type: "r", side: RED };

    const rookEndgameBoard = Array(90).fill(null);
    rookEndgameBoard[85] = { type: "k", side: RED };
    rookEndgameBoard[40] = { type: "r", side: RED };
    rookEndgameBoard[4] = { type: "k", side: BLACK };
    rookEndgameBoard[3] = { type: "a", side: BLACK };
    rookEndgameBoard[5] = { type: "a", side: BLACK };
    rookEndgameBoard[2] = { type: "b", side: BLACK };
    rookEndgameBoard[6] = { type: "b", side: BLACK };

    const bookGame = new XiangqiGame();
    const masterBookMove = chooseAIMove(bookGame, "master");
    const analysisProbe = analyzePosition(
      cloneBoard(INITIAL_POSITION),
      RED,
      {
        depth: 3,
        timeMs: 1100,
        nodeLimit: 90000,
        candidates: 4,
        nullMove: true,
        pvs: true,
        checkExtension: true,
        lmr: true
      }
    );
    const tacticalGame = new XiangqiGame();
    [
      [60, 51],
      [1, 20],
      [70, 67],
      [25, 24],
      [67, 31]
    ].forEach(([from, to]) => tacticalGame.play(from, to));
    const tacticalBoard = cloneBoard(tacticalGame.board);
    const tacticalNullOn = analyzePosition(tacticalBoard, BLACK, {
      depth: 3,
      timeMs: 1400,
      nodeLimit: 120000,
      candidates: 5,
      nullMove: true,
      pvs: true,
      checkExtension: true,
      lmr: true
    });
    const tacticalNullOff = analyzePosition(tacticalBoard, BLACK, {
      depth: 3,
      timeMs: 1400,
      nodeLimit: 120000,
      candidates: 5,
      nullMove: false,
      pvs: true,
      checkExtension: true,
      lmr: true
    });
    const tacticalDeep = analyzePosition(tacticalBoard, BLACK, {
      depth: 4,
      timeMs: 2800,
      nodeLimit: 240000,
      candidates: 5,
      nullMove: true,
      pvs: true,
      checkExtension: true,
      lmr: true
    });
    const ratingLevels = [0, 0.8, 2, 4, 7, 10, 15, 22, 35, 50].map((loss) => {
      const analysis = {
        winRed: 60,
        candidates: [{ move: { from: 0, to: 1 }, winRed: 60 }],
        moveScores: [
          { move: { from: 0, to: 1 }, winRed: 60 },
          { move: { from: 2, to: 3 }, winRed: 60 - loss }
        ]
      };
      return qualityForRecord({ from: 2, to: 3, side: RED }, analysis).label;
    });
    const ratingLevelsBlack = [0, 0.8, 2, 4, 7, 10, 15, 22, 35, 50].map((loss) => {
      const analysis = {
        winRed: 40,
        candidates: [{ move: { from: 0, to: 1 }, winRed: 40 }],
        moveScores: [
          { move: { from: 0, to: 1 }, winRed: 40 },
          { move: { from: 2, to: 3 }, winRed: 40 + loss }
        ]
      };
      return qualityForRecord({ from: 2, to: 3, side: BLACK }, analysis).label;
    });

    document.documentElement.dataset.selftest = JSON.stringify({
      d1: perft(cloneBoard(INITIAL_POSITION), RED, 1),
      d2: perft(cloneBoard(INITIAL_POSITION), RED, 2),
      d3: perft(cloneBoard(INITIAL_POSITION), RED, 3),
      kingMoves: generateLegalMoves(palaceBoard, RED).filter((move) => move.from === 85).length,
      mate: {
        legalMoves: generateLegalMoves(mateBoard, RED).length,
        inCheck: isInCheck(mateBoard, RED)
      },
      stalemate: {
        legalMoves: generateLegalMoves(stalemateBoard, RED).length,
        inCheck: isInCheck(stalemateBoard, RED)
      },
      flyingGeneral: {
        rookMoves: generateLegalMoves(faceBoard, RED).filter((move) => move.from === 49).length
      },
      openingBook: {
        positions: OPENING_BOOK.size,
        lines: AI_DATA.openingLines.length,
        masterFirstMove: masterBookMove ? moveToNotation(bookGame.board, masterBookMove) : null
      },
      analysisProbe: {
        best: analysisProbe.bestNotation,
        rate: analysisProbe.winRed,
        top: analysisProbe.moveScores.slice(0, 4).map((entry) => ({
          move: moveToNotation(INITIAL_POSITION, entry.move),
          score: entry.score,
          rate: entry.winRed
        }))
      },
      tacticalProbe: {
        nullOn: {
          best: tacticalNullOn.bestNotation,
          rate: tacticalNullOn.winRed,
          top: tacticalNullOn.moveScores.slice(0, 5).map((entry) => ({
            move: moveToNotation(tacticalBoard, entry.move),
            score: entry.score,
            rate: entry.winRed
          }))
        },
        nullOff: {
          best: tacticalNullOff.bestNotation,
          rate: tacticalNullOff.winRed,
          top: tacticalNullOff.moveScores.slice(0, 5).map((entry) => ({
            move: moveToNotation(tacticalBoard, entry.move),
            score: entry.score,
            rate: entry.winRed
          }))
        },
        deep: {
          best: tacticalDeep.bestNotation,
          rate: tacticalDeep.winRed,
          top: tacticalDeep.moveScores.slice(0, 5).map((entry) => ({
            move: moveToNotation(tacticalBoard, entry.move),
            score: entry.score,
            scoreText: String(entry.score),
            rate: entry.winRed
          }))
        }
      },
      endgame: {
        rookVsFullDefense: endgameKnowledgeScore(rookEndgameBoard, RED)
      },
      ratingLevels,
      ratingLevelsBlack
    });
  }

  resetGame();
  }
})();
