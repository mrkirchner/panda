-- One number that changes whenever what the library catalog shows changes, so the server's
-- in-memory catalog knows to rebuild (crate::catalog), whatever wrote the change. Updates only
-- count when a shown value actually changed: a scan re-touching every row (scan_gen) doesn't.
CREATE TABLE catalog_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
INSERT INTO catalog_version (id, version) VALUES (1, 0);

CREATE TRIGGER catalog_items_insert AFTER INSERT ON items
BEGIN UPDATE catalog_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER catalog_items_delete AFTER DELETE ON items
BEGIN UPDATE catalog_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER catalog_items_update AFTER UPDATE ON items
WHEN OLD.library_id IS NOT NEW.library_id OR OLD.title IS NOT NEW.title OR OLD.year IS NOT NEW.year
  OR OLD.series IS NOT NEW.series OR OLD.season IS NOT NEW.season OR OLD.episode IS NOT NEW.episode
  OR OLD.size_bytes IS NOT NEW.size_bytes OR OLD.duration_secs IS NOT NEW.duration_secs
  OR OLD.video_codec IS NOT NEW.video_codec OR OLD.width IS NOT NEW.width OR OLD.height IS NOT NEW.height
  OR OLD.dynamic_range IS NOT NEW.dynamic_range OR OLD.metadata_id IS NOT NEW.metadata_id
  OR OLD.added_at IS NOT NEW.added_at
BEGIN UPDATE catalog_version SET version = version + 1 WHERE id = 1; END;

CREATE TRIGGER catalog_metadata_insert AFTER INSERT ON metadata
BEGIN UPDATE catalog_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER catalog_metadata_delete AFTER DELETE ON metadata
BEGIN UPDATE catalog_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER catalog_metadata_update AFTER UPDATE ON metadata
WHEN OLD.title IS NOT NEW.title OR OLD.year IS NOT NEW.year OR OLD.overview IS NOT NEW.overview
  OR OLD.genres IS NOT NEW.genres OR OLD.rating IS NOT NEW.rating OR OLD.poster IS NOT NEW.poster
  OR OLD.backdrop IS NOT NEW.backdrop OR OLD.tmdb_id IS NOT NEW.tmdb_id
BEGIN UPDATE catalog_version SET version = version + 1 WHERE id = 1; END;

CREATE TRIGGER catalog_episodes_insert AFTER INSERT ON episode_metadata
BEGIN UPDATE catalog_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER catalog_episodes_delete AFTER DELETE ON episode_metadata
BEGIN UPDATE catalog_version SET version = version + 1 WHERE id = 1; END;

CREATE TRIGGER catalog_libraries_insert AFTER INSERT ON libraries
BEGIN UPDATE catalog_version SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER catalog_libraries_delete AFTER DELETE ON libraries
BEGIN UPDATE catalog_version SET version = version + 1 WHERE id = 1; END;
