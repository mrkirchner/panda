-- A title's details page (cast and crew, studios, age rating...), fetched from TMDB the first
-- time someone opens it and kept here. `details` is the JSON the API returns.
CREATE TABLE title_details (
    kind        TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    tmdb_id     INTEGER NOT NULL,
    details     TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL,  -- unix seconds
    PRIMARY KEY (kind, tmdb_id)
);
