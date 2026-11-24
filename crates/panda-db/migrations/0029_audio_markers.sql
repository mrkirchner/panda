-- Intros and credits found in an episode's sound (shared with its season's other episodes), for
-- "Skip intro" and "Up next". One row per file once checked (all NULL: nothing found); a file
-- replaced since (another size) is checked again.
CREATE TABLE audio_markers (
    item_id        INTEGER PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
    size_bytes     INTEGER NOT NULL,
    intro_start    REAL,
    intro_end      REAL,
    credits_start  REAL,
    checked_at     INTEGER NOT NULL
);
