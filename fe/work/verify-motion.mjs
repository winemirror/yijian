// Verifies the move trail and the dashed previous-move connector.
import fs from "node:fs";
import path from "node:path";
import { loadEngine, RED, BLACK } from "./harness.mjs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const engine = loadEngine(path.join(here, "www", "app.js"));
const css = fs.readFileSync(path.join(here, "www", "styles.css"), "utf8");
const html = fs.readFileSync(path.join(here, "www", "index.html"), "utf8");

const problems = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

function fakePiece() {
  const classes = new Set(["piece", "r"]);
  const props = {};
  const attributes = { "data-square": "51", "aria-label": "红车" };
  return {
    classes,
    props,
    attributes,
    tabIndex: 0,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: () => {},
    },
    style: {
      setProperty: (name, value) => { props[name] = String(value); },
      removeProperty: (name) => { delete props[name]; },
    },
    removeAttribute: (name) => { delete attributes[name]; },
    remove: () => {},
    cloneNode: () => fakePiece(),
  };
}

console.log("== markup + stylesheet ==");
check("board has a move-line layer", html.includes('id="moveLine"'));
check(".move-line is styled", /\.move-line\s*\{[^}]*\}/.test(css));
check(".piece.trail is styled", /\.piece\.trail\s*\{[^}]*\}/.test(css));
check("trail keyframes exist", /@keyframes\s+piece-trail/.test(css));
check("trail blurs the after-image", /\.piece\.trail\s*\{[^}]*blur\(/.test(css));

console.log("== dashed connector ==");
const line = () => engine.__document.getElementById("moveLine").innerHTML;
{
  engine.renderMoveLine();
  check("no line before the first move", line() === "", JSON.stringify(line()));

  engine.applyPieceColors({ red: "#ff0000", black: "#00ff00" });
  engine.state.game.play(60, 51); // red pawn forward
  engine.renderMoveLine();
  const redLine = line();
  console.log(`  red move   : ${redLine}`);
  check("connector drawn after a move", redLine.includes("<line"));
  check("connector is dashed", redLine.includes("stroke-dasharray"));
  check("connector uses the red side colour", redLine.includes('stroke="#ff0000"'));
  check("connector spans from 60 to 51",
    redLine.includes('x1="650.0"') && redLine.includes('y1="650.0"')
    && redLine.includes('x2="650.0"') && redLine.includes('y2="550.0"'),
    redLine);

  engine.state.game.play(1, 20); // black horse out
  engine.renderMoveLine();
  const blackLine = line();
  console.log(`  black move : ${blackLine}`);
  check("connector switches to the black side colour", blackLine.includes('stroke="#00ff00"'));
  check("connector follows the newest move",
    blackLine !== redLine
    && blackLine.includes('x1="150.0"') && blackLine.includes('y1="50.0"')
    && blackLine.includes('x2="250.0"') && blackLine.includes('y2="250.0"'),
    blackLine);
  check("connector anchors on the piece centres",
    redLine.includes('y1="650.0"') && redLine.includes('y2="550.0"'));
  check("pieces layer paints above the connector",
    /\.pieces\s*\{[^}]*z-index:\s*3/.test(css)
    && /\.move-line\s*\{[^}]*z-index:\s*2/.test(css));

  engine.applyPieceColors(engine.DEFAULT_PIECE_COLORS);
  engine.renderMoveLine();
  check("connector uses the current custom colours",
    line().includes('stroke="#1f1d1a"'), line());
}

console.log("== board flip ==");
{
  check("topbar has a flip button", html.includes('id="flipBoard"'));
  check("flipped layout swaps the player strips",
    /\.game-column\.flipped \.player-strip\.red\s*\{[^}]*order:\s*1/.test(css)
    && /\.game-column\.flipped \.player-strip\.black\s*\{[^}]*order:\s*3/.test(css));

  engine.reset();
  engine.state.flipped = false;
  engine.renderPieces();
  // renderPieces 先塞进 DocumentFragment 再 append；测试里把它摊平。
  const flatPieces = () => {
    const root = engine.__document.getElementById("pieces");
    const out = [];
    const walk = (nodes) => (nodes || []).forEach((node) => {
      if (node.dataset && node.dataset.square) out.push(node);
      else if (node.children) walk(node.children);
    });
    walk(root.children);
    return out;
  };
  // 桩 DOM 的 clearChildren 不会真的清空，取最后一批节点。
  const findPiece = (square) => flatPieces()
    .filter((node) => node.dataset.square === square)
    .pop();
  const normal = findPiece("60");
  check("默认红方在下：60 显示在第 6 列第 6 行",
    !!normal && normal.style.props["--x"] === "6" && normal.style.props["--y"] === "6",
    JSON.stringify(normal && normal.style.props));

  engine.state.flipped = true;
  engine.renderPieces();
  const flipped = findPiece("60");
  check("翻转后棋子坐标取反",
    !!flipped && flipped.style.props["--x"] === "2" && flipped.style.props["--y"] === "3",
    JSON.stringify(flipped && flipped.style.props));

  engine.state.game.play(60, 51);
  engine.renderMoveLine();
  const flippedLine = line();
  console.log(`  flipped line: ${flippedLine}`);
  check("翻转后虚线坐标同步",
    flippedLine.includes('x1="250.0"') && flippedLine.includes('y1="350.0"')
    && flippedLine.includes('x2="250.0"') && flippedLine.includes('y2="450.0"'),
    flippedLine);

  // 点击反解：屏幕坐标 -> 棋盘索引，翻转后必须也能对上。
  engine.state.flipped = false;
  check("未翻转时点击坐标反解正确",
    engine.pointToSquare({ clientX: 650, clientY: 650 }) === 60,
    String(engine.pointToSquare({ clientX: 650, clientY: 650 })));
  engine.state.flipped = true;
  check("翻转后点击坐标反解到正确棋盘索引",
    engine.pointToSquare({ clientX: 650, clientY: 650 }) === 29,
    String(engine.pointToSquare({ clientX: 650, clientY: 650 })));
  const roundTrip = [0, 4, 60, 85].every((square) => {
    const row = Math.floor(square / 9);
    const col = square % 9;
    const visualCol = 8 - col;
    const visualRow = 9 - row;
    return engine.pointToSquare({
      clientX: 50 + visualCol * 100,
      clientY: 50 + visualRow * 100
    }) === square;
  });
  check("翻转后显示位置与棋盘索引一一对应", roundTrip);

  engine.state.flipped = false;
  engine.toggleBoardFlip();
  check("翻转按钮切换状态", engine.state.flipped === true);
  check("翻转状态写入 localStorage",
    engine.__window.localStorage.getItem("xiangqi.board.flipped") === "1",
    String(engine.__window.localStorage.getItem("xiangqi.board.flipped")));
  engine.toggleBoardFlip();
  check("再次翻转恢复并写入 0",
    engine.state.flipped === false
      && engine.__window.localStorage.getItem("xiangqi.board.flipped") === "0");
}

console.log("== move ticker ==");
{
  check("markup has a move ticker", html.includes('id="moveTicker"'));
  check("ticker is horizontally scrollable and width-capped",
    /\.move-ticker\s*\{[^}]*overflow-x:\s*auto/.test(css)
    && /\.move-ticker\s*\{[^}]*min-width:\s*0/.test(css)
    && /\.move-ticker\s*\{[^}]*max-width:\s*100%/.test(css)
    && /\.move-ticker::-webkit-scrollbar\s*\{/.test(css));

  engine.reset();
  engine.state.game.play(60, 51);
  engine.state.game.play(1, 20);
  // 桩 DOM 的 clearChildren 不会真的清空，测试前手动清掉旧节点。
  const tickerEl = engine.__document.getElementById("moveTicker");
  tickerEl.children.length = 0;
  engine.renderMoveTicker();
  const ticker = tickerEl;
  const items = ticker.children;
  check("ticker lists both moves in order",
    items.length === 2
      && items[0].textContent === engine.state.game.history[0].notation
      && items[1].textContent === engine.state.game.history[1].notation,
    items.map((node) => node.textContent).join("|"));
  check("latest move is highlighted",
    !!items[1] && items[1].className.includes("latest")
      && !items[0].className.includes("latest"));
}

console.log("== move trail ==");
{
  const pieces = engine.__document.getElementById("pieces");
  const before = pieces.children.length;
  const piece = fakePiece();
  engine.spawnMoveTrail(piece, 6, 6, 6, 5, 300);
  const added = pieces.children.slice(before);
  console.log(`  spawned ${added.length} trail nodes`);
  check("four after-images are spawned", added.length === 4, String(added.length));
  check("after-images are tagged as trails",
    added.every((node) => node.classList.contains("trail")));
  check("after-images sit between the two squares",
    added[0].props["--x"] === "6" && added[0].props["--y"] === "5.8",
    JSON.stringify(added[0].props));
  check("after-images fade with depth",
    added.map((node) => Number(node.props["--trail-opacity"]))
      .every((value, index, all) => index === 0 || value < all[index - 1]));
  check("after-images are inert (no data-square / aria-label)",
    added.every((node) => !("data-square" in node.attributes)
      && !("aria-label" in node.attributes)));
}

console.log("");
console.log("== clock ==");
{
  check("formatClock pads to mm:ss", engine.formatClock(0) === "00:00", engine.formatClock(0));
  check("formatClock rolls minutes",
    engine.formatClock(65000) === "01:05", engine.formatClock(65000));
  check("formatClock adds hours",
    engine.formatClock(3725000) === "1:02:05", engine.formatClock(3725000));

  const doc = engine.__document;
  check("clock elements exist in the status bar",
    html.includes('id="gameClock"') && html.includes('id="turnClock"'));

  engine.reset();
  engine.state.startedAt = Date.now() - 65000;
  engine.state.turnStartedAt = Date.now() - 7000;
  engine.updateClocks();
  const gameText = doc.getElementById("gameClock").textContent;
  const turnText = doc.getElementById("turnClock").textContent;
  console.log(`  ${gameText} / ${turnText}`);
  check("total clock counts this game", gameText === "本局 01:05", gameText);
  check("turn clock counts the current move", turnText === "本手 00:07", turnText);

  engine.state.turnStartedAt = Date.now() - 7000;
  const played = engine.state.game.play(60, 51);
  engine.markMoveTiming(played);
  check("each move records its own time",
    played.moveTimeMs >= 6900 && played.moveTimeMs < 9000, String(played.moveTimeMs));

  engine.renderMoveList();
  const list = doc.getElementById("moveList").innerHTML;
  check("move list shows the recorded time", /00:0\d/.test(list), list.slice(0, 140));
  check("turn clock restarts for the next move",
    Date.now() - engine.state.turnStartedAt < 1500,
    String(Date.now() - engine.state.turnStartedAt));
}

console.log("");
if (problems.length === 0) {
  console.log("MOTION CHECKS PASSED");
  process.exitCode = 0;
} else {
  console.log(`PROBLEMS: ${problems.join("; ")}`);
  process.exitCode = 1;
}
