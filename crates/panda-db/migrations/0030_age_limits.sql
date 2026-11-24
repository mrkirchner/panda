-- Age limits per profile. Each title's age rating from TMDB for the server's region (else the
-- US): as shown ("PG-13") and as the youngest age it's for, looked up in the background
-- (`rated_region`: the region it was looked up for, NULL until then; `rated_at` to refresh).
ALTER TABLE metadata ADD COLUMN certification TEXT;
ALTER TABLE metadata ADD COLUMN rating_age INTEGER;
ALTER TABLE metadata ADD COLUMN rated_region TEXT;
ALTER TABLE metadata ADD COLUMN rated_at INTEGER;

-- The oldest rating this profile may watch (NULL: no limit). Set by the account's owner or an
-- admin; titles without a rating are hidden from a limited profile.
ALTER TABLE users ADD COLUMN max_age INTEGER;
-- The account's parental PIN (on its owner's row; Argon2id like profile PINs): asked only to
-- change age limits and to leave a limited profile for a less limited one on a device.
ALTER TABLE users ADD COLUMN parental_pin_hash TEXT;
-- The profile a device was last switched to, kept past sign-outs and expiry: leaving a limited
-- one needs the parental PIN even after its session is gone.
ALTER TABLE devices ADD COLUMN profile_id INTEGER REFERENCES users (id) ON DELETE SET NULL;

-- A title's rating is shown (who sees it): the catalog rebuilds when it changes.
CREATE TRIGGER catalog_metadata_rating AFTER UPDATE OF rating_age ON metadata
WHEN OLD.rating_age IS NOT NEW.rating_age
BEGIN UPDATE catalog_version SET version = version + 1 WHERE id = 1; END;
