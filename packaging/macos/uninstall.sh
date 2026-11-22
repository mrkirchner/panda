#!/usr/bin/env bash
# Remove Panda. Your settings, database and artwork stay unless you pass --delete-data.
#
#   ./uninstall.sh                 remove the program and stop it starting at login
#   ./uninstall.sh --delete-data   also delete accounts, settings, watch history and caches
set -euo pipefail

app="$HOME/Applications/Panda"
data="$HOME/Library/Application Support/Panda"
cache="$HOME/Library/Caches/Panda"
logs="$HOME/Library/Logs/Panda"
label="local.panda.server"
plist="$HOME/Library/LaunchAgents/$label.plist"

launchctl bootout "gui/$UID/$label" 2>/dev/null || true
rm -f "$plist"
rm -rf "$app"
echo "Panda is removed and won't start at login."

if [[ "${1:-}" == "--delete-data" ]]; then
  read -r -p "Delete all Panda accounts, settings and watch history in $data? [y/N] " answer
  if [[ "$answer" == [yY]* ]]; then
    rm -rf "$data" "$cache" "$logs"
    echo "Deleted Panda's data and caches."
  else
    echo "Kept your data."
  fi
else
  echo "Your settings and database are still in $data (reinstalling picks them up)."
fi
