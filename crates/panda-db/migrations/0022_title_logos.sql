-- A title's logo (its name as transparent artwork) for Home's feature cards, fetched from TMDB
-- the first time a title is featured. NULL logo: TMDB has none (asked again after a while).
CREATE TABLE title_logos (
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    tmdb_id INTEGER NOT NULL,
    logo TEXT,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (kind, tmdb_id)
);
