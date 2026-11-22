-- One row per matched TMDB movie or series. Several items can share one row
-- (4K + HD copies of a movie, every episode of a series).
CREATE TABLE metadata (
    id              INTEGER PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    tmdb_id         INTEGER NOT NULL,
    title           TEXT NOT NULL,
    original_title  TEXT,
    year            INTEGER,
    overview        TEXT,
    tagline         TEXT,
    genres          TEXT,     -- comma-separated, display only
    runtime_mins    INTEGER,
    rating          REAL,
    poster          TEXT,     -- image cache key, served at /api/images/{key}
    backdrop        TEXT,
    fetched_at      TEXT NOT NULL,
    UNIQUE (kind, tmdb_id)
);

CREATE TABLE episode_metadata (
    metadata_id  INTEGER NOT NULL REFERENCES metadata (id) ON DELETE CASCADE,
    season       INTEGER NOT NULL,
    episode      INTEGER NOT NULL,
    name         TEXT,
    overview     TEXT,
    air_date     TEXT,
    still        TEXT,
    PRIMARY KEY (metadata_id, season, episode)
);

ALTER TABLE items ADD COLUMN metadata_id INTEGER REFERENCES metadata (id) ON DELETE SET NULL;
-- When matching last failed, so unmatched files aren't re-searched on every scan.
ALTER TABLE items ADD COLUMN match_attempted_at TEXT;

CREATE INDEX items_metadata ON items (metadata_id);
CREATE INDEX items_unmatched ON items (kind) WHERE metadata_id IS NULL;
