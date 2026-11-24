//! Panda HTTP server. `main.rs` is a thin wrapper so the router can be built in tests.

mod auth;
pub mod bench;
mod catalog;
mod config;
mod error;
mod routes;
mod services;
mod state;

pub use config::Config;
pub use state::AppState;

use anyhow::Context;
use tokio::net::TcpListener;

/// Run the scanner once, then serve HTTP until Ctrl-C.
pub async fn serve(state: AppState) -> anyhow::Result<()> {
    services::scanner::spawn_scan(state.clone());
    services::scanner::spawn_periodic_scans(state.clone());
    routes::home_more::spawn_warmup(state.clone());
    services::sessions::spawn_reaper(state.sessions.clone());
    services::sessions::spawn_throttle(state.sessions.clone());
    spawn_auth_cleanup(state.clone());
    services::images::spawn_webp_migration(state.clone());
    services::cache::spawn_trim(state.clone());
    services::arr_cleanup::spawn(state.clone());
    services::request_ready::spawn(state.clone());
    services::markers::spawn(state.clone());
    services::ratings::spawn(state.clone());
    services::library_health::spawn(state.clone());
    services::library_watch::spawn(state.clone());
    services::discovery::spawn(&state);

    let listener = TcpListener::bind(&state.config.server.bind)
        .await
        .with_context(|| format!("binding {}", state.config.server.bind))?;
    tracing::info!("listening on http://{}", listener.local_addr()?);

    // Connect info gives rate limiting the client's IP.
    axum::serve(
        listener,
        routes::router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

/// Ctrl-C, or SIGTERM: what launchd, systemd and Docker send to stop a service.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    tracing::info!("shutting down");
}

pub use routes::router;

/// Hourly purge of expired sessions, device codes and invites.
fn spawn_auth_cleanup(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            tick.tick().await;
            if let Err(e) = state.db.purge_expired(services::settings::now()).await {
                tracing::warn!(error = %e, "auth cleanup failed");
            }
        }
    });
}

impl AppState {
    /// The one-time first-run setup token (also printed to the log). `None` once an
    /// account exists. Exposed for embedding and tests.
    pub async fn pending_setup_token(&self) -> Option<String> {
        self.setup_token.lock().await.clone()
    }
}

/// Run a full library scan and wait for it to finish (startup and webhooks use the background version).
pub async fn scan_now(state: &AppState) -> anyhow::Result<()> {
    services::scanner::scan_all_waiting(state).await
}

/// Check every library's storage now (normally once a minute); for tests and tools.
pub async fn check_library_health(state: &AppState) {
    services::library_health::check(state).await;
}
