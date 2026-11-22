#!/usr/bin/env bash
# Install (or update) Panda for this user: the program goes to ~/Applications/Panda and starts
# now and at every login. Your settings, database and artwork are kept across updates in
# ~/Library/Application Support/Panda.
#
#   ./install.sh                         listen on port 8096
#   PANDA_BIND=0.0.0.0:9000 ./install.sh another port
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

if [[ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]]; then
  echo "This Panda build is for Apple silicon Macs." >&2
  exit 1
fi

app="$HOME/Applications/Panda"
data="$HOME/Library/Application Support/Panda"
logs="$HOME/Library/Logs/Panda"
label="local.panda.server"
plist="$HOME/Library/LaunchAgents/$label.plist"
bind="${PANDA_BIND:-0.0.0.0:8096}"
port="${bind##*:}"

# Downloaded or AirDropped copies are marked "from the internet"; this copy is yours.
xattr -dr com.apple.quarantine "$here" 2>/dev/null || true

# Stop the running copy before replacing it.
launchctl bootout "gui/$UID/$label" 2>/dev/null || true

echo "Installing Panda $(cat "$here/VERSION") to $app"
rm -rf "$app"
mkdir -p "$app" "$data" "$logs" "$HOME/Library/LaunchAgents"
cp -R "$here/bin" "$here/ffmpeg" "$app/"
cp "$here/uninstall.sh" "$here/VERSION" "$here/README.txt" "$here/panda.example.toml" "$app/"
[[ -f "$data/panda.toml" ]] || cp "$here/panda.example.toml" "$data/panda.example.toml"

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$(xml "$app/bin/panda")</string></array>
  <key>WorkingDirectory</key><string>$(xml "$data")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PANDA_FFMPEG</key><string>$(xml "$app/ffmpeg/ffmpeg")</string>
    <key>PANDA_BIND</key><string>$(xml "$bind")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml "$logs/panda.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$logs/panda.log")</string>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$UID" "$plist"

printf "Starting"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    echo " done."
    echo
    if [[ -f "$data/setup-token" ]]; then
      echo "Create your admin account at:"
      echo "  http://localhost:$port/setup?token=$(cat "$data/setup-token")"
    else
      echo "Panda is running: http://localhost:$port"
    fi
    ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
    [[ -n "$ip" ]] && echo "On your TVs, use this server address: http://$ip:$port"
    echo
    echo "Settings and database: $data"
    echo "Log:                   $logs/panda.log"
    echo "Uninstall:             $app/uninstall.sh"
    exit 0
  fi
  printf "."
  sleep 1
done
echo
echo "Panda didn't start. The end of its log:" >&2
tail -20 "$logs/panda.log" >&2 || true
exit 1
