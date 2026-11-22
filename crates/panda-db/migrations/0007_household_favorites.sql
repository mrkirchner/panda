-- Household members (family) vs invited people (friends).
ALTER TABLE users ADD COLUMN household INTEGER NOT NULL DEFAULT 0;
-- Family profile without a password (e.g. kids): usable only by switching to it on a household
-- TV. Its password_hash is the hash of a discarded random secret, so it can never match.
ALTER TABLE users ADD COLUMN managed INTEGER NOT NULL DEFAULT 0;
-- Admins are household members.
UPDATE users SET household = 1 WHERE role = 'admin';

-- Invites say which kind of account they create.
ALTER TABLE invites ADD COLUMN household INTEGER NOT NULL DEFAULT 0;

-- A household TV (paired by a household member) offers every household profile and never lists
-- invited people. Other TVs list only the people who added themselves.
ALTER TABLE devices ADD COLUMN household INTEGER NOT NULL DEFAULT 0;
UPDATE devices SET household = 1 WHERE id IN (
    SELECT p.device_id FROM device_profiles p JOIN users u ON u.id = p.user_id WHERE u.household = 1
);

-- My List, per profile. `ref` is a title id (m123 / i45) or a series name.
CREATE TABLE favorites (
    user_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind      TEXT NOT NULL CHECK (kind IN ('title', 'series')),
    ref       TEXT NOT NULL,
    added_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, ref)
);
