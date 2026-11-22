-- A profile can be given its own sign-in: an email (or its username) and a password the person
-- chooses through a one-time link. Emails are unique across the server.
ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE;
CREATE UNIQUE INDEX users_email ON users (email) WHERE email IS NOT NULL;

-- One-time links ("let Sam sign in"). Only the hash of the code is stored, like invites.
CREATE TABLE sign_in_links (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
