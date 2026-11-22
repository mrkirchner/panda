-- What each metadata provider (TMDB, TVmaze, OMDb) said about a title or one of its episodes,
-- kept apart: the shown value (metadata.overview, episode_metadata name/overview/air_date) is
-- picked from these by the admin's provider order, so changing the order needs no new lookups.
-- season/episode -1: the title itself. Fields: overview, name, air_date, rating.<source>.
CREATE TABLE provider_values (
    metadata_id INTEGER NOT NULL REFERENCES metadata (id) ON DELETE CASCADE,
    provider    TEXT NOT NULL,
    season      INTEGER NOT NULL DEFAULT -1,
    episode     INTEGER NOT NULL DEFAULT -1,
    field       TEXT NOT NULL,
    value       TEXT NOT NULL,
    PRIMARY KEY (metadata_id, season, episode, field, provider)
);

-- When a title was last looked up at an extra provider (found or not), so lookups repeat
-- monthly rather than on every scan.
CREATE TABLE provider_fetches (
    metadata_id INTEGER NOT NULL REFERENCES metadata (id) ON DELETE CASCADE,
    provider    TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL,
    PRIMARY KEY (metadata_id, provider)
);

-- What's shown today came from TMDB (TVmaze only filled gaps, and only for a day): keep it as
-- TMDB's answer.
INSERT INTO provider_values (metadata_id, provider, field, value)
    SELECT id, 'tmdb', 'overview', overview FROM metadata WHERE overview IS NOT NULL AND overview <> '';
INSERT INTO provider_values (metadata_id, provider, season, episode, field, value)
    SELECT metadata_id, 'tmdb', season, episode, 'name', name FROM episode_metadata
    WHERE name IS NOT NULL AND name <> '';
INSERT INTO provider_values (metadata_id, provider, season, episode, field, value)
    SELECT metadata_id, 'tmdb', season, episode, 'overview', overview FROM episode_metadata
    WHERE overview IS NOT NULL AND overview <> '';
INSERT INTO provider_values (metadata_id, provider, season, episode, field, value)
    SELECT metadata_id, 'tmdb', season, episode, 'air_date', air_date FROM episode_metadata
    WHERE air_date IS NOT NULL AND air_date <> '';
