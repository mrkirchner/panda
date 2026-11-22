Panda for Mac (Apple silicon)

Install or update:
  ./install.sh
It copies Panda to ~/Applications/Panda, starts it now and at every login, and prints the link
to create your admin account. Running it again with a newer copy updates Panda and keeps your
settings.

If macOS says the files can't be opened (copied with AirDrop or a browser), run this first in
this folder:
  xattr -dr com.apple.quarantine .

Where things are:
  Settings, database, artwork  ~/Library/Application Support/Panda  (put panda.toml here)
  Previews, transcodes         ~/Library/Caches/Panda  (safe to delete)
  Log                          ~/Library/Logs/Panda/panda.log

Moving from another Mac: stop Panda on both, then copy the whole
~/Library/Application Support/Panda folder (panda.db and secret.key belong together).

Uninstall:
  ~/Applications/Panda/uninstall.sh                 (keeps your data)
  ~/Applications/Panda/uninstall.sh --delete-data   (removes everything)

FFmpeg: this package includes jellyfin-ffmpeg (GPL). Source:
  https://github.com/jellyfin/jellyfin-ffmpeg
