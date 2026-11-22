#!/bin/bash
# Double-click to remove Panda (installed from Panda.pkg). Your settings, accounts and library
# stay in ~/Library/Application Support/Panda unless you choose to delete them.
set -uo pipefail
label="local.panda.server"
data="$HOME/Library/Application Support/Panda"

echo "This removes Panda from this Mac. Your password is needed to delete it from /Applications."
launchctl bootout "gui/$UID/$label" 2>/dev/null
sudo rm -f "/Library/LaunchAgents/$label.plist" || exit 1
sudo pkgutil --forget local.panda.pkg >/dev/null 2>&1
cd / && sudo rm -rf /Applications/Panda
echo "Panda is removed."
echo
read -r -p "Also delete your Panda accounts, settings and watch history in $data? [y/N] " answer
if [[ "$answer" == [yY]* ]]; then
  rm -rf "$data" "$HOME/Library/Caches/Panda" "$HOME/Library/Logs/Panda"
  echo "Deleted Panda's data."
else
  echo "Kept your data: installing Panda again picks it up."
fi
echo "You can close this window."
