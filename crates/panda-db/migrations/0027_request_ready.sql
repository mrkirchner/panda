-- A request's title arriving in the library is news for whoever asked: when it arrived, whether
-- their apps have shown it ("ready to watch"), and whether it has been emailed.
ALTER TABLE requests ADD COLUMN ready_at INTEGER;
ALTER TABLE requests ADD COLUMN ready_seen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN ready_emailed INTEGER NOT NULL DEFAULT 0;

-- Requests already in the library before this: nothing to announce.
UPDATE requests
SET ready_at = CAST(strftime('%s', 'now') AS INTEGER), ready_seen = 1, ready_emailed = 1
WHERE listed = 1 OR status = 'available';
