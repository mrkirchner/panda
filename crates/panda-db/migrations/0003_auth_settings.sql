-- Accounts. No public sign-up: the first admin comes from the setup wizard, everyone else
-- from an admin-issued invite.
CREATE TABLE users (
    id             INTEGER PRIMARY KEY,
    username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash  TEXT NOT NULL,   -- Argon2id PHC string. Never a plaintext password.
    role           TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    disabled       INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,  -- unix seconds
    last_login_at  INTEGER
);

-- Browser sessions (cookie) and device sessions (TV bearer token).
CREATE TABLE sessions (
    id            INTEGER PRIMARY KEY,
    token_hash    TEXT NOT NULL UNIQUE,  -- SHA-256 of the token. The token itself is never stored.
    user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('browser', 'device')),
    name          TEXT,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

CREATE TABLE invites (
    id          INTEGER PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,  -- SHA-256 of the invite code. Shown once at creation.
    role        TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    note        TEXT,
    created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
    used_at     INTEGER
);

-- TV sign-in (OAuth device-flow style): the TV polls with device_code, a signed-in person
-- approves user_code on their phone.
CREATE TABLE device_codes (
    device_code_hash  TEXT PRIMARY KEY,
    user_code         TEXT NOT NULL UNIQUE,
    device_name       TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    approved_by       INTEGER REFERENCES users (id) ON DELETE CASCADE,
    approved_at       INTEGER
);

-- Runtime settings edited in the admin UI. Secret values are XChaCha20-Poly1305 ciphertext
-- (encrypted = 1) under data/secret.key, which is never stored in the database.
CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    encrypted   INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
);

-- Library access for non-admin users. No rows for a user means every library.
CREATE TABLE user_libraries (
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    library_id  INTEGER NOT NULL REFERENCES libraries (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, library_id)
);
