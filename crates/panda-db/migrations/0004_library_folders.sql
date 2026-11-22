-- A library can span several folders (e.g. "Movies" = Movies-4K + Movies-HD), so a movie in
-- both shows up once with two versions. libraries.path is kept only for older code paths.
CREATE TABLE library_folders (
    id          INTEGER PRIMARY KEY,
    library_id  INTEGER NOT NULL REFERENCES libraries (id) ON DELETE CASCADE,
    path        TEXT NOT NULL UNIQUE
);
CREATE INDEX library_folders_library ON library_folders (library_id);

INSERT INTO library_folders (library_id, path) SELECT id, path FROM libraries;
