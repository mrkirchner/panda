#!/bin/sh
# After the panda package is installed or upgraded (.deb: `configure [old version]`; .rpm: 1 on a
# first install, 2 on an upgrade). Never touches what's in /var/lib/panda: an upgrade keeps every
# setting, account and library. The server backs up its database before applying migrations.
set -e

case "$1" in
  configure) [ -z "$2" ] && fresh=1 || fresh=0 ;;  # deb
  1) fresh=1 ;;                                    # rpm install
  [0-9]*) fresh=0 ;;                               # rpm upgrade
  *) exit 0 ;;                                     # deb abort-*: nothing to do
esac

data=/var/lib/panda
cache=/var/cache/panda

if ! getent group panda >/dev/null; then
  groupadd --system panda
fi
if ! getent passwd panda >/dev/null; then
  nologin=$(command -v nologin || echo /bin/false)
  useradd --system --gid panda --home-dir "$data" --no-create-home --shell "$nologin" \
    --comment "Panda media server" panda
fi
# Hardware encoding needs the GPU device nodes (/dev/dri, owned by these groups).
for g in video render; do
  if getent group "$g" >/dev/null; then usermod -aG "$g" panda; fi
done

mkdir -p "$data" "$cache"
chown panda:panda "$data" "$cache"
chmod 750 "$data"

# Removed earlier (not purged) and now installed again: start it like a first install.
if [ -e "$data/.package-removed" ]; then
  fresh=1
  rm -f "$data/.package-removed"
fi

if [ -d /run/systemd/system ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
  if [ "$fresh" = 1 ]; then
    systemctl enable --now panda.service >/dev/null 2>&1 || true
  else
    systemctl try-restart panda.service >/dev/null 2>&1 || true
  fi
fi

port=8096
ip=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$ip" ] || ip=localhost
if [ "$fresh" = 1 ]; then
  # The server writes the setup link's token on its first start.
  i=0
  while [ ! -f "$data/setup-token" ] && [ $i -lt 15 ] && [ -d /run/systemd/system ]; do
    sleep 1
    i=$((i + 1))
  done
  echo
  if [ -f "$data/setup-token" ]; then
    echo "Panda is running. Create your admin account at:"
    echo "  http://$ip:$port/setup?token=$(cat "$data/setup-token")"
  else
    echo "Panda is installed: http://$ip:$port"
    echo "  (status: systemctl status panda; log: journalctl -u panda)"
  fi
  echo "Settings and database: $data (kept when Panda is upgraded or removed)"
  echo "Panda runs as the 'panda' user: it needs read access to your library folders."
  echo
fi
exit 0
