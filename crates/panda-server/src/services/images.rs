//! One-time move of the artwork cache from TMDB's JPEGs to WebP (37-56% smaller). New images
//! are converted at download time; this converts whatever was cached before WebP existed.

use std::sync::Arc;

use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::state::AppState;

const PARALLEL: usize = 4;

pub(crate) fn spawn_webp_migration(state: AppState) {
    if !state.images.webp_enabled() {
        return;
    }
    tokio::spawn(async move {
        let keys = match state.db.jpeg_image_keys().await {
            Ok(k) if k.is_empty() => return,
            Ok(k) => k,
            Err(e) => return tracing::warn!(error = %e, "WebP migration: listing images failed"),
        };
        let started = std::time::Instant::now();
        tracing::info!(images = keys.len(), "converting cached artwork to WebP in the background");
        let permits = Arc::new(Semaphore::new(PARALLEL));
        let mut set = JoinSet::new();
        for key in keys {
            let (state, permits) = (state.clone(), permits.clone());
            set.spawn(async move {
                let _permit = permits.acquire_owned().await;
                match state.images.migrate_to_webp(&key).await {
                    Ok(Some(new)) => state.db.rename_image_key(&key, &new).await.is_ok(),
                    Ok(None) => false,
                    Err(e) => {
                        tracing::debug!(key, error = %e, "WebP conversion failed; keeping JPEG");
                        false
                    }
                }
            });
        }
        let mut converted = 0usize;
        while let Some(r) = set.join_next().await {
            converted += usize::from(r.unwrap_or(false));
        }
        tracing::info!(converted, elapsed_s = started.elapsed().as_secs(), "artwork WebP migration finished");
    });
}
