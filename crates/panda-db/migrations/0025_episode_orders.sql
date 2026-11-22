-- A show folder numbered by one of TMDB's other episode orders (DVD, absolute, ...: an "episode
-- group") rather than TMDB's default seasons. Keyed like season_matches, by the folder's
-- normalized name, so it sticks across rescans and re-matches.
CREATE TABLE episode_orders (
    folder   TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    name     TEXT NOT NULL,
    set_at   INTEGER NOT NULL
);
