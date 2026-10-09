// Verifies the LAN multiplayer layer.
//
// Part A drives two real net.js instances against each other over a real
// BroadcastChannel, with a stub RTCPeerConnection standing in for the browser
// one. That exercises room discovery + offer/answer + the open data channel.
//
// Part B loads app.js in the headless harness with a stub XiangqiNet and
// checks the game protocol: seat assignment, move exchange, the "not your
// turn" guard, ply mismatch, chat, resign and sync.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadEngine, RED, BLACK } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const NET_JS = path.join(here, "www", "net.js");
const APP_JS = path.join(here, "www", "app.js");

const problems = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- fake WebRTC

function makeFakeWebRTC() {
  const all = [];

  function FakeChannel(label) {
    this.label = label;
    this.readyState = "connecting";
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.peer = null;
  }
  FakeChannel.prototype.send = function (data) {
    if (this.readyState !== "open") throw new Error("channel not open");
    if (this.peer && this.peer.onmessage) this.peer.onmessage({ data: data });
  };
  FakeChannel.prototype.open = function () {
    this.readyState = "open";
    if (this.onopen) this.onopen({});
  };
  FakeChannel.prototype.close = function () {
    this.readyState = "closed";
    if (this.onclose) this.onclose({});
  };

  function FakePeerConnection(config) {
    this.config = config;
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = "new";
    this.onicecandidate = null;
    this.ondatachannel = null;
    this.onconnectionstatechange = null;
    this.channel = null;
    all.push(this);
  }
  FakePeerConnection.prototype.createDataChannel = function (label) {
    this.channel = new FakeChannel(label);
    return this.channel;
  };
  FakePeerConnection.prototype.createOffer = function () {
    return Promise.resolve({ type: "offer", sdp: "sdp-offer" });
  };
  FakePeerConnection.prototype.createAnswer = function () {
    return Promise.resolve({ type: "answer", sdp: "sdp-answer" });
  };
  FakePeerConnection.prototype.setLocalDescription = function (desc) {
    this.localDescription = { type: desc.type, sdp: desc.sdp };
    const self = this;
    return Promise.resolve().then(function () {
      if (self.onicecandidate) {
        self.onicecandidate({ candidate: { candidate: "candidate:host 1 udp" } });
      }
    });
  };
  FakePeerConnection.prototype.setRemoteDescription = function (desc) {
    this.remoteDescription = desc;
    const self = this;
    if (desc.type === "offer") {
      return Promise.resolve().then(function () {
        const incoming = new FakeChannel("yijian");
        self.channel = incoming;
        if (self.ondatachannel) self.ondatachannel({ channel: incoming });
      });
    }
    return Promise.resolve();
  };
  FakePeerConnection.prototype.addIceCandidate = function () {
    return Promise.resolve();
  };
  FakePeerConnection.prototype.close = function () {
    this.connectionState = "closed";
  };

  return { PeerConnection: FakePeerConnection, all };
}

function loadNet(webRTC, label) {
  const win = {
    BroadcastChannel,
    RTCPeerConnection: webRTC.PeerConnection,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  };
  win.window = win;
  win.self = win;
  const sandbox = {
    window: win,
    self: win,
    BroadcastChannel,
    RTCPeerConnection: webRTC.PeerConnection,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    Math,
    JSON,
    Date,
    Promise,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Error,
    isNaN,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(NET_JS, "utf8"), sandbox, { filename: `${label}:net.js` });
  return win.XiangqiNet;
}

// ---------------------------------------------------------------------- part A

console.log("== net.js: transport selection ==");
{
  const webRTC = makeFakeWebRTC();
  const net = loadNet(webRTC, "probe");
  const status = await net.ready();
  check("falls back to the tab transport", status.mode === "tab", status.mode);
  check("reports itself available", status.available === true);
}

console.log("== net.js: native bridge wins ==");
{
  const webRTC = makeFakeWebRTC();
  const win = {
    BroadcastChannel,
    RTCPeerConnection: webRTC.PeerConnection,
    YiJianNative: {
      lan: {
        announce() {},
        stopAnnounce() {},
        send() { return Promise.resolve(); },
        inbox() { return Promise.resolve({ cursor: 0, blobs: [] }); },
        rooms() { return Promise.resolve([]); },
      },
    },
    setTimeout, clearTimeout, setInterval, clearInterval, console,
  };
  win.window = win;
  const sandbox = {
    window: win, self: win, BroadcastChannel,
    RTCPeerConnection: webRTC.PeerConnection,
    setTimeout, clearTimeout, setInterval, clearInterval, console,
    Math, JSON, Date, Promise, Object, Array, Number, String, Boolean, Error, isNaN,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(NET_JS, "utf8"), sandbox, { filename: "native:net.js" });
  const status = await win.XiangqiNet.ready();
  check("prefers the shell bridge", status.mode === "native", status.mode);
}

console.log("== net.js: two peers complete a handshake ==");
try {
  const webRTC = makeFakeWebRTC();
  const host = loadNet(webRTC, "host");
  const guest = loadNet(webRTC, "guest");

  // The guest has to be listening before the host announces, otherwise it
  // would have to wait for the next announce tick.
  await guest.ready();
  await host.hostRoom({ id: "room-a", name: "棋局A" });
  await tick(80);

  const rooms = await guest.scan();
  check("guest discovers the room", rooms.length === 1, `rooms=${rooms.length}`);
  check("discovered room keeps its name", rooms.length === 1 && rooms[0].name === "棋局A",
    rooms.length ? rooms[0].name : "-");

  await guest.joinRoom(rooms[0], { player: "乙" });
  await tick(80);

  check("host created an answering peer connection", webRTC.all.length === 2,
    `pcs=${webRTC.all.length}`);
  const hostPc = webRTC.all.find((pc) => pc.remoteDescription
    && pc.remoteDescription.type === "offer");
  const guestPc = webRTC.all.find((pc) => pc.localDescription
    && pc.localDescription.type === "offer");
  check("offer reached the host", !!hostPc);
  check("host produced an answer", !!hostPc && !!hostPc.localDescription
    && hostPc.localDescription.type === "answer");
  check("guest received the answer", !!guestPc && !!guestPc.remoteDescription
    && guestPc.remoteDescription.type === "answer");

  if (hostPc && guestPc && hostPc.channel && guestPc.channel) {
    hostPc.channel.peer = guestPc.channel;
    guestPc.channel.peer = hostPc.channel;
    hostPc.channel.open();
    guestPc.channel.open();
    await tick(10);

    check("host reports connected", host.status().phase === "connected", host.status().phase);
    check("guest reports connected", guest.status().phase === "connected", guest.status().phase);

    let received = null;
    host.onMessage((message) => { received = message; });
    const sent = guest.send({ t: "chat", text: "你好" });
    await tick(10);
    check("guest can send over the channel", sent === true);
    check("host receives the message", !!received && received.text === "你好",
      JSON.stringify(received));
  } else {
    check("handshake produced channels", false);
  }

  host.leave();
  guest.leave();
} catch (error) {
  check("handshake completed", false, String(error && error.message || error));
}

// ---------------------------------------------------------------------- part B

console.log("== app.js: game protocol ==");
try {
  const sent = [];
  let messageHandler = null;
  let statusHandler = null;
  const stubNet = {
    proto: 1,
    ready() {
      return Promise.resolve({ available: true, mode: "stub", phase: "idle" });
    },
    onStatus(cb) { statusHandler = cb; },
    onMessage(cb) { messageHandler = cb; },
    onRooms() {},
    scan() { return Promise.resolve([]); },
    hostRoom() { return Promise.resolve({ available: true, mode: "stub" }); },
    joinRoom() { return Promise.resolve({ available: true, mode: "stub" }); },
    send(message) { sent.push(message); return true; },
    leave() {},
    status() { return { available: true, mode: "stub", phase: "idle" }; },
  };

  const engine = loadEngine(APP_JS, undefined, {
    beforeEngine(sandbox) {
      sandbox.window.XiangqiNet = stubNet;
      sandbox.XiangqiNet = stubNet;
    },
  });

  check("app picked up the net layer", typeof engine.netActive === "function"
    && engine.netActive() === false);

  engine.netBegin("guest", RED, "乙");
  check("joining marks the session active", engine.netActive() === true);
  check("guest owns red", engine.state.net.mySide === RED);
  check("guest may move on its own turn", engine.canMoveLocally() === true);
  check("fresh board after connecting", engine.state.game.history.length === 0);

  // Red is ours and it is red's turn, so a move arriving now is a desync.
  sent.length = 0;
  const blackFirst = engine.generateLegalMoves(engine.state.game.board, BLACK)[0];
  engine.netHandleMessage({
    t: "move", from: blackFirst.from, to: blackFirst.to, ply: 0
  });
  check("wrong-turn move is refused", engine.state.game.history.length === 0);
  check("wrong-turn move asks for sync",
    sent.some((message) => message.t === "syncReq"), JSON.stringify(sent));

  // We play red, so the opponent is on move and their reply must land.
  engine.state.game.play(60, 51);
  check("local move advances the board", engine.state.game.history.length === 1);
  check("cannot move out of turn", engine.canMoveLocally() === false);

  sent.length = 0;
  const blackStale = engine.generateLegalMoves(engine.state.game.board, BLACK)[0];
  engine.netHandleMessage({
    t: "move", from: blackStale.from, to: blackStale.to, ply: 7
  });
  check("out-of-sequence move is refused", engine.state.game.history.length === 1);
  check("out-of-sequence move asks for sync",
    sent.some((message) => message.t === "syncReq"));

  const blackReply = engine.generateLegalMoves(engine.state.game.board, BLACK)[0];
  engine.netHandleMessage({
    t: "move",
    from: blackReply.from,
    to: blackReply.to,
    ply: 1,
    elapsedMs: 1000,
    turnMs: 500
  });
  check("opponent move is applied", engine.state.game.history.length === 2,
    `history=${engine.state.game.history.length}`);
  check("turn returns to the local player", engine.canMoveLocally() === true);

  sent.length = 0;
  engine.netHandleMessage({ t: "chat", text: "好棋" });
  const chatText = engine.__document.getElementById("chatLog").children
    .map((node) => node.children.map((child) => child.textContent).join(""))
    .join("|");
  check("chat message is shown", chatText.includes("好棋"), chatText.slice(0, 80));

  engine.netHandleMessage({ t: "resign" });
  check("opponent resign ends the game",
    engine.state.game.result.type === "win" && engine.state.game.result.winner === RED,
    JSON.stringify(engine.state.game.result));

  engine.netBegin("guest", RED, "乙");
  engine.state.game.play(60, 51);
  engine.netHandleMessage({ t: "sync", snapshot: engine.state.game.snapshot() });
  check("sync restores the board",
    engine.state.game.history.length === 1, `history=${engine.state.game.history.length}`);

  engine.netLeave();
  check("leaving clears the session", engine.netActive() === false);
  check("leaving frees local input", engine.canMoveLocally() === true);
} catch (error) {
  check("app protocol completed", false, String(error && error.stack || error));
}

console.log("");
if (problems.length === 0) {
  console.log("NET CHECKS PASSED");
  process.exit(0);
} else {
  console.log(`PROBLEMS: ${problems.join("; ")}`);
  process.exit(1);
}
