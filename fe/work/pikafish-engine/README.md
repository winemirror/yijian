# YiJian Pikafish relay service

This service runs Pikafish on the Android/Termux compute node and joins the
existing YiJian signalling server as a private room host. The signalling server
continues to relay opaque messages only; it never executes Pikafish.

Environment variables:

- `PIKAFISH_BIN`: engine binary path.
- `PIKAFISH_SIGNAL_URL`: relay WebSocket URL.
- `PIKAFISH_ROOM`: fixed six-character room code.
- `PIKAFISH_THREADS`: engine threads.
- `PIKAFISH_HASH`: transposition table size in MiB.

Run:

```sh
node engine-service.mjs
```

## Home server deployment

The home-server package uses a dedicated Node 24 runtime and the official
Linux x86-64 Pikafish build. The service files are under `deploy/`:

- `install-server.sh`: installs the runtime, engine, NNUE and systemd unit.
- `yijian-pikafish.service`: runs as `yijian-pikafish`, joins room `PKAFST`,
  uses 8 threads and a 1 GiB transposition table, and restarts on failure.

The installer expects its payload in `/root/yijian-pikafish-deploy`:

```text
node.tar.xz
engine-service.mjs
Pikafish-Linux-x86-64-universal
pikafish.nnue
Copying.txt
NNUE-License.md
yijian-pikafish.service
```

Install and start:

```sh
sh /root/yijian-pikafish-deploy/install-server.sh
systemctl start yijian-pikafish.service
systemctl status yijian-pikafish.service
```

Verify the live relay from the development workstation:

```powershell
node work\pikafish-engine\verify-relay.mjs
```
