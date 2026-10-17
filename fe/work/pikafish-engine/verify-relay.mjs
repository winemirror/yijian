const URL = process.env.PIKAFISH_SIGNAL_URL || "wss://c.syjnb.top/ws";
const ROOM = process.env.PIKAFISH_ROOM || "PKAFST";
const socket = new WebSocket(URL);
let hostId = "";
let requestId = 0;
let finished = false;

const timeout = setTimeout(() => {
  console.error("FAIL relay timeout");
  process.exit(1);
}, 20000);

function send(message) {
  socket.send(JSON.stringify(message));
}

function finish(ok, detail) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  console.log(`${ok ? "PASS" : "FAIL"} ${detail}`);
  try {
    send({ t: "room.leave" });
    socket.close();
  } catch {
    // Ignore cleanup failures.
  }
  setTimeout(() => process.exit(ok ? 0 : 1), 50);
}

socket.addEventListener("open", () => {
  send({ t: "hello", proto: 1, name: "Pikafish relay verifier" });
});

socket.addEventListener("message", (event) => {
  let message;
  try {
    message = JSON.parse(String(event.data));
  } catch {
    return;
  }

  if (message.t === "welcome") {
    send({ t: "room.join", roomId: ROOM, want: "spectate", password: "" });
    return;
  }

  if (message.t === "room.joined") {
    const peers = message.peers || [];
    const peer = peers.find((item) => item.id !== message.self.id);
    if (!peer) {
      finish(false, "engine peer is missing");
      return;
    }
    hostId = peer.id;
    requestId = 1;
    send({
      t: "signal",
      to: hostId,
      data: {
        t: "pf.request",
        id: String(requestId),
        kind: "move",
        moves: [],
        timeMs: 700,
        multiPv: 1
      }
    });
    return;
  }

  if (message.t === "signal" && message.data) {
    const data = message.data;
    if (requestId === 1 && data.t === "pf.result") {
      if (!/^[a-i][0-9][a-i][0-9]$/.test(data.bestmove || "")) {
        finish(false, `invalid move result ${data.bestmove}`);
        return;
      }
      console.log(`PASS move ${data.bestmove} ${data.engine}`);
      requestId = 2;
      send({
        t: "signal",
        to: hostId,
        data: {
          t: "pf.request",
          id: String(requestId),
          kind: "analyze",
          moves: [data.bestmove],
          timeMs: 1200,
          multiPv: 3
        }
      });
      return;
    }
    if (requestId === 2 && data.t === "pf.result") {
      const candidates = data.candidates || [];
      if (candidates.length < 1) {
        finish(false, "analysis returned no candidates");
        return;
      }
      finish(true, `analysis candidates=${candidates.length} best=${data.bestmove}`);
      return;
    }
    if (data.t === "pf.error") {
      finish(false, data.message || "engine error");
    }
  }

  if (message.t === "error") {
    finish(false, message.message || message.code || "relay error");
  }
});

socket.addEventListener("error", () => finish(false, "websocket error"));
