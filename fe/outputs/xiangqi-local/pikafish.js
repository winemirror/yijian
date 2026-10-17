(function (scope) {
  "use strict";

  var DEFAULT_SERVER = "wss://c.syjnb.top/ws";
  var ROOM_ID = "PKAFST";
  var REQUEST_TIMEOUT_MS = 22000;
  var LEVELS = {
    "pikafish-fast": {
      label: "皮卡鱼 · 快速",
      moveMs: 500,
      analysisMs: 1200
    },
    "pikafish-standard": {
      label: "皮卡鱼 · 标准",
      moveMs: 1000,
      analysisMs: 1800
    },
    "pikafish-deep": {
      label: "皮卡鱼 · 深度",
      moveMs: 2200,
      analysisMs: 3200
    }
  };

  var socket = null;
  var readyPromise = null;
  var selfId = "";
  var peerId = "";
  var activeRequestId = "";
  var nextRequestId = 1;
  var pending = new Map();
  var heartbeat = null;
  var lastStatus = "idle";

  function serverUrl() {
    try {
      var match = String(scope.location && scope.location.search || "").match(
        /[?&]pikafishServer=([^&]+)/
      );
      if (match) return decodeURIComponent(match[1]);
    } catch (error) {
      // Fall through to the production endpoint.
    }
    return DEFAULT_SERVER;
  }

  function isPikafishLevel(levelKey) {
    return Object.prototype.hasOwnProperty.call(LEVELS, levelKey);
  }

  function labelFor(levelKey) {
    var level = LEVELS[levelKey];
    return level ? level.label : "皮卡鱼";
  }

  function rejectPending(error) {
    for (var request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    activeRequestId = "";
  }

  function post(message) {
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function failReady(error) {
    readyPromise = null;
    selfId = "";
    peerId = "";
    lastStatus = "error: " + ((error && error.message) || String(error));
    rejectPending(error);
  }

  function connect() {
    if (readyPromise) return readyPromise;
    lastStatus = "connecting";
    readyPromise = new Promise(function (resolve, reject) {
      var settled = false;
      var timer = scope.setTimeout(function () {
        if (settled) return;
        settled = true;
        try {
          if (socket) socket.close();
        } catch (error) {
          // Already closed.
        }
        failReady(new Error("皮卡鱼连接超时"));
        reject(new Error("皮卡鱼连接超时"));
      }, 10000);

      function settleReady() {
        if (settled || !peerId) return;
        settled = true;
        clearTimeout(timer);
        lastStatus = "online";
        resolve({
          selfId: selfId,
          peerId: peerId,
          roomId: ROOM_ID,
          server: serverUrl()
        });
      }

      try {
        socket = new scope.WebSocket(serverUrl());
      } catch (error) {
        clearTimeout(timer);
        failReady(error);
        reject(error);
        return;
      }

      socket.onopen = function () {
        post({ t: "hello", proto: 1, name: "皮卡鱼测试客户端" });
      };

      socket.onmessage = function (event) {
        var message = null;
        try {
          message = JSON.parse(String(event.data));
        } catch (error) {
          return;
        }
        if (!message || typeof message.t !== "string") return;

        if (message.t === "welcome") {
          selfId = message.clientId || "";
          post({
            t: "room.join",
            roomId: ROOM_ID,
            want: "spectate",
            password: ""
          });
          return;
        }

        if (message.t === "room.joined") {
          selfId = message.self && message.self.id || selfId;
          var peers = message.peers || [];
          for (var index = 0; index < peers.length; index += 1) {
            if (peers[index].id !== selfId) {
              peerId = peers[index].id;
              break;
            }
          }
          settleReady();
          if (!heartbeat) {
            heartbeat = scope.setInterval(function () {
              post({ t: "ping", at: Date.now() });
            }, 20000);
          }
          return;
        }

        if (message.t === "peer.join") {
          if (message.peer && message.peer.id && message.peer.id !== selfId) {
            peerId = message.peer.id;
            settleReady();
          }
          return;
        }

        if (message.t === "peer.leave") {
          if (message.peerId === peerId) peerId = "";
          return;
        }

        if (message.t === "room.closed") {
          peerId = "";
          failReady(new Error("皮卡鱼测试房间已关闭"));
          try {
            if (socket) socket.close();
          } catch (error) {
            // Already closed.
          }
          return;
        }

        if (message.t === "signal") {
          var data = message.data;
          if (!data || (data.t !== "pf.result" && data.t !== "pf.error")) return;
          var request = pending.get(String(data.id || ""));
          if (!request) return;
          pending.delete(String(data.id || ""));
          if (activeRequestId === String(data.id || "")) activeRequestId = "";
          clearTimeout(request.timer);
          if (data.t === "pf.error") request.reject(new Error(data.message || "皮卡鱼请求失败"));
          else request.resolve(data);
          return;
        }

        if (message.t === "error") {
          var error = new Error(message.message || message.code || "皮卡鱼中继错误");
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            failReady(error);
            reject(error);
          }
        }
      };

      socket.onerror = function () {
        lastStatus = "error: socket";
      };

      socket.onclose = function () {
        socket = null;
        selfId = "";
        peerId = "";
        activeRequestId = "";
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (readyPromise) failReady(new Error("皮卡鱼连接已断开"));
      };
    });
    return readyPromise;
  }

  function request(kind, moves, levelKey, options) {
    options = options || {};
    var level = LEVELS[levelKey] || LEVELS["pikafish-standard"];
    return connect().then(function () {
      return new Promise(function (resolve, reject) {
        if (!peerId) {
          reject(new Error("皮卡鱼测试节点不在线"));
          return;
        }
        var id = String(nextRequestId++);
        activeRequestId = id;
        var timer = scope.setTimeout(function () {
          pending.delete(id);
          reject(new Error("皮卡鱼思考超时"));
        }, options.timeoutMs || REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        var sent = post({
          t: "signal",
          to: peerId,
          data: {
            t: "pf.request",
            id: id,
            kind: kind,
            moves: moves || [],
            timeMs: options.timeMs || (kind === "analyze" ? level.analysisMs : level.moveMs),
            multiPv: options.multiPv || 3
          }
        });
        if (!sent) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error("皮卡鱼中继连接不可用"));
        }
      });
    });
  }

  function chooseMove(moves, levelKey) {
    return request("move", moves, levelKey, { multiPv: 1 });
  }

  function analyze(moves, levelKey, options) {
    return request("analyze", moves, levelKey, options || {});
  }

  function status() {
    return {
      status: lastStatus,
      selfId: selfId,
      peerId: peerId,
      roomId: ROOM_ID,
      server: serverUrl(),
      levels: LEVELS
    };
  }

  function cancelActive() {
    if (!peerId || !activeRequestId) return false;
    var id = activeRequestId;
    activeRequestId = "";
    return post({
      t: "signal",
      to: peerId,
      data: { t: "pf.cancel", id: id }
    });
  }

  function close() {
    rejectPending(new Error("皮卡鱼连接已关闭"));
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    try {
      if (socket) socket.close();
    } catch (error) {
      // Already closed.
    }
    socket = null;
    readyPromise = null;
    selfId = "";
    peerId = "";
    activeRequestId = "";
  }

  scope.XiangqiPikafish = {
    LEVELS: LEVELS,
    DEFAULT_SERVER: DEFAULT_SERVER,
    ROOM_ID: ROOM_ID,
    isPikafishLevel: isPikafishLevel,
    labelFor: labelFor,
    chooseMove: chooseMove,
    analyze: analyze,
    cancelActive: cancelActive,
    connect: connect,
    status: status,
    close: close
  };
})(typeof window !== "undefined" ? window : self);
