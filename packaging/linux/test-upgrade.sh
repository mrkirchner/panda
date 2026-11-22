#!/usr/bin/env bash
# The .deb on a real system (systemd, sudo): an upgrade keeps everything, remove keeps the data,
# installing again picks it up, purge deletes it. Run by the release workflow on Ubuntu.
#
#   packaging/linux/test-upgrade.sh <new.deb> [<old.deb>]
#
# Without an older package (the first release), the new one is installed twice instead.
set -euo pipefail

new="$(realpath "${1:?usage: test-upgrade.sh <new.deb> [<old.deb>]}")"
old="$(realpath "${2:-$1}")"
base=http://127.0.0.1:8096
data=/var/lib/panda
password="upgrade-test-$RANDOM-$RANDOM"

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; sudo journalctl -u panda --no-pager -n 60 >&2 || true; exit 1; }
wait_up() {
  for _ in $(seq 1 30); do
    if curl -fsS "$base/health" 2>/dev/null | grep -qx ok; then return 0; fi
    sleep 1
  done
  fail "Panda didn't answer on $base/health"
}
login() {
  curl -fsS -o /dev/null -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$password\"}" "$base/api/auth/login" \
    || fail "signing in as the admin made before the upgrade"
}
install() { sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "$1" >/dev/null; }

step "install $(basename "$old")"
install "$old"
wait_up
[[ -f $data/setup-token ]] || fail "no setup token on first start"
token=$(sudo cat $data/setup-token)
curl -fsS -o /dev/null -H 'Content-Type: application/json' \
  -d "{\"token\":\"$token\",\"username\":\"admin\",\"password\":\"$password\"}" "$base/api/setup" \
  || fail "creating the admin account"
login
key=$(sudo sha256sum $data/secret.key)
sudo -u panda touch $data/kept-marker

step "upgrade to $(basename "$new")"
# Same version twice (no older release yet): dpkg reinstalls it, which runs the same scripts.
sudo DEBIAN_FRONTEND=noninteractive dpkg -i "$new" >/dev/null
wait_up
[[ "$(sudo sha256sum $data/secret.key)" == "$key" ]] || fail "secret.key changed"
sudo test -f $data/kept-marker || fail "files in $data were lost"
sudo test -f $data/panda.db || fail "database missing"
curl -fsS "$base/api/setup" | grep -q '"needs_setup":false' || fail "setup asked for again"
login
systemctl is-enabled --quiet panda || fail "service not enabled after the upgrade"
panda --version

step "remove keeps the data"
sudo DEBIAN_FRONTEND=noninteractive apt-get remove -y panda >/dev/null
! systemctl is-active --quiet panda || fail "still running after remove"
[[ ! -e /usr/bin/panda ]] || fail "program still installed"
sudo test -f $data/panda.db || fail "remove deleted the database"

step "installing again picks it up"
install "$new"
wait_up
systemctl is-enabled --quiet panda || fail "not enabled after installing again"
login

step "purge deletes it"
sudo DEBIAN_FRONTEND=noninteractive apt-get purge -y panda >/dev/null
[[ ! -e $data ]] || fail "$data still there after purge"
! getent passwd panda >/dev/null || fail "panda user still there after purge"

echo
echo "OK: upgrade, remove, reinstall and purge behave"
