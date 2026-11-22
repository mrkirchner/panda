-- Listing every movie (no library filter) couldn't use items_library (library_id first): it
-- scanned all items, mostly episodes.
CREATE INDEX items_kind ON items (kind, library_id);
-- The scanner's prune (scan_gen < ? per library) and MAX(scan_gen).
CREATE INDEX items_scan_gen ON items (library_id, scan_gen);
