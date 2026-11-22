use std::collections::HashMap;

use chrono::Utc;
use panda_library::{Parsed, ScannedFile};
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite};

use crate::{Db, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Movie,
    Episode,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Item {
    pub id: i64,
    pub library_id: i64,
    pub kind: String,
    pub title: String,
    pub year: Option<i64>,
    pub series: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    #[serde(skip)]
    pub path: String,
    pub size_bytes: i64,
    pub duration_secs: Option<f64>,
    pub video_codec: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub dynamic_range: Option<String>,
    #[serde(skip)]
    pub probe_json: Option<String>,
    pub added_at: String,
    // From TMDB (NULL until matched). Image fields are cache keys for `/api/images/{key}`.
    pub tmdb_id: Option<i64>,
    /// Movie title or series name as TMDB spells it.
    pub meta_title: Option<String>,
    pub overview: Option<String>,
    pub genres: Option<String>,
    pub rating: Option<f64>,
    pub poster: Option<String>,
    pub backdrop: Option<String>,
    pub episode_title: Option<String>,
    pub episode_overview: Option<String>,
    /// The episode's own still (image key), when TMDB has one.
    pub episode_still: Option<String>,
}

/// Searchable columns copied out of the full ffprobe JSON.
#[derive(Debug, Clone, Default)]
pub struct ProbeSummary {
    pub duration_secs: Option<f64>,
    pub video_codec: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub dynamic_range: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ItemFilter {
    pub library_id: Option<i64>,
    /// Restrict to these libraries (per-user access). Set by the server, never from a query string.
    #[serde(skip)]
    pub allowed_libraries: Option<Vec<i64>>,
    pub kind: Option<ItemKind>,
    pub series: Option<String>,
    /// Episodes of exactly this show folder (any case), not every folder of its show.
    #[serde(skip)]
    pub folder: Option<String>,
    /// Case-insensitive substring match on title or series.
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// A show folder and what it matched.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct SeriesFolder {
    pub series: String,
    pub tmdb_id: Option<i64>,
    pub meta_title: Option<String>,
    pub year: Option<i64>,
    pub poster: Option<String>,
}

/// One row per series, for browse screens (avoids shipping every episode).
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct SeriesSummary {
    pub series: String,
    pub library_id: i64,
    pub episodes: i64,
    pub seasons: i64,
    pub tmdb_id: Option<i64>,
    pub meta_title: Option<String>,
    pub year: Option<i64>,
    pub overview: Option<String>,
    pub genres: Option<String>,
    pub rating: Option<f64>,
    pub poster: Option<String>,
    pub backdrop: Option<String>,
    /// Newest episode's add time (for "Recently added").
    pub latest_added_at: String,
}

#[derive(Debug, Clone, Copy)]
pub struct Upserted {
    pub id: i64,
    /// New file, or the file changed since it was last probed.
    pub needs_probe: bool,
}

/// Select list + joins for [`Item`]. Macros so queries stay `&'static str` literals
/// (sqlx rejects runtime-built SQL strings). `item_columns!(list)` skips the large probe JSON.
macro_rules! item_columns {
    () => {
        item_columns!(@ "i.probe_json")
    };
    (list) => {
        item_columns!(@ "NULL AS probe_json")
    };
    (@ $probe:literal) => {
        concat!(
            "i.id, i.library_id, i.kind, i.title, i.year, i.series, i.season, i.episode, i.path, \
             i.size_bytes, i.duration_secs, i.video_codec, i.width, i.height, i.dynamic_range, ",
            $probe,
            ", i.added_at, m.tmdb_id, m.title AS meta_title, m.overview, m.genres, m.rating, \
             m.poster, m.backdrop, e.name AS episode_title, e.overview AS episode_overview, e.still AS episode_still \
             FROM items i \
             LEFT JOIN metadata m ON m.id = i.metadata_id \
             LEFT JOIN episode_metadata e \
                ON e.metadata_id = i.metadata_id AND e.season = i.season AND e.episode = i.episode"
        )
    };
}

/// What a scanned file stores: its kind and what its name says.
struct Columns {
    kind: &'static str,
    title: String,
    year: Option<i64>,
    series: Option<String>,
    season: Option<i64>,
    episode: Option<i64>,
}

fn columns(f: &ScannedFile) -> Columns {
    match &f.parsed {
        Parsed::Movie { title, year } => Columns {
            kind: "movie",
            title: title.clone(),
            year: year.map(i64::from),
            series: None,
            season: None,
            episode: None,
        },
        Parsed::Episode { series, season, episode, episode_title, .. } => Columns {
            kind: "episode",
            title: match (episode, episode_title) {
                (Some(e), _) => format!("{series} S{season:02}E{e:02}"),
                (None, Some(t)) => t.clone(),
                (None, None) => series.clone(),
            },
            year: None,
            series: Some(series.clone()),
            season: Some(i64::from(*season)),
            episode: episode.map(i64::from),
        },
    }
}

/// A stored file as a scan compares it.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FileState {
    pub id: i64,
    pub path: String,
    pub kind: String,
    pub title: String,
    pub year: Option<i64>,
    pub series: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub size_bytes: i64,
    pub mtime: i64,
    pub probed: bool,
}

impl FileState {
    /// The same file as scanned (size, time, what its name says) and already probed: the scan
    /// only needs to mark it seen, not rewrite it.
    pub fn unchanged(&self, f: &ScannedFile) -> bool {
        let c = columns(f);
        #[allow(clippy::cast_possible_wrap)]
        let same_file = self.size_bytes == f.size as i64 && self.mtime == f.mtime;
        // A title-only episode's number came from TMDB, not the name: no number is still the same.
        let same_episode = self.episode == c.episode || c.episode.is_none();
        self.probed
            && same_file
            && same_episode
            && self.kind == c.kind
            && self.title == c.title
            && self.year == c.year
            && self.series == c.series
            && self.season == c.season
    }
}

impl Db {
    pub async fn upsert_item(&self, library_id: i64, scan_gen: i64, f: &ScannedFile) -> Result<Upserted> {
        let Columns { kind, title, year, series, season, episode } = columns(f);
        let row: (i64, bool) = sqlx::query_as(
            "INSERT INTO items (library_id, kind, title, year, series, season, episode, path,
                                size_bytes, mtime, scan_gen, added_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (path) DO UPDATE SET
                library_id = excluded.library_id, kind = excluded.kind, title = excluded.title,
                year = excluded.year, series = excluded.series, season = excluded.season,
                -- A title-only episode's number comes from TMDB (set_item_episode); the file name
                -- never has it, so a rescan of the same file keeps it rather than blanking it.
                episode = CASE WHEN excluded.episode IS NULL AND items.title IS excluded.title
                                    AND items.series IS excluded.series AND items.season IS excluded.season
                               THEN items.episode ELSE excluded.episode END,
                scan_gen = excluded.scan_gen,
                probe_json = CASE WHEN items.size_bytes = excluded.size_bytes AND items.mtime = excluded.mtime
                                  THEN items.probe_json END,
                size_bytes = excluded.size_bytes, mtime = excluded.mtime
             RETURNING id, probe_json IS NULL",
        )
        .bind(library_id)
        .bind(kind)
        .bind(title)
        .bind(year)
        .bind(series)
        .bind(season)
        .bind(episode)
        .bind(f.path.to_string_lossy())
        .bind(f.size as i64)
        .bind(f.mtime)
        .bind(scan_gen)
        .bind(Utc::now().to_rfc3339())
        .fetch_one(&self.pool)
        .await?;
        Ok(Upserted { id: row.0, needs_probe: row.1 })
    }

    pub async fn set_probe(&self, id: i64, summary: &ProbeSummary, json: &str) -> Result<()> {
        sqlx::query(
            "UPDATE items SET duration_secs = ?, video_codec = ?, width = ?, height = ?,
                              dynamic_range = ?, probe_json = ? WHERE id = ?",
        )
        .bind(summary.duration_secs)
        .bind(&summary.video_codec)
        .bind(summary.width)
        .bind(summary.height)
        .bind(&summary.dynamic_range)
        .bind(json)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Delete items in a library that weren't seen by scan `scan_gen`. Returns rows removed.
    /// Every file of a library as stored, by path (what a scan compares against).
    pub async fn file_states(&self, library_id: i64) -> Result<HashMap<String, FileState>> {
        let rows: Vec<FileState> = sqlx::query_as(
            "SELECT id, path, kind, title, year, series, season, episode, size_bytes, mtime,
                    probe_json IS NOT NULL AS probed
             FROM items WHERE library_id = ?",
        )
        .bind(library_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| (r.path.clone(), r)).collect())
    }

    /// Mark unchanged files as seen by this scan: one transaction, in chunks, instead of a
    /// rewrite (and commit) per file.
    pub async fn mark_seen(&self, ids: &[i64], scan_gen: i64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for chunk in ids.chunks(500) {
            let mut q = QueryBuilder::new("UPDATE items SET scan_gen = ");
            q.push_bind(scan_gen).push(" WHERE id IN (");
            let mut sep = q.separated(", ");
            for id in chunk {
                sep.push_bind(*id);
            }
            sep.push_unseparated(")");
            q.build().execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Remove a library's files under `folder` that this scan didn't see (a partial scan of one
    /// folder: the rest of the library is left alone).
    pub async fn prune_items_under(&self, library_id: i64, folder: &str, scan_gen: i64) -> Result<u64> {
        let prefix = format!("{}/", folder.trim_end_matches('/'));
        let res = sqlx::query(
            "DELETE FROM items WHERE library_id = ? AND scan_gen < ? AND substr(path, 1, length(?3)) = ?3",
        )
        .bind(library_id)
        .bind(scan_gen)
        .bind(prefix)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    pub async fn prune_items(&self, library_id: i64, scan_gen: i64) -> Result<u64> {
        let res = sqlx::query("DELETE FROM items WHERE library_id = ? AND scan_gen < ?")
            .bind(library_id)
            .bind(scan_gen)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected())
    }

    /// Every show folder (one row per spelling, unlike [`Db::series`], which groups the folders
    /// of one TMDB show), with what it matched: for checking matches folder by folder.
    pub async fn series_folders(&self) -> Result<Vec<SeriesFolder>> {
        Ok(sqlx::query_as(
            "SELECT MIN(i.series) AS series, m.tmdb_id, m.title AS meta_title, m.year, m.poster
             FROM items i LEFT JOIN metadata m ON m.id = i.metadata_id
             WHERE i.kind = 'episode' AND i.series IS NOT NULL
             GROUP BY LOWER(i.series), m.id
             ORDER BY LOWER(i.series)",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    /// Unmatch one show folder (any case), so the next metadata pass matches it again.
    pub async fn clear_series_match(&self, folder: &str) -> Result<u64> {
        let res = sqlx::query(
            "UPDATE items SET metadata_id = NULL WHERE kind = 'episode' AND LOWER(series) = LOWER(?)",
        )
        .bind(folder)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    /// The TMDB show a series folder name matched (any spelling of it), if any.
    pub async fn series_tmdb_id(&self, name: &str) -> Result<Option<i64>> {
        Ok(sqlx::query_scalar(
            "SELECT m.tmdb_id FROM items i JOIN metadata m ON m.id = i.metadata_id
             WHERE i.kind = 'episode' AND LOWER(i.series) = LOWER(?) AND m.kind = 'series' LIMIT 1",
        )
        .bind(name)
        .fetch_optional(&self.pool)
        .await?)
    }

    /// Changes whenever what the library catalog shows changes (kept by triggers), for caches.
    pub async fn catalog_version(&self) -> Result<i64> {
        Ok(sqlx::query_scalar("SELECT version FROM catalog_version WHERE id = 1")
            .fetch_one(&self.pool)
            .await?)
    }

    /// Several items in one query (without the probe JSON), in no particular order.
    pub async fn items_by_ids(&self, ids: &[i64]) -> Result<Vec<Item>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut q = QueryBuilder::new(concat!("SELECT ", item_columns!(list), " WHERE i.id IN ("));
        let mut sep = q.separated(", ");
        for id in ids {
            sep.push_bind(*id);
        }
        sep.push_unseparated(")");
        Ok(q.build_query_as().fetch_all(&self.pool).await?)
    }

    /// The current file for a watch key (`m{tmdb}`, `s{tmdb}e{season}x{episode}`): progress is
    /// kept per title, while the file it was saved on may have been replaced (an upgrade gives
    /// it a new item). The smallest such file; `None` for per-file keys (`i{id}`).
    pub async fn item_for_watch_key(&self, key: &str) -> Result<Option<Item>> {
        if let Some(tmdb) = key.strip_prefix('m').and_then(|t| t.parse::<i64>().ok()) {
            return Ok(sqlx::query_as(concat!(
                "SELECT ",
                item_columns!(list),
                " WHERE i.kind = 'movie' AND m.tmdb_id = ? ORDER BY i.height, i.size_bytes LIMIT 1"
            ))
            .bind(tmdb)
            .fetch_optional(&self.pool)
            .await?);
        }
        let Some(rest) = key.strip_prefix('s') else { return Ok(None) };
        let Some((tmdb, se)) = rest.split_once('e') else { return Ok(None) };
        let Some((season, episode)) = se.split_once('x') else { return Ok(None) };
        let (Ok(tmdb), Ok(season), Ok(episode)) =
            (tmdb.parse::<i64>(), season.parse::<i64>(), episode.parse::<i64>())
        else {
            return Ok(None);
        };
        Ok(sqlx::query_as(concat!(
            "SELECT ",
            item_columns!(list),
            " WHERE i.kind = 'episode' AND m.tmdb_id = ? AND i.season = ? AND i.episode = ?
              ORDER BY i.height, i.size_bytes LIMIT 1"
        ))
        .bind(tmdb)
        .bind(season)
        .bind(episode)
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn item(&self, id: i64) -> Result<Option<Item>> {
        Ok(sqlx::query_as(concat!("SELECT ", item_columns!(), " WHERE i.id = ?"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?)
    }

    pub async fn items(&self, filter: &ItemFilter) -> Result<Vec<Item>> {
        let mut qb: QueryBuilder<Sqlite> =
            QueryBuilder::new(concat!("SELECT ", item_columns!(list), " WHERE 1 = 1"));
        if let Some(id) = filter.library_id {
            qb.push(" AND i.library_id = ").push_bind(id);
        }
        if let Some(allowed) = &filter.allowed_libraries {
            qb.push(" AND i.library_id IN (");
            if allowed.is_empty() {
                qb.push("NULL");
            }
            let mut sep = qb.separated(", ");
            for id in allowed {
                sep.push_bind(*id);
            }
            qb.push(")");
        }
        if let Some(kind) = filter.kind {
            qb.push(" AND i.kind = ").push_bind(if kind == ItemKind::Movie { "movie" } else { "episode" });
        }
        if let Some(folder) = &filter.folder {
            qb.push(" AND LOWER(i.series) = LOWER(").push_bind(folder.clone()).push(")");
        }
        if let Some(series) = &filter.series {
            // One show can span several folders (spelled differently, or two that matched the
            // same TMDB show): its episodes are those of every folder of that show.
            qb.push(
                " AND i.series IN (SELECT x.series FROM items x LEFT JOIN metadata mx ON mx.id = x.metadata_id
                    WHERE x.kind = 'episode' AND (LOWER(x.series) = LOWER(",
            )
            .push_bind(series.clone())
            .push(
                ") OR mx.tmdb_id IN (SELECT my.tmdb_id FROM items y JOIN metadata my ON my.id = y.metadata_id
                    WHERE y.kind = 'episode' AND LOWER(y.series) = LOWER(",
            )
            .push_bind(series.clone())
            .push(") AND my.kind = 'series')))");
        }
        if let Some(q) = filter.q.as_deref().filter(|q| !q.is_empty()) {
            let like = format!("%{}%", q.replace(['%', '_'], ""));
            qb.push(" AND (i.title LIKE ")
                .push_bind(like.clone())
                .push(" OR i.series LIKE ")
                .push_bind(like.clone())
                .push(" OR m.title LIKE ")
                .push_bind(like)
                .push(")");
        }
        qb.push(" ORDER BY COALESCE(m.title, i.series, i.title), i.season, i.episode, i.title");
        qb.push(" LIMIT ").push_bind(filter.limit.unwrap_or(200).clamp(1, 10_000));
        qb.push(" OFFSET ").push_bind(filter.offset.unwrap_or(0).max(0));
        Ok(qb.build_query_as().fetch_all(&self.pool).await?)
    }

    pub async fn series(&self) -> Result<Vec<SeriesSummary>> {
        // Every episode of a series shares one metadata row, so the bare m.* columns are stable.
        Ok(sqlx::query_as(
            // One row per show: folders that matched the same TMDB show, or that are spelled the
            // same but for case, are one show (named by one of its folders).
            "SELECT MIN(i.series) AS series, MIN(i.library_id) AS library_id, COUNT(*) AS episodes,
                    COUNT(DISTINCT i.season) AS seasons, m.tmdb_id, m.title AS meta_title, m.year,
                    m.overview, m.genres, m.rating, m.poster, m.backdrop, MAX(i.added_at) AS latest_added_at
             FROM items i LEFT JOIN metadata m ON m.id = i.metadata_id
             WHERE i.kind = 'episode' AND i.series IS NOT NULL
             GROUP BY COALESCE('t' || m.tmdb_id, 'n' || LOWER(i.series))
             ORDER BY COALESCE(m.title, MIN(i.series))",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn next_scan_gen(&self) -> Result<i64> {
        let (max,): (Option<i64>,) =
            sqlx::query_as("SELECT MAX(scan_gen) FROM items").fetch_one(&self.pool).await?;
        Ok(max.unwrap_or(0) + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use panda_library::LibraryKind;
    use std::path::PathBuf;

    fn film(path: &str, title: &str) -> ScannedFile {
        ScannedFile {
            path: PathBuf::from(path),
            size: 10,
            mtime: 5,
            parsed: Parsed::Movie { title: title.into(), year: Some(1995) },
        }
    }

    #[tokio::test]
    async fn a_folder_scan_prunes_only_inside_that_folder() {
        let db = Db::in_memory().await.unwrap();
        let lib = db.upsert_library("Movies", LibraryKind::Movies, "/m").await.unwrap();
        let heat = db.upsert_item(lib.id, 1, &film("/m/Heat (1995)/heat.mkv", "Heat")).await.unwrap();
        let old = db.upsert_item(lib.id, 1, &film("/m/Heat (1995)/old.mkv", "Heat")).await.unwrap();
        // `Heat (1995)2` shares the prefix but isn't inside the folder.
        let near = db.upsert_item(lib.id, 1, &film("/m/Heat (1995)2/x.mkv", "Heat")).await.unwrap();
        let other = db.upsert_item(lib.id, 1, &film("/m/Alien (1979)/alien.mkv", "Alien")).await.unwrap();

        db.mark_seen(&[heat.id], 2).await.unwrap();
        assert_eq!(db.prune_items_under(lib.id, "/m/Heat (1995)", 2).await.unwrap(), 1);
        assert!(db.item(heat.id).await.unwrap().is_some(), "seen by the scan");
        assert!(db.item(old.id).await.unwrap().is_none(), "gone from the folder");
        assert!(db.item(near.id).await.unwrap().is_some(), "a different folder");
        assert!(db.item(other.id).await.unwrap().is_some(), "outside the scanned folder");
    }

    #[tokio::test]
    async fn an_unchanged_probed_file_is_only_marked_seen() {
        let db = Db::in_memory().await.unwrap();
        let lib = db.upsert_library("Movies", LibraryKind::Movies, "/m").await.unwrap();
        let f = film("/m/Heat (1995)/heat.mkv", "Heat");
        let up = db.upsert_item(lib.id, 1, &f).await.unwrap();
        let state = |db: Db| async move {
            db.file_states(lib.id).await.unwrap().remove("/m/Heat (1995)/heat.mkv").unwrap()
        };
        assert!(!state(db.clone()).await.unchanged(&f), "not probed yet");
        db.set_probe(up.id, &ProbeSummary::default(), "{}").await.unwrap();
        let s = state(db.clone()).await;
        assert!(s.unchanged(&f));
        assert!(!s.unchanged(&ScannedFile { size: 11, ..f.clone() }), "size changed");
        assert!(!s.unchanged(&film("/m/Heat (1995)/heat.mkv", "Heat 2")), "name parses differently");
    }

    fn file(path: &str, size: u64, title: &str) -> ScannedFile {
        ScannedFile {
            path: PathBuf::from(path),
            size,
            mtime: 100,
            parsed: Parsed::Movie { title: title.into(), year: Some(1995) },
        }
    }

    #[tokio::test]
    async fn one_show_across_folders_is_one_show() {
        use crate::metadata::{MetadataKind, NewMetadata};
        let db = Db::in_memory().await.unwrap();
        let lib = db.upsert_library("TV", LibraryKind::Shows, "/tv").await.unwrap();
        let episode = |path: &str, series: &str, n: u32| ScannedFile {
            path: PathBuf::from(path),
            size: 1,
            mtime: 1,
            parsed: Parsed::Episode {
                series: series.into(),
                season: 1,
                episode: Some(n),
                episode_end: None,
                episode_title: None,
            },
        };
        // Two folders, spelled differently, of one show.
        let a = db.upsert_item(lib.id, 1, &episode("/tv/A/1.mkv", "The Legend Of Korra", 1)).await.unwrap();
        let b = db.upsert_item(lib.id, 1, &episode("/tv/B/2.mkv", "The Legend of Korra", 2)).await.unwrap();
        // Unmatched yet: the same name but for case is one show.
        assert_eq!(db.series().await.unwrap().len(), 1);
        let meta = db
            .upsert_metadata(&NewMetadata {
                kind: MetadataKind::Series,
                tmdb_id: 33880,
                title: "The Legend of Korra".into(),
                original_title: None,
                year: Some(2012),
                overview: None,
                tagline: None,
                genres: None,
                runtime_mins: None,
                rating: None,
                poster: None,
                backdrop: None,
            })
            .await
            .unwrap();
        db.set_item_metadata(&[a.id, b.id], Some(meta)).await.unwrap();
        let shows = db.series().await.unwrap();
        assert_eq!(shows.len(), 1, "{shows:?}");
        assert_eq!(shows[0].episodes, 2);
        // Either spelling lists every episode.
        for name in ["The Legend of Korra", "The Legend Of Korra"] {
            let filter = ItemFilter { series: Some(name.into()), ..Default::default() };
            assert_eq!(db.items(&filter).await.unwrap().len(), 2, "{name}");
        }
        assert_eq!(db.series_tmdb_id("the legend of korra").await.unwrap(), Some(33880));
    }

    #[tokio::test]
    async fn two_folders_wrongly_matched_to_one_show_can_be_told_apart() {
        use crate::metadata::{MetadataKind, NewMetadata};
        let db = Db::in_memory().await.unwrap();
        let lib = db.upsert_library("TV", LibraryKind::Shows, "/tv").await.unwrap();
        let episode = |path: &str, series: &str| ScannedFile {
            path: PathBuf::from(path),
            size: 1,
            mtime: 1,
            parsed: Parsed::Episode {
                series: series.into(),
                season: 1,
                episode: Some(1),
                episode_end: None,
                episode_title: None,
            },
        };
        let a = db.upsert_item(lib.id, 1, &episode("/tv/Monster/1.mkv", "Monster")).await.unwrap();
        let b =
            db.upsert_item(lib.id, 1, &episode("/tv/Monster (2022)/1.mkv", "Monster (2022)")).await.unwrap();
        let meta = db
            .upsert_metadata(&NewMetadata {
                kind: MetadataKind::Series,
                tmdb_id: 30981,
                title: "Monster".into(),
                original_title: None,
                year: Some(2004),
                overview: None,
                tagline: None,
                genres: None,
                runtime_mins: None,
                rating: None,
                poster: None,
                backdrop: None,
            })
            .await
            .unwrap();
        db.set_item_metadata(&[a.id, b.id], Some(meta)).await.unwrap();
        assert_eq!(db.series().await.unwrap().len(), 1, "grouped as one show");

        let folders = db.series_folders().await.unwrap();
        assert_eq!(
            folders.iter().map(|f| f.series.as_str()).collect::<Vec<_>>(),
            ["Monster", "Monster (2022)"]
        );
        assert!(folders.iter().all(|f| f.year == Some(2004)));
        let one = ItemFilter { folder: Some("monster (2022)".into()), ..Default::default() };
        assert_eq!(db.items(&one).await.unwrap().iter().map(|i| i.id).collect::<Vec<_>>(), [b.id]);

        assert_eq!(db.clear_series_match("Monster (2022)").await.unwrap(), 1);
        assert!(db.item(b.id).await.unwrap().unwrap().tmdb_id.is_none());
        assert_eq!(
            db.item(a.id).await.unwrap().unwrap().tmdb_id,
            Some(30981),
            "the other folder keeps its match"
        );
    }

    #[tokio::test]
    async fn a_watch_key_finds_the_titles_current_file() {
        use crate::metadata::{MetadataKind, NewMetadata};
        let db = Db::in_memory().await.unwrap();
        let lib = db.upsert_library("Movies", LibraryKind::Movies, "/m").await.unwrap();
        let meta = db
            .upsert_metadata(&NewMetadata {
                kind: MetadataKind::Movie,
                tmdb_id: 603,
                title: "The Matrix".into(),
                original_title: None,
                year: Some(1999),
                overview: None,
                tagline: None,
                genres: None,
                runtime_mins: None,
                rating: None,
                poster: None,
                backdrop: None,
            })
            .await
            .unwrap();
        // Watched on the first file; Radarr then replaces it (a new path is a new item).
        let old = db.upsert_item(lib.id, 1, &file("/m/matrix-720p.mkv", 10, "The Matrix")).await.unwrap();
        let new = db.upsert_item(lib.id, 2, &file("/m/matrix-1080p.mkv", 20, "The Matrix")).await.unwrap();
        db.set_item_metadata(&[old.id, new.id], Some(meta)).await.unwrap();
        db.prune_items(lib.id, 2).await.unwrap();
        assert!(db.item(old.id).await.unwrap().is_none());
        let found = db.item_for_watch_key("m603").await.unwrap().expect("the title's current file");
        assert_eq!(found.id, new.id);
        assert!(db.item_for_watch_key("i42").await.unwrap().is_none());
        assert!(db.item_for_watch_key("s9e1x").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn rescans_keep_a_title_only_episodes_number() {
        let db = Db::in_memory().await.unwrap();
        let lib = db.upsert_library("TV", LibraryKind::Shows, "/tv").await.unwrap();
        let twiggy = ScannedFile {
            path: PathBuf::from("/tv/The Muppet Show/Season 1/Twiggy.m4v"),
            size: 10,
            mtime: 100,
            parsed: Parsed::Episode {
                series: "The Muppet Show".into(),
                season: 1,
                episode: None,
                episode_end: None,
                episode_title: Some("Twiggy".into()),
            },
        };
        let up = db.upsert_item(lib.id, 1, &twiggy).await.unwrap();
        db.set_item_episode(up.id, 5).await.unwrap();
        // The next scan sees the same file, still without a number in its name.
        db.upsert_item(lib.id, 2, &twiggy).await.unwrap();
        assert_eq!(db.item(up.id).await.unwrap().unwrap().episode, Some(5));
    }

    #[tokio::test]
    async fn upsert_probe_and_prune() {
        let db = Db::in_memory().await.unwrap();
        let lib = db.upsert_library("Movies", LibraryKind::Movies, "/m").await.unwrap();

        let a = db.upsert_item(lib.id, 1, &file("/m/heat.mkv", 10, "Heat")).await.unwrap();
        assert!(a.needs_probe);
        db.set_probe(a.id, &ProbeSummary::default(), "{}").await.unwrap();

        // Same file on the next scan: no re-probe. Changed size: re-probe.
        assert!(!db.upsert_item(lib.id, 2, &file("/m/heat.mkv", 10, "Heat")).await.unwrap().needs_probe);
        assert!(db.upsert_item(lib.id, 3, &file("/m/heat.mkv", 11, "Heat")).await.unwrap().needs_probe);

        db.upsert_item(lib.id, 1, &file("/m/gone.mkv", 1, "Gone")).await.unwrap();
        assert_eq!(db.prune_items(lib.id, 3).await.unwrap(), 1);

        let found = db.items(&ItemFilter { q: Some("hea".into()), ..Default::default() }).await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(db.next_scan_gen().await.unwrap(), 4);
    }
}
