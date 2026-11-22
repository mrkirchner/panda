use panda_library::LibraryKind;
use serde::Serialize;

use crate::{Db, Result};

#[derive(Debug, Clone, Serialize)]
pub struct Library {
    pub id: i64,
    pub name: String,
    pub kind: String,
    /// Folders scanned into this library. Hidden from non-admins by the API.
    pub folders: Vec<String>,
}

impl Library {
    pub fn kind(&self) -> LibraryKind {
        if self.kind == "shows" { LibraryKind::Shows } else { LibraryKind::Movies }
    }

    /// The folder that contains `path`, if any (on a `/` boundary: `/media/tv` doesn't contain
    /// `/media/tv2/...`).
    pub fn folder_for(&self, path: &str) -> Option<&str> {
        self.folders.iter().map(String::as_str).find(|f| {
            let f = f.trim_end_matches('/');
            path == f || path.strip_prefix(f).is_some_and(|rest| rest.starts_with('/'))
        })
    }
}

impl Db {
    /// Create a library with one folder (or return the library that already owns that folder).
    pub async fn upsert_library(&self, name: &str, kind: LibraryKind, path: &str) -> Result<Library> {
        if let Some(existing) = self.library_for_folder(path).await? {
            return Ok(existing);
        }
        let mut tx = self.pool.begin().await?;
        let (id,): (i64,) =
            sqlx::query_as("INSERT INTO libraries (name, kind, path) VALUES (?, ?, ?) RETURNING id")
                .bind(name)
                .bind(kind.as_str())
                .bind(path)
                .fetch_one(&mut *tx)
                .await?;
        sqlx::query("INSERT INTO library_folders (library_id, path) VALUES (?, ?)")
            .bind(id)
            .bind(path)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(Library {
            id,
            name: name.to_string(),
            kind: kind.as_str().to_string(),
            folders: vec![path.to_string()],
        })
    }

    async fn library_for_folder(&self, path: &str) -> Result<Option<Library>> {
        let row: Option<(i64,)> = sqlx::query_as("SELECT library_id FROM library_folders WHERE path = ?")
            .bind(path)
            .fetch_optional(&self.pool)
            .await?;
        Ok(match row {
            Some((id,)) => self.libraries().await?.into_iter().find(|l| l.id == id),
            None => None,
        })
    }

    pub async fn libraries(&self) -> Result<Vec<Library>> {
        let libs: Vec<(i64, String, String)> =
            sqlx::query_as("SELECT id, name, kind FROM libraries ORDER BY name")
                .fetch_all(&self.pool)
                .await?;
        let folders: Vec<(i64, String)> =
            sqlx::query_as("SELECT library_id, path FROM library_folders ORDER BY path")
                .fetch_all(&self.pool)
                .await?;
        Ok(libs
            .into_iter()
            .map(|(id, name, kind)| Library {
                id,
                name,
                kind,
                folders: folders.iter().filter(|(l, _)| *l == id).map(|(_, p)| p.clone()).collect(),
            })
            .collect())
    }

    /// Add a folder to a library. Errors (unique violation) if another library owns it.
    pub async fn add_library_folder(&self, library_id: i64, path: &str) -> Result<()> {
        sqlx::query("INSERT INTO library_folders (library_id, path) VALUES (?, ?)")
            .bind(library_id)
            .bind(path)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Remove a folder and the items scanned from it. Files on disk are untouched.
    pub async fn remove_library_folder(&self, library_id: i64, path: &str) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let removed = sqlx::query("DELETE FROM library_folders WHERE library_id = ? AND path = ?")
            .bind(library_id)
            .bind(path)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if removed > 0 {
            // An exact prefix compare (LIKE would treat `_` and `%` in folder names as wildcards
            // and could delete another folder's items).
            let prefix = format!("{}/", path.trim_end_matches('/'));
            sqlx::query("DELETE FROM items WHERE library_id = ? AND substr(path, 1, length(?2)) = ?2")
                .bind(library_id)
                .bind(prefix)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(removed > 0)
    }

    /// Move everything from `from` into `into` (same kind): folders, items (with their metadata
    /// and watch history) and per-user access. No rescan needed.
    pub async fn merge_libraries(&self, from: i64, into: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE library_folders SET library_id = ? WHERE library_id = ?")
            .bind(into)
            .bind(from)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE items SET library_id = ? WHERE library_id = ?")
            .bind(into)
            .bind(from)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT OR IGNORE INTO user_libraries (user_id, library_id)
             SELECT user_id, ? FROM user_libraries WHERE library_id = ?",
        )
        .bind(into)
        .bind(from)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM libraries WHERE id = ?").bind(from).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn rename_library(&self, id: i64, name: &str) -> Result<()> {
        sqlx::query("UPDATE libraries SET name = ? WHERE id = ?")
            .bind(name)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Remove a library and (via cascade) its items. Files on disk are untouched.
    /// Accounts for whom this is the only library they may see. Deleting it would leave them
    /// no allowed library, which means *every* library (no rows = unrestricted).
    pub async fn sole_library_of(&self, id: i64) -> Result<Vec<String>> {
        Ok(sqlx::query_scalar(
            "SELECT u.username FROM user_libraries ul JOIN users u ON u.id = ul.user_id
             WHERE ul.library_id = ?1
               AND NOT EXISTS (SELECT 1 FROM user_libraries x WHERE x.user_id = ul.user_id AND x.library_id != ?1)
             ORDER BY u.username",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn delete_library(&self, id: i64) -> Result<bool> {
        Ok(sqlx::query("DELETE FROM libraries WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected()
            > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use panda_library::{Parsed, ScannedFile};
    use std::path::PathBuf;

    fn movie(path: &str) -> ScannedFile {
        ScannedFile {
            path: PathBuf::from(path),
            size: 1,
            mtime: 1,
            parsed: Parsed::Movie { title: "Heat".into(), year: Some(1995) },
        }
    }

    #[test]
    fn a_folder_contains_only_paths_under_it() {
        let lib =
            Library { id: 1, name: "TV".into(), kind: "shows".into(), folders: vec!["/media/tv".into()] };
        assert_eq!(lib.folder_for("/media/tv/Show/S01E01.mkv"), Some("/media/tv"));
        assert_eq!(lib.folder_for("/media/tv2/Show/S01E01.mkv"), None);
    }

    #[tokio::test]
    async fn removing_a_folder_keeps_other_folders_items() {
        let db = Db::in_memory().await.unwrap();
        let lib = db.upsert_library("Movies", LibraryKind::Movies, "/m/a_b").await.unwrap();
        db.add_library_folder(lib.id, "/m/aXb").await.unwrap();
        let gone = db.upsert_item(lib.id, 1, &movie("/m/a_b/Heat.mkv")).await.unwrap();
        // `_` would match any character as a LIKE pattern: this one must survive.
        let kept = db.upsert_item(lib.id, 1, &movie("/m/aXb/Heat.mkv")).await.unwrap();
        assert!(db.remove_library_folder(lib.id, "/m/a_b").await.unwrap());
        assert!(db.item(gone.id).await.unwrap().is_none());
        assert!(db.item(kept.id).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn merging_moves_folders_and_items_without_rescan() {
        let db = Db::in_memory().await.unwrap();
        let k4 = db.upsert_library("Movies 4K", LibraryKind::Movies, "/m/4k").await.unwrap();
        let hd = db.upsert_library("Movies HD", LibraryKind::Movies, "/m/hd").await.unwrap();
        let a = db.upsert_item(k4.id, 1, &movie("/m/4k/Heat (1995)/heat.mkv")).await.unwrap();
        db.upsert_item(hd.id, 1, &movie("/m/hd/Heat (1995)/heat.mkv")).await.unwrap();

        db.merge_libraries(k4.id, hd.id).await.unwrap();
        db.rename_library(hd.id, "Movies").await.unwrap();
        let libs = db.libraries().await.unwrap();
        assert_eq!(libs.len(), 1);
        assert_eq!(libs[0].name, "Movies");
        assert_eq!(libs[0].folders, vec!["/m/4k".to_string(), "/m/hd".to_string()]);
        assert_eq!(db.item(a.id).await.unwrap().unwrap().library_id, hd.id, "item kept, moved");

        // Upserting a known folder returns its library instead of creating a new one.
        assert_eq!(db.upsert_library("x", LibraryKind::Movies, "/m/4k").await.unwrap().id, hd.id);

        assert!(db.remove_library_folder(hd.id, "/m/4k").await.unwrap());
        assert!(db.item(a.id).await.unwrap().is_none(), "items from a removed folder go too");
    }
}

/// Per-library counts for the admin dashboard.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct LibraryStats {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub items: i64,
    /// Items without TMDB metadata.
    pub unmatched: i64,
}

impl Db {
    pub async fn library_stats(&self) -> Result<Vec<LibraryStats>> {
        Ok(sqlx::query_as(
            "SELECT l.id, l.name, l.kind, COUNT(i.id) AS items,
                    COALESCE(SUM(i.id IS NOT NULL AND i.metadata_id IS NULL), 0) AS unmatched
             FROM libraries l LEFT JOIN items i ON i.library_id = l.id
             GROUP BY l.id ORDER BY l.name",
        )
        .fetch_all(&self.pool)
        .await?)
    }
}
