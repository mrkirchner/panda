-- Signed media/image/Top Shelf URLs carry this; bumping it (password change, sign out
-- everywhere, disable) makes every URL signed before it stop working.
ALTER TABLE users ADD COLUMN token_gen INTEGER NOT NULL DEFAULT 0;
