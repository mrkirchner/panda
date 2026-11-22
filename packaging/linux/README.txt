Panda for Linux
===============

On Debian/Ubuntu or Fedora/RHEL, use the .deb or .rpm instead: they do all of this for you,
and upgrade in place.

This folder holds:
  panda           the server (static; the admin UI and the TV app for browsers are built in)
  ffmpeg/         jellyfin-ffmpeg (ffmpeg + ffprobe), used for playback, previews and artwork
  panda.service   a systemd unit for the layout below

Try it out (settings and database go to ~/.local/share/panda):
  PANDA_FFMPEG=$PWD/ffmpeg/ffmpeg ./panda
  then open http://localhost:8096 (the setup link is printed in the log)

Install as a service:
  sudo install -Dm755 panda /usr/bin/panda
  sudo install -Dm755 -t /usr/lib/panda/ffmpeg ffmpeg/ffmpeg ffmpeg/ffprobe
  sudo install -Dm644 panda.service /usr/lib/systemd/system/panda.service
  sudo useradd --system --user-group --home-dir /var/lib/panda --shell /usr/sbin/nologin panda
  sudo usermod -aG video,render panda          # hardware encoding, where those groups exist
  sudo install -d -o panda -g panda /var/lib/panda /var/cache/panda
  sudo systemctl daemon-reload && sudo systemctl enable --now panda
  sudo cat /var/lib/panda/setup-token          # for http://<this machine>:8096/setup?token=...

Upgrade: replace /usr/bin/panda (and ffmpeg) and `sudo systemctl restart panda`. Your settings,
accounts and libraries in /var/lib/panda are kept; the database is backed up to
/var/lib/panda/backups before an upgrade changes it.

Remove: sudo systemctl disable --now panda, then delete the files above. Your data is in
/var/lib/panda (delete it too to start over) and caches in /var/cache/panda.
