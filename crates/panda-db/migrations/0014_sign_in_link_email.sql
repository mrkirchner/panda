-- A sign-in link carries the email it was sent to (it becomes the profile's sign-in email).
-- Links are short-lived and none could have been made before this, so the table starts over.
DROP TABLE sign_in_links;
CREATE TABLE sign_in_links (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
