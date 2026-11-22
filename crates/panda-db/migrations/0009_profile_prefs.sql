-- Per-profile settings, edited from the TV: a display name (the username stays the sign-in
-- name), the app language, and an avatar picture from the bundled set. NULL = default.
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN language TEXT;
ALTER TABLE users ADD COLUMN avatar TEXT;
