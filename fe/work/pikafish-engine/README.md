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
