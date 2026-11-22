-- Per-user playback progress. Keyed by what was watched, not by file: movies by TMDB id
-- (`m603`), episodes by show + episode (`s1396e2x5`), unmatched files by item (`i42`). So
-- progress carries across versions (4K/HD) and survives Radarr/Sonarr upgrading a file.
CREATE TABLE watch_state (
    user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    watch_key       TEXT NOT NULL,
    item_id         INTEGER NOT NULL,  -- last file played (no FK: files come and go)
    position_secs   REAL NOT NULL DEFAULT 0,
    duration_secs   REAL,
    finished        INTEGER NOT NULL DEFAULT 0,
    play_count      INTEGER NOT NULL DEFAULT 0,
    last_played_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, watch_key)
);
CREATE INDEX watch_state_recent ON watch_state (user_id, last_played_at DESC);
