# Legal

## License

Panda is licensed under the [Apache License 2.0](LICENSE). Use it however you like, for
anything, including commercially. If you use Panda's code to build something, give credit:

- keep the [LICENSE](LICENSE) and [NOTICE](NOTICE) files (or their text) with any copy or
  work based on Panda, which credits the original project, and
- say which files you changed.

The license comes with no warranty. Panda is provided "as is".

## Third-party services

Panda talks to these services only when you set them up, with your own account or key. Their
data comes under their own terms:

- **TMDB.** This product uses the TMDB API but is not endorsed or certified by TMDB.
  [Terms of use](https://www.themoviedb.org/api-terms-of-use).
- **TVmaze.** Episode data from TVmaze, licensed
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
  [API terms](https://www.tvmaze.com/api#licensing).
- **OMDb.** Data from OMDb, licensed
  [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). [Site](https://www.omdbapi.com/).
- **Fanart.tv.** Artwork from Fanart.tv, with your own API key. [Site](https://fanart.tv/).
- **Radarr and Sonarr.** Your own servers ([Radarr](https://radarr.video/),
  [Sonarr](https://sonarr.tv/), both GPL-3.0).

Panda shows each one's credit in the TV app's About screen and the admin UI.

## Third-party software

- **FFmpeg** ([LGPL/GPL](https://ffmpeg.org/legal.html)) is never linked into Panda; Panda runs
  `ffmpeg` and `ffprobe` as separate programs. The macOS packages bundle
  [jellyfin-ffmpeg](https://github.com/jellyfin/jellyfin-ffmpeg)
  ([GPL-3.0](https://github.com/jellyfin/jellyfin-ffmpeg/blob/jellyfin/COPYING.GPLv3),
  [source](https://github.com/jellyfin/jellyfin-ffmpeg)) as its own program under its own license.
- **Fonts** (bundled in `clients/tv/public/fonts`, each with its license file there):
  [Roboto](https://github.com/googlefonts/roboto) ([Apache License 2.0](clients/tv/public/fonts/Roboto-LICENSE.txt))
  and [Noto Sans](https://github.com/notofonts/latin-greek-cyrillic)
  ([SIL Open Font License 1.1](clients/tv/public/fonts/NotoSans-OFL.txt)).
- **Logo:** the wordmark is drawn from [Fredoka](https://github.com/hafontia/Fredoka-One)
  ([SIL Open Font License 1.1](https://openfontlicense.org/open-font-license-official-text/)), as outlines.
- **Libraries:** Rust crates and npm packages, each under its own license (mostly MIT,
  Apache-2.0 and BSD), listed in `Cargo.lock` and each client's lock file. Main ones:
  [SolidJS](https://github.com/solidjs/solid) (MIT),
  [SolidTV](https://github.com/solid-tv/solid) and its [renderer](https://github.com/solid-tv/renderer) (Apache-2.0),
  [shaka-player](https://github.com/shaka-project/shaka-player) (Apache-2.0),
  [NativeScript](https://github.com/NativeScript/NativeScript) (Apache-2.0),
  [Tokio](https://github.com/tokio-rs/tokio) and [axum](https://github.com/tokio-rs/axum) (MIT),
  [SQLx](https://github.com/launchbadge/sqlx) (MIT/Apache-2.0).

## Trademarks

Apple, Apple TV, tvOS, LG, webOS, Samsung, Tizen, Android TV, Netflix, TMDB, Radarr, Sonarr and
other names are trademarks of their owners. Panda is not affiliated with or endorsed by any of
them. The Apache License does not grant rights to the Panda name or logo beyond saying where
your copy came from.
