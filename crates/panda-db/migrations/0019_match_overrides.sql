-- Matches fixed by hand, remembered by the (normalized) file/folder name, so a new file for the
-- same title (a Radarr/Sonarr upgrade, a renamed folder) gets the same match instead of being
-- searched again (and maybe mis-matched again).
CREATE TABLE match_overrides (
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    name TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (kind, name)
);
