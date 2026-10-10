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
      poll: function (cursor) {
        return Promise.resolve(bridge.inbox(cursor)).then(function (result) {
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
      return fetch(base + path, options).then(function (response) {
        if (!response.ok) throw new Error("lan " + path + " -> " + response.status);
        return response.json();
      });
    }
    return {
      name: "http",
      setHello: function (info) { hello = info; },
      info: function () { return Promise.resolve(hello); },
      send: function (addr, blob) {
        return json("/lan/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ip: addr.ip, port: addr.port, data: blob })
        });
      },
      announce: function (room) {
        json("/lan/announce", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room: room })
        }).catch(function () { /* best effort */ });
      },
      stopAnnounce: function () {
        json("/lan/announce", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stop: true })
        }).catch(function () { /* best effort */ });
      },
      poll: function (cursor) {
        return json("/lan/inbox?since=" + encodeURIComponent(cursor)
          + "&wait=" + POLL_TIMEOUT_MS);
      },
      rooms: function () {
        return json("/lan/rooms").then(function (result) {
          return (result && result.rooms) || [];
        });
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
    if (!plugin) return null;
    return {
      announce: function (room) { return plugin.announce({ room: room }); },
      stopAnnounce: function () { return plugin.announce({ stop: true }); },
      rooms: function () {
        return Promise.resolve(plugin.rooms()).then(function (result) {
          return (result && result.rooms) || [];
        });
      },
      inbox: function (cursor) {
        return Promise.resolve(plugin.inbox({ since: cursor })).then(function (result) {
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
    localIps: []
  };
  var announceTimer = null;
  var pollTimer = null;
  var pollCursor = 0;
  var pc = null;
  var channel = null;

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

  function closePeer() {
    if (channel) {
      try { channel.close(); } catch (error) { /* already closed */ }
      channel = null;
    }
    if (pc) {
      try { pc.close(); } catch (error) { /* already closed */ }
      pc = null;
    }
  }

  function newPeerConnection() {
    var connection = new scope.RTCPeerConnection({ iceServers: ICE_SERVERS });
    connection.onicecandidate = function (event) {
      if (event.candidate && state.peer) {
        state.transport.send(state.peer.addr, {
          t: "ice", sdp: event.candidate
        });
      }
    };
    connection.onconnectionstatechange = function () {
      if (connection.connectionState === "failed"
        || connection.connectionState === "disconnected") {
        state.peer = null;
        emitDebug("disconnected", connection.connectionState);
        state.phase = state.room && state.room.role === "host"
          ? "announcing"
          : (state.room ? "connecting" : "idle");
        pushStatus();
      }
    };
    return connection;
  }

  function attachChannel(connection, isHost) {
    if (isHost) {
      connection.ondatachannel = function (event) { bindChannel(event.channel); };
    } else {
      bindChannel(connection.createDataChannel("yijian", { ordered: true }));
    }
  }

  function bindChannel(dataChannel) {
    channel = dataChannel;
    channel.onopen = function () {
      state.phase = "connected";
      emitDebug("connected", null);
      pushStatus();
    };
    channel.onclose = function () {
      emitDebug("closed", null);
      if (state.phase === "connected") {
        state.phase = state.room ? "announcing" : "idle";
        pushStatus();
      }
    };
    channel.onmessage = function (event) {
      var message = null;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (message) emit(listeners.message, message);
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
      state.peer = { addr: addr, name: blob.name || "" };
      state.phase = "connecting";
      pushStatus();
      closePeer();
      pc = newPeerConnection();
      attachChannel(pc, true);
      pc.setRemoteDescription({ type: "offer", sdp: blob.sdp })
        .then(function () { return pc.createAnswer(); })
        .then(function (answer) { return pc.setLocalDescription(answer); })
        .then(function () {
          state.transport.send(addr, {
            t: "answer", sdp: pc.localDescription.sdp, name: state.room.name
          });
        })
        .catch(function (error) { fail(describe(error)); });
      return;
    }

    if (blob.t === "answer" && pc && state.room && state.room.role === "guest") {
      if (!blob.sdp) {
        fail("answer 缺少 sdp（数据可能在传输中损坏）");
        return;
      }
      pc.setRemoteDescription({ type: "answer", sdp: blob.sdp })
        .catch(function (error) { fail(describe(error)); });
      return;
    }

    if (blob.t === "ice" && pc) {
      pc.addIceCandidate(blob.sdp).catch(function () { /* late candidate */ });
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
        closePeer();
        state.room = room;
        state.peer = null;
        state.phase = "announcing";
        state.error = "";
        if (state.transport.onBlob) state.transport.onBlob(handleBlob);
        state.transport.announce(room);
        emitDebug("announce", room);
        if (announceTimer) scope.clearInterval(announceTimer);
        announceTimer = scope.setInterval(function () {
          if (state.room) state.transport.announce(state.room);
        }, ANNOUNCE_MS);
        startPolling();
        pushStatus();
        return status();
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
        closePeer();
        state.room = { id: target.id, name: target.name, role: "guest" };
        state.peer = { addr: target.addr, name: (options && options.name) || "" };
        state.phase = "connecting";
        state.error = "";
        if (state.transport.onBlob) state.transport.onBlob(handleBlob);
        emitDebug("offer", target.addr);
        pc = newPeerConnection();
        attachChannel(pc, false);
        startPolling();
        return pc.createOffer()
          .then(function (offer) { return pc.setLocalDescription(offer); })
          .then(function () {
            return state.transport.send(target.addr, {
              t: "offer",
              sdp: pc.localDescription.sdp,
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

    send: function (message) {
      if (!channel || channel.readyState !== "open") return false;
      try {
        channel.send(JSON.stringify(message));
        return true;
      } catch (error) {
        return false;
      }
    },

    leave: function () {
      if (announceTimer) scope.clearInterval(announceTimer);
      announceTimer = null;
      stopPolling();
      if (state.transport && state.room) state.transport.stopAnnounce(state.room);
      closePeer();
      state.room = null;
      state.peer = null;
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
    __state: state
  };

  scope.XiangqiNet = api;
})();
