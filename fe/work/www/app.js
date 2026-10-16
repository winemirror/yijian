(() => {
  "use strict";

  const FILES = "abcdefghi";
  const RED = "r";
  const BLACK = "b";
  const MATE = 900000;
  const IS_WORKER = typeof window === "undefined";
  const GLOBAL_SCOPE = IS_WORKER ? self : window;
  const APP_ASSET_VERSION = "3.2.0-20261016";
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
    // Deliberately awful: it does not search, avoids good moves and walks
    // pieces into capture. Meant as the "even a beginner wins" setting.
    idiot: {
      label: "瞎几把下",
      depth: 1,
      timeMs: 200,
      nodeLimit: 1200,
      randomness: 200,
      candidateCount: 10,
      blunderChance: 1,
      useBook: false,
      maxBookPly: 0,
      chaos: true
    },
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
      depth: 4,
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
      depth: 6,
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
      depth: 8,
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
    depth: 5,
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
  // Pacing for AI-vs-AI auto play. "fullAnalysis" runs the same before-move
  // review a human game gets; the lighter modes only score the resulting
  // position so the eval bar and chart keep updating at speed.
  const AUTO_PLAY_SPEEDS = {
    fast: { label: "快", delayMs: 140, animate: false, fullAnalysis: false },
    normal: { label: "中", delayMs: 460, animate: true, fullAnalysis: false },
    slow: { label: "慢", delayMs: 1000, animate: true, fullAnalysis: true }
  };
  const AI_DATA = GLOBAL_SCOPE.XiangqiAiData || {
    openingLines: [],
    endgamePatterns: []
  };

  const INITIAL_POSITION = createInitialBoard();

  // --- Fast move encoding, hashing and make/unmake for the search hot path ---
  // The public helpers (applyMove/stateKey) stay immutable and allocation
  // friendly for the game/UI layer; everything below intentionally mutates one
  // shared board array to keep node cost low.
  const PIECE_TYPE_INDEX = { k: 0, a: 1, b: 2, n: 3, r: 4, c: 5, p: 6 };
  const ZOBRIST_PIECE = [];
  const ZOBRIST_SIDE = 0x9e3779b9;

  {
    let seed = 0x2545f491;
    const nextRandom = () => {
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed >>> 0;
    };
    for (let index = 0; index < 14; index += 1) {
      const squares = new Uint32Array(90);
      for (let square = 0; square < 90; square += 1) {
        squares[square] = nextRandom();
      }
      ZOBRIST_PIECE.push(squares);
    }
  }

  function zobristIndex(piece) {
    return (piece.side === RED ? 0 : 7) + PIECE_TYPE_INDEX[piece.type];
  }

  function computeHash(board, side) {
    let hash = side === BLACK ? ZOBRIST_SIDE : 0;
    for (let index = 0; index < 90; index += 1) {
      const piece = board[index];
      if (piece) hash ^= ZOBRIST_PIECE[zobristIndex(piece)][index];
    }
    return hash >>> 0;
  }

  function moveCode(move) {
    return move.from * 90 + move.to;
  }

  // Apply/undo a move in place. Returns the captured piece so the caller can
  // restore it. Nothing else about the board is copied.
  function doMove(board, move) {
    const moving = board[move.from];
    const captured = board[move.to];
    board[move.to] = moving;
    board[move.from] = null;
    return captured;
  }

  function undoMove(board, move, captured) {
    board[move.from] = board[move.to];
    board[move.to] = captured || null;
  }

  // Hashed variants keep context.hash in sync so the transposition table can
  // use a numeric Zobrist key instead of a rebuilt board string.
  function doMoveHashed(board, move, context) {
    const moving = board[move.from];
    const captured = board[move.to];
    board[move.to] = moving;
    board[move.from] = null;
    const movingIndex = zobristIndex(moving);
    context.hash ^= ZOBRIST_PIECE[movingIndex][move.from];
    context.hash ^= ZOBRIST_PIECE[movingIndex][move.to];
    if (captured) context.hash ^= ZOBRIST_PIECE[zobristIndex(captured)][move.to];
    context.hash ^= ZOBRIST_SIDE;
    return captured;
  }

  function undoMoveHashed(board, move, captured, context) {
    context.hash ^= ZOBRIST_SIDE;
    const moving = board[move.to];
    const movingIndex = zobristIndex(moving);
    context.hash ^= ZOBRIST_PIECE[movingIndex][move.from];
    context.hash ^= ZOBRIST_PIECE[movingIndex][move.to];
    if (captured) context.hash ^= ZOBRIST_PIECE[zobristIndex(captured)][move.to];
    board[move.from] = moving;
    board[move.to] = captured || null;
  }

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

  // Small ES5-friendly helpers so the app also runs on older WebViews. The
  // newer array "at", the element child-replacement method and optional
  // chaining / nullish coalescing are all avoided in favour of these.
  function lastOf(list) {
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }

  function defaultTo(value, fallback) {
    return value === undefined || value === null ? fallback : value;
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function setChildren(node, children) {
    clearChildren(node);
    for (let index = 0; index < children.length; index += 1) {
      node.appendChild(children[index]);
    }
    return node;
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
    const kingRow = Math.floor(king / 9);
    const kingCol = king % 9;
    const enemy = opposite(side);

    // Rook ("no screen") and cannon ("exactly one screen") along the four rays.
    const rays = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1]
    ];
    for (const [dr, dc] of rays) {
      let row = kingRow + dr;
      let col = kingCol + dc;
      let screens = 0;
      while (inside(row, col)) {
        const piece = board[row * 9 + col];
        if (piece) {
          if (screens === 0) {
            if (piece.side === enemy && piece.type === "r") return true;
            // A bare enemy general on the same file is the flying-general check.
            if (piece.side === enemy && piece.type === "k" && dc === 0) return true;
            screens = 1;
          } else {
            if (piece.side === enemy && piece.type === "c") return true;
            break;
          }
        }
        row += dr;
        col += dc;
      }
    }

    // Horses: check the eight origins, honouring the blocking leg.
    const horseOffsets = [
      [-2, -1],
      [-2, 1],
      [2, -1],
      [2, 1],
      [-1, -2],
      [1, -2],
      [-1, 2],
      [1, 2]
    ];
    for (const [dr, dc] of horseOffsets) {
      const horseRow = kingRow + dr;
      const horseCol = kingCol + dc;
      if (!inside(horseRow, horseCol)) continue;
      const piece = board[horseRow * 9 + horseCol];
      if (!piece || piece.side !== enemy || piece.type !== "n") continue;
      const legRow = Math.abs(dr) === 2 ? kingRow + dr / 2 : kingRow + dr;
      const legCol = Math.abs(dr) === 2 ? kingCol + dc : kingCol + dc / 2;
      if (!board[legRow * 9 + legCol]) return true;
    }

    // Pawns: one square ahead, plus the sideways attack once across the river.
    const pawnRow = enemy === RED ? kingRow + 1 : kingRow - 1;
    if (inside(pawnRow, kingCol)) {
      const piece = board[pawnRow * 9 + kingCol];
      if (piece && piece.side === enemy && piece.type === "p") return true;
    }
    const pawnCrossed = enemy === RED ? kingRow <= 4 : kingRow >= 5;
    if (pawnCrossed) {
      for (const dc of [-1, 1]) {
        const col = kingCol + dc;
        if (!inside(kingRow, col)) continue;
        const piece = board[kingRow * 9 + col];
        if (piece && piece.side === enemy && piece.type === "p") return true;
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
      const captured = doMove(board, move);
      const legalMove = !captured
        || captured.type !== "k"
          ? !generalsFace(board) && !isInCheck(board, piece.side)
          : false;
      undoMove(board, move, captured);
      if (legalMove) legal.push(move);
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
      const captured = doMove(board, move);
      nodes += perft(board, opposite(side), depth - 1);
      undoMove(board, move, captured);
    }
    return nodes;
  }

  // --- Mate pattern recognition ---------------------------------------------
  // Classified on the finished position: the side to move has no legal move and
  // is in check. Rules stay conservative on purpose - a pattern we miss is much
  // better than one we invent.
  const BLACK_PALACE_CORNERS = [3, 5, 21, 23];
  const RED_PALACE_CORNERS = [66, 68, 84, 86];
  const BLACK_HOME_SQUARE = 4;
  const RED_HOME_SQUARE = 85;

  function piecesOf(board, type, side) {
    const found = [];
    for (let index = 0; index < 90; index += 1) {
      const piece = board[index];
      if (piece && piece.type === type && piece.side === side) found.push(index);
    }
    return found;
  }

  // Every piece of `side` that attacks `square`. Cannons also report the single
  // screen they fire over.
  function attackersOf(board, square, side) {
    const found = [];
    for (let index = 0; index < 90; index += 1) {
      const piece = board[index];
      if (!piece || piece.side !== side) continue;
      if (!attacksSquare(board, index, square)) continue;
      found.push({
        from: index,
        type: piece.type,
        screen: piece.type === "c" ? screenBetween(board, index, square) : -1
      });
    }
    return found;
  }

  // The only piece standing between two squares that share a rank or file.
  function screenBetween(board, from, to) {
    const fromRow = Math.floor(from / 9);
    const fromCol = from % 9;
    const toRow = Math.floor(to / 9);
    const toCol = to % 9;
    if (fromRow !== toRow && fromCol !== toCol) return -1;
    const dr = Math.sign(toRow - fromRow);
    const dc = Math.sign(toCol - fromCol);
    let row = fromRow + dr;
    let col = fromCol + dc;
    let found = -1;
    let count = 0;
    while (row !== toRow || col !== toCol) {
      if (board[row * 9 + col]) {
        count += 1;
        if (count > 1) return -1;
        found = row * 9 + col;
      }
      row += dr;
      col += dc;
    }
    return count === 1 ? found : -1;
  }

  // Why each of the king's steps is unavailable, using the real move rules.
  function kingEscapeInfo(board, side) {
    const king = findKing(board, side);
    if (king < 0) return { king: -1, squares: [] };
    const row = Math.floor(king / 9);
    const col = king % 9;
    const enemy = opposite(side);
    const squares = [];
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nextRow = row + dr;
      const nextCol = col + dc;
      if (!inPalace(side, nextRow, nextCol)) continue;
      const square = nextRow * 9 + nextCol;
      const occupant = board[square];
      const capture = doMove(board, { from: king, to: square });
      const legal = !generalsFace(board) && !isInCheck(board, side);
      undoMove(board, { from: king, to: square }, capture);
      squares.push({
        square,
        occupiedByOwn: Boolean(occupant && occupant.side === side),
        occupiedByEnemy: Boolean(occupant && occupant.side === enemy),
        legal,
        attackers: attackersOf(board, square, enemy).map((entry) => entry.from)
      });
    }
    return { king, squares };
  }

  function matchFlyingGeneral(context) {
    return context.checkers.length === 1 && context.checkers[0].type === "k";
  }

  function matchHorseCannon(context) {
    if (context.checkers.length !== 1) return false;
    const checker = context.checkers[0];
    if (checker.type !== "c" || checker.screen < 0) return false;
    const screen = context.board[checker.screen];
    return Boolean(screen && screen.type === "n" && screen.side === context.winner);
  }

  function matchDoubleCannon(context) {
    if (context.checkers.length !== 1) return false;
    const checker = context.checkers[0];
    if (checker.type !== "c" || checker.screen < 0) return false;
    const screen = context.board[checker.screen];
    return Boolean(screen && screen.type === "c" && screen.side === context.winner);
  }

  function matchTroughHorse(context) {
    const trough = context.loser === BLACK ? [11, 15] : [74, 78];
    return context.checkers.some((c) => c.type === "n" && trough.includes(c.from));
  }

  function matchCornerHorse(context) {
    const corners = context.loser === BLACK ? BLACK_PALACE_CORNERS : RED_PALACE_CORNERS;
    return context.checkers.some((c) => c.type === "n" && corners.includes(c.from));
  }

  // King still at home, its own advisors brick up the palace, one cannon fires
  // over one of those advisors.
  function matchSmotheredPalace(context) {
    const home = context.loser === BLACK ? BLACK_HOME_SQUARE : RED_HOME_SQUARE;
    if (context.king !== home) return false;
    if (context.checkers.length !== 1) return false;
    const checker = context.checkers[0];
    if (checker.type !== "c" || checker.screen < 0) return false;
    const screen = context.board[checker.screen];
    return Boolean(screen && screen.type === "a" && screen.side === context.loser);
  }

  // A cannon firing down the palace file from the enemy half, with a rook or
  // pawn sealing the gate behind it.
  function matchIronBolt(context) {
    if (context.checkers.length !== 1) return false;
    const checker = context.checkers[0];
    if (checker.type !== "c") return false;
    if (checker.from % 9 !== 4) return false;
    const row = Math.floor(checker.from / 9);
    const inEnemyHalf = context.loser === BLACK ? row <= 4 : row >= 5;
    if (!inEnemyHalf) return false;
    const groundRow = context.loser === BLACK ? 0 : 9;
    return context.rooks.concat(context.pawns).some(
      (square) => Math.floor(square / 9) === groundRow || square % 9 === 4
    );
  }

  // One cannon on the central file, another on the mated side's back rank.
  function matchSkyEarthCannon(context) {
    if (context.cannons.length < 2) return false;
    const groundRow = context.loser === BLACK ? 0 : 9;
    const sky = context.cannons.some((square) => square % 9 === 4);
    const ground = context.cannons.some((square) => Math.floor(square / 9) === groundRow);
    if (!sky || !ground) return false;
    const attackers = new Set(context.checkers.map((checker) => checker.from));
    return context.cannons.some((square) => attackers.has(square));
  }

  function matchDoubleRook(context) {
    if (context.rooks.length < 2) return false;
    if (context.checkers.length === 0) return false;
    if (!context.checkers.every((checker) => checker.type === "r")) return false;
    if (context.checkers.length > 1) return true;
    const checking = context.checkers[0].from;
    return context.rooks.some((square) => square !== checking
      && context.escapes.some((escape) => escape.attackers.includes(square)));
  }

  function matchTwinPawns(context) {
    if (context.pawns.length < 2) return false;
    const rows = context.loser === BLACK ? [0, 1, 2] : [7, 8, 9];
    const onFile = (col) => context.pawns.some(
      (square) => square % 9 === col && rows.includes(Math.floor(square / 9))
    );
    return onFile(3) && onFile(5);
  }

  function matchSmother(context) {
    return context.ownBlocked;
  }

  const MATE_PATTERNS = [
    { id: "flyingGeneral", name: "对面笑", match: matchFlyingGeneral },
    { id: "horseCannon", name: "马后炮", match: matchHorseCannon },
    { id: "doubleCannon", name: "重炮", match: matchDoubleCannon },
    { id: "troughHorse", name: "卧槽马", match: matchTroughHorse },
    { id: "cornerHorse", name: "挂角马", match: matchCornerHorse },
    { id: "smotheredPalace", name: "闷宫", match: matchSmotheredPalace },
    { id: "ironBolt", name: "铁门栓", match: matchIronBolt },
    { id: "skyEarthCannon", name: "天地炮", match: matchSkyEarthCannon },
    { id: "doubleRook", name: "双车错", match: matchDoubleRook },
    { id: "twinPawns", name: "二鬼拍门", match: matchTwinPawns },
    { id: "smother", name: "闷杀", match: matchSmother }
  ];

  function classifyMate(board, winner) {
    const loser = opposite(winner);
    const king = findKing(board, loser);
    if (king < 0) return [];

    const checkers = attackersOf(board, king, winner);
    if (generalsFace(board)) {
      const enemyKing = findKing(board, winner);
      if (enemyKing >= 0 && !checkers.some((checker) => checker.from === enemyKing)) {
        checkers.push({ from: enemyKing, type: "k", screen: -1 });
      }
    }
    if (checkers.length === 0) return [];

    const escapes = kingEscapeInfo(board, loser).squares;
    const context = {
      board,
      winner,
      loser,
      king,
      checkers,
      escapes,
      ownBlocked: escapes.length > 0 && escapes.every((escape) => escape.occupiedByOwn),
      rooks: piecesOf(board, "r", winner),
      cannons: piecesOf(board, "c", winner),
      pawns: piecesOf(board, "p", winner)
    };
    return MATE_PATTERNS
      .filter((pattern) => {
        try {
          return pattern.match(context);
        } catch (error) {
          return false;
        }
      })
      .map((pattern) => ({ id: pattern.id, name: pattern.name }));
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
      history: this.history.map((record) => Object.assign({}, record)),
      positionCounts: Object.assign({}, this.positionCounts),
        halfmoveClock: this.halfmoveClock,
      result: Object.assign({}, this.result)
      };
    }

    restore(snapshot) {
      this.board = cloneBoard(snapshot.board);
      this.sideToMove = snapshot.sideToMove;
    this.history = snapshot.history.map((record) => Object.assign({}, record));
    this.positionCounts = Object.assign({}, snapshot.positionCounts);
      this.halfmoveClock = snapshot.halfmoveClock;
    this.result = Object.assign({}, snapshot.result);
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
      piece: Object.assign({}, piece),
      captured: applied.captured ? Object.assign({}, applied.captured) : null,
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
        const winner = opposite(this.sideToMove);
        const checkmate = isInCheck(this.board, this.sideToMove);
        this.result = {
          type: "win",
          winner,
          reason: checkmate ? "绝杀" : "困毙"
        };
        if (checkmate) {
          const patterns = classifyMate(this.board, winner);
          this.result.patterns = patterns;
          this.result.pattern = patterns[0] || null;
          const last = this.history[this.history.length - 1];
          if (last) last.mate = patterns[0] || null;
        }
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

  // Piece-square tables from Red's point of view: row 0 is Black's back rank,
  // row 9 is Red's back rank. Black mirrors the table vertically. These replace
  // the old per-eval move generation, which was the single most expensive part
  // of evaluation (two pseudo-move lists per leaf node).
  const PIECE_SQUARE_ROWS = {
    p: [
      [34, 40, 46, 52, 56, 52, 46, 40, 34],
      [28, 34, 40, 46, 50, 46, 40, 34, 28],
      [22, 26, 32, 38, 42, 38, 32, 26, 22],
      [16, 20, 26, 32, 36, 32, 26, 20, 16],
      [10, 12, 16, 22, 26, 22, 16, 12, 10],
      [0, 0, 0, 0, 4, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0]
    ],
    n: [
      [0, 4, 8, 10, 10, 10, 8, 4, 0],
      [4, 8, 12, 16, 16, 16, 12, 8, 4],
      [6, 10, 16, 20, 22, 20, 16, 10, 6],
      [6, 12, 18, 24, 26, 24, 18, 12, 6],
      [4, 10, 16, 22, 24, 22, 16, 10, 4],
      [2, 8, 14, 18, 20, 18, 14, 8, 2],
      [0, 6, 10, 14, 16, 14, 10, 6, 0],
      [0, 4, 8, 10, 12, 10, 8, 4, 0],
      [0, 2, 4, 6, 8, 6, 4, 2, 0],
      [0, 0, 2, 4, 4, 4, 2, 0, 0]
    ],
    c: [
      [6, 6, 8, 10, 10, 10, 8, 6, 6],
      [6, 8, 10, 12, 12, 12, 10, 8, 6],
      [6, 8, 12, 14, 16, 14, 12, 8, 6],
      [6, 8, 12, 16, 18, 16, 12, 8, 6],
      [4, 6, 10, 14, 16, 14, 10, 6, 4],
      [4, 6, 10, 12, 14, 12, 10, 6, 4],
      [4, 6, 10, 12, 14, 12, 10, 6, 4],
      [4, 6, 10, 12, 12, 12, 10, 6, 4],
      [6, 8, 10, 12, 12, 12, 10, 8, 6],
      [6, 6, 8, 10, 10, 10, 8, 6, 6]
    ],
    r: [
      [10, 12, 12, 14, 14, 14, 12, 12, 10],
      [10, 14, 14, 16, 16, 16, 14, 14, 10],
      [10, 12, 14, 16, 18, 16, 14, 12, 10],
      [10, 12, 14, 18, 20, 18, 14, 12, 10],
      [8, 10, 12, 16, 18, 16, 12, 10, 8],
      [8, 10, 12, 14, 16, 14, 12, 10, 8],
      [6, 8, 10, 12, 14, 12, 10, 8, 6],
      [6, 8, 10, 12, 12, 12, 10, 8, 6],
      [6, 8, 10, 10, 10, 10, 10, 8, 6],
      [6, 6, 8, 10, 10, 10, 8, 6, 6]
    ],
    k: [
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, -10, -12, -10, 0, 0, 0],
      [0, 0, 0, -6, -8, -6, 0, 0, 0],
      [0, 0, 0, 2, 4, 2, 0, 0, 0]
    ]
  };
  const PIECE_SQUARE = {};
  for (const [type, rows] of Object.entries(PIECE_SQUARE_ROWS)) {
    const flat = [];
    for (const row of rows) flat.push(...row);
    PIECE_SQUARE[type] = Int16Array.from(flat);
  }

  function positionalBonus(piece, row, col, board) {
    const table = PIECE_SQUARE[piece.type];
    let score = table
      ? (piece.side === RED ? table[row * 9 + col] : table[(9 - row) * 9 + col])
      : 8;

    if (piece.type === "r") {
      let friendlyPawnsOnFile = 0;
      for (let r = 0; r < 10; r += 1) {
        const candidate = board[r * 9 + col];
        if (candidate && candidate.side === piece.side && candidate.type === "p") {
          friendlyPawnsOnFile += 1;
        }
      }
      if (friendlyPawnsOnFile === 0) score += 14;
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
      const material = PIECE_VALUES[piece.type] + positionalBonus(piece, row, col, board);
      score += piece.side === side ? material : -material;
    }

    if (endgame) {
      score += endgameAdjustment(board, side, counts);
      score += endgameKnowledgeScore(board, side, counts);
    }

    if (isInCheck(board, side)) score -= 30;
    else if (isInCheck(board, opposite(side))) score += 18;
    return score;
  }

  // Least valuable attacker of `square`, used by the static exchange
  // evaluation below.
  function leastValuableAttacker(board, side, square, exclude) {
    let bestSquare = -1;
    let bestValue = Infinity;
    for (let index = 0; index < 90; index += 1) {
      if (index === square || index === exclude) continue;
      const piece = board[index];
      if (!piece || piece.side !== side) continue;
      if (!attacksSquare(board, index, square)) continue;
      const value = PIECE_VALUES[piece.type] || 0;
      if (value < bestValue) {
        bestValue = value;
        bestSquare = index;
      }
    }
    return bestSquare;
  }

  // Static exchange evaluation: net material the mover wins by starting the
  // capture sequence on move.to, assuming both sides keep recapturing with
  // their least valuable attacker. Mutates the board only transiently.
  function staticExchangeScore(board, move) {
    if (!board[move.to]) return 0;
    const played = [];
    const gains = [];
    const firstVictim = board[move.to];
    played.push([move, doMove(board, move)]);
    gains.push(sideValueFromPiece(firstVictim));

    let recaptureSide = opposite(board[move.to].side);
    while (played.length < 24) {
      const from = leastValuableAttacker(board, recaptureSide, move.to, -1);
      if (from < 0) break;
      const recapture = { from, to: move.to };
      const victim = board[move.to];
      played.push([recapture, doMove(board, recapture)]);
      gains.push(sideValueFromPiece(victim) - gains[gains.length - 1]);
      recaptureSide = opposite(recaptureSide);
    }

    for (let index = gains.length - 1; index > 0; index -= 1) {
      gains[index - 1] = -Math.max(-gains[index - 1], gains[index]);
    }
    for (let index = played.length - 1; index >= 0; index -= 1) {
      undoMove(board, played[index][0], played[index][1]);
    }
    return gains[0];
  }

  function orderedMoves(board, moves, context, ply = 0, ttMove = null, withSee = true) {
    const ttCode = ttMove ? moveCode(ttMove) : -1;
    const killers = (context && context.killers && context.killers[ply]) || [];
    const history = context && context.history;
    const scored = new Array(moves.length);
    for (let index = 0; index < moves.length; index += 1) {
      const move = moves[index];
      const code = moveCode(move);
      const target = board[move.to];
      let score;
      if (code === ttCode) {
        score = 1e7;
      } else if (target) {
        const victim = sideValueFromPiece(target);
        const attacker = sideValueFromPiece(board[move.from]);
        score = 5e6 + victim * 16 - attacker;
        if (withSee && victim <= attacker) {
          const gain = staticExchangeScore(board, move);
          score = gain < 0 ? 5e6 - 500000 + gain : score + gain;
        }
      } else if (killers[0] === code) {
        score = 4e6;
      } else if (killers[1] === code) {
        score = 4e6 - 1;
      } else {
        score = history ? history[code] : 0;
      }
      scored[index] = { move, score, order: index };
    }
    scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
    const out = new Array(scored.length);
    for (let index = 0; index < scored.length; index += 1) out[index] = scored[index].move;
    return out;
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
      hash: 0,
      aborted: false,
      nullMove: Boolean(settings.nullMove),
      pvs: Boolean(settings.pvs),
      checkExtension: Boolean(settings.checkExtension),
      lmr: Boolean(settings.lmr),
      qDepth: defaultTo(settings.qDepth, 3)
    };
  }

  function storeKiller(context, ply, move) {
    if (!context.killers[ply]) context.killers[ply] = [];
    const key = moveCode(move);
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
    const moves = generateLegalMoves(board, side);
    if (moves.length === 0) return -MATE + ply;

    const standPat = checked ? -Infinity : evaluateBoard(board, side);
    const hardLimit = checked ? context.qDepth + 1 : context.qDepth;
    if (!checked) {
      if (extraDepth >= hardLimit) return standPat;
      if (standPat >= beta) return beta;
      alpha = Math.max(alpha, standPat);
    } else if (extraDepth >= hardLimit) {
      return evaluateBoard(board, side);
    }

    let candidates;
    if (checked) {
      candidates = moves;
    } else {
      // Keep only captures that survive delta pruning and a static exchange
      // test, so we stop wasting nodes on clearly losing exchanges.
      candidates = [];
      for (const move of moves) {
        const target = board[move.to];
        if (!target) continue;
        if (standPat + sideValueFromPiece(target) + 130 < alpha) continue;
        if (staticExchangeScore(board, move) < 0) continue;
        candidates.push(move);
      }
    }
    candidates = orderedMoves(board, candidates, context, ply, null, false);
    if (candidates.length === 0) return standPat;

    let best = standPat;
    for (const move of candidates) {
      const captured = doMove(board, move);
      const score = -quiescence(
        board,
        opposite(side),
        -beta,
        -alpha,
        ply + 1,
        context,
        extraDepth + 1
      );
      undoMove(board, move, captured);
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

    const checked = isInCheck(board, side);
    const searchDepth = checked && context.checkExtension ? depth + 1 : depth;
    if (searchDepth <= 0 && !checked) {
      return quiescence(board, side, alpha, beta, ply, context, 0);
    }

    const originalAlpha = alpha;
    const key = context.hash;
    const cached = context.cache.get(key);
    const ttMove = cached ? cached.move : null;
    if (cached && cached.depth >= searchDepth && !checked) {
      if (cached.flag === "exact") return cached.score;
      if (cached.flag === "lower") {
        if (cached.score > alpha) alpha = cached.score;
      } else if (cached.flag === "upper") {
        if (cached.score < beta) beta = cached.score;
      }
      if (alpha >= beta) return cached.score;
    }

    const staticEval = evaluateBoard(board, side);

    // Reverse futility pruning: if we still beat beta after handing the
    // opponent a free move, the subtree is very unlikely to be useful.
    if (
      !checked &&
      !ttMove &&
      searchDepth <= 4 &&
      beta - alpha === 1 &&
      beta < MATE &&
      beta > -MATE &&
      staticEval - 90 * searchDepth >= beta
    ) {
      return staticEval;
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
      staticEval >= beta &&
      hasNullMoveMaterial(board, side)
    ) {
      context.hash ^= ZOBRIST_SIDE;
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
      context.hash ^= ZOBRIST_SIDE;
      if (nullScore >= beta) return nullScore;
    }

    const futilityLimit = staticEval + 110 + 85 * searchDepth;
    let best = -Infinity;
    let bestMove = null;
    let moveIndex = 0;

    for (const move of moves) {
      const captured = doMoveHashed(board, move, context);
      const givesCheck = isInCheck(board, opposite(side));
      const quiet = !captured;

      // Futility and late move pruning near the leaves: quiet, non-checking
      // moves we are unlikely to need.
      if (
        quiet &&
        !givesCheck &&
        !checked &&
        searchDepth <= 3 &&
        best > -MATE + 1000
      ) {
        if (futilityLimit <= alpha) {
          undoMoveHashed(board, move, captured, context);
          continue;
        }
        if (moveIndex >= 8 + 4 * searchDepth) {
          undoMoveHashed(board, move, captured, context);
          continue;
        }
      }

      let reduction = 0;
      if (
        context.lmr &&
        !checked &&
        searchDepth >= 4 &&
        moveIndex >= 4 &&
        quiet &&
        !givesCheck &&
        (!context.history || context.history[moveCode(move)] <= 0)
      ) {
        reduction = 1;
        if (searchDepth >= 6 && moveIndex >= 10) reduction = 2;
        if (reduction > searchDepth - 3) reduction = searchDepth - 3;
      }

      let score;
      if (moveIndex === 0 || !context.pvs) {
        score = -negamax(
          board,
          opposite(side),
          searchDepth - 1 - reduction,
          -beta,
          -alpha,
          ply + 1,
          context
        );
      } else {
        score = -negamax(
          board,
          opposite(side),
          searchDepth - 1 - reduction,
          -alpha - 1,
          -alpha,
          ply + 1,
          context
        );
        if (score > alpha && reduction > 0) {
          score = -negamax(
            board,
            opposite(side),
            searchDepth - 1,
            -alpha - 1,
            -alpha,
            ply + 1,
            context
          );
        }
        if (score > alpha && score < beta) {
          score = -negamax(
            board,
            opposite(side),
            searchDepth - 1,
            -beta,
            -alpha,
            ply + 1,
            context
          );
        }
      }

      undoMoveHashed(board, move, captured, context);

      if (score > best) {
        best = score;
        bestMove = move;
      }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        if (quiet) {
          storeKiller(context, ply, move);
          context.history[moveCode(move)] += searchDepth * searchDepth;
        }
        break;
      }
      moveIndex += 1;
    }

    const flag = best <= originalAlpha ? "upper" : best >= beta ? "lower" : "exact";
    const existing = context.cache.get(key);
    if (!existing || searchDepth >= existing.depth) {
      context.cache.set(key, {
        depth: searchDepth,
        score: best,
        move: bestMove,
        flag
      });
    }
    if (context.cache.size >= 600000) context.cache.clear();
    return best;
  }

  function fallbackRootRanking(board, side, moves) {
    const ranked = new Array(moves.length);
    for (let index = 0; index < moves.length; index += 1) {
      const move = moves[index];
      const captured = doMove(board, move);
      ranked[index] = { move, score: -evaluateBoard(board, opposite(side)) };
      undoMove(board, move, captured);
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }

  function searchRoot(board, side, settings, context) {
    const legal = generateLegalMoves(board, side);
    if (legal.length === 0) return { ranked: [], depth: 0, aborted: false };
    context.hash = computeHash(board, side);
    let ranked = fallbackRootRanking(board, side, legal);
    let completedDepth = 0;

    for (let depth = 1; depth <= settings.depth; depth += 1) {
      if (context.aborted || context.deadline - performance.now() < 45) break;
      const ordered = ranked.map((entry) => entry.move);
      const current = [];
      let iterationComplete = true;
      let alpha = -Infinity;
      let firstMove = true;

      for (const move of ordered) {
        const captured = doMoveHashed(board, move, context);
        let score;
        if (firstMove || !context.pvs) {
          score = -negamax(board, opposite(side), depth - 1, -Infinity, -alpha, 1, context);
          firstMove = false;
        } else {
          score = -negamax(board, opposite(side), depth - 1, -alpha - 1, -alpha, 1, context);
          if (score > alpha) {
            score = -negamax(board, opposite(side), depth - 1, -Infinity, -alpha, 1, context);
          }
        }
        undoMoveHashed(board, move, captured, context);
        current.push({ move, score });
        if (score > alpha) alpha = score;
        if (context.aborted) {
          iterationComplete = false;
          break;
        }
      }

      if (!iterationComplete) break;
      current.sort((a, b) => b.score - a.score);
      ranked = current;
      completedDepth = depth;
      if (ranked[0] && ranked[0].score >= MATE - 1000) break;
    }

    return {
      ranked,
      depth: completedDepth || 1,
      aborted: context.aborted
    };
  }

  function searchMoveSubset(board, side, requestedMoves, settings) {
    const legal = generateLegalMoves(board, side);
    const requested = new Set(requestedMoves.map((move) => moveCode(move)));
    const moves = legal.filter((move) => requested.has(moveCode(move)));
    if (moves.length === 0) return { ranked: [], depth: 0, nodes: 0, aborted: false };

    const context = createSearchContext(settings, performance.now());
    context.hash = computeHash(board, side);
    let ranked = fallbackRootRanking(board, side, moves);
    let completedDepth = 0;

    for (let depth = 1; depth <= settings.depth; depth += 1) {
      if (context.aborted || context.deadline - performance.now() < 45) break;
      const current = [];
      let iterationComplete = true;
      let alpha = -Infinity;
      let firstMove = true;

      for (const entry of ranked) {
        const captured = doMoveHashed(board, entry.move, context);
        let score;
        if (firstMove || !context.pvs) {
          score = -negamax(board, opposite(side), depth - 1, -Infinity, -alpha, 1, context);
          firstMove = false;
        } else {
          score = -negamax(board, opposite(side), depth - 1, -alpha - 1, -alpha, 1, context);
          if (score > alpha) {
            score = -negamax(board, opposite(side), depth - 1, -Infinity, -alpha, 1, context);
          }
        }
        undoMoveHashed(board, entry.move, captured, context);
        current.push({ move: entry.move, score });
        if (score > alpha) alpha = score;
        if (context.aborted) {
          iterationComplete = false;
          break;
        }
      }

      if (!iterationComplete) break;
      current.sort((a, b) => b.score - a.score);
      ranked = current;
      completedDepth = depth;
      if (ranked[0] && ranked[0].score >= MATE - 1000) break;
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
      depth: defaultTo(options.depth, 4),
      candidates: defaultTo(options.candidates, 5),
      nodeLimit: defaultTo(options.nodeLimit, 240000),
      timeMs: defaultTo(options.timeMs, 2800),
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
      const ranked = search.ranked.map((entry) => Object.assign({}, entry, {
        evalRed: side === RED ? entry.score : -entry.score,
        winRed: scoreToRedWin(entry.score, side)
      }));
    const bestScore = ranked.length > 0 ? ranked[0].score : evaluateBoard(board, side);
    const evalRed = side === RED ? bestScore : -bestScore;
    return {
      side,
      score: bestScore,
      evalRed,
      winRed: clamp(scoreToRedWin(bestScore, side), 0.5, 99.5),
      bestMove: ranked.length > 0 ? ranked[0].move : null,
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

  // "瞎几把下" move choice: score how much a move helps, then pick from the
  // worst end of the list. It walks pieces into capture, ignores free material
  // and misses mates on purpose.
  function idiotMoveScore(board, move, side) {
    const target = board[move.to];
    let score = target ? sideValueFromPiece(target) * 6 : 0;
    const captured = doMove(board, move);
    const opponent = opposite(side);
    const landed = board[move.to];

    let attacked = false;
    for (let index = 0; index < 90 && !attacked; index += 1) {
      const piece = board[index];
      if (piece && piece.side === opponent && attacksSquare(board, index, move.to)) {
        attacked = true;
      }
    }
    let defended = false;
    if (attacked) {
      for (let index = 0; index < 90 && !defended; index += 1) {
        const piece = board[index];
        if (piece && piece.side === side && index !== move.to
          && attacksSquare(board, index, move.to)) {
          defended = true;
        }
      }
    }
    // Hanging a piece is bad play, so it scores low - and hanging something
    // expensive scores lower still.
    if (attacked && !defended && landed) score -= 200 + sideValueFromPiece(landed);
    if (isInCheck(board, opponent)) score += 200;

    undoMove(board, move, captured);
    return score;
  }

  function chooseIdiotMove(board, side, moves) {
    if (moves.length === 0) return null;
    if (moves.length === 1) return moves[0];
    // Mostly nonsense, otherwise a move from the worst-looking slice.
    if (Math.random() < 0.55) return moves[Math.floor(Math.random() * moves.length)];
    const scored = moves.map((move) => ({ move, score: idiotMoveScore(board, move, side) }));
    scored.sort((a, b) => a.score - b.score);
    const poolSize = Math.max(1, Math.ceil(scored.length * 0.15));
    const pool = scored.slice(0, poolSize);
    return pool[Math.floor(Math.random() * pool.length)].move;
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
    if (level.chaos) return chooseIdiotMove(board, side, moves);

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
    const allScores = analysis.moveScores && analysis.moveScores.length
      ? analysis.moveScores
      : analysis.candidates;
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
        const requestSettings = request.settings || {};
        const settings = {
          depth: defaultTo(requestSettings.depth, 4),
          timeMs: defaultTo(requestSettings.timeMs, 1200),
          nodeLimit: defaultTo(requestSettings.nodeLimit, 120000),
          nullMove: Boolean(requestSettings.nullMove),
          pvs: Boolean(requestSettings.pvs),
          checkExtension: Boolean(requestSettings.checkExtension),
          lmr: Boolean(requestSettings.lmr),
          qDepth: requestSettings.qDepth
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
          message: (error && error.message) || String(error)
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
      const worker = new Worker("ai-worker-bootstrap.js?v=" + APP_ASSET_VERSION, { name: "xiangqi-ai" });
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
        const reason = (event && event.message)
          || (event && event.error && event.error.message)
          || (event && event.filename
            ? `${event.filename}:${event.lineno || 0}`
            : "Worker failed");
        for (const pending of this.pending.values()) {
          pending.reject((event && event.error) || new Error(reason));
        }
      this.pending.clear();
      this.idle = this.idle.filter((item) => item !== worker);
    }

    request(message) {
      if (this.failed) return Promise.reject(new Error("Worker pool failed"));
      return new Promise((resolve, reject) => {
        const id = this.nextId++;
      this.queue.push({
        id,
        message: Object.assign({}, message, { id }),
        resolve,
        reject
      });
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
      } catch (error) {
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
        const merged = [];
        for (let index = 0; index < results.length; index += 1) {
          const ranked = results[index].ranked || [];
          for (let inner = 0; inner < ranked.length; inner += 1) {
            merged.push(ranked[inner]);
          }
        }
        return merged;
    } catch (error) {
      document.documentElement.dataset.workerBackend = "fallback";
      document.documentElement.dataset.workerError = (error && error.message) || String(error);
      if (enginePool && enginePool !== false) {
        enginePool.terminate();
        enginePool = false;
      }
      return null;
    }
  }

  async function analyzePositionScheduled(board, side, options) {
    const settings = {
      depth: defaultTo(options.depth, 4),
      timeMs: defaultTo(options.timeMs, 2800),
      nodeLimit: defaultTo(options.nodeLimit, 240000),
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
    const bestScore = ranked.length > 0 ? ranked[0].score : evaluateBoard(board, side);
    const evalRed = side === RED ? bestScore : -bestScore;
    return {
      side,
      score: bestScore,
      evalRed,
      winRed: clamp(scoreToRedWin(bestScore, side), 0.5, 99.5),
      bestMove: ranked.length > 0 ? ranked[0].move : null,
      bestNotation: ranked[0] ? moveToNotation(board, ranked[0].move) : "",
      candidates: ranked.slice(0, defaultTo(options.candidates, 5)),
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
    if (level.chaos) return chooseIdiotMove(game.board, game.sideToMove, moves);
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
    moveLine: document.getElementById("moveLine"),
    resultBanner: document.getElementById("resultBanner"),
    resultBannerText: document.getElementById("resultBannerText"),
    pieces: document.getElementById("pieces"),
    moveHints: document.getElementById("moveHints"),
    thinking: document.getElementById("thinking"),
    redSetup: document.getElementById("redSetup"),
    blackSetup: document.getElementById("blackSetup"),
    redColor: document.getElementById("redColor"),
    blackColor: document.getElementById("blackColor"),
    autoSpeed: document.getElementById("autoSpeed"),
    playToggle: document.getElementById("playToggle"),
    soundToggle: document.getElementById("soundToggle"),
    autoStep: document.getElementById("autoStep"),
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
    gameClock: document.getElementById("gameClock"),
    turnClock: document.getElementById("turnClock"),
    firstMove: document.getElementById("firstMove"),
    prevMove: document.getElementById("prevMove"),
    nextMove: document.getElementById("nextMove"),
    lastMove: document.getElementById("lastMove"),
    liveMode: document.getElementById("liveMode"),
    chatLog: document.getElementById("chatLog"),
    chatForm: document.getElementById("chatForm"),
    chatInput: document.getElementById("chatInput"),
    chatNote: document.getElementById("chatNote"),
    netBadge: document.getElementById("netBadge"),
    netUnavailable: document.getElementById("netUnavailable"),
    netIdle: document.getElementById("netIdle"),
    netActive: document.getElementById("netActive"),
    netMode: document.getElementById("netMode"),
    netServerField: document.getElementById("netServerField"),
    netServerUrl: document.getElementById("netServerUrl"),
    netServerJoin: document.getElementById("netServerJoin"),
    netRoomCode: document.getElementById("netRoomCode"),
    netJoinCode: document.getElementById("netJoinCode"),
    netWatchCode: document.getElementById("netWatchCode"),
    netRoomName: document.getElementById("netRoomName"),
    netSide: document.getElementById("netSide"),
    netHost: document.getElementById("netHost"),
    netRooms: document.getElementById("netRooms"),
    netSelfTest: document.getElementById("netSelfTest"),
    netRefresh: document.getElementById("netRefresh"),
    netManual: document.getElementById("netManual"),
    netManualJoin: document.getElementById("netManualJoin"),
    netStatusText: document.getElementById("netStatusText"),
    netDetail: document.getElementById("netDetail"),
    netResign: document.getElementById("netResign"),
    netNewGame: document.getElementById("netNewGame"),
    netLeave: document.getElementById("netLeave"),
    netLog: document.getElementById("netLog")
  };

  const state = {
    game: new XiangqiGame(),
    // Who plays each side ("human" or "ai"). Levels are kept per side even
    // while that side is human, so handing a side back to the AI restores the
    // strength it had before.
    control: { [RED]: "human", [BLACK]: "ai" },
    levels: { [RED]: "medium", [BLACK]: "medium" },
    selected: null,
    legalMoves: [],
    live: true,
    reviewPly: 0,
    displayAnalysis: null,
    busy: false,
    playing: false,
    autoSpeed: "normal",
    pieceColors: { red: "#8b0000", black: "#1f1d1a" },
    moveLineHidden: false,
    startedAt: 0,
    turnStartedAt: 0,
    endedAt: 0,
    soundOn: true,
    session: 0,
    // LAN multiplayer. Inactive until a room is joined or hosted, so the
    // single-player paths below stay exactly as they were.
    net: {
      active: false,
      inRoom: false,
      spectating: false,
      want: "play",
      opponentJoined: false,
      spectators: 0,
      role: null,
      mySide: null,
      peerName: "",
      peerSide: null,
      phase: "idle",
      mode: null,
      available: false,
      pendingUndo: false,
      sentAt: 0
    }
  };
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let allowAnimation = !prefersReducedMotion;
  let aiDriverToken = 0;

  // Optional LAN layer. It stays null in plain browsers and inside the test
  // harness, which disables the multiplayer entry points without touching any
  // of the single-player paths.
  const Net = (typeof window !== "undefined" && window.XiangqiNet) || null;

  function netActive() {
    return !!(state.net && state.net.active);
  }

  // In a net game the local player may only move on their own turn.
  function canMoveLocally() {
    if (!netActive()) return true;
    return state.net.mySide === state.game.sideToMove;
  }

  // Whether the local user may move right now. In a net game side ownership
  // comes from the room, not from the single-player per-side selects - those
  // still default to "red human / black AI" and used to block whoever joined.
  function canPlayNow() {
    if (netActive()) return canMoveLocally();
    return state.control[state.game.sideToMove] === "human";
  }

  // The per-side <select> encodes both ownership and AI strength:
  // "human" or "ai:<levelKey>".
  function parseSetup(value) {
    // "玩家" is what the two selects show while a net room is active.
    if (value === "player") return { control: "human", level: null };
    if (value === "human") return { control: "human", level: null };
    if (typeof value === "string" && value.startsWith("ai:")) {
      const level = value.slice(3);
      return { control: "ai", level: AI_LEVELS[level] ? level : "medium" };
    }
    return { control: "ai", level: "medium" };
  }

  function setupValue(side) {
    return state.control[side] === "human" ? "human" : `ai:${state.levels[side]}`;
  }

  function applySetup(side, value) {
    const parsed = parseSetup(value);
    state.control[side] = parsed.control;
    if (parsed.level) state.levels[side] = parsed.level;
  }

  function readSetupFromControls() {
    applySetup(RED, elements.redSetup.value);
    applySetup(BLACK, elements.blackSetup.value);
  }

  // In a net room both sides are people, so the two per-side selects are pinned
  // to "玩家" and locked. The single-player choice is restored on leaving.
  let netSetupBackup = null;

  function enterNetSetup() {
    if (!netSetupBackup) {
      netSetupBackup = {
        red: elements.redSetup.value,
        black: elements.blackSetup.value
      };
    }
    elements.redSetup.value = "player";
    elements.blackSetup.value = "player";
    elements.redSetup.disabled = true;
    elements.blackSetup.disabled = true;
    applySetup(RED, "player");
    applySetup(BLACK, "player");
  }

  function exitNetSetup() {
    if (!netSetupBackup) return;
    elements.redSetup.value = netSetupBackup.red;
    elements.blackSetup.value = netSetupBackup.black;
    elements.redSetup.disabled = false;
    elements.blackSetup.disabled = false;
    netSetupBackup = null;
    readSetupFromControls();
  }

  function levelFor(side) {
    return state.levels[side] || "medium";
  }

  function controlLabel(side) {
    if (netActive()) return side === state.net.mySide ? "你" : "对手";
    return state.control[side] === "human" ? "你" : `AI · ${AI_LEVELS[levelFor(side)].label}`;
  }

  function anyHumanControlled() {
    return state.control[RED] === "human" || state.control[BLACK] === "human";
  }

  function actorLabel(side) {
    const color = side === RED ? "红方" : "黑方";
    if (netActive()) {
      return `${color} · ${side === state.net.mySide ? "你" : "对手"}`;
    }
    return state.control[side] === "human" ? `${color} · 你` : `${color} · AI`;
  }

  // --- Piece colours ---------------------------------------------------------
  const PIECE_COLOR_KEY = "xiangqi.piece.colors";
  const DEFAULT_PIECE_COLORS = { red: "#8b0000", black: "#1f1d1a" };
  const HEX_COLOR = /^#[0-9a-f]{6}$/i;

  function normalizeColor(value, fallback) {
    return typeof value === "string" && HEX_COLOR.test(value)
      ? value.toLowerCase()
      : fallback;
  }

  // Relative luminance of the fill, so the glyph stays readable if someone
  // picks a light colour (white text by default, dark text on light fills).
  function glyphColorFor(fill) {
    const channel = (offset) => {
      const value = parseInt(fill.slice(offset, offset + 2), 16) / 255;
      return value <= 0.03928
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    return luminance > 0.55 ? "#1f1d1a" : "#ffffff";
  }

  function applyPieceColors(colors) {
    const red = normalizeColor(colors && colors.red, DEFAULT_PIECE_COLORS.red);
    const black = normalizeColor(colors && colors.black, DEFAULT_PIECE_COLORS.black);
    const redText = glyphColorFor(red);
    const blackText = glyphColorFor(black);
    document.documentElement.style.setProperty("--piece-red", red);
    document.documentElement.style.setProperty("--piece-black", black);
    document.documentElement.style.setProperty("--piece-red-text", redText);
    document.documentElement.style.setProperty("--piece-black-text", blackText);
    elements.redColor.value = red;
    elements.blackColor.value = black;
    state.pieceColors = { red, black };
    return { red, black, redText, blackText };
  }

  function loadPieceColors() {
    try {
      const raw = window.localStorage.getItem(PIECE_COLOR_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.red || parsed.black)) return parsed;
      }
    } catch (error) {
      // Storage can be unavailable; fall back to the defaults.
    }
    return DEFAULT_PIECE_COLORS;
  }

  function savePieceColors(colors) {
    try {
      window.localStorage.setItem(PIECE_COLOR_KEY, JSON.stringify(colors));
    } catch (error) {
      // Not being able to remember the choice is not fatal.
    }
  }

  function pieceColorsFromInputs() {
    return applyPieceColors({
      red: elements.redColor.value,
      black: elements.blackColor.value
    });
  }

  // --- Clock -----------------------------------------------------------------
  function formatClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (value) => String(value).padStart(2, "0");
    return hours > 0
      ? `${hours}:${pad(minutes)}:${pad(seconds)}`
      : `${pad(minutes)}:${pad(seconds)}`;
  }

  function updateClocks() {
    if (!elements.gameClock || !elements.turnClock) return;
    const now = Date.now();
    const ongoing = state.game.result.type === "ongoing";
    const last = lastOf(state.game.history);
    const totalMs = ongoing || !state.endedAt
      ? Math.max(0, now - (state.startedAt || now))
      : Math.max(0, state.endedAt - state.startedAt);
    const turnMs = ongoing
      ? Math.max(0, now - (state.turnStartedAt || now))
      : Math.max(0, (last && last.moveTimeMs) || 0);
    elements.gameClock.textContent = `本局 ${formatClock(totalMs)}`;
    elements.turnClock.textContent = `本手 ${formatClock(turnMs)}`;
  }

  // Called right after a move lands: stores how long that move took and starts
  // the clock for the next one.
  function markMoveTiming(record) {
    const now = Date.now();
    if (record) record.moveTimeMs = Math.max(0, now - (state.turnStartedAt || now));
    state.turnStartedAt = now;
    if (state.game.result.type !== "ongoing") state.endedAt = now;
  }

  // --- Sound -----------------------------------------------------------------
  // Clips ship inline in ai-data.js (Kenney, CC0) so playback needs no request.
  const SOUND_SOURCES = (GLOBAL_SCOPE.XiangqiAiData && GLOBAL_SCOPE.XiangqiAiData.sounds) || {};
  const SOUND_KEY = "xiangqi.sound.enabled";
  const SOUND_VOLUME = 0.5;
  const soundPlayers = Object.create(null);

  function soundPlayer(name) {
    if (soundPlayers[name] !== undefined) return soundPlayers[name];
    const source = SOUND_SOURCES[name];
    let player = null;
    if (source && typeof window.Audio === "function") {
      try {
        player = new window.Audio(source);
        player.preload = "auto";
        player.volume = SOUND_VOLUME;
      } catch (error) {
        player = null;
      }
    }
    soundPlayers[name] = player;
    return player;
  }

  function playSound(name) {
    if (!state.soundOn) return false;
    const player = soundPlayer(name);
    if (!player) return false;
    try {
      player.currentTime = 0;
      const started = player.play();
      if (started && typeof started.catch === "function") started.catch(() => {});
      return true;
    } catch (error) {
      // Autoplay policies may reject the very first clip; that is fine.
      return false;
    }
  }

  function loadSoundSetting() {
    try {
      if (window.localStorage.getItem(SOUND_KEY) === "off") return false;
    } catch (error) {
      // Without storage the default stays on.
    }
    return true;
  }

  function saveSoundSetting(enabled) {
    try {
      window.localStorage.setItem(SOUND_KEY, enabled ? "on" : "off");
    } catch (error) {
      // Forgetting the preference is not fatal.
    }
  }

  function updateSoundButton() {
    if (!elements.soundToggle) return;
    elements.soundToggle.textContent = state.soundOn ? "\u{1F50A}" : "\u{1F507}";
    elements.soundToggle.classList.toggle("muted", !state.soundOn);
    elements.soundToggle.setAttribute("aria-label", state.soundOn ? "关闭音效" : "开启音效");
    elements.soundToggle.title = state.soundOn ? "音效：开" : "音效：关";
  }

  function toggleSound() {
    state.soundOn = !state.soundOn;
    saveSoundSetting(state.soundOn);
    updateSoundButton();
    if (state.soundOn) playSound("place");
  }

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
      return (record && record.afterAnalysis) || (record && record.analysis)
        || state.displayAnalysis || {
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
    renderMoveLine();
    renderCaptured();
    renderStatus();
    renderResultBanner();
    renderAnalysis();
    renderMoveList();
    renderLabels();
    updateAutoStepButton();
    updatePlayButton();
    updateClocks();
    updateSoundButton();
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
    if (!ghost || !allowAnimation) return;
    elements.pieces.appendChild(ghost);
    void ghost.offsetWidth;
    ghost.classList.add("capture-ghost-out");
    window.setTimeout(() => ghost.remove(), 260);
  }

  function animateMoveTransition(record, reverse = false) {
    if (!record || !allowAnimation) return 0;
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

    // The connector belongs to the finished move, so hide it while the piece is
    // still sliding and draw the new one once it lands.
    state.moveLineHidden = true;
    renderMoveLine();
    spawnMoveTrail(target, sourceCol, sourceRow, targetCol, targetRow, duration);

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
      state.moveLineHidden = false;
      renderMoveLine();
      if (target.isConnected) {
        target.classList.remove("moving");
        target.style.removeProperty("--tx");
        target.style.removeProperty("--ty");
        target.style.removeProperty("--scale");
        target.style.removeProperty("--move-duration");
      }
    }, duration + 30);
    return duration;
  }

  // Fading after-images behind the sliding piece.
  function spawnMoveTrail(piece, fromCol, fromRow, toCol, toRow, duration) {
    if (!allowAnimation) return;
    const count = 4;
    const ghosts = [];
    for (let index = 1; index <= count; index += 1) {
      const ratio = index / (count + 1);
      const ghost = piece.cloneNode(true);
      ghost.classList.remove("playable", "selected", "last-move", "moving");
      ghost.classList.add("trail");
      ghost.removeAttribute("data-square");
      ghost.removeAttribute("aria-label");
      ghost.tabIndex = -1;
      ghost.style.removeProperty("--tx");
      ghost.style.removeProperty("--ty");
      ghost.style.removeProperty("--scale");
      ghost.style.setProperty("--x", String(fromCol + (toCol - fromCol) * ratio));
      ghost.style.setProperty("--y", String(fromRow + (toRow - fromRow) * ratio));
      ghost.style.setProperty("--trail-opacity", (0.26 - index * 0.045).toFixed(3));
      ghost.style.setProperty("--trail-duration", `${Math.round(duration * 0.7)}ms`);
      ghost.style.setProperty("--trail-delay", `${index * 16}ms`);
      elements.pieces.appendChild(ghost);
      ghosts.push(ghost);
    }
    window.setTimeout(() => {
      for (const ghost of ghosts) ghost.remove();
    }, duration + 200);
  }

  function renderMove(record, ghost) {
    playSound(record.captured ? "capture" : "place");
    render();
    const duration = animateMoveTransition(record);
    animateCapturedGhost(ghost);
    return duration;
  }

  function renderLabels() {
    // While a room is open the two selects are managed by enter/exitNetSetup,
    // so a plain render must not write the single-player values back into them.
    if (!state.net.inRoom) {
      elements.redSetup.value = setupValue(RED);
      elements.blackSetup.value = setupValue(BLACK);
    }
    elements.redLabel.textContent = controlLabel(RED);
    elements.blackLabel.textContent = controlLabel(BLACK);
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
        state.control[piece.side] === "human" &&
        state.game.sideToMove === piece.side
      ) {
        button.classList.add("playable");
      }

      const lastRecord = displayedPly > 0 ? state.game.history[displayedPly - 1] : null;
      if (lastRecord && (lastRecord.from === index || lastRecord.to === index)) {
        button.classList.add("last-move");
      }
      fragment.appendChild(button);
    }

      clearChildren(elements.pieces);
      elements.pieces.appendChild(fragment);
      clearChildren(elements.moveHints);
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
      clearChildren(elements.moveHints);
      elements.moveHints.appendChild(hintFragment);
  }

  // Dashed connector between the from/to squares of the displayed move, tinted
  // with the colour of the side that played it. It is replaced as soon as the
  // next move is played (or when the review cursor moves).
  function renderMoveLine() {
    const svg = elements.moveLine;
      if (!svg) return;
      if (state.moveLineHidden) {
        clearChildren(svg);
        return;
      }
    const ply = currentPly();
      const record = ply > 0 ? state.game.history[ply - 1] : null;
      if (!record) {
        clearChildren(svg);
        return;
      }

    const colors = state.pieceColors || DEFAULT_PIECE_COLORS;
    const color = record.side === RED ? colors.red : colors.black;
    const x1 = 50 + (record.from % 9) * 100;
    const y1 = 50 + Math.floor(record.from / 9) * 100;
    const x2 = 50 + (record.to % 9) * 100;
    const y2 = 50 + Math.floor(record.to / 9) * 100;
    // Centre to centre: the pieces layer paints above this SVG, so the two ends
    // are covered by the discs rather than the line being shortened.
    const sx = x1.toFixed(1);
    const sy = y1.toFixed(1);
    const ex = x2.toFixed(1);
    const ey = y2.toFixed(1);

    svg.innerHTML =
      `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}"`
      + ` stroke="${color}" stroke-width="7" stroke-linecap="round"`
      + ` stroke-dasharray="16 13" opacity="0.9" />`;
  }

  function renderCaptured() {
    const capturedByRed = [];
    const capturedByBlack = [];
    for (const record of state.game.history) {
      if (!record.captured) continue;
      if (record.side === RED) capturedByRed.push(record.captured);
      else capturedByBlack.push(record.captured);
    }
      setChildren(elements.redCaptured, capturedByRed.map(createCapturedPiece));
      setChildren(elements.blackCaptured, capturedByBlack.map(createCapturedPiece));
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
      const pattern = result.pattern ? ` · ${result.pattern.name}` : "";
      const winnerText = result.type === "draw"
        ? result.reason
        : `${result.winner === RED ? "红方" : "黑方"}胜 · ${result.reason}${pattern}`;
      setStatus(winnerText);
    } else {
      const playingSide = state.game.sideToMove;
      elements.turnBadge.textContent = `${playingSide === RED ? "红方" : "黑方"}行棋`;
      elements.turnBadge.className = `turn-badge${playingSide === BLACK ? " black" : ""}`;
      if (!state.live) {
        setStatus(`复盘到第 ${state.reviewPly} 手`);
      } else if (state.busy) {
        setStatus("AI 正在计算");
      } else if (netActive()) {
        setStatus(canMoveLocally()
          ? (state.selected === null ? "请选择棋子" : "请选择落点")
          : "等待对手落子");
      } else if (state.control[playingSide] === "human") {
        setStatus(state.selected === null ? "请选择棋子" : "请选择落点");
      } else if (!state.playing) {
        setStatus("已暂停 · 点播放让 AI 走子");
      } else {
        setStatus("等待 AI 落子");
      }
    }
    elements.moveCounter.textContent = `第 ${Math.max(1, Math.ceil(currentPly() / 2))} 回合`;
  }

  // Victory banner. It appears the moment a side wins and is cleared by the
  // next render of an unfinished game, i.e. after 新对局 or 悔棋.
  function renderResultBanner() {
    const banner = elements.resultBanner;
    const label = elements.resultBannerText;
    if (!banner || !label) return;
    const result = state.game.result;
    if (result.type !== "win" || !result.winner) {
      banner.hidden = true;
      label.textContent = "";
      return;
    }
    const detail = (result.pattern && result.pattern.name) || result.reason || "绝杀";
    label.textContent = `${result.winner === RED ? "红方" : "黑方"}胜，${detail}`;
    const colors = state.pieceColors || DEFAULT_PIECE_COLORS;
    banner.style.setProperty(
      "--banner-fill",
      result.winner === RED ? colors.red : colors.black
    );
    banner.hidden = false;
  }

  function renderAnalysis() {
    const analysis = analysisForCurrentPly();
    const winRed = defaultTo(analysis.winRed, 50);
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
    const playerRecord = lastOf(analyzed.filter((record) => state.control[record.side] === "human"))
      || (!anyHumanControlled() ? lastOf(analyzed) : null)
      || null;
    const currentQuality = playerRecord ? playerRecord.quality : null;

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
      const actor = actorLabel(currentRecord.side);
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
        const chosenRate = record.quality && record.quality.chosenRedRate;
        const afterRate = record.afterAnalysis && record.afterAnalysis.winRed;
        const beforeRate = record.analysis && record.analysis.winRed;
        points.push({
          x: index + 1,
          y: defaultTo(
            defaultTo(defaultTo(chosenRate, record.winRedAfter), afterRate),
            defaultTo(beforeRate, points[points.length - 1].y)
          )
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
    const timing = record.moveTimeMs ? ` · ${formatClock(record.moveTimeMs)}` : "";
    return `
      <div class="move-cell ${record.side === RED ? "red-side" : "black-side"}" data-ply="${index + 1}">
        <strong>${record.notation}</strong>
        <span>${quality}${record.analysis ? ` · 深度 ${record.analysis.depth}` : ""}${timing}</span>
        ${record.mate ? `<em class="mate-tag">${record.mate.name}</em>` : ""}
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
    const side = state.game.sideToMove;
    if (state.control[side] !== "human") {
      setStatus("该方由 AI 执子");
      return;
    }
    const piece = state.game.board[square];
    if (!piece || piece.side !== side) {
      state.selected = null;
      state.legalMoves = [];
      render();
      return;
    }
    state.selected = square;
    state.legalMoves = generateLegalMoves(state.game.board, side)
      .filter((move) => move.from === square);
    playSound("pickup");
    render();
  }

  async function performHumanMove(from, to, options = {}) {
    state.selected = null;
    state.legalMoves = [];
    allowAnimation = !prefersReducedMotion;
    const session = state.session;
    const ghost = captureCapturedGhost(from, to);
    const record = state.game.play(from, to);
    markMoveTiming(record);
    // A local move in a net game has to reach the other side; a move that
    // arrived from the wire must not be echoed back.
    if (netActive() && !options.remote) netSendMove(record);
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

    runAIDriver({ reply: true });
  }

  async function analyzeAndAttach(record, levels = {}) {
    const beforeLevel = levels.before || ANALYSIS_LEVEL;
    const afterLevel = levels.after || CURRENT_ANALYSIS_LEVEL;
    const boardBefore = positionAtPly(state.game.history, record.index);
    const analysis = await analyzePositionScheduled(
      boardBefore,
      record.side,
      beforeLevel
    );
    record.analysis = analysis;
    record.chosen = (analysis.moveScores || analysis.candidates).find((candidate) => (
      candidate.move.from === record.from && candidate.move.to === record.to
    )) || null;
      record.winRedAfter = defaultTo(record.chosen && record.chosen.winRed, analysis.winRed);
      record.evalRedAfter = defaultTo(record.chosen && record.chosen.evalRed, analysis.evalRed);
    record.quality = qualityForRecord(record, analysis);
    const boardAfter = positionAtPly(state.game.history, record.index + 1);
    const sideAfter = opposite(record.side);
    record.afterAnalysis = await analyzePositionScheduled(
      boardAfter,
      sideAfter,
      afterLevel
    );
  }

  // Makes a single AI move for whichever side is on the move. Shared by normal
  // human-vs-AI play and the AI-vs-AI auto play loop.
  async function playAIMoveOnce(options = {}) {
    if (state.game.result.type !== "ongoing") return;
    const session = state.session;
    const side = state.game.sideToMove;
    state.busy = true;
    state.selected = null;
    state.legalMoves = [];
    renderThinking();
    render();
    if (options.pauseBefore) await wait(options.pauseBefore);
    if (session !== state.session) return;

    const move = await chooseAIMoveScheduled(state.game, levelFor(side));
    if (session !== state.session) return;
    if (!move) {
      state.busy = false;
      renderThinking();
      render();
      return;
    }

    const ghost = captureCapturedGhost(move.from, move.to);
    const record = state.game.play(move.from, move.to);
    markMoveTiming(record);
    state.reviewPly = state.game.history.length;
    elements.thinking.hidden = true;
    const animationDuration = renderMove(record, ghost);
    await wait(animationDuration + 20);
    if (session !== state.session) return;
    await analyzeAndAttach(record, options.levels);
    if (session !== state.session) return;
    state.busy = false;
    renderThinking();
    state.displayAnalysis = record.afterAnalysis || record.analysis || state.displayAnalysis;
    render();
    return record;
  }

  function refreshAnimationFlag() {
    const speed = AUTO_PLAY_SPEEDS[state.autoSpeed] || AUTO_PLAY_SPEEDS.normal;
    allowAnimation = !prefersReducedMotion && speed.animate !== false;
  }

  function aiAnalysisLevels() {
    const speed = AUTO_PLAY_SPEEDS[state.autoSpeed] || AUTO_PLAY_SPEEDS.normal;
    return speed.fullAnalysis
      ? { before: ANALYSIS_LEVEL, after: CURRENT_ANALYSIS_LEVEL }
      : { before: CURRENT_ANALYSIS_LEVEL, after: CURRENT_ANALYSIS_LEVEL };
  }

  function updateAutoStepButton() {
    const usable = state.live
      && !state.busy
      && state.game.result.type === "ongoing"
      // Disabled in a net game: letting the engine pick your move would play
      // the game for you.
      && !netActive()
      && canPlayNow();
    elements.autoStep.disabled = !usable;
  }

  function updatePlayButton() {
    const hasAI = !netActive()
      && (state.control[RED] === "ai" || state.control[BLACK] === "ai");
    elements.playToggle.disabled = !hasAI;
    elements.playToggle.textContent = state.playing ? "\u23F8" : "\u25B6";
    elements.playToggle.classList.toggle("playing", state.playing);
    elements.playToggle.setAttribute("aria-label", state.playing ? "暂停" : "播放");
    elements.playToggle.title = state.playing ? "暂停 AI 走子" : "开始 AI 走子";
  }

  // Single AI driver. Every side marked "ai" moves on its own. A direct answer to
  // a human move always runs (options.reply), but continuous play - including a
  // full AI-vs-AI game - only runs while the play button is active.
  async function runAIDriver(options = {}) {
    // In a net game both sides are driven by their own player, never by the
    // local engine.
    if (netActive()) return;
    const token = ++aiDriverToken;
    const session = state.session;
    let movesLeft = options.reply ? 1 : (state.playing ? Infinity : 0);
    while (
      movesLeft > 0
      && token === aiDriverToken
      && session === state.session
      && state.game.result.type === "ongoing"
      && state.live
      && !state.busy
    ) {
      const side = state.game.sideToMove;
      if (state.control[side] !== "ai") break;

      const speed = AUTO_PLAY_SPEEDS[state.autoSpeed] || AUTO_PLAY_SPEEDS.normal;
      refreshAnimationFlag();
      const nextIsAI = state.control[opposite(side)] === "ai";
      const record = await playAIMoveOnce({
        levels: aiAnalysisLevels(),
        pauseBefore: defaultTo(options.pauseBefore, nextIsAI ? 0 : 90)
      });
      if (token !== aiDriverToken || session !== state.session) return;
      if (!record || state.game.result.type !== "ongoing") break;
      movesLeft -= 1;
      if (!state.playing) break;
      // Only pace the moves when the other side will also move on its own.
      if (state.control[state.game.sideToMove] === "ai") await wait(speed.delayMs);
    }
    allowAnimation = !prefersReducedMotion;
    if (state.game.result.type !== "ongoing" && state.playing) {
      state.playing = false;
      updatePlayButton();
    }
  }

  function togglePlay() {
    state.playing = !state.playing;
    updatePlayButton();
    if (state.playing) runAIDriver();
    else aiDriverToken += 1;
    render();
  }

  // "自动下一步": the system plays one move for whichever human-controlled side
  // is on the move, using that side's remembered AI strength.
  async function playAutoStep() {
    if (state.busy || !state.live || state.game.result.type !== "ongoing") return;
    if (netActive()) {
      setStatus("联机对局不使用自动下一步");
      return;
    }
    if (!canPlayNow()) {
      setStatus(state.control[state.game.sideToMove] === "ai" && !netActive()
        ? "该方由 AI 执子"
        : "还没轮到你");
      return;
    }
    allowAnimation = !prefersReducedMotion;
    await playAIMoveOnce({
      pauseBefore: 0,
      levels: { before: ANALYSIS_LEVEL, after: CURRENT_ANALYSIS_LEVEL }
    });
    await runAIDriver({ reply: true });
  }

  // A per-side select change can mean "take over", "hand back to the AI", or
  // just "change that side's strength" - all three take effect immediately.
  function onSetupChange(side, value) {
    applySetup(side, value);
    state.session += 1;
    aiDriverToken += 1;
    state.busy = false;
    refreshAnimationFlag();
    renderThinking();
    render();
    runAIDriver();
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function resetGame(options = {}) {
    state.session += 1;
    aiDriverToken += 1;
    state.game = new XiangqiGame();
    state.selected = null;
    state.legalMoves = [];
    state.live = true;
    state.reviewPly = 0;
    state.displayAnalysis = null;
    state.busy = false;
    state.startedAt = Date.now();
    state.turnStartedAt = state.startedAt;
    state.endedAt = 0;
    refreshAnimationFlag();
    renderThinking();
    render();
    if (netActive() && !options.remote) {
      netSend({ t: "newGame" });
      netLog("已请求重开新局");
    } else if (!netActive()) {
      appendChat("对手", "新对局开始，请多指教。", false);
    }
    runAIDriver();
  }

  function undo(options = {}) {
    // In a net game an undo has to be agreed by the other side first.
    if (netActive() && !options.remote) {
      if (state.game.history.length === 0) return;
      state.net.pendingUndo = true;
      netSend({ t: "undoReq" });
      netLog("已向对手发送悔棋请求");
      return;
    }
    // Cancel a move that is still being computed: undoing should win the race.
    state.session += 1;
    aiDriverToken += 1;
    state.busy = false;
    if (state.game.history.length === 0) {
      renderThinking();
      render();
      return;
    }
    state.game.undo(1);
    // When one side is human, step back past the AI's reply so it is the
    // human's turn again. With both sides automated, undo a single ply.
    const stopAtHuman = anyHumanControlled();
    while (
      stopAtHuman
      && state.game.history.length > 0
      && state.control[state.game.sideToMove] === "ai"
    ) {
      state.game.undo(1);
    }
    state.selected = null;
    state.legalMoves = [];
    state.live = true;
    state.reviewPly = state.game.history.length;
    state.busy = false;
    state.turnStartedAt = Date.now();
    state.endedAt = 0;
    const lastRecord = lastOf(state.game.history);
    state.displayAnalysis = (lastRecord && lastRecord.afterAnalysis)
      || (lastRecord && lastRecord.analysis) || null;
    renderThinking();
    render();
    runAIDriver();
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
    if (!canPlayNow()) return;
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
  elements.autoStep.addEventListener("click", playAutoStep);
  elements.playToggle.addEventListener("click", togglePlay);
  elements.soundToggle.addEventListener("click", toggleSound);
  elements.autoSpeed.addEventListener("change", () => {
    state.autoSpeed = elements.autoSpeed.value;
    refreshAnimationFlag();
  });
  elements.redColor.addEventListener("input", () => {
    savePieceColors(pieceColorsFromInputs());
  });
  elements.blackColor.addEventListener("input", () => {
    savePieceColors(pieceColorsFromInputs());
  });
  elements.redSetup.addEventListener("change", () => {
    onSetupChange(RED, elements.redSetup.value);
  });
  elements.blackSetup.addEventListener("change", () => {
    onSetupChange(BLACK, elements.blackSetup.value);
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
    runAIDriver();
  });
  elements.lastMove.addEventListener("click", () => {
    state.live = true;
    state.reviewPly = state.game.history.length;
    render();
    runAIDriver();
  });
  elements.liveMode.addEventListener("click", () => {
    state.live = true;
    state.reviewPly = state.game.history.length;
    render();
    runAIDriver();
  });

  document.querySelectorAll(".quick-chat").forEach((container) => {
    container.addEventListener("click", (event) => {
      const button = event.target.closest("[data-chat]");
      if (!button) return;
      const text = button.dataset.chat;
      appendChat("你", text, true);
      if (netActive()) netSend({ t: "chat", text });
      else respondToChat(text);
    });
  });

  elements.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = elements.chatInput.value.trim();
    if (!text) return;
    elements.chatInput.value = "";
    appendChat("你", text, true);
    if (netActive()) netSend({ t: "chat", text });
    else respondToChat(text);
  });

  // ------------------------------------------------------------ LAN multiplayer
  //
  // Transport and WebRTC live in net.js. Everything below is the game protocol
  // on top of it: who sits where, move exchange, chat, undo agreement, resign.

  const netPlayerName = "棋友" + (Math.floor(Math.random() * 90) + 10);

  function netLog(text) {
    if (!elements.netLog || !text) return;
    const stamp = new Date().toTimeString().slice(0, 8);
    elements.netLog.textContent += `[${stamp}] ${text}\n`;
    elements.netLog.scrollTop = elements.netLog.scrollHeight;
  }

  function netSend(message) {
    if (!Net) return false;
    const sent = Net.send(message);
    if (!sent && state.net.inRoom) netLog("通道未就绪，发送被丢弃");
    return sent;
  }

  function netSendMove(record) {
    netSend({
      t: "move",
      from: record.from,
      to: record.to,
      ply: record.index,
      elapsedMs: Math.max(0, Date.now() - (state.startedAt || Date.now())),
      turnMs: defaultTo(record.moveTimeMs, 0)
    });
  }

  function netBegin(role, mySide, peerName) {
    state.net.active = true;
    state.net.inRoom = true;
    state.net.role = role;
    state.net.mySide = mySide;
    state.net.peerSide = opposite(mySide);
    state.net.peerName = peerName || "对手";
    state.net.phase = "connected";
    state.net.pendingUndo = false;
    enterNetSetup();
    // Both sides start from a clean board, so the two copies line up.
    resetGame({ remote: true });
    // Spectators that arrived before the opponent need the fresh board too.
    if (role === "host") netSend({ t: "newGame" });
    appendChat("系统", `已连接，我方执${mySide === RED ? "红" : "黑"}`, false);
    netLog(`连接建立：我方执${mySide === RED ? "红" : "黑"}，对手 ${state.net.peerName}`);
    netRender();
  }

  function netFinishByResign(loser) {
    if (state.game.result.type !== "ongoing") return;
    state.game.result = { type: "win", winner: opposite(loser), reason: "认输" };
    state.endedAt = Date.now();
    state.playing = false;
    renderThinking();
    render();
  }

  function netApplySync(snapshot) {
    if (!snapshot) return;
    try {
      state.session += 1;
      aiDriverToken += 1;
      state.busy = false;
      state.game.restore(snapshot);
      state.live = true;
      state.reviewPly = state.game.history.length;
      state.selected = null;
      state.legalMoves = [];
      state.displayAnalysis = null;
      renderThinking();
      render();
      netLog("已按对手的快照对齐棋局");
    } catch (error) {
      netLog("对齐失败：" + defaultTo(error && error.message, "unknown"));
    }
  }

  function netApplyMove(message) {
    if (!netActive() || state.game.result.type !== "ongoing") return;
    if (state.net.mySide === state.game.sideToMove) {
      // It is our turn, so a move from the opponent means the two boards have
      // drifted apart. Ask for a snapshot instead of guessing.
      netLog("收到的走子不在对手回合，请求对齐");
      netSend({ t: "syncReq" });
      return;
    }
    if (state.game.history.length !== message.ply) {
      netLog("双方步数不一致，请求对齐");
      netSend({ t: "syncReq" });
      return;
    }
    if (typeof message.elapsedMs === "number") {
      state.startedAt = Date.now() - message.elapsedMs;
    }
    if (typeof message.turnMs === "number") {
      state.turnStartedAt = Date.now() - message.turnMs;
    }
    performHumanMove(message.from, message.to, { remote: true });
  }

  function netIncomingUndo() {
    const ask = "对手请求悔棋，同意吗？";
    const agreed = typeof window.confirm === "function" ? window.confirm(ask) : true;
    if (agreed) {
      netSend({ t: "undoOk" });
      undo({ remote: true });
      netLog("已同意对手悔棋");
    } else {
      netSend({ t: "undoNo" });
      netLog("已拒绝对手悔棋");
    }
  }

  // Records a spectator, tells it the current position, and keeps the game
  // untouched: a spectator never takes a seat.
  function netAddSpectator(message, peer) {
    const name = message.name || "观战者";
    state.net.spectators += 1;
    if (Net && peer && Net.setPeerKind) Net.setPeerKind(peer.id, "spectator");
    netLog(`${name} 加入观战（共 ${state.net.spectators} 人观战）`);
    if (Net && peer && Net.sendTo) {
      Net.sendTo(peer.id, {
        t: "welcome",
        proto: Net ? Net.proto : 1,
        role: "spectator",
        name: netPlayerName,
        redName: state.net.mySide === RED ? netPlayerName : state.net.peerName,
        blackName: state.net.mySide === BLACK ? netPlayerName : state.net.peerName,
        snapshot: state.game.snapshot(),
        elapsedMs: Math.max(0, Date.now() - (state.startedAt || Date.now())),
        turnMs: Math.max(0, Date.now() - (state.turnStartedAt || Date.now()))
      });
    }
    netRender();
  }

  function netRejectFull(peer) {
    if (Net && peer && Net.sendTo) {
      Net.sendTo(peer.id, { t: "welcome", full: true, name: netPlayerName });
    }
    netLog("已有两名棋手，拒绝了一名想加入对局的玩家");
  }

  function netBeginSpectator(message) {
    state.net.active = true;
    state.net.inRoom = true;
    state.net.spectating = true;
    state.net.role = "guest";
    state.net.mySide = null;
    state.net.peerSide = null;
    state.net.peerName = message.name || "房主";
    state.net.phase = "connected";
    state.net.pendingUndo = false;
    enterNetSetup();
    if (message.snapshot) netApplySync(message.snapshot);
    if (typeof message.elapsedMs === "number") {
      state.startedAt = Date.now() - message.elapsedMs;
    }
    if (typeof message.turnMs === "number") {
      state.turnStartedAt = Date.now() - message.turnMs;
    }
    appendChat("系统", `开始观战（房主 ${state.net.peerName}）`, false);
    netLog(`已开始观战：${message.redName || "红方"} vs ${message.blackName || "黑方"}`);
    render();
    netRender();
  }

  // Game events the host forwards from one peer to the rest. Without this a
  // spectator only ever sees the host's own moves, because the opponent's move
  // is addressed to the host alone.
  const NET_RELAY_TYPES = {
    move: true,
    chat: true,
    resign: true,
    newGame: true,
    // undoOk is a board change, so spectators need it. A request or a refusal
    // is not, and must not be answered by anyone but the opponent.
    undoOk: true,
    sync: true
  };

  function netRelayFromHost(message, peer) {
    if (state.net.role !== "host" || !peer || !Net || !Net.sendExcept) return;
    if (!NET_RELAY_TYPES[message.t]) return;
    Net.sendExcept(peer.id, message);
  }

  function netHandleMessage(message, peer) {
    if (!message || !message.t) return;
    netRelayFromHost(message, peer);
    switch (message.t) {
      case "hello":
        if (state.net.role !== "host") break;
        if (message.want === "spectate") {
          netAddSpectator(message, peer);
        } else if (state.net.opponentJoined) {
          netRejectFull(peer);
        } else {
          state.net.peerName = message.name || state.net.peerName || "对手";
          state.net.opponentJoined = true;
          netBegin("host", state.net.mySide, state.net.peerName);
          if (Net && peer && Net.sendTo) {
            Net.sendTo(peer.id, {
              t: "welcome",
              proto: Net ? Net.proto : 1,
              side: state.net.peerSide,
              name: netPlayerName
            });
          }
        }
        break;
      case "welcome":
        if (state.net.role !== "guest") break;
        if (message.full) {
          netLog("房间已满：已有两名棋手，可以改用「观战」");
          netLeave();
          break;
        }
        if (message.role === "spectator") {
          netBeginSpectator(message);
          break;
        }
        if (!state.net.active) netBegin("guest", message.side, message.name || "对手");
        break;
      case "move":
        netApplyMove(message);
        break;
      case "chat":
        appendChat(state.net.peerName || "对手", String(defaultTo(message.text, "")), false);
        break;
      case "undoReq":
        // Only the opponent answers an undo request; a spectator just watches.
        if (state.net.spectating) break;
        netIncomingUndo();
        break;
      case "undoOk":
        if (state.net.spectating) {
          // The two players agreed: the spectator's copy has to roll back too.
          undo({ remote: true });
          netLog("双方同意悔棋");
          break;
        }
        if (state.net.pendingUndo) {
          state.net.pendingUndo = false;
          netLog("对手同意悔棋");
          undo({ remote: true });
        }
        break;
      case "undoNo":
        state.net.pendingUndo = false;
        netLog("对手拒绝了悔棋");
        break;
      case "resign":
        netFinishByResign(state.net.peerSide);
        netLog("对手认输");
        break;
      case "newGame":
        resetGame({ remote: true });
        netLog("对手开始了新对局");
        break;
      case "syncReq":
        netSend({ t: "sync", snapshot: state.game.snapshot() });
        break;
      case "sync":
        netApplySync(message.snapshot);
        break;
      case "ping":
        netSend({ t: "pong", at: message.at });
        break;
      case "pong":
        state.net.rtt = Math.max(0, Date.now() - defaultTo(message.at, Date.now()));
        netRender();
        break;
      default:
        break;
    }
  }

  function netRenderRooms(list) {
    if (!elements.netRooms) return;
    clearChildren(elements.netRooms);
    if (!list || list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "暂时没有发现房间";
      elements.netRooms.appendChild(empty);
      return;
    }
    list.forEach((room) => {
      const row = document.createElement("div");
      row.className = "net-room";
      const name = document.createElement("span");
      name.className = "net-room-name";
      name.textContent = room.name || "未命名房间";
      const meta = document.createElement("span");
      meta.className = "net-room-meta";
      meta.textContent = defaultTo(room.addr && (room.addr.ip || room.addr.id), "本机");
      const actions = document.createElement("span");
      actions.className = "net-room-actions";
      const join = document.createElement("button");
      join.type = "button";
      join.className = "btn small";
      join.textContent = "加入";
      join.addEventListener("click", () => netJoin(room, "play"));
      const watch = document.createElement("button");
      watch.type = "button";
      watch.className = "btn small";
      watch.textContent = "观战";
      watch.addEventListener("click", () => netJoin(room, "spectate"));
      actions.appendChild(join);
      actions.appendChild(watch);
      row.appendChild(name);
      row.appendChild(meta);
      row.appendChild(actions);
      elements.netRooms.appendChild(row);
    });
  }

  function netRender() {
    const net = state.net;
    if (elements.netUnavailable) elements.netUnavailable.hidden = net.available;
    if (elements.netIdle) elements.netIdle.hidden = net.inRoom;
    if (elements.netActive) elements.netActive.hidden = !net.inRoom;
    if (elements.netBadge) {
      elements.netBadge.hidden = !net.inRoom;
      if (net.inRoom) {
        const side = net.mySide === RED ? "红" : net.mySide === BLACK ? "黑" : "待定";
        elements.netBadge.textContent = net.active
          ? `联机 · ${side} · ${net.rtt ? net.rtt + "ms" : "直连"}`
          : "联机 · 等待对手";
        elements.netBadge.classList.toggle("waiting", !net.active);
      }
    }
    if (elements.netStatusText && net.inRoom) {
      if (net.spectating) {
        elements.netStatusText.textContent = "观战中（不执棋）";
      } else if (net.active) {
        elements.netStatusText.textContent = net.role === "host"
          ? "房间已建立，对局进行中"
          : "已加入房间，对局进行中";
      } else {
        elements.netStatusText.textContent = net.role === "host"
          ? "正在广播房间，等待加入…"
          : "正在连接房间…";
      }
    }
    if (elements.netDetail && net.inRoom) {
      if (net.spectating) {
        elements.netDetail.textContent = `房主：${net.peerName} · 通道：${net.mode || "-"}`;
      } else if (net.active) {
        elements.netDetail.textContent = `对手：${net.peerName} · 通道：${net.mode || "-"}`
          + (net.spectators ? ` · 观众 ${net.spectators}` : "");
      } else {
        elements.netDetail.textContent = `通道：${net.mode || "-"}`;
      }
    }
    // A spectator watches: no resign, no restart.
    if (elements.netResign) elements.netResign.hidden = net.spectating;
    if (elements.netNewGame) elements.netNewGame.hidden = net.spectating;
    if (elements.chatNote) {
      elements.chatNote.textContent = net.active
        ? "联机聊天 · 消息会实时发给对手"
        : "本地模拟聊天 · 不连接网络";
    }
  }

  async function netScan() {
    if (!Net || !state.net.available || state.net.inRoom) return;
    // Server mode has no LAN room list - you join by room code.
    if (state.net.mode === "server") return;
    try {
      const list = await Net.scan();
      netRenderRooms(list);
      const key = list.map((room) => `${room.id}@${room.addr ? room.addr.ip : ""}`).join(",");
      if (key !== lastRoomKey) {
        lastRoomKey = key;
        netLog(list.length
          ? `发现 ${list.length} 个房间：${list
            .map((room) => `${room.name || "未命名"}(${room.addr ? room.addr.ip : "?"})`)
            .join("、")}`
          : "暂未发现局域网房间");
      }
    } catch (error) {
      netLog("搜索房间失败：" + defaultTo(error && error.message, "unknown"));
    }
  }

  let lastRoomKey = "";

  const NET_MODE_KEY = "xiangqi.net.mode";
  const NET_SERVER_KEY = "xiangqi.net.server";
  const DEFAULT_NET_SERVER = "wss://c.syjnb.top/ws";

  function defaultNetMode() {
    const isBlogWeb = GLOBAL_SCOPE.location.protocol === "https:" && GLOBAL_SCOPE.location.hostname === "web.syjnb.top";
    return {
      mode: isBlogWeb ? "server" : "lan",
      server: DEFAULT_NET_SERVER
    };
  }

  function loadNetMode() {
    try {
      const fallback = defaultNetMode();
      return {
        mode: localStorage.getItem(NET_MODE_KEY) || fallback.mode,
        server: localStorage.getItem(NET_SERVER_KEY) || fallback.server
      };
    } catch (error) {
      return defaultNetMode();
    }
  }

  function saveNetMode(mode, server) {
    try {
      localStorage.setItem(NET_MODE_KEY, mode);
      localStorage.setItem(NET_SERVER_KEY, server);
    } catch (error) { /* private mode */ }
  }

  // Switching between LAN discovery and the relay server. Both drop whatever
  // room is open, so the log says so explicitly.
  async function netApplyMode() {
    if (!Net) return;
    const mode = defaultTo(elements.netMode && elements.netMode.value, "lan");
    const server = defaultTo(elements.netServerUrl && elements.netServerUrl.value.trim(), "");
    const useServer = mode === "server";
    saveNetMode(mode, server);

    if (elements.netServerField) elements.netServerField.hidden = !useServer;
    if (elements.netServerJoin) elements.netServerJoin.hidden = !useServer;
    if (elements.netRefresh) elements.netRefresh.hidden = useServer;
    if (elements.netRooms) elements.netRooms.hidden = useServer;
    if (elements.netManual) elements.netManual.parentNode.hidden = useServer;

    if (useServer && !server) {
      netLog("请先填写服务器地址，再创建或加入房间");
      return;
    }
    if (useServer) {
      if (typeof Net.setServer === "function") await Net.setServer(server);
      netLog("已切换到服务器模式：" + server);
    } else {
      if (typeof Net.setLan === "function") await Net.setLan();
      netLog("已切换到局域网模式");
    }

    const status = await Net.ready();
    state.net.available = !!status.available;
    state.net.mode = status.mode;
    if (status.localIps && status.localIps.length) {
      netLog("本机局域网地址：" + status.localIps.join(" / "));
    }
    netRender();
  }

  // Server mode joins by room code instead of picking from a discovered list.
  async function netJoinByCode(want) {
    if (!Net || typeof Net.joinByCode !== "function") return;
    if (state.net.inRoom) return;
    const code = defaultTo(elements.netRoomCode && elements.netRoomCode.value.trim(), "")
      .toUpperCase();
    // The relay always hands out exactly six characters; anything else is a
    // typo and would just round-trip to a "房间不存在" from the server.
    if (code.length !== 6) {
      netLog("请输入 6 位房间码");
      return;
    }
    const spectate = want === "spectate";
    state.net.inRoom = true;
    state.net.active = false;
    state.net.spectating = spectate;
    state.net.want = spectate ? "spectate" : "play";
    state.net.role = "guest";
    state.net.mySide = null;
    state.net.peerSide = null;
    state.net.phase = "connecting";
    enterNetSetup();
    netLog(`正在通过服务器加入「${code}」…`);
    netRender();
    try {
      await Net.joinByCode(code, { player: netPlayerName, want: state.net.want });
    } catch (error) {
      state.net.phase = "error";
      netLog("加入房间失败：" + defaultTo(error && error.message, "unknown"));
      netRender();
    }
  }

  // One-click diagnostic: proves whether this device can do UDP at all before
  // blaming the network.
  async function netRunSelfTest() {
    if (!Net || typeof Net.selfTest !== "function") {
      netLog("当前版本不支持网络自检");
      return;
    }
    netLog("开始网络自检…");
    try {
      const result = await Net.selfTest();
      if (result && result.ok) {
        if (result.note === "server-reachable") {
          netLog(`自检通过：服务器可达（${result.mode || "server"}）`);
        } else {
          netLog(`自检通过：${result.mode || "-"} 通道可收发（本机回环已验证）`);
        }
      } else {
        netLog(`自检失败：${(result && result.reason) || "unknown"}`
          + (result && result.mode ? `（通道 ${result.mode}）` : ""));
      }
    } catch (error) {
      netLog("自检异常：" + defaultTo(error && error.message, "unknown"));
    }
    // TURN 单独自检：直连失败时它就是唯一能救场的通道，值得单独验一次。
    if (Net && typeof Net.turnCheck === "function") {
      try {
        const turn = await Net.turnCheck();
        if (turn && turn.ok) {
          netLog("中继自检：TURN 可用（已拿到中继候选）");
        } else if (turn && turn.reason === "no-turn-configured") {
          netLog("中继自检：未配置 TURN，只能直连");
        } else {
          netLog("中继自检：TURN 不可用（" + defaultTo(turn && turn.reason, "unknown") + "）");
        }
      } catch (error) {
        netLog("中继自检异常：" + defaultTo(error && error.message, "unknown"));
      }
    }
    if (typeof Net.status === "function") {
      const status = Net.status();
      if (status && status.localIps && status.localIps.length) {
        netLog("本机局域网地址：" + status.localIps.join(" / "));
      }
    }
  }

  function netHandleDebug(event) {
    if (!event || !event.kind) return;
    const detail = event.detail || {};
    switch (event.kind) {
      case "announce":
        netLog(`正在广播房间「${detail.name || ""}」`);
        break;
      case "offer":
        netLog(`已向 ${detail.ip || "?"}:${detail.port || "?"} 发送连接请求`);
        break;
      case "recv":
        if (detail.type === "offer" || detail.type === "answer") {
          netLog(`收到 ${detail.from || "对方"} 的${detail.type === "offer" ? "连接请求" : "应答"}`);
        }
        break;
      case "answer":
        netLog(`已把应答发回 ${detail.ip || "?"}`);
        break;
      case "ice":
        netLog(`收到 ${detail.from || "对方"} 的候选地址`);
        break;
      case "candidate":
        netLog("本机候选：" + (detail.text || ""));
        break;
      case "relay":
        netLog("已获得中继候选（TURN 中继可用）");
        break;
      case "connected":
        netLog(detail.kind === "spectator" ? "观众已连上" : "点对点通道已建立");
        break;
      case "left":
        netLog(detail.kind === "spectator" ? "一名观众离开了" : "对局通道断开");
        break;
      case "disconnected":
        netLog(`点对点通道断开（${event.detail || ""}）`);
        break;
      case "closed":
        netLog("点对点通道已关闭");
        break;
      default:
        break;
    }
  }

  async function netHost() {
    if (!Net) return;
    if (state.net.inRoom) return;
    const preference = defaultTo(elements.netSide && elements.netSide.value, "red");
    const side = preference === "random"
      ? (Math.random() < 0.5 ? RED : BLACK)
      : (preference === "black" ? BLACK : RED);
    state.net.inRoom = true;
    state.net.active = false;
    state.net.role = "host";
    state.net.mySide = side;
    state.net.peerSide = opposite(side);
    state.net.phase = "announcing";
    enterNetSetup();
    try {
      const created = await Net.hostRoom({
        name: defaultTo(elements.netRoomName && elements.netRoomName.value.trim(), "") || "我的棋局",
        player: netPlayerName
      });
      if (created && created.mode === "server" && created.room && created.room.id) {
        netLog(`房间码 ${created.room.id} —— 发给对手即可加入`);
      } else {
        netLog(`正在广播房间，我方执${side === RED ? "红" : "黑"}`);
      }
    } catch (error) {
      state.net.phase = "error";
      netLog("创建房间失败：" + defaultTo(error && error.message, "unknown"));
    }
    netRender();
  }

  async function netJoin(room, want) {
    if (!Net || !room) return;
    if (state.net.inRoom) return;
    const spectate = want === "spectate";
    state.net.inRoom = true;
    state.net.active = false;
    state.net.spectating = spectate;
    state.net.want = spectate ? "spectate" : "play";
    state.net.role = "guest";
    state.net.mySide = null;
    state.net.peerSide = null;
    state.net.phase = "connecting";
    enterNetSetup();
    netLog(`正在连接「${room.name || "房间"}」…`);
    netRender();
    try {
      await Net.joinRoom(room, { player: netPlayerName, want: state.net.want });
    } catch (error) {
      state.net.phase = "error";
      netLog("加入房间失败：" + defaultTo(error && error.message, "unknown"));
      netRender();
    }
  }

  function netLeave() {
    if (Net) Net.leave();
    if (state.net.inRoom) netLog("已离开房间");
    exitNetSetup();
    state.net.active = false;
    state.net.inRoom = false;
    state.net.spectating = false;
    state.net.want = "play";
    state.net.opponentJoined = false;
    state.net.spectators = 0;
    state.net.role = null;
    state.net.mySide = null;
    state.net.peerSide = null;
    state.net.peerName = "";
    state.net.phase = "idle";
    state.net.pendingUndo = false;
    // Refresh the buttons: "auto next step" comes back once the room is gone.
    render();
    netRender();
  }

  function netResign() {
    if (!netActive()) return;
    const ask = "确定认输吗？";
    if (typeof window.confirm === "function" && !window.confirm(ask)) return;
    netSend({ t: "resign" });
    netFinishByResign(state.net.mySide);
    netLog("我方认输");
  }

  function netManualJoin() {
    if (!elements.netManual) return;
    const raw = elements.netManual.value.trim();
    if (!raw) return;
    const parts = raw.split(":");
    const ip = parts[0];
    const port = Number(parts[1] || 0);
    if (!ip) return;
    netJoin({
      id: ip + ":" + port,
      name: ip,
      addr: { id: ip, ip: ip, port: port }
    }, "play");
  }

  function netWire() {
    if (elements.netHost) elements.netHost.addEventListener("click", netHost);
    if (elements.netSelfTest) {
      elements.netSelfTest.addEventListener("click", netRunSelfTest);
    }
    if (elements.netRefresh) elements.netRefresh.addEventListener("click", netScan);
    if (elements.netLeave) elements.netLeave.addEventListener("click", netLeave);
    if (elements.netResign) elements.netResign.addEventListener("click", netResign);
    if (elements.netManualJoin) elements.netManualJoin.addEventListener("click", netManualJoin);
    if (elements.netMode) elements.netMode.addEventListener("change", netApplyMode);
    if (elements.netServerUrl) {
      elements.netServerUrl.addEventListener("change", netApplyMode);
    }
    if (elements.netJoinCode) {
      elements.netJoinCode.addEventListener("click", () => netJoinByCode("play"));
    }
    if (elements.netWatchCode) {
      elements.netWatchCode.addEventListener("click", () => netJoinByCode("spectate"));
    }
    if (elements.netNewGame) {
      elements.netNewGame.addEventListener("click", () => resetGame());
    }
  }

  async function netInit() {
    netWire();
    if (!Net) {
      state.net.available = false;
      netRender();
      return;
    }
    Net.onStatus((status) => {
      state.net.phase = status.phase;
      state.net.mode = status.mode;
      if (status.phase === "error") netLog("通道错误：" + defaultTo(status.error, "unknown"));
      if (status.phase === "connected") {
        netLog("数据通道已建立");
        if (state.net.role === "guest" && !state.net.active) {
          netSend({ t: "hello", name: netPlayerName, want: state.net.want });
        }
      }
      if (status.phase === "announcing" && state.net.active) {
        state.net.active = false;
        netLog("与对手的连接已断开");
      }
      netRender();
    });
    Net.onMessage((message, peer) => netHandleMessage(message, peer));
    if (typeof Net.onDebug === "function") Net.onDebug(netHandleDebug);
    // Restore the last used connection mode before probing anything.
    const savedMode = loadNetMode();
    if (elements.netMode) elements.netMode.value = savedMode.mode;
    if (elements.netServerUrl) elements.netServerUrl.value = savedMode.server;
    const serverMode = savedMode.mode === "server";
    if (elements.netServerField) elements.netServerField.hidden = !serverMode;
    if (elements.netServerJoin) elements.netServerJoin.hidden = !serverMode;
    if (elements.netRefresh) elements.netRefresh.hidden = serverMode;
    if (elements.netRooms) elements.netRooms.hidden = serverMode;
    if (serverMode && savedMode.server && typeof Net.setServer === "function") {
      await Net.setServer(savedMode.server);
    }
    const status = await Net.ready();
    state.net.available = !!status.available;
    state.net.mode = status.mode;
    if (status.localIps && status.localIps.length) {
      netLog("本机局域网地址：" + status.localIps.join(" / "));
    }
    if (state.net.available) {
      netScan();
      window.setInterval(() => {
        if (state.net.inRoom) return;
        netScan();
      }, 2500);
      window.setInterval(() => {
        if (!netActive()) return;
        netSend({ t: "ping", at: Date.now() });
      }, 4000);
    }
    netRender();
  }

  window.XiangqiLocal = {
    game: () => state.game,
    state,
    perft,
    initialBoard: () => cloneBoard(INITIAL_POSITION),
    generateLegalMoves,
    orderedMoves,
    AI_LEVELS,
    ANALYSIS_LEVEL,
    analyzePosition,
    searchMoveSubset,
    chooseAIMove,
    playAutoStep,
    togglePlay,
    onSetupChange,
    runAIDriver,
    applySetup,
    setupValue,
    levelFor,
    applyPieceColors,
    DEFAULT_PIECE_COLORS,
    renderMoveLine,
    spawnMoveTrail,
    formatClock,
    updateClocks,
    markMoveTiming,
    renderMoveList,
    classifyMate,
    MATE_PATTERNS,
    isInCheck,
    renderResultBanner,
    playSound,
    toggleSound,
    reset: resetGame,
    canMoveLocally,
    canPlayNow,
    netActive,
    netHandleMessage,
    netBegin,
    netApplyMove,
    netSend,
    netLeave,
    netApplySync,
    netFinishByResign
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

  readSetupFromControls();
  applyPieceColors(loadPieceColors());
  state.soundOn = loadSoundSetting();
  resetGame();
  netInit();
  // Keep the clocks live. `setInterval` is optional so a headless harness that
  // only stubs setTimeout can still load this file.
  if (typeof window.setInterval === "function") {
    window.setInterval(updateClocks, 500);
  }
  }
})();
