CREATE TABLE libraries (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL,
    kind  TEXT NOT NULL CHECK (kind IN ('movies', 'shows')),
    path  TEXT NOT NULL UNIQUE
);

CREATE TABLE items (
    id             INTEGER PRIMARY KEY,
    library_id     INTEGER NOT NULL REFERENCES libraries (id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('movie', 'episode')),
    title          TEXT NOT NULL,
    year           INTEGER,
    series         TEXT,
    season         INTEGER,
    episode        INTEGER,
    path           TEXT NOT NULL UNIQUE,
    size_bytes     INTEGER NOT NULL,
    mtime          INTEGER NOT NULL,
    -- Bumped on every scan. Rows left behind with an older value were deleted from disk.
    scan_gen       INTEGER NOT NULL,
    -- Filled after ffprobe. Cleared when size or mtime changes.
    duration_secs  REAL,
    video_codec    TEXT,
    width          INTEGER,
    height         INTEGER,
    dynamic_range  TEXT,
    probe_json     TEXT,
    added_at       TEXT NOT NULL
);

CREATE INDEX items_library ON items (library_id, kind);
CREATE INDEX items_series ON items (series, season, episode) WHERE kind = 'episode';

CREATE TABLE requests (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    title       TEXT NOT NULL,
    year        INTEGER,
    tmdb_id     INTEGER,
    tvdb_id     INTEGER,
    status      TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'available', 'failed')),
    error       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX requests_movie ON requests (tmdb_id) WHERE kind = 'movie';
CREATE UNIQUE INDEX requests_series ON requests (tvdb_id) WHERE kind = 'series';
