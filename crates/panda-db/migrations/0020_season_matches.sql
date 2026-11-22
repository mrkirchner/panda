-- A season of a show folder matched by hand to another TMDB show's season. Sonarr (TVDB) keeps
-- anthologies as one show with a season per story (Monster: S2 Menendez, S3 Ed Gein), while
-- TMDB lists each story as its own show; this maps one onto the other. Keyed by the folder's
-- normalized name, like match_overrides, so new episodes of that season follow.
CREATE TABLE season_matches (
    folder TEXT NOT NULL,
    season INTEGER NOT NULL,
    tmdb_id INTEGER NOT NULL,
    tmdb_season INTEGER NOT NULL,
    -- That show's name and artwork (image cache keys), shown for the season.
    title TEXT NOT NULL,
    poster TEXT,
    backdrop TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (folder, season)
);
