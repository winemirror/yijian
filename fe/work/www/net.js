/* YiJian - LAN transport layer.
 *
 * This layer only moves opaque messages to and from a peer. It never touches
 * the chess rules; the game protocol lives in app.js.
 *
 * Three transports are probed in order:
 *   1. native  - the app shell exposes window.YiJianNative.lan (Android plugin,
 *                or any future shell that injects the bridge).
 *   2. http    - the desktop launcher serves /lan/* endpoints on the same
 *                origin, so the page talks to the C# LAN service over HTTP.
 *   3. tab     - no native layer at all: BroadcastChannel, which only reaches
 *                other windows on this machine. Used for development and for
 *                the automated tests.
 *
 * Everything here degrades quietly. If no transport is available the caller
 * simply hides the multiplayer entry points.
 */
(function () {
  var scope = typeof window !== "undefined" ? window : self;
  if (!scope || scope.XiangqiNet) return;

  var PROTO = 1;
  var ANNOUNCE_MS = 1500;
  var ROOM_TTL_MS = 4500;
  var POLL_TIMEOUT_MS = 25000;
  // LAN play needs no STUN: both peers are on the same subnet and (in every
  // shell we ship) the page is a secure context, so Chrome hands out the real
  // local address instead of an mDNS placeholder.
  var ICE_SERVERS = [];

  function now() {
    return Date.now();
  }

  function randomId() {
    return Math.random().toString(36).slice(2, 10) + now().toString(36).slice(-4);
  }

  function hasPeerConnection() {
    return typeof scope.RTCPeerConnection === "function";
  }

  // ---------------------------------------------------------------- transports

  // Talks to a shell that publishes window.YiJianNative.lan.
  function nativeTransport(bridge) {
    return {
      name: "native",
      send: function (addr, blob) {
        try {
          return Promise.resolve(bridge.send(addr.ip, addr.port, blob));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      announce: function (room) {
        try { bridge.announce(room); } catch (error) { /* best effort */ }
      },
      stopAnnounce: function () {
        try { bridge.stopAnnounce(); } catch (error) { /* best effort */ }
      },
      poll: function (cursor, waitMs) {
        return Promise.resolve(bridge.inbox(cursor, waitMs)).then(function (result) {
          return result || { cursor: cursor, blobs: [] };
        });
      },
      rooms: function () {
        return Promise.resolve(bridge.rooms()).then(function (list) {
          return list || [];
        });
      },
      info: function () {
        if (typeof bridge.status !== "function") return Promise.resolve(null);
        try {
          return Promise.resolve(bridge.status()).then(
            function (result) { return result || null; },
            function () { return null; }
          );
        } catch (error) {
          return Promise.resolve(null);
        }
      }
    };
  }

  // Talks to the desktop launcher's /lan/* HTTP endpoints.
  function httpTransport(base) {
    var hello = null;
    function json(path, options) {
      // `path` must be relative: base already carries the "lan/" prefix, and a
      // leading slash here used to produce "lan//lan/inbox" -> 404.
      return fetch(base + path, options).then(function (response) {
        if (!response.ok) throw new Error("lan " + base + path + " -> " + response.status);
        return response.json();
      });
    }
    return {
      name: "http",
      setHello: function (info) { hello = info; },
      info: function () { return Promise.resolve(hello); },
      send: function (addr, blob) {
        return json("send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ip: addr.ip, port: addr.port, data: blob })
        });
      },
      announce: function (room) {
        json("announce", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room: room })
        }).catch(function () { /* best effort */ });
      },
      stopAnnounce: function () {
        json("announce", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stop: true })
        }).catch(function () { /* best effort */ });
      },
      poll: function (cursor, waitMs) {
        var wait = waitMs === undefined ? POLL_TIMEOUT_MS : waitMs;
        return json("inbox?since=" + encodeURIComponent(cursor)
          + "&wait=" + encodeURIComponent(wait));
      },
      rooms: function () {
        return json("rooms").then(function (result) {
          return (result && result.rooms) || [];
        });
      }
    };
  }

  // Signalling through a relay server instead of LAN broadcast. Push based -
  // the server hands us messages as they arrive, so poll() is a no-op.
  // The server never sees chess moves: those ride the WebRTC data channel.
  function wsTransport(url) {
    var socket = null;
    var readyPromise = null;
    var blobHandler = null;
    var inbox = [];
    var waiters = [];
    var iceServers = [];
    var selfId = null;
    var currentRoom = null;

    function post(message) {
      if (!socket || socket.readyState !== 1) return false;
      socket.send(JSON.stringify(message));
      return true;
    }

    // Resolves on the next message of `type`, or on any `error` so a server
    // rejection surfaces as an exception instead of a timeout.
    function waitFor(type, timeoutMs) {
      for (var index = 0; index < inbox.length; index += 1) {
        if (inbox[index].t === type || inbox[index].t === "error") {
          return Promise.resolve(inbox.splice(index, 1)[0]);
        }
      }
      return new Promise(function (resolve, reject) {
        var waiter = { type: type, resolve: null };
        var timer = scope.setTimeout(function () {
          var index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("server timeout: " + type));
        }, timeoutMs || 8000);
        waiter.resolve = function (message) {
          scope.clearTimeout(timer);
          resolve(message);
        };
        waiters.push(waiter);
      });
    }

    function deliver(message) {
      for (var index = 0; index < waiters.length; index += 1) {
        if (waiters[index].type === message.t || message.t === "error") {
          waiters.splice(index, 1)[0].resolve(message);
          return;
        }
      }
      inbox.push(message);
    }

    function connect() {
      if (readyPromise) return readyPromise;
      readyPromise = new Promise(function (resolve, reject) {
        if (typeof scope.WebSocket !== "function") {
          reject(new Error("no-websocket"));
          return;
        }
        var ws;
        try {
          ws = new scope.WebSocket(url);
        } catch (error) {
          reject(error);
          return;
        }
        socket = ws;
        ws.onopen = function () {
          post({ t: "hello", proto: 1, name: "棋友" });
          resolve();
        };
        ws.onerror = function () {
          reject(new Error("server unreachable"));
        };
        ws.onmessage = function (event) {
          var message = null;
          try {
            message = JSON.parse(event.data);
          } catch (error) {
            return;
          }
          if (!message || !message.t) return;
          if (message.t === "signal") {
            if (blobHandler) blobHandler({ id: message.from }, message.data);
            return;
          }
          if (message.t === "welcome") {
            selfId = message.clientId;
            iceServers = (message.ice && message.ice.servers) || [];
          }
          deliver(message);
        };
      });
      return readyPromise;
    }

    function expect(message) {
      if (message.t === "error") {
        throw new Error(message.message || message.code || "server error");
      }
      return message;
    }

    return {
      name: "server",
      push: true,
      url: url,
      onBlob: function (cb) { blobHandler = cb; },
      ready: connect,
      info: function () {
        return connect().then(function () {
          // The ICE config rides on "welcome", which can land just after the
          // socket opens - wait for it instead of returning an empty list.
          return waitFor("welcome");
        }).then(function () {
          return { ice: iceServers, ips: [], serverId: selfId };
        });
      },
      poll: function () { return Promise.resolve({ cursor: 0, blobs: [] }); },
      rooms: function () {
        return connect()
          .then(function () { post({ t: "room.list" }); return waitFor("room.list"); })
          .then(function (message) { return expect(message).rooms || []; });
      },
      announce: function (room) {
        return connect().then(function () {
          post({ t: "room.create", name: room && room.name, visibility: "public" });
          return waitFor("room.joined");
        }).then(function (message) {
          expect(message);
          currentRoom = message.room;
          selfId = message.self.id;
          return { id: message.room.id, name: message.room.name };
        });
      },
      stopAnnounce: function () {
        post({ t: "room.leave" });
        currentRoom = null;
      },
      send: function (addr, blob) {
        return connect().then(function () {
          post({ t: "signal", to: addr && addr.id, data: blob });
        });
      },
      // Server mode only: join by room code and learn which peer is the hub.
      joinSignalling: function (code, want) {
        return connect().then(function () {
          post({
            t: "room.join",
            roomId: String(code || "").toUpperCase(),
            want: want === "spectate" ? "spectate" : "play"
          });
          return waitFor("room.joined");
        }).then(function (message) {
          expect(message);
          currentRoom = message.room;
          selfId = message.self.id;
          var hostId = message.room.hostId;
          var hostName = "";
          for (var index = 0; index < message.peers.length; index += 1) {
            if (message.peers[index].id === hostId) hostName = message.peers[index].name;
          }
          return {
            room: message.room,
            selfId: selfId,
            hostId: hostId,
            hostName: hostName,
            peers: message.peers
          };
        });
      },
      close: function () {
        try { if (socket) socket.close(); } catch (error) { /* gone */ }
        socket = null;
        readyPromise = null;
        inbox = [];
        waiters = [];
      }
    };
  }

  // Same machine only: lets two windows/tabs play each other for testing.
  // Rooms are tracked here so the session layer sees the same shape as the
  // native transport (a list of {id, name, addr}).
  function tabTransport() {
    var channel = new scope.BroadcastChannel("yijian-lan");
    var localId = randomId();
    var handlers = { blob: null };
    var rooms = Object.create(null);

    channel.addEventListener("message", function (event) {
      var pack = event.data;
      if (!pack || pack.from === localId) return;
      if (pack.t === "announce" && pack.room) {
        rooms[pack.room.id] = {
          id: pack.room.id,
          name: pack.room.name,
          addr: { id: pack.from, ip: pack.from, port: 0 },
          at: now()
        };
        return;
      }
      if (pack.t === "bye" && pack.roomId) {
        delete rooms[pack.roomId];
        return;
      }
      if (pack.t === "blob" && pack.to === localId && handlers.blob) {
        handlers.blob({ id: pack.from, ip: pack.from, port: 0 }, pack.data);
      }
    });

    return {
      name: "tab",
      localId: localId,
      send: function (addr, blob) {
        channel.postMessage({ t: "blob", to: addr.id || addr.ip, from: localId, data: blob });
        return Promise.resolve();
      },
      announce: function (room) {
        channel.postMessage({ t: "announce", room: room, from: localId, at: now() });
      },
      stopAnnounce: function (room) {
        channel.postMessage({
          t: "bye", roomId: room && room.id, from: localId
        });
      },
      poll: function () {
        return Promise.resolve({ cursor: 0, blobs: [] });
      },
      rooms: function () {
        var out = [];
        var keys = Object.keys(rooms);
        for (var index = 0; index < keys.length; index += 1) {
          var entry = rooms[keys[index]];
          if (now() - entry.at < ROOM_TTL_MS) {
            out.push({ id: entry.id, name: entry.name, addr: entry.addr });
          }
        }
        return Promise.resolve(out);
      },
      onBlob: function (cb) { handlers.blob = cb; }
    };
  }

  // ------------------------------------------------------------------- probing

  function probeHttp() {
    if (typeof fetch !== "function") return Promise.resolve(null);
    return fetch("lan/hello", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) return null;
        return response.json();
      })
      .then(function (info) {
        if (!info || info.ok !== true) return null;
        var transport = httpTransport("lan/");
        transport.setHello(info);
        return transport;
      })
      .catch(function () { return null; });
  }

  // Capacitor publishes plugins as Capacitor.Plugins.<Name>. Wrapping it here
  // keeps the shell interface identical to the injected native bridge, so the
  // session code never needs to know which shell it runs in.
  function capacitorLan(capacitor) {
    var plugin = capacitor && capacitor.Plugins && capacitor.Plugins.YiJianLan;
    if (!plugin) {
      // A native-only plugin is not always mirrored into Capacitor.Plugins, so
      // fall back to calling the bridge directly.
      if (!capacitor || typeof capacitor.nativePromise !== "function") return null;
      plugin = {};
      ["announce", "rooms", "send", "inbox", "status"].forEach(function (method) {
        plugin[method] = function (options) {
          return capacitor.nativePromise("YiJianLan", method, options || {});
        };
      });
    }
    return {
      announce: function (room) { return plugin.announce({ room: room }); },
      stopAnnounce: function () { return plugin.announce({ stop: true }); },
      rooms: function () {
        return Promise.resolve(plugin.rooms()).then(function (result) {
          return (result && result.rooms) || [];
        });
      },
      inbox: function (cursor, waitMs) {
        return Promise.resolve(plugin.inbox({ since: cursor, wait: waitMs || 0 }))
          .then(function (result) {
          return result || { cursor: cursor, blobs: [] };
        });
      },
      send: function (ip, port, data) {
        return plugin.send({ ip: ip, port: port, data: data });
      },
      status: function () {
        return plugin.status();
      }
    };
  }

  // The bridge may inject Capacitor slightly after our script runs.
  function retryCapacitor(capacitor, attempts) {
    return new Promise(function (resolve) {
      scope.setTimeout(function () {
        resolve(waitForCapacitorPlugin(capacitor, attempts - 1));
      }, 100);
    });
  }

  function waitForCapacitorPlugin(capacitor, attempts) {
    var wrapped = capacitorLan(capacitor);
    if (!wrapped) {
      if (attempts <= 0) return Promise.resolve(null);
      return retryCapacitor(capacitor, attempts);
    }
    // Capacitor hands out a proxy even when the native side is missing, so ask
    // the plugin something cheap before trusting it.
    var probe = null;
    try {
      probe = capacitor.Plugins.YiJianLan.status();
    } catch (error) {
      probe = null;
    }
    if (!probe || typeof probe.then !== "function") {
      return Promise.resolve(nativeTransport(wrapped));
    }
    return Promise.resolve(probe).then(
      function () { return nativeTransport(wrapped); },
      function () {
        if (attempts <= 0) return nativeTransport(wrapped);
        return retryCapacitor(capacitor, attempts);
      }
    );
  }

  function chooseTransport() {
    // Server mode is opt-in and replaces LAN discovery entirely.
    if (state.prefer === "server") {
      if (!state.serverUrl) return Promise.resolve(null);
      return Promise.resolve(wsTransport(state.serverUrl));
    }
    var bridge = scope.YiJianNative && scope.YiJianNative.lan;
    if (bridge) return Promise.resolve(nativeTransport(bridge));
    if (scope.Capacitor) return waitForCapacitorPlugin(scope.Capacitor, 10);
    return probeHttp().then(function (transport) {
      if (transport) return transport;
      if (typeof scope.BroadcastChannel === "function") return tabTransport();
      return null;
    });
  }

  // ------------------------------------------------------------------- session

  var listeners = { status: [], message: [], rooms: [], debug: [] };
  var state = {
    transport: null,
    mode: null,
    phase: "idle",      // idle | announcing | connecting | connected | error
    room: null,
    peer: null,
    error: "",
    localIps: [],
    // "auto" keeps the LAN chain; "server" uses the relay for signalling.
    prefer: "auto",
    serverUrl: "",
    iceServers: []
  };
  var announceTimer = null;
  var pollTimer = null;
  var pollCursor = 0;
  // One entry per connected peer. A guest keeps a single entry (the room's
  // owner); the host keeps one for the opponent plus one for every spectator,
  // which is what lets a third device watch without disturbing the game.
  var peers = Object.create(null);
  var localIceLogged = 0;

  function emit(list, payload) {
    for (var index = 0; index < list.length; index += 1) {
      try { list[index](payload); } catch (error) { /* listener fault */ }
    }
  }

  // Low-volume trace of the connection lifecycle, surfaced in the app's room
  // log so a failed pairing can be diagnosed from the UI alone.
  function emitDebug(kind, detail) {
    emit(listeners.debug, { kind: kind, detail: detail || null, at: now() });
  }

  // Transports report rooms in slightly different shapes: the tab transport
  // hands over an `addr` object, while the native/http bridges flatten it into
  // ip/port. Normalise here so joinRoom always has something to dial.
  function normalizeRooms(list) {
    var out = [];
    var items = list || [];
    for (var index = 0; index < items.length; index += 1) {
      var room = items[index] || {};
      var addr = room.addr;
      if (!addr || addr.ip === undefined) {
        addr = { id: room.id, ip: room.ip, port: room.port };
      }
      out.push({ id: room.id, name: room.name, ip: addr.ip, port: addr.port, addr: addr });
    }
    return out;
  }

  function status() {
    return {
      available: !!state.transport,
      mode: state.mode,
      phase: state.phase,
      room: state.room,
      peer: state.peer,
      peers: peerCounts(),
      prefer: state.prefer,
      serverUrl: state.serverUrl,
      error: state.error,
      localIps: state.localIps.slice()
    };
  }

  // Records where this device sits on the network, so the UI can show it and
  // the user can tell at a glance whether both sides share a subnet.
  function loadTransportInfo(transport) {
    if (!transport || typeof transport.info !== "function") return Promise.resolve();
    return Promise.resolve(transport.info()).then(function (info) {
      if (info && info.ips && info.ips.length) state.localIps = info.ips.slice();
      // STUN/TURN for the relay path comes from the server, not from a constant.
      if (info && info.ice && info.ice.length) state.iceServers = info.ice.slice();
    }).catch(function () { });
  }

  function pushStatus() {
    emit(listeners.status, status());
  }

  function fail(message) {
    state.phase = "error";
    state.error = message || "";
    pushStatus();
  }

  // Errors that cross a promise chain lose their shape; keep name, message and
  // the first stack frame so the in-app log actually points somewhere.
  function describe(error) {
    if (error === null || error === undefined) return "unknown";
    if (typeof error === "string") return error;
    var text = error.name ? error.name + ": " : "";
    text += error.message || String(error);
    if (error.stack) {
      var first = String(error.stack).split("\n")[0];
      if (first && text.indexOf(first) < 0) text += " | " + first;
    }
    return text;
  }

  // ------------------------------------------------------------ WebRTC plumbing

  function peerKeyFor(addr) {
    if (!addr) return "";
    return String(addr.ip || addr.id || "") + ":" + (addr.port || 0);
  }

  function peerFor(addr) {
    return peers[peerKeyFor(addr)] || null;
  }

  function eachPeer(callback) {
    var keys = Object.keys(peers);
    for (var index = 0; index < keys.length; index += 1) {
      callback(peers[keys[index]], keys[index]);
    }
  }

  // The "primary" peer is the opponent: what the status line and the UI show.
  function primaryPeer() {
    var fallback = null;
    var player = null;
    eachPeer(function (peer) {
      if (!fallback) fallback = peer;
      if (!player && peer.kind === "player") player = peer;
    });
    return player || fallback;
  }

  function publicPeer(peer) {
    if (!peer) return null;
    return { id: peer.key, name: peer.name, kind: peer.kind };
  }

  function peerCounts() {
    var players = 0;
    var spectators = 0;
    eachPeer(function (peer) {
      if (peer.kind === "spectator") spectators += 1;
      else if (peer.kind === "player") players += 1;
    });
    return { players: players, spectators: spectators };
  }

  function dropPeer(key) {
    var peer = peers[key];
    if (!peer) return;
    delete peers[key];
    try { if (peer.channel) peer.channel.close(); } catch (error) { /* gone */ }
    try { if (peer.pc) peer.pc.close(); } catch (error) { /* gone */ }
    state.peer = publicPeer(primaryPeer());
    emitDebug("left", { kind: peer.kind, peers: peerCounts() });
    if (!Object.keys(peers).length && state.phase === "connected") {
      state.phase = state.room && state.room.role === "host" ? "announcing" : "connecting";
    }
    pushStatus();
  }

  // Drops every connection and the current transport, ready for a mode switch.
  function resetTransport() {
    closePeers();
    stopPolling();
    if (announceTimer) scope.clearInterval(announceTimer);
    announceTimer = null;
    if (state.transport && typeof state.transport.close === "function") {
      try { state.transport.close(); } catch (error) { /* gone */ }
    }
    state.transport = null;
    state.mode = null;
    state.iceServers = [];
    state.room = null;
    state.peer = null;
    state.phase = "idle";
    state.error = "";
    pushStatus();
    return status();
  }

  function closePeers() {
    eachPeer(function (peer) {
      try { if (peer.channel) peer.channel.close(); } catch (error) { /* gone */ }
      try { if (peer.pc) peer.pc.close(); } catch (error) { /* gone */ }
    });
    peers = Object.create(null);
    state.peer = null;
    localIceLogged = 0;
  }

  function newPeerConnection(peer) {
    var connection = new scope.RTCPeerConnection({
      iceServers: state.iceServers.length ? state.iceServers : ICE_SERVERS
    });
    connection.onicecandidate = function (event) {
      if (!event.candidate) return;
      // Log the first few local candidates: whether they carry a real LAN
      // address or an mDNS placeholder decides if the peer can reach us.
      if (localIceLogged < 3) {
        localIceLogged += 1;
        emitDebug("candidate", {
          text: String(event.candidate.candidate || "").slice(0, 110)
        });
      }
      if (peer.addr) {
        state.transport.send(peer.addr, { t: "ice", sdp: event.candidate });
      }
    };
    connection.onconnectionstatechange = function () {
      if (connection.connectionState === "failed"
        || connection.connectionState === "disconnected") {
        emitDebug("disconnected", { kind: peer.kind });
        dropPeer(peer.key);
      }
    };
    return connection;
  }

  // Replay any candidates that arrived ahead of the remote description.
  function flushPendingIce(peer) {
    if (!peer || !peer.pc || !peer.pc.remoteDescription) return;
    var queued = peer.pendingIce;
    peer.pendingIce = [];
    for (var index = 0; index < queued.length; index += 1) {
      peer.pc.addIceCandidate(queued[index]).catch(function () { /* stale */ });
    }
  }

  // Chromium hides host candidates behind an mDNS name (.local) even on a
  // trustworthy localhost origin, and plenty of access points do not forward
  // the multicast needed to resolve it. The peer's real address is the source
  // of the UDP packet that carried the candidate, so swap the host part for it
  // and skip mDNS entirely.
  function normalizeCandidate(candidate, peerIp) {
    if (!candidate || !candidate.candidate || !peerIp) return candidate;
    var text = String(candidate.candidate);
    if (text.indexOf(".local") < 0) return candidate;
    var parts = text.split(" ");
    for (var index = 0; index < parts.length; index += 1) {
      if (parts[index].indexOf(".local") >= 0) parts[index] = peerIp;
    }
    return {
      candidate: parts.join(" "),
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
      usernameFragment: candidate.usernameFragment
    };
  }

  function attachChannel(peer, connection, isHost) {
    if (isHost) {
      connection.ondatachannel = function (event) {
        bindChannel(peer, event.channel);
      };
    } else {
      bindChannel(peer, connection.createDataChannel("yijian", { ordered: true }));
    }
  }

  function bindChannel(peer, dataChannel) {
    peer.channel = dataChannel;
    dataChannel.onopen = function () {
      state.phase = "connected";
      emitDebug("connected", { kind: peer.kind, peers: peerCounts() });
      pushStatus();
    };
    dataChannel.onclose = function () {
      emitDebug("closed", { kind: peer.kind });
      dropPeer(peer.key);
    };
    dataChannel.onmessage = function (event) {
      var message = null;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (!message) return;
      for (var index = 0; index < listeners.message.length; index += 1) {
        try { listeners.message[index](message, publicPeer(peer)); } catch (error) { /* */ }
      }
    };
  }

  function handleBlob(addr, blob) {
    if (!blob || !blob.t) return;
    emitDebug("recv", { type: blob.t, from: addr && addr.ip });

    if (blob.t === "offer" && state.room && state.room.role === "host") {
      if (!blob.sdp) {
        fail("offer 缺少 sdp（数据可能在传输中损坏）");
        return;
      }
      var key = peerKeyFor(addr);
      var previous = peers[key];
      if (previous) {
        try { if (previous.channel) previous.channel.close(); } catch (error) { /* */ }
        try { if (previous.pc) previous.pc.close(); } catch (error) { /* */ }
        delete peers[key];
      }
      // Every arrival gets its own connection, so spectators stack up next to
      // the opponent instead of taking the game over.
      var peer = {
        key: key,
        addr: addr,
        name: blob.name || "",
        kind: "player",
        pc: null,
        channel: null,
        pendingIce: []
      };
      peers[key] = peer;
      state.peer = publicPeer(primaryPeer());
      state.phase = "connecting";
      pushStatus();
      peer.pc = newPeerConnection(peer);
      attachChannel(peer, peer.pc, true);
      peer.pc.setRemoteDescription({ type: "offer", sdp: blob.sdp })
        .then(function () { flushPendingIce(peer); })
        .then(function () { return peer.pc.createAnswer(); })
        .then(function (answer) { return peer.pc.setLocalDescription(answer); })
        .then(function () {
          state.transport.send(addr, {
            t: "answer", sdp: peer.pc.localDescription.sdp, name: state.room.name
          });
          emitDebug("answer", { ip: addr.ip, port: addr.port });
        })
        .catch(function (error) { fail(describe(error)); });
      return;
    }

    if (blob.t === "answer" && state.room && state.room.role === "guest") {
      if (!blob.sdp) {
        fail("answer 缺少 sdp（数据可能在传输中损坏）");
        return;
      }
      var hostPeer = peerFor(addr) || primaryPeer();
      if (!hostPeer || !hostPeer.pc) return;
      hostPeer.pc.setRemoteDescription({ type: "answer", sdp: blob.sdp })
        .then(function () { flushPendingIce(hostPeer); })
        .catch(function (error) { fail(describe(error)); });
      return;
    }

    if (blob.t === "ice") {
      var target = peerFor(addr);
      if (!target || !target.pc) return;
      target.iceCount = (target.iceCount || 0) + 1;
      if (target.iceCount === 1) emitDebug("ice", { from: addr && addr.ip });
      // The .local -> real-IP rewrite only makes sense on a LAN, where the
      // source address of the UDP packet is the peer. Over the relay the
      // candidates that matter are the STUN ones.
      var candidate = state.mode === "server"
        ? blob.sdp
        : normalizeCandidate(blob.sdp, addr && addr.ip);
      if (!target.pc.remoteDescription) {
        target.pendingIce.push(candidate);
        return;
      }
      target.pc.addIceCandidate(candidate).catch(function () { /* stale */ });
    }
  }

  // ------------------------------------------------------------------ poll loop

  function pollOnce() {
    if (!state.transport) return;
    Promise.resolve(state.transport.poll(pollCursor))
      .then(function (result) {
        if (!result) return;
        if (typeof result.cursor === "number") pollCursor = result.cursor;
        var blobs = result.blobs || [];
        for (var index = 0; index < blobs.length; index += 1) {
          var item = blobs[index];
          handleBlob({ ip: item.ip, port: item.port, id: item.ip }, item.data);
        }
      })
      .catch(function () { /* retry on the next tick */ })
      .then(function () {
        if (state.transport && state.phase !== "idle") {
          pollTimer = scope.setTimeout(pollOnce, 350);
        }
      });
  }

  function startPolling() {
    // Push transports (the relay server) deliver on their own; nothing to poll.
    if (state.transport && state.transport.push) return;
    if (pollTimer) scope.clearTimeout(pollTimer);
    pollTimer = scope.setTimeout(pollOnce, 0);
  }

  function stopPolling() {
    if (pollTimer) scope.clearTimeout(pollTimer);
    pollTimer = null;
  }

  // --------------------------------------------------------------------- public

  var api = {
    proto: PROTO,

    ready: function () {
      if (state.transport) return Promise.resolve(status());
      return chooseTransport().then(function (transport) {
        if (transport) {
          state.transport = transport;
          state.mode = transport.name;
          return loadTransportInfo(transport);
        }
        return undefined;
      }).then(function () {
        return status();
      });
    },

    status: status,

    onStatus: function (cb) { listeners.status.push(cb); },
    onMessage: function (cb) { listeners.message.push(cb); },
    onRooms: function (cb) { listeners.rooms.push(cb); },
    onDebug: function (cb) { listeners.debug.push(cb); },

    readySync: function () { return !!state.transport; },
    mode: function () { return state.mode; },

    scan: function () {
      return api.ready().then(function () {
        if (!state.transport) return [];
        return Promise.resolve(state.transport.rooms())
          .then(function (list) { return normalizeRooms(list); })
          .catch(function () { return []; });
      });
    },

    hostRoom: function (options) {
      var room = {
        id: options.id || randomId(),
        name: options.name || "YiJian",
        role: "host"
      };
      return api.ready().then(function () {
        if (!state.transport) {
          fail("no-transport");
          return status();
        }
        closePeers();
        state.room = room;
        state.phase = "announcing";
        state.error = "";
        if (state.transport.onBlob) state.transport.onBlob(handleBlob);
        // The relay server assigns the room code, so wait for its answer
        // before deciding what to display.
        return Promise.resolve(state.transport.announce(room)).then(function (info) {
          if (info && info.id) state.room.id = info.id;
          if (info && info.name) state.room.name = info.name;
          emitDebug("announce", state.room);
          // Re-announcing is a LAN thing; asking the server to create the room
          // again every 1.5s would spawn a room per tick.
          if (!state.transport.push) {
            if (announceTimer) scope.clearInterval(announceTimer);
            announceTimer = scope.setInterval(function () {
              if (state.room) state.transport.announce(state.room);
            }, ANNOUNCE_MS);
          }
          startPolling();
          pushStatus();
          return status();
        }).catch(function (error) {
          fail(describe(error));
          return status();
        });
      });
    },

    joinRoom: function (target, options) {
      return api.ready().then(function () {
        if (!state.transport) {
          fail("no-transport");
          return status();
        }
        if (!hasPeerConnection()) {
          fail("no-webrtc");
          return status();
        }
        closePeers();
        state.room = { id: target.id, name: target.name, role: "guest" };
        state.phase = "connecting";
        state.error = "";
        if (state.transport.onBlob) state.transport.onBlob(handleBlob);
        emitDebug("offer", target.addr);
        var key = peerKeyFor(target.addr);
        var peer = {
          key: key,
          addr: target.addr,
          name: (options && options.name) || "",
          kind: "player",
          pc: null,
          channel: null,
          pendingIce: []
        };
        peers[key] = peer;
        state.peer = publicPeer(peer);
        peer.pc = newPeerConnection(peer);
        attachChannel(peer, peer.pc, false);
        startPolling();
        return peer.pc.createOffer()
          .then(function (offer) { return peer.pc.setLocalDescription(offer); })
          .then(function () {
            return state.transport.send(target.addr, {
              t: "offer",
              sdp: peer.pc.localDescription.sdp,
              name: (options && options.name) || ""
            });
          })
          .then(function () {
            pushStatus();
            return status();
          })
          .catch(function (error) {
            fail(describe(error));
            return status();
          });
      });
    },

    // Server mode: join by room code. Everyone dials the room's host, exactly
    // like the LAN path does.
    joinByCode: function (code, options) {
      return api.ready().then(function () {
        if (!state.transport || typeof state.transport.joinSignalling !== "function") {
          fail("no-server");
          return status();
        }
        if (!hasPeerConnection()) {
          fail("no-webrtc");
          return status();
        }
        closePeers();
        state.room = { id: String(code || "").toUpperCase(), name: "", role: "guest" };
        state.phase = "connecting";
        state.error = "";
        if (state.transport.onBlob) state.transport.onBlob(handleBlob);
        return state.transport.joinSignalling(code, options && options.want)
          .then(function (info) {
            state.room = { id: info.room.id, name: info.room.name, role: "guest" };
            var hostId = info.hostId;
            var key = peerKeyFor({ id: hostId });
            var peer = {
              key: key,
              addr: { id: hostId },
              name: info.hostName || "",
              kind: "player",
              pc: null,
              channel: null,
              pendingIce: []
            };
            peers[key] = peer;
            state.peer = publicPeer(peer);
            emitDebug("offer", peer.addr);
            peer.pc = newPeerConnection(peer);
            attachChannel(peer, peer.pc, false);
            return peer.pc.createOffer()
              .then(function (offer) { return peer.pc.setLocalDescription(offer); })
              .then(function () {
                return state.transport.send(peer.addr, {
                  t: "offer",
                  sdp: peer.pc.localDescription.sdp,
                  name: (options && options.name) || "",
                  want: (options && options.want) || "play"
                });
              })
              .then(function () {
                pushStatus();
                return status();
              });
          })
          .catch(function (error) {
            fail(describe(error));
            return status();
          });
      });
    },

    // Switching between LAN and the relay drops whatever is running.
    setServer: function (url) {
      var text = String(url || "").trim();
      state.prefer = text ? "server" : "auto";
      state.serverUrl = text;
      return resetTransport();
    },

    setLan: function () {
      state.prefer = "auto";
      state.serverUrl = "";
      return resetTransport();
    },

    // Loopback probe: send a packet to ourselves and check it comes back
    // through the inbox. Separates "this device cannot do UDP at all" from
    // "the other device is unreachable".
    selfTest: function () {
      return api.ready().then(function () {
        if (!state.transport) return { ok: false, reason: "no-transport", mode: null };
        var token = "selftest-" + randomId();
        var from = 0;
        // wait=0: the self test must not sit on the long poll for 25 seconds.
        return Promise.resolve(state.transport.poll(0, 0)).then(function (result) {
          from = result && typeof result.cursor === "number" ? result.cursor : 0;
          return state.transport.send(
            { ip: "127.0.0.1", port: 0, id: "127.0.0.1" },
            { t: "selftest", token: token }
          );
        }).then(function () {
          return new Promise(function (resolve) { scope.setTimeout(resolve, 500); });
        }).then(function () {
          return Promise.resolve(state.transport.poll(from, 0));
        }).then(function (result) {
          var blobs = (result && result.blobs) || [];
          for (var index = 0; index < blobs.length; index += 1) {
            if (blobs[index].data && blobs[index].data.token === token) {
              return { ok: true, reason: "", mode: state.mode };
            }
          }
          return { ok: false, reason: "loopback-failed", mode: state.mode };
        });
      }).catch(function (error) {
        return { ok: false, reason: describe(error), mode: state.mode };
      });
    },

    // Broadcasts to every open peer, or to a single one when an id is given.
    // The host uses this to fan game events out to the opponent and to every
    // spectator.
    send: function (message, peerId) {
      var sent = false;
      eachPeer(function (peer) {
        if (peerId && peer.key !== peerId) return;
        if (!peer.channel || peer.channel.readyState !== "open") return;
        try {
          peer.channel.send(JSON.stringify(message));
          sent = true;
        } catch (error) { /* that peer is gone */ }
      });
      return sent;
    },

    sendTo: function (peerId, message) {
      return api.send(message, peerId);
    },

    // Fan out to everyone except one peer. The host uses this to relay what a
    // player sent on to the spectators without echoing it back.
    sendExcept: function (peerId, message) {
      var sent = false;
      eachPeer(function (peer) {
        if (peerId && peer.key === peerId) return;
        if (!peer.channel || peer.channel.readyState !== "open") return;
        try {
          peer.channel.send(JSON.stringify(message));
          sent = true;
        } catch (error) { /* that peer is gone */ }
      });
      return sent;
    },

    // The app marks a peer as "player" or "spectator" once the hello arrives.
    setPeerKind: function (peerId, kind) {
      var peer = peers[peerId];
      if (peer) {
        peer.kind = kind === "spectator" ? "spectator" : "player";
        state.peer = publicPeer(primaryPeer());
      }
      return status();
    },

    leave: function () {
      if (announceTimer) scope.clearInterval(announceTimer);
      announceTimer = null;
      stopPolling();
      if (state.transport && state.room) state.transport.stopAnnounce(state.room);
      closePeers();
      state.room = null;
      state.phase = "idle";
      state.error = "";
      pushStatus();
    },

    // Exposed for the tests: drive a peer without any real networking.
    __setTransport: function (transport) {
      state.transport = transport;
      state.mode = transport ? transport.name : null;
      return status();
    },
    __handleBlob: handleBlob,
    __bindChannel: bindChannel,
    __normalizeCandidate: normalizeCandidate,
    __state: state
  };

  scope.XiangqiNet = api;
})();
