-- Requests belong to the profile that asked (each profile sees its own on the TV), and keep
-- the poster so the TV can show them before the title is in the library.
ALTER TABLE requests ADD COLUMN user_id INTEGER REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE requests ADD COLUMN poster TEXT;

-- Unique per profile instead of per household: two people can each ask for the same title.
-- Older requests have no owner (NULL never collides).
DROP INDEX requests_movie;
DROP INDEX requests_series;
CREATE UNIQUE INDEX requests_movie ON requests (user_id, tmdb_id) WHERE kind = 'movie';
CREATE UNIQUE INDEX requests_series ON requests (user_id, tvdb_id) WHERE kind = 'series';
CREATE INDEX requests_user ON requests (user_id);
