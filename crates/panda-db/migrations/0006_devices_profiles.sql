-- TVs as first-class devices, each with the household profiles added to it.
CREATE TABLE devices (
    id            INTEGER PRIMARY KEY,
    token_hash    TEXT NOT NULL UNIQUE,  -- SHA-256 of the device credential, never the credential
    name          TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
);

-- People who added themselves to a device (via a code approved on their phone).
CREATE TABLE device_profiles (
    device_id  INTEGER NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    added_at   INTEGER NOT NULL,
    PRIMARY KEY (device_id, user_id)
);

-- Optional profile PIN for shared TVs (Argon2id PHC string, like passwords).
ALTER TABLE users ADD COLUMN pin_hash TEXT;

-- The device a session belongs to; removing the device signs all its profiles out.
ALTER TABLE sessions ADD COLUMN device_id INTEGER REFERENCES devices (id) ON DELETE CASCADE;

-- Codes started by an already-paired device add a profile to that device.
ALTER TABLE device_codes ADD COLUMN device_id INTEGER REFERENCES devices (id) ON DELETE CASCADE;
