# 弈鉴 · 信令与房间服务（3.0）

## 它做什么

| 做 | 不做 |
|---|---|
| 房间登记（建房 / 房间码 / 公开房间列表） | **不碰棋局数据**（走 WebRTC DataChannel） |
| 信令中转（转发 `offer/answer/ice`，不解析内容） | 不存棋局、不存账号、不写数据库 |
| 下发 ICE 配置（STUN；TURN 预留） | 不做内容审核 |

服务端重启只丢房间、不丢数据。所有状态在内存里，`rooms` + `clients` 两个 Map。

## 零依赖

WebSocket 按 RFC 6455 自己实现，只用 Node 内置模块。**服务器上不需要 `npm install`**。

```bash
node server.mjs
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `STUN_URL` | 空 | 例 `stun:你的域名:3478`。**留空则不下发 STUN → 公网连不上** |
| `TURN_URL` / `TURN_SECRET` / `TURN_TTL` | 空 / 空 / 600 | 三个都配了才下发带临时凭证的 TURN；3.0 留空 |
| `MAX_ROOMS` | `500` | 同时存在的房间上限 |
| `ROOM_TTL_MS` | 1800000 | 房间空闲多久后回收 |

## 协议

客户端 → 服务端

```
{ t:"hello",       proto:1, name }
{ t:"ice" }                                    // 需要时重新取 ICE 配置
{ t:"room.create", name, visibility:"public"|"private" }
{ t:"room.list" }
{ t:"room.join",   roomId, want:"play"|"spectate" }
{ t:"room.leave" }
{ t:"signal",      to:"<peerId>", data:<不透明 JSON> }
{ t:"ping", at }
```

服务端 → 客户端

```
{ t:"welcome",     proto, clientId, ice:{ servers:[…] } }
{ t:"ice",         servers:[…] }
{ t:"room.joined", room:{id,name,hostId}, self:{id,kind}, peers:[{id,name,kind}] }
{ t:"room.left" } / { t:"room.closed", roomId, reason }
{ t:"room.list",   rooms:[{id,name,players,spectators,private}] }
{ t:"peer.join",   peer } / { t:"peer.leave", peerId }
{ t:"signal",      from:"<peerId>", data }
{ t:"error",       code, message } / { t:"pong", at }
```

规则：

- 房间码 6 位，字符集 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（去掉 0/O/1/I/L）。
- 最多 2 名棋手；第 3 个 `want:"play"` 会收到 `error code=room_full`，改用 `spectate` 可进。
- **房主离开 = 房间解散**，其余成员收到 `room.closed`（对局本来也无法继续）。
- `signal` 只允许房间内互发；`data` 原样透传，服务端不解析。
- 单帧上限 128 KB，令牌桶限流 20 条/秒，心跳 25 秒，房间空闲 30 分钟回收。

## 本地验证

```bash
node verify-server.mjs
```

会用真实 WebSocket 客户端跑完：ICE 下发、建房、玩家加入、座位已满、改观战、
信令透传、房间列表、`/health`、房主离开解散、非法 JSON 与不存在房间的处理。

## 部署（**待你审查后再执行**）

### 1. 信令服务

```bash
# 建议用 systemd 常驻
Environment=PORT=8787
Environment=STUN_URL=stun:你的域名:3478
ExecStart=/usr/bin/node /opt/yijian/server.mjs
```

### 2. TLS 反代（**必须**）

安卓端页面是 `https://localhost`、桌面端是 `http://127.0.0.1`，**都是安全上下文**。
从安全上下文发起 `ws://` 会被浏览器按混合内容直接拦掉，所以必须 `wss://`。

Caddy 两行搞定（自动签证书）：

```
yijian.example.com {
    reverse_proxy /ws* 127.0.0.1:8787
    reverse_proxy /health 127.0.0.1:8787
}
```

客户端连 `wss://yijian.example.com/ws`。

### 3. STUN / TURN（coturn）

见同目录 `coturn.conf`。3.0 只需要它的 STUN：

```bash
turnserver -c coturn.conf
```

### 4. 放行端口

| 端口 | 用途 |
|---|---|
| `443/tcp` | wss（Caddy） |
| `3478/udp`+`3478/tcp` | STUN |
| `49160–49200/udp` | TURN 中继（3.0 可暂不开放） |

### 5. 部署前检查

- `curl https://你的域名/health` 返回 `{"ok":true,…}`；
- `STUN_URL` 已设置（否则公网连不上，等于白搭）；
- 证书有效（`wss` 不能被浏览器拦）；
- 若主机在中国大陆，域名需 **ICP 备案**；后续做账号注册还要考虑实名要求。

## 已知限制（3.0）

- **没有 TURN**：家用宽带之间多数能直连；两端都在手机流量上（国内运营商 CGNAT）
  失败率明显偏高；企业网/校园网经常不通。接口已留，3.1 加 TURN 只改服务端。
- 服务端不存棋局，重启会让在线房间失效（客户端重连重建即可）。
- 房间无密码、无账号，靠房间码的随机性防误入。
