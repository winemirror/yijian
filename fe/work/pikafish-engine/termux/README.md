# Termux autostart

Install `termux-services` and the matching `Termux:Boot` add-on from the same
APK source used for Termux.

Deployment layout:

- `$PREFIX/var/service/frpc/run`
- `$PREFIX/var/service/yijian-pikafish/run`
- `$HOME/.termux/boot/start-services`

The boot script starts the runit daemon, takes a wake lock, and raises the SSH,
FRP and Pikafish relay services.
