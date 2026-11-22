-- A title's ids elsewhere (from TMDB when it's matched), so the extra metadata providers
-- (TVmaze by TVDB id, OMDb by IMDb id) don't each ask TMDB for them again. Display-free: not
-- in the catalog triggers.
ALTER TABLE metadata ADD COLUMN imdb_id TEXT;
ALTER TABLE metadata ADD COLUMN tvdb_id INTEGER;
