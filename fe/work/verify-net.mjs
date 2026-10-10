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
    if (!this.remoteDescription) {
      this.lateCandidates = (this.lateCandidates || 0) + 1;
      return Promise.reject(new Error("remote description is not set"));
    }
    this.appliedCandidates = (this.appliedCandidates || 0) + 1;
    return Promise.resolve();
  };
  FakePeerConnection.prototype.close = function () {
    this.connectionState = "closed";
  };

  return { PeerConnection: FakePeerConnection, all };
}

function loadNet(webRTC, label, extra) {
  const win = {
    BroadcastChannel,
    RTCPeerConnection: webRTC ? webRTC.PeerConnection : undefined,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    ...(extra || {}),
  };
  win.window = win;
  win.self = win;
  const sandbox = {
    window: win,
    self: win,
    BroadcastChannel,
    RTCPeerConnection: webRTC ? webRTC.PeerConnection : undefined,
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
    ...(extra || {}),
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

console.log("== net.js: desktop http bridge ==");
try {
  const urls = [];
  const respond = (body) => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
  const fetchStub = (url) => {
    urls.push(url);
    if (url.indexOf("hello") >= 0) {
      return respond({ ok: true, proto: 1, ips: ["192.168.5.31"] });
    }
    if (url.indexOf("rooms") >= 0) return respond({ rooms: [] });
    if (url.indexOf("inbox") >= 0) return respond({ cursor: 0, blobs: [] });
    return respond({ ok: true });
  };
  const net = loadNet(null, "http", { fetch: fetchStub });
  const status = await net.ready();
  check("desktop page uses the http bridge", status.mode === "http", status.mode);
  await net.scan();
  await net.hostRoom({ id: "room-http", name: "棋局H" });
  await tick(20);
  await net.selfTest();

  // The page prefixes every call with "lan/", so a path that already starts
  // with a slash produced "lan//lan/inbox" and 404'd on the desktop. That made
  // the PC unable to announce, poll or answer at all.
  const doubled = urls.filter((url) => url.indexOf("//") >= 0 || url.indexOf("lan/") !== 0);
  check("http bridge never doubles the lan/ prefix", doubled.length === 0,
    JSON.stringify(urls));
  check("http bridge uses the expected endpoints",
    urls.indexOf("lan/hello") >= 0
      && urls.some((url) => url.indexOf("lan/rooms") === 0)
      && urls.some((url) => url.indexOf("lan/inbox") === 0)
      && urls.indexOf("lan/announce") >= 0
      && urls.indexOf("lan/send") >= 0,
    JSON.stringify(urls));
  net.leave();
} catch (error) {
  check("http bridge completed", false, String(error && error.message || error));
}

console.log("== net.js: mDNS candidates are rewritten to the peer ip ==");
{
  const net = loadNet(makeFakeWebRTC(), "mdns");
  const rewritten = net.__normalizeCandidate(
    {
      candidate: "candidate:1 1 udp 2113937151 abc-123.local 60855 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    },
    "192.168.5.48"
  );
  check("mDNS host is replaced by the peer address",
    rewritten.candidate.indexOf("192.168.5.48") >= 0
      && rewritten.candidate.indexOf(".local") < 0,
    rewritten.candidate);
  const untouched = net.__normalizeCandidate(
    { candidate: "candidate:1 1 udp 2113937151 192.168.5.31 60855 typ host" },
    "192.168.5.48"
  );
  check("real addresses are left alone",
    untouched.candidate.indexOf("192.168.5.31") >= 0
      && untouched.candidate.indexOf("192.168.5.48") < 0,
    untouched.candidate);
}

console.log("== net.js: late ICE candidates are buffered ==");
try {
  const webRTC = makeFakeWebRTC();
  const host = loadNet(webRTC, "ice-host");
  await host.ready();
  await host.hostRoom({ id: "room-ice", name: "候选" });
  await tick(20);

  // Offer and candidate land in the same poll batch, so the candidate is seen
  // while setRemoteDescription is still pending. It used to be rejected and
  // dropped, which left the connection stuck at "failed".
  const from = { ip: "10.0.0.5", port: 45455 };
  host.__handleBlob(from, { t: "offer", sdp: "sdp-offer" });
  host.__handleBlob(from, { t: "ice", sdp: { candidate: "candidate:1" } });
  await tick(40);

  const hostPc = webRTC.all.find((pc) => pc.remoteDescription
    && pc.remoteDescription.type === "offer");
  check("the offer reached the guest handler", !!hostPc);
  check("no candidate was pushed before the remote description",
    !hostPc || !hostPc.lateCandidates, String(hostPc && hostPc.lateCandidates));
  check("the queued candidate is replayed afterwards",
    !!hostPc && (hostPc.appliedCandidates || 0) >= 1,
    String(hostPc && hostPc.appliedCandidates));
  host.leave();
} catch (error) {
  check("late ICE buffering completed", false, String(error && error.message || error));
}

console.log("== net.js: capacitor plugin bridge ==");
try {
  const calls = [];
  const received = [];
  const plugin = {
    announce(payload) {
      calls.push(["announce", payload]);
      return Promise.resolve({ ok: true });
    },
    rooms() {
      // Flat shape, exactly what the Android plugin and /lan/rooms return.
      return Promise.resolve({
        rooms: [{ id: "r1", name: "棋局C", ip: "10.0.0.9", port: 45455 }],
      });
    },
    inbox(payload) {
      calls.push(["inbox", payload]);
      const since = payload.since || 0;
      return Promise.resolve({ cursor: received.length, blobs: received.slice(since) });
    },
    send(payload) {
      calls.push(["send", payload]);
      // Emulate the loopback delivery a real UDP socket performs.
      received.push({ ip: "127.0.0.1", port: 45455, data: payload.data });
      return Promise.resolve({ ok: true });
    },
    status() {
      return Promise.resolve({ ok: true, proto: 1, ips: ["10.0.0.9"] });
    },
  };
  const webRTC = makeFakeWebRTC();
  const net = loadNet(webRTC, "capacitor", {
    Capacitor: { Plugins: { YiJianLan: plugin } },
  });
  const status = await net.ready();
  check("uses the capacitor plugin as the native bridge", status.mode === "native",
    status.mode);
  check("local addresses are surfaced for diagnostics",
    status.localIps.indexOf("10.0.0.9") >= 0, JSON.stringify(status.localIps));
  const rooms = await net.scan();
  check("rooms are read through the plugin", rooms.length === 1 && rooms[0].name === "棋局C",
    JSON.stringify(rooms));
  check("a discovered room always exposes a dialable address",
    !!(rooms[0] && rooms[0].addr
      && rooms[0].addr.ip === "10.0.0.9" && rooms[0].addr.port === 45455),
    JSON.stringify(rooms[0] && rooms[0].addr));

  await net.joinRoom(rooms[0], { player: "甲" });
  await tick(30);
  const offers = calls.filter((entry) => entry[0] === "send").map((entry) => entry[1]);
  const offer = offers.find((entry) => entry.data && entry.data.t === "offer");
  check("joining dials the discovered address",
    !!offer && offer.ip === "10.0.0.9" && offer.port === 45455
      && offer.data.sdp === "sdp-offer",
    JSON.stringify(offers));

  net.leave();
  await net.hostRoom({ id: "room-c", name: "棋局C" });
  await tick(20);
  check("hosting announces through the plugin",
    calls.some((entry) => entry[0] === "announce" && entry[1].room
      && entry[1].room.id === "room-c"),
    JSON.stringify(calls.map((entry) => entry[0])));

  const selfResult = await net.selfTest();
  check("loopback self test passes when the bridge echoes", selfResult.ok === true,
    JSON.stringify(selfResult));
  net.leave();
} catch (error) {
  check("capacitor bridge completed", false, String(error && error.message || error));
}

console.log("== net.js: native bridge fallback ==");
try {
  const calls = [];
  const capacitor = {
    // Deliberately no Capacitor.Plugins.YiJianLan: a pure native plugin is not
    // always mirrored there, so net.js has to use the low level bridge.
    nativePromise(pluginName, method, options) {
      calls.push([pluginName, method]);
      if (method === "status") {
        return Promise.resolve({ ok: true, proto: 1, ips: ["192.168.5.46"] });
      }
      if (method === "rooms") return Promise.resolve({ rooms: [] });
      if (method === "inbox") return Promise.resolve({ cursor: 0, blobs: [] });
      return Promise.resolve({ ok: true });
    },
  };
  const net = loadNet(null, "capacitor-fallback", { Capacitor: capacitor });
  const status = await net.ready();
  check("falls back to Capacitor.nativePromise", status.mode === "native", status.mode);
  check("fallback talks to the YiJianLan plugin",
    calls.some((entry) => entry[0] === "YiJianLan"), JSON.stringify(calls.slice(0, 3)));
  check("fallback still surfaces local addresses",
    status.localIps.indexOf("192.168.5.46") >= 0, JSON.stringify(status.localIps));
} catch (error) {
  check("native bridge fallback completed", false, String(error && error.message || error));
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

  // Regression: net play must not be gated by the single-player selects. They
  // default to red = human / black = AI, which used to lock out whoever joined
  // as black after the very first move. Put those values back by hand so the
  // guard really exercises the reported failure.
  engine.netBegin("guest", BLACK, "甲");
  const redSelect = engine.__document.getElementById("redSetup");
  const blackSelect = engine.__document.getElementById("blackSetup");
  check("net: both side selects are pinned to 玩家",
    redSelect.value === "player" && blackSelect.value === "player"
      && redSelect.disabled === true && blackSelect.disabled === true,
    `red=${redSelect.value} black=${blackSelect.value}`);

  engine.state.control[RED] = "human";
  engine.state.control[BLACK] = "ai";
  check("net: waiting for the opponent cannot move", engine.canPlayNow() === false);
  const redOpening = engine.generateLegalMoves(engine.state.game.board, RED)[0];
  engine.netHandleMessage({
    t: "move", from: redOpening.from, to: redOpening.to, ply: 0
  });
  check("net: black may move even though the select still reads AI",
    engine.state.game.sideToMove === BLACK && engine.canPlayNow() === true,
    `side=${engine.state.game.sideToMove} control=${engine.state.control[BLACK]}`);

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
