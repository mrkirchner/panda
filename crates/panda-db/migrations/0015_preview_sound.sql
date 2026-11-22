-- Preview clips on the TV home play quietly with sound; a profile can turn that off.
ALTER TABLE users ADD COLUMN preview_sound INTEGER NOT NULL DEFAULT 1;
