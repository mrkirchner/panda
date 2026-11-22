#!/bin/sh
# Before the panda package is removed (.deb: `remove`; .rpm: 0) or replaced by an upgrade
# (.deb: `upgrade`; .rpm: 1). On an upgrade the server keeps running until postinstall restarts it.
set -e

case "$1" in
  remove | 0)
    if [ -d /run/systemd/system ]; then
      systemctl disable --now panda.service >/dev/null 2>&1 || true
    fi
    # Installed again later: start it again (see postinstall).
    if [ -d /var/lib/panda ]; then touch /var/lib/panda/.package-removed; fi
    ;;
esac
exit 0
