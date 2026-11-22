-- Accounts. An account is a person who signs in plus the profiles they make for their family
-- (up to 8), and the TVs they pair. It is identified by its owner profile: every profile's
-- account_id is its owner's id (the owner's is its own). Deleting the owner deletes the
-- account: its profiles and TVs cascade. Sharing the server = another account; accounts never
-- see each other's profiles.
ALTER TABLE users ADD COLUMN account_id INTEGER REFERENCES users (id) ON DELETE CASCADE;

-- The household becomes the first admin's account...
UPDATE users SET account_id = (SELECT MIN(id) FROM users WHERE household = 1 AND role = 'admin')
WHERE household = 1;
-- ...and every invited person owns an account of their own.
UPDATE users SET account_id = id WHERE account_id IS NULL;

-- A TV belongs to one account: household TVs to the household, any other TV to whoever added
-- themselves to it first.
ALTER TABLE devices ADD COLUMN account_id INTEGER REFERENCES users (id) ON DELETE CASCADE;
UPDATE devices SET account_id = (SELECT MIN(id) FROM users WHERE household = 1 AND role = 'admin')
WHERE household = 1;
UPDATE devices SET account_id = (
    SELECT u.account_id FROM device_profiles p JOIN users u ON u.id = p.user_id
    WHERE p.device_id = devices.id ORDER BY p.added_at LIMIT 1
) WHERE account_id IS NULL;
-- A TV nobody was on can't be used: it pairs again.
DELETE FROM devices WHERE account_id IS NULL;
-- A session on a TV for a profile outside that TV's account ends (that person signs in again).
DELETE FROM sessions WHERE device_id IS NOT NULL AND user_id NOT IN (
    SELECT u.id FROM users u JOIN devices d ON d.id = sessions.device_id WHERE u.account_id = d.account_id
);

-- Replaced by accounts.
DROP TABLE device_profiles;
ALTER TABLE users DROP COLUMN household;
ALTER TABLE devices DROP COLUMN household;
ALTER TABLE invites DROP COLUMN household;

CREATE INDEX users_account ON users (account_id);
CREATE INDEX devices_account ON devices (account_id);
