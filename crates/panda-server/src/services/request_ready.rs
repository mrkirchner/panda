//! Requests arriving: when a requested title reaches the library (Radarr/Sonarr imported it and a
//! scan found it), the request is marked ready and the person who asked is told: their apps show
//! it the next time they open (`GET /api/notifications`), and it's emailed when the server has
//! mail set up (to them, else to their account's owner).
//!
//! Checked a minute after the library changes (the catalog's version moving), from the library
//! itself, as each requester's profile sees it (a title in a library they can't open isn't theirs
//! yet).

use std::collections::HashMap;
use std::time::Duration;

use panda_db::{MediaRequest, RequestKind};

use crate::catalog;
use crate::services::external::{self, Service};
use crate::services::mail::MailConfig;
use crate::state::AppState;

/// How often the library is looked at (only checked when it changed).
const EVERY: Duration = Duration::from_secs(60);

pub(crate) fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut seen_version: Option<i64> = None;
        loop {
            tokio::time::sleep(EVERY).await;
            let Ok(version) = state.db.catalog_version().await else { continue };
            if seen_version == Some(version) {
                continue;
            }
            match check(&state).await {
                Ok(n) => {
                    if n > 0 {
                        tracing::info!(arrived = n, "requested titles arrived");
                    }
                    seen_version = Some(version);
                }
                Err(e) => tracing::warn!(error = %e, "checking requests failed"),
            }
        }
    });
}

/// After a scan: arrivals are told at once, not at the next minute's check.
pub(crate) async fn after_scan(state: &AppState) {
    match check(state).await {
        Ok(n) if n > 0 => tracing::info!(arrived = n, "requested titles arrived"),
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "checking requests failed"),
    }
}

/// Mark requests whose title is now in the requester's library, then email the arrivals.
/// Returns how many arrived.
pub(crate) async fn check(state: &AppState) -> anyhow::Result<usize> {
    let waiting = state.db.waiting_requests().await?;
    let mut by_user: HashMap<i64, Vec<MediaRequest>> = HashMap::new();
    for r in waiting {
        if let Some(uid) = r.user_id {
            by_user.entry(uid).or_default().push(r);
        }
    }
    let now = crate::services::settings::now();
    let mut arrived = 0;
    for (uid, requests) in by_user {
        let titles = crate::routes::titles::movie_titles(state, uid, None).await?;
        let allowed = crate::auth::allowed_libraries(state, uid).await?;
        let series = catalog::series(state, allowed.as_deref()).await?;
        for r in requests {
            let here = match r.kind {
                RequestKind::Movie => {
                    r.tmdb_id.is_some_and(|id| titles.iter().any(|t| t.id == format!("m{id}")))
                }
                RequestKind::Series => {
                    r.tmdb_id.is_some_and(|id| series.iter().any(|s| s.tmdb_id == Some(id)))
                }
            };
            if here {
                state.db.mark_request_ready(r.id, now).await?;
                arrived += 1;
            }
        }
    }
    email_arrivals(state).await?;
    Ok(arrived)
}

/// Email each arrival once: to whoever asked, else their account's owner. Without mail set up
/// (or anyone to write to) they're only shown in the apps.
async fn email_arrivals(state: &AppState) -> anyhow::Result<()> {
    let pending = state.db.unemailed_ready().await?;
    if pending.is_empty() {
        return Ok(());
    }
    let mail = external::read::<MailConfig>(state, Service::Mail).await.ok().flatten();
    for r in pending {
        let sent = match (&mail, r.user_id) {
            (Some(mail), Some(uid)) => match recipient(state, uid).await? {
                Some((to, who)) => {
                    let (subject, body) = message(&r, &who);
                    match mail.send(&to, &subject, body).await {
                        Ok(()) => true,
                        // Tried again at the next change (the mail server may be down).
                        Err(e) => {
                            tracing::warn!(error = %e, request = r.id, "couldn't email an arrival");
                            false
                        }
                    }
                }
                None => true,
            },
            _ => true,
        };
        if sent {
            state.db.mark_ready_emailed(r.id).await?;
        }
    }
    Ok(())
}

/// Where to write about `uid`'s request, and their name: their own email, else the owner's.
async fn recipient(state: &AppState, uid: i64) -> anyhow::Result<Option<(String, String)>> {
    let Some(user) = state.db.user(uid).await? else { return Ok(None) };
    let name = user.display_name.clone().unwrap_or_else(|| user.username.clone());
    if let Some(email) = user.email.clone().filter(|e| !e.is_empty()) {
        return Ok(Some((email, name)));
    }
    let owner = state.db.user(user.account_id).await?;
    Ok(owner.and_then(|o| o.email.filter(|e| !e.is_empty())).map(|e| (e, name)))
}

/// The email: "Dune is ready to watch".
fn message(r: &MediaRequest, who: &str) -> (String, String) {
    let title = match r.year {
        Some(y) => format!("{} ({y})", r.title),
        None => r.title.clone(),
    };
    let what = if r.kind == RequestKind::Series { "show" } else { "movie" };
    (
        format!("{} is ready to watch", r.title),
        format!("The {what} {who} asked for, {title}, is in Panda now.\n\nEnjoy!\n"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_email_names_the_title_and_who_asked() {
        let r = MediaRequest {
            id: 1,
            kind: RequestKind::Movie,
            title: "Dune".into(),
            year: Some(2021),
            tmdb_id: Some(438_631),
            tvdb_id: None,
            status: panda_db::RequestStatus::Approved,
            error: None,
            created_at: String::new(),
            updated_at: String::new(),
            user_id: Some(2),
            poster: None,
            listed: false,
            ready_at: Some(0),
        };
        let (subject, body) = message(&r, "Kids");
        assert_eq!(subject, "Dune is ready to watch");
        assert!(body.contains("The movie Kids asked for, Dune (2021), is in Panda now."), "{body}");
    }
}
