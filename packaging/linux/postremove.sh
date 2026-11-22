#!/bin/sh
# After the panda package is removed. Your data stays unless you purge (.deb only:
# `apt purge panda`); with .rpm, delete /var/lib/panda and /var/cache/panda yourself.
set -e

case "$1" in
  purge)
    rm -rf /var/lib/panda /var/cache/panda
    if getent passwd panda >/dev/null; then userdel panda >/dev/null 2>&1 || true; fi
    if getent group panda >/dev/null; then groupdel panda >/dev/null 2>&1 || true; fi
    ;;
  remove)
    echo "Panda is removed. Your settings and database are still in /var/lib/panda"
    echo "(installing Panda again picks them up; 'sudo apt purge panda' deletes them)."
    ;;
  0)
    echo "Panda is removed. Your settings and database are still in /var/lib/panda"
    echo "(installing Panda again picks them up; to delete them:"
    echo "  sudo rm -rf /var/lib/panda /var/cache/panda && sudo userdel panda)."
    ;;
esac
if [ -d /run/systemd/system ]; then systemctl daemon-reload >/dev/null 2>&1 || true; fi
exit 0
