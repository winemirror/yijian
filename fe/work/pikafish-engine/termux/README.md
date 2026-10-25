# Termux autostart

Install `termux-services` and the matching `Termux:Boot` add-on from the same
APK source used for Termux.

Deployment layout:

- `$PREFIX/var/service/frpc/run`
- `$PREFIX/var/service/yijian-pikafish/run`
- `$HOME/.termux/boot/start-services`

The boot script starts the runit daemon, takes a wake lock, and raises SSH and
FRP. The Pikafish relay is intentionally not started after moving compute to
the home server.

To stop and permanently disable the old phone relay:

```sh
sh stop-services
```

This lowers `yijian-pikafish` and leaves a runit `down` marker so a manual
`service-daemon start` cannot raise it again. The Termux:Boot script also no
longer starts that service.
