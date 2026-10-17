// Drives the signalling server with real WebSocket clients.
//
//   node verify-server.mjs
//
// Covers: hello/ice, room create, join as player, join as spectator, the
// two-player seat limit, opaque signal relay, peer.join/leave notifications,
// host-leave closing the room, the room list, the /health endpoint and the
// TURN REST credential (URL 列表、有效期、HMAC 校验、缺 secret 时不下发).
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listen, close } from "./server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const problems = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const queue = [];
    const waiters = [];

    socket.addEventListener("message", (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else queue.push(message);
    });
    socket.addEventListener("error", () => reject(new Error("websocket error")));
    socket.addEventListener("open", () => {
      resolve({
        socket,
        send: (message) => socket.send(JSON.stringify(message)),
        next: (timeoutMs = 2500) => {
          if (queue.length) return Promise.resolve(queue.shift());
          return new Promise((res, rej) => {
            const waiter = { resolve: null };
            const timer = setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              rej(new Error("timeout waiting for a message"));
            }, timeoutMs);
            waiter.resolve = (message) => {
              clearTimeout(timer);
              res(message);
            };
            waiters.push(waiter);
          });
        },
        close: () => socket.close(),
      });
    });
  });
}

// 进程内启动：沙箱不允许 Node 起子进程，而且这样测试更快。
const port = await listen({
  host: "127.0.0.1",
  port: 0,
  stunUrl: "stun:stun.example.test:3478",
  turnUrl: "turn:turn.example.test:3478",
  turnSecret: "test-secret",
});

try {
  console.log("== 连接与 ICE 配置 ==");
  const a = await connect(port);
  a.send({ t: "hello", proto: 1, name: "甲" });
  const welcome = await a.next();
  check("hello 收到 welcome", welcome.t === "welcome", welcome.t);
  check("welcome 带 clientId", typeof welcome.clientId === "string" && welcome.clientId.length > 0);
  const servers = (welcome.ice && welcome.ice.servers) || [];
  check("下发 STUN", servers.some((s) => String(s.urls).startsWith("stun:")),
    JSON.stringify(servers));
  const turn = servers.find((s) => String(s.urls).startsWith("turn:"));
  check("下发 TURN 时带临时凭证", !!(turn && turn.username && turn.credential),
    JSON.stringify(servers.map((s) => s.urls)));
  check("TURN 凭证 = base64(HMAC-SHA1(secret, username))",
    !!turn
      && crypto.createHmac("sha1", "test-secret").update(turn.username).digest("base64")
        === turn.credential,
    turn ? turn.username : "-");
  const expireAt = Number(String(turn && turn.username).split(":")[0]);
  const expectedExpiry = Math.floor(Date.now() / 1000) + 600;
  check("TURN 凭证默认 600 秒有效",
    Number.isFinite(expireAt) && Math.abs(expireAt - expectedExpiry) <= 3,
    `${expireAt} vs ${expectedExpiry}`);

  console.log("== 建房 ==");
  a.send({ t: "room.create", name: "甲的房间", visibility: "public" });
  const created = await a.next();
  check("建房收到 room.joined", created.t === "room.joined", created.t);
  const code = created.room && created.room.id;
  check("房间码是 6 位且不含易混字符",
    typeof code === "string" && /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(code), code);
  check("建房者是 host", created.room.hostId === welcome.clientId);
  check("建房者身份是 player", created.self.kind === "player", created.self.kind);
  check("刚建房时没有其他成员", created.peers.length === 0, String(created.peers.length));

  console.log("== 玩家加入 ==");
  const b = await connect(port);
  b.send({ t: "hello", proto: 1, name: "乙" });
  const welcomeB = await b.next();
  b.send({ t: "room.join", roomId: code, want: "play" });
  const joinedB = await b.next();
  check("乙加入成功", joinedB.t === "room.joined", joinedB.t);
  check("乙能看到房主", joinedB.peers.length === 1 && joinedB.peers[0].id === welcome.clientId,
    JSON.stringify(joinedB.peers));
  const peerJoin = await a.next();
  check("房主收到 peer.join", peerJoin.t === "peer.join" && peerJoin.peer.id === welcomeB.clientId,
    JSON.stringify(peerJoin));

  console.log("== 坐满之后的处理 ==");
  const c = await connect(port);
  c.send({ t: "hello", proto: 1, name: "丙" });
  await c.next();
  c.send({ t: "room.join", roomId: code, want: "play" });
  const full = await c.next();
  check("第三名棋手被拒绝", full.t === "error" && full.code === "room_full",
    JSON.stringify(full));
  c.send({ t: "room.join", roomId: code, want: "spectate" });
  const watch = await c.next();
  check("同一人改为观战可以进", watch.t === "room.joined" && watch.self.kind === "spectator",
    JSON.stringify(watch.self));
  // 丙进来时甲和乙各会收到一条 peer.join，先排空再测信令
  const joinSeenByA = await a.next();
  const joinSeenByB = await b.next();
  check("观战者加入会通知房主",
    joinSeenByA.t === "peer.join" && joinSeenByA.peer.kind === "spectator",
    JSON.stringify(joinSeenByA));
  check("观战者加入会通知对手",
    joinSeenByB.t === "peer.join" && joinSeenByB.peer.kind === "spectator",
    JSON.stringify(joinSeenByB));

  console.log("== 信令中转 ==");
  a.send({ t: "signal", to: welcomeB.clientId, data: { t: "offer", sdp: "fake" } });
  const relayed = await b.next();
  check("对端收到 signal", relayed.t === "signal", relayed.t);
  check("转发时带上发送者 id", relayed.from === welcome.clientId, relayed.from);
  check("data 原样透传（服务端不解析）",
    relayed.data && relayed.data.t === "offer" && relayed.data.sdp === "fake",
    JSON.stringify(relayed.data));

  c.send({ t: "signal", to: "nobody", data: { t: "offer" } });
  const noPeer = await c.next();
  check("发给不在房间的人会报错", noPeer.t === "error" && noPeer.code === "no_peer",
    JSON.stringify(noPeer));

  console.log("== 房间列表与健康检查 ==");
  const d = await connect(port);
  d.send({ t: "hello", proto: 1 });
  await d.next();
  d.send({ t: "room.list" });
  const list = await d.next();
  check("公开房间出现在列表里",
    list.t === "room.list" && list.rooms.some((room) => room.id === code),
    JSON.stringify(list.rooms));
  check("列表里带上人数",
    list.rooms.every((room) => typeof room.players === "number"
      && typeof room.spectators === "number"),
    JSON.stringify(list.rooms));

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  check("/health 正常", health.ok === true && health.rooms === 1 && health.clients === 4,
    JSON.stringify(health));
  check("/health 汇报 STUN 与 TURN 都已启用", health.stun === 1 && health.turn === 1,
    JSON.stringify({ stun: health.stun, turn: health.turn }));

  console.log("== 房主离开 ==");
  a.send({ t: "room.leave" });
  const closedB = await b.next();
  const closedC = await c.next();
  check("房主离开后房间解散（乙）", closedB.t === "room.closed", JSON.stringify(closedB));
  check("房主离开后房间解散（丙）", closedC.t === "room.closed", JSON.stringify(closedC));

  const healthAfter = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  check("房间已从服务端移除", healthAfter.rooms === 0, JSON.stringify(healthAfter));

  console.log("== 健壮性 ==");
  d.socket.send("not json");
  const badJson = await d.next();
  check("非法 JSON 得到错误而不是崩溃", badJson.t === "error" && badJson.code === "bad_json",
    JSON.stringify(badJson));
  d.send({ t: "room.join", roomId: "ZZZZZZ" });
  const noRoom = await d.next();
  check("加入不存在的房间有明确错误",
    noRoom.t === "error" && noRoom.code === "no_room", JSON.stringify(noRoom));

  a.close();
  b.close();
  c.close();
  d.close();
} catch (error) {
  check("测试流程完成", false, String(error && error.stack || error));
} finally {
  await close();
}

// 第二轮：TURN 的配置边界。server.mjs 是单例，所以先关掉再换参数重启。
console.log("== TURN 配置边界 ==");
try {
  const port2 = await listen({
    host: "127.0.0.1",
    port: 0,
    stunUrl: "stun:stun.example.test:3478",
    turnUrl: "turn:turn.example.test:3478?transport=udp, turn:turn.example.test:3478?transport=tcp",
    turnSecret: "another-secret",
    turnTtl: 3600,
  });
  const e = await connect(port2);
  e.send({ t: "hello", proto: 1, name: "边界" });
  const welcome2 = await e.next();
  const turn2 = ((welcome2.ice && welcome2.ice.servers) || [])
    .find((s) => String(s.urls).includes("turn:"));
  check("多条 TURN_URL 合并成一个 urls 数组",
    !!turn2 && Array.isArray(turn2.urls) && turn2.urls.length === 2,
    JSON.stringify(turn2 && turn2.urls));
  const expire2 = Number(String(turn2 && turn2.username).split(":")[0]);
  check("TURN_TTL 生效（3600 秒）",
    Math.abs(expire2 - (Math.floor(Date.now() / 1000) + 3600)) <= 3,
    String(expire2));
  const health2 = await fetch(`http://127.0.0.1:${port2}/health`).then((r) => r.json());
  check("/health 的 turn 计数是 2", health2.turn === 2, JSON.stringify(health2));

  e.close();
  await close();

  const port3 = await listen({
    host: "127.0.0.1",
    port: 0,
    stunUrl: "stun:stun.example.test:3478",
    turnUrl: "turn:turn.example.test:3478",
    turnSecret: "",
  });
  const f = await connect(port3);
  f.send({ t: "hello", proto: 1, name: "无密钥" });
  const welcome3 = await f.next();
  const list3 = (welcome3.ice && welcome3.ice.servers) || [];
  check("只给 TURN_URL 不给 secret 时不下发 TURN",
    !list3.some((s) => String(s.urls).includes("turn:")),
    JSON.stringify(list3.map((s) => s.urls)));
  f.close();
  await close();
} catch (error) {
  check("TURN 边界用例完成", false, String(error && error.stack || error));
}

// 第三轮：房间密码。
console.log("== 房间密码 ==");
try {
  const port4 = await listen({
    host: "127.0.0.1",
    port: 0,
    stunUrl: "stun:stun.example.test:3478",
    turnUrl: "",
    turnSecret: "",
  });

  const host = await connect(port4);
  host.send({ t: "hello", proto: 1, name: "房主" });
  await host.next();
  host.send({ t: "room.create", name: "上锁房", visibility: "public", password: "s3cret" });
  const createdLocked = await host.next();
  const lockedCode = createdLocked.room && createdLocked.room.id;
  check("可以创建带密码的房间", createdLocked.t === "room.joined", createdLocked.t);

  const lister = await connect(port4);
  lister.send({ t: "hello", proto: 1, name: "路人" });
  await lister.next();
  lister.send({ t: "room.list" });
  const listed = await lister.next();
  const entry = (listed.rooms || []).find((room) => room.id === lockedCode);
  check("房间列表里能看出房间是否上锁", !!entry && entry.locked === true,
    JSON.stringify(entry));

  lister.send({ t: "room.join", roomId: lockedCode, want: "play" });
  const noPassword = await lister.next();
  check("不给密码时被拒绝",
    noPassword.t === "error" && noPassword.code === "bad_password", JSON.stringify(noPassword));

  lister.send({ t: "room.join", roomId: lockedCode, want: "play", password: "wrong" });
  const wrongPassword = await lister.next();
  check("密码错误时被拒绝",
    wrongPassword.t === "error" && wrongPassword.code === "bad_password",
    JSON.stringify(wrongPassword));

  lister.send({ t: "room.join", roomId: lockedCode, want: "play", password: "s3cret" });
  const rightPassword = await lister.next();
  check("密码正确时可以加入",
    rightPassword.t === "room.joined" && rightPassword.room.id === lockedCode,
    JSON.stringify(rightPassword.room));

  const openRoom = await connect(port4);
  openRoom.send({ t: "hello", proto: 1, name: "公开房主" });
  await openRoom.next();
  openRoom.send({ t: "room.create", name: "公开房", visibility: "public" });
  const createdOpen = await openRoom.next();
  openRoom.send({ t: "room.list" });
  const listedOpen = await openRoom.next();
  const openEntry = (listedOpen.rooms || []).find((room) => room.id === createdOpen.room.id);
  check("没设密码的房间 locked 为 false", !!openEntry && openEntry.locked === false,
    JSON.stringify(openEntry));

  host.close();
  lister.close();
  openRoom.close();
  await close();
} catch (error) {
  check("房间密码用例完成", false, String(error && error.stack || error));
}

// 第四轮：固定房间码。
console.log("== 固定房间码 ==");
try {
  const port5 = await listen({
    host: "127.0.0.1",
    port: 0,
    stunUrl: "stun:stun.example.test:3478",
    turnUrl: "",
    turnSecret: "",
  });

  const a = await connect(port5);
  a.send({ t: "hello", proto: 1, name: "甲" });
  await a.next();
  a.send({ t: "room.create", name: "固定房", visibility: "public", preferredId: "ABC234" });
  const fixed = await a.next();
  check("建房时沿用请求的固定房间码",
    fixed.t === "room.joined" && fixed.room.id === "ABC234",
    JSON.stringify(fixed.room));

  const b = await connect(port5);
  b.send({ t: "hello", proto: 1, name: "乙" });
  await b.next();
  b.send({ t: "room.create", name: "抢码房", visibility: "public", preferredId: "ABC234" });
  const taken = await b.next();
  check("房间码被占用时换一个新的",
    taken.t === "room.joined" && taken.room.id !== "ABC234"
      && /^[2-9A-HJ-NP-Z]{6}$/.test(taken.room.id),
    JSON.stringify(taken.room));

  a.send({ t: "room.leave" });
  await a.next();
  b.send({ t: "room.leave" });
  await b.next();

  const c = await connect(port5);
  c.send({ t: "hello", proto: 1, name: "丙" });
  await c.next();
  c.send({ t: "room.create", name: "复用固定房", visibility: "public", preferredId: "ABC234" });
  const reused = await c.next();
  check("房间释放后可以复用同一个固定房间码",
    reused.t === "room.joined" && reused.room.id === "ABC234",
    JSON.stringify(reused.room));

  a.close();
  b.close();
  c.close();
  await close();
} catch (error) {
  check("固定房间码用例完成", false, String(error && error.stack || error));
}

console.log("");
if (problems.length === 0) {
  console.log("SERVER CHECKS PASSED");
  process.exitCode = 0;
} else {
  console.log(`PROBLEMS: ${problems.join("; ")}`);
  process.exitCode = 1;
}
