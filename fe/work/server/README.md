# 弈鉴 · 信令与房间服务（3.2）

## 它做什么

| 做 | 不做 |
|---|---|
| 房间登记（建房 / 房间码 / 公开房间列表） | **不碰棋局数据**（走 WebRTC DataChannel） |
| 信令中转（转发 `offer/answer/ice`，不解析内容） | 不存棋局、不存账号、不写数据库 |
| 下发 ICE 配置（STUN + coturn REST 临时凭证的 TURN） | 不做内容审核 |
| 按请求现场签发 TURN 凭证（HMAC-SHA1，分钟级有效） | 不存凭证、不存账号 |

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
| `TURN_URL` | 空 | 中继地址，**逗号分隔可给多条**。例 `turn:1.2.3.4:3478?transport=udp,turn:1.2.3.4:3478?transport=tcp` |
| `TURN_SECRET` | 空 | 必须与 coturn 的 `static-auth-secret` 一致；**留空则不下发 TURN**（只剩直连） |
| `TURN_TTL` | `600` | 临时凭证有效期（秒），会夹到 60 ~ 86400 |
| `MAX_ROOMS` | `500` | 同时存在的房间上限 |
| `ROOM_TTL_MS` | 1800000 | 房间空闲多久后回收 |

## 协议

客户端 → 服务端

```
{ t:"hello",       proto:1, name }
{ t:"ice" }                                    // 需要时重新取 ICE 配置
{ t:"room.create", name, visibility:"public"|"private", password?, preferredId? }
{ t:"room.list" }
{ t:"room.join",   roomId, want:"play"|"spectate", password? }
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
{ t:"room.list",   rooms:[{id,name,players,spectators,private,locked}] }
{ t:"peer.join",   peer } / { t:"peer.leave", peerId }
{ t:"signal",      from:"<peerId>", data }
{ t:"error",       code, message } / { t:"pong", at }
```

规则：

- 房间码 6 位，字符集 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（去掉 0/O/1/I/L）。
- `room.create` 可以带 `preferredId`：格式合法且当前空闲时直接采用，
  否则退回随机生成。客户端用它让同一主机默认复用固定房间码。
- 房间可以带密码：`room.create` 传 `password` 即为上锁房间，服务端只存
  `sha256("<房间码>\n<密码>")`（房间码当盐，不存明文）；`room.join` 密码不对回
  `error code=bad_password`。`room.list` 用 `locked` 标记上锁房间（不下发任何密码信息）。
- 最多 2 名棋手；第 3 个 `want:"play"` 会收到 `error code=room_full`，改用 `spectate` 可进。
- **房主离开 = 房间解散**，其余成员收到 `room.closed`（对局本来也无法继续）。
- `signal` 只允许房间内互发；`data` 原样透传，服务端不解析。
- 单帧上限 128 KB，令牌桶限流 20 条/秒，心跳 25 秒，房间空闲 30 分钟回收。

## 本地验证

```bash
node verify-server.mjs
```

会用真实 WebSocket 客户端跑完：ICE 下发、建房、玩家加入、座位已满、改观战、
信令透传、房间列表、`/health`、房主离开解散、非法 JSON 与不存在房间的处理，
以及 TURN 凭证的 HMAC 校验、有效期、多 URL 合并与"缺 secret 时不下发"。

## 部署

一条命令（在服务器上，和 `server.mjs` 同目录）：

```bash
sudo STUN_HOST=stun:你的IP:3478 \
     PUBLIC_IP=你的公网IP \
     TURN_SECRET=与coturn一致的随机串 \
     INSTALL_COTURN=1 \
     bash deploy.sh
```

`deploy.sh` 会拷 `server.mjs`、渲染 `/etc/turnserver.conf`（备份原文件）、重启 coturn、
写 systemd 单元（含 TURN 环境变量）并自检。不装软件包、不改防火墙。

### 1. 信令服务

```bash
# 建议用 systemd 常驻
Environment=PORT=8787
Environment=STUN_URL=stun:你的域名:3478
Environment=TURN_URL=turn:你的IP:3478?transport=udp,turn:你的IP:3478?transport=tcp
Environment=TURN_SECRET=与coturn的static-auth-secret一致
Environment=TURN_TTL=600
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

见同目录 `coturn.conf`（三个占位符由 `deploy.sh` 渲染）：

```bash
turnserver -c /etc/turnserver.conf
```

要点：

- `use-auth-secret` + `static-auth-secret` 打开 REST 临时凭证；
  信令服务端用**同一个 secret** 现场算 `credential = base64(HMAC-SHA1(secret, username))`，
  `username` 形如 `<过期unix时间戳>:<随机串>`。静态密码从不下发、也不落库。
- `external-ip` 必须写公网 IP（机器在 NAT 后面时否则返回的地址是错的）。
- `min-port` / `max-port` 是每路中继占用的端口，要同步在防火墙放行。

自己验一次中继是否真的能分配（用服务端同款算法造一个凭证）：

```bash
SECRET=你的secret
USER=$(( $(date +%s) + 600 )):probe
PASS=$(printf %s "$USER" | openssl dgst -sha1 -hmac "$SECRET" -binary | base64 -w0)
turnutils_uclient -u "$USER" -w "$PASS" -p 3478 -y -v 127.0.0.1 | grep -i relay
# 期望看到：IPv4. Received relay addr: <公网IP>:491xx
```

### 4. 放行端口

| 端口 | 用途 |
|---|---|
| `443/tcp` | wss（Caddy） |
| `3478/udp`+`3478/tcp` | STUN |
| `49160–49200/udp` | TURN 中继（`coturn.conf` 里的 min-port / max-port） |

```bash
ufw allow 3478/udp && ufw allow 3478/tcp
ufw allow 49160:49200/udp
```

### 5. 部署前检查

- `curl https://你的域名/health` 返回 `{"ok":true,…}`；
- `STUN_URL` 已设置（否则公网连不上，等于白搭）；
- 启用了 TURN 时，`/health` 里 `turn` 应当 ≥ 1（几条 TURN_URL 就是几）；
- 证书有效（`wss` 不能被浏览器拦）；
- 若主机在中国大陆，域名需 **ICP 备案**；后续做账号注册还要考虑实名要求。

## 已知限制（3.4）

- TURN 已启用，但中继带宽就是这台 VPS 的带宽：两端都在 CGNAT 后面时会全程走中继，
  流量和延迟都比直连差。家用宽带之间多数仍会直连成功。
- 中继端口段按 `coturn.conf` 的 min-port/max-port 限制并发路数，
  人多时要么扩端口段，要么单独加一台 TURN。
- 服务端不存棋局，重启会让在线房间失效（房间码与密码一并失效，客户端重连重建即可）。
- 房间密码只用于挡误入：服务端不限制试错次数，也不做账号体系；房间码的随机性仍是主要防线。
