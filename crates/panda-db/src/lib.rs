//! `SQLite` persistence. One [`Db`] handle exposes a method group per table.

mod auth;
mod devices;
mod items;
mod libraries;
mod metadata;
mod provider_values;
mod requests;
mod settings;
mod watch;

pub use auth::{Credentials, DevicePoll, Invite, Role, Session, SessionKind, User};
pub use devices::{Device, DeviceProfile};
pub use items::{FileState, Item, ItemFilter, ItemKind, ProbeSummary, SeriesFolder, SeriesSummary, Upserted};
pub use libraries::{Library, LibraryStats};
pub use metadata::{MetadataKind, NewEpisode, NewMetadata, PendingEpisode, PendingMovie, SeasonMatch};
pub use provider_values::{Artwork, ProviderValue, ShownEpisode, StaleTitle, TITLE_LEVEL};
pub use requests::{MediaRequest, NewRequest, RequestKind, RequestStatus};
pub use settings::Setting;
pub use watch::{FINISHED_FRACTION, MIN_PROGRESS_SECS, WatchState};

use std::str::FromStr;

use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Migrate(#[from] sqlx::migrate::MigrateError),
    /// The database was upgraded by a newer Panda; this one would damage it.
    #[error(
        "this database is from a newer version of Panda (schema {found}, this version knows up to \
         {supported}). Update Panda, or restore a backup from the backups folder next to the database"
    )]
    NewerDatabase { found: i64, supported: i64 },
    #[error("backing up the database before upgrading it: {0}")]
    Backup(String),
}

pub type Result<T> = std::result::Result<T, Error>;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
/// Upgrade backups kept next to the database (the oldest go first).
const BACKUPS_KEPT: usize = 3;

/// Schema versions already applied (none for a new database).
async fn applied_versions(pool: &SqlitePool) -> Result<Vec<i64>> {
    let exists: Option<(String,)> =
        sqlx::query_as("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'")
            .fetch_optional(pool)
            .await?;
    if exists.is_none() {
        return Ok(Vec::new());
    }
    let rows: Vec<(i64,)> =
        sqlx::query_as("SELECT version FROM _sqlx_migrations WHERE success = 1").fetch_all(pool).await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

/// The seconds in a backup's name (`panda-schema{N}-{secs}.db`); 0 if it has none.
fn backup_time(path: &std::path::Path) -> u64 {
    path.file_stem()
        .and_then(|s| s.to_str())
        .and_then(|s| s.rsplit('-').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// A consistent copy (`VACUUM INTO`, safe with WAL and other connections) in `backups/` next to
/// the database, named for the schema it holds; only the newest few are kept.
async fn backup(pool: &SqlitePool, file: &std::path::Path, schema: i64) -> Result<()> {
    let dir = file.parent().unwrap_or(std::path::Path::new(".")).join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| Error::Backup(e.to_string()))?;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let target = dir.join(format!("panda-schema{schema}-{secs}.db"));
    sqlx::query("VACUUM INTO ?").bind(target.to_string_lossy().to_string()).execute(pool).await?;
    let mut old: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| Error::Backup(e.to_string()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "db"))
        .collect();
    // Oldest first by the time in the name (`panda-schema{N}-{secs}.db`): sorting the names as
    // text would put schema10 before schema7 and delete the newest backup.
    old.sort_by_key(|p| backup_time(p));
    let extra = old.len().saturating_sub(BACKUPS_KEPT);
    for p in old.into_iter().take(extra) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Db {
    pool: SqlitePool,
}

impl Db {
    /// Open (creating if needed) a database file and run pending migrations.
    pub async fn open(url: &str) -> Result<Self> {
        let opts = SqliteConnectOptions::from_str(url)?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            // With WAL, NORMAL is still crash-safe for the database (a power cut can only lose
            // the last moments of writes) and skips a full disk sync on every commit.
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(std::time::Duration::from_secs(10))
            .foreign_keys(true);
        let file = opts.get_filename().to_path_buf();
        let pool = SqlitePoolOptions::new().max_connections(8).connect_with(opts).await?;
        // Before upgrading: refuse a newer database, and copy this one aside.
        let applied = applied_versions(&pool).await?;
        let known: Vec<i64> = MIGRATOR.iter().map(|m| m.version).collect();
        let supported = known.iter().copied().max().unwrap_or(0);
        if let Some(&found) = applied.iter().max()
            && found > supported
        {
            return Err(Error::NewerDatabase { found, supported });
        }
        if !applied.is_empty() && known.iter().any(|v| !applied.contains(v)) {
            backup(&pool, &file, applied.iter().copied().max().unwrap_or(0)).await?;
        }
        Self::from_pool(pool).await
    }

    /// Private in-memory database (one connection, so every query sees the same data).
    pub async fn in_memory() -> Result<Self> {
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")?.foreign_keys(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await?;
        Self::from_pool(pool).await
    }

    async fn from_pool(pool: SqlitePool) -> Result<Self> {
        MIGRATOR.run(&pool).await?;
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

impl Error {
    /// True for UNIQUE constraint failures (e.g. requesting the same movie twice).
    pub fn is_unique_violation(&self) -> bool {
        matches!(self, Error::Sqlx(sqlx::Error::Database(e)) if e.is_unique_violation())
    }
}

#[cfg(test)]
mod upgrade_tests {
    use super::*;

    #[tokio::test]
    async fn upgrades_back_up_first_and_newer_databases_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", dir.path().join("panda.db").display());
        // A new database: no backup (nothing to keep).
        drop(Db::open(&url).await.unwrap());
        assert!(!dir.path().join("backups").exists());

        // Backups: a consistent copy each time, only the newest few kept.
        let pool = SqlitePoolOptions::new()
            .connect_with(SqliteConnectOptions::from_str(&url).unwrap())
            .await
            .unwrap();
        backup(&pool, &dir.path().join("panda.db"), 1).await.unwrap();
        assert_eq!(std::fs::read_dir(dir.path().join("backups")).unwrap().count(), 1);
        for i in 0..4 {
            backup(&pool, &dir.path().join("panda.db"), 2 + i).await.unwrap();
            std::thread::sleep(std::time::Duration::from_millis(1100));
        }
        assert_eq!(std::fs::read_dir(dir.path().join("backups")).unwrap().count(), BACKUPS_KEPT);

        // A newer Panda's schema: refused, with a clear message.
        sqlx::query(
            "INSERT INTO _sqlx_migrations (version, description, installed_on, success, checksum, execution_time)
             VALUES (99999, 'future', CURRENT_TIMESTAMP, 1, x'00', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        drop(pool);
        let err = Db::open(&url).await.unwrap_err();
        assert!(matches!(err, Error::NewerDatabase { found: 99999, .. }), "{err}");
        assert!(err.to_string().contains("newer version of Panda"));
    }
}

#[cfg(test)]
mod backup_tests {
    use super::backup_time;
    use std::path::PathBuf;

    #[test]
    fn backups_sort_by_time_not_by_name() {
        let mut names: Vec<PathBuf> =
            ["panda-schema10-1700000300.db", "panda-schema7-1700000100.db", "panda-schema9-1700000200.db"]
                .iter()
                .map(PathBuf::from)
                .collect();
        names.sort_by_key(|p| backup_time(p));
        assert_eq!(names[0], PathBuf::from("panda-schema7-1700000100.db"));
        assert_eq!(names[2], PathBuf::from("panda-schema10-1700000300.db"));
    }
}
