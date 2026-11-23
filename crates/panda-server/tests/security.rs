//! Security tests: what an outsider, a regular user or a leaked URL can and can't do.

mod common;

use axum::http::{StatusCode, header};
use common::*;
use serde_json::json;

#[tokio::test]
async fn everything_requires_auth_and_setup_requires_the_log_token() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut anon = Client::new(&server.app);

    for path in [
        "/api/items",
        "/api/series",
        "/api/libraries",
        "/api/auth/me",
        "/api/admin/users",
        "/api/admin/settings",
        "/api/admin/matches",
        "/api/admin/matches/search?kind=movie&q=x",
        "/api/admin/matches/seasons?series=x",
        "/api/find?q=test",
        "/api/find/more?q=test",
        "/api/find/people?q=test",
        "/api/titles/m1/clip",
        "/api/series/x/clip",
        "/api/items/1/clip",
        "/api/genres",
        "/api/browse/movies",
        "/api/home/more",
        "/api/discover",
        "/api/requests/mine",
        "/api/titles/m1/details",
        "/api/titles/m1/suggestions",
        "/api/discover/movie/603",
        "/api/people/1",
        "/api/series/x/details",
        "/api/auth/profile/sign-in-link",
        "/api/features",
        "/api/libraries/offline",
        "/api/series/x/seasons",
        "/api/series/x/suggestions",
    ] {
        assert_eq!(anon.get(path).await.status, StatusCode::UNAUTHORIZED, "{path} must require auth");
    }
    assert_eq!(anon.get("/api/items/1/stream").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(anon.get("/api/images/w342_x.jpg").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(anon.get("/health").await.status, StatusCode::OK);

    assert_eq!(anon.get("/api/setup").await.json()["needs_setup"], true);
    let res = anon
        .post("/api/setup", json!({ "token": "guess", "username": "evil", "password": "evil password!" }))
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN, "setup must need the token from the server log");

    let token_file = server.state.config.setup_token_path();
    assert!(token_file.exists(), "setup token is written to data/setup-token");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&token_file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let mut admin = admin(&server).await;
    assert!(!token_file.exists(), "token file is deleted after setup");
    let res = anon
        .post(
            "/api/setup",
            json!({ "token": "anything", "username": "second", "password": "second password!" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT, "setup works exactly once");
    assert_eq!(admin.get("/api/auth/me").await.json()["user"]["role"], "admin");
}

#[tokio::test]
async fn passwords_and_secrets_are_never_stored_or_returned_in_plaintext() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;

    let creds = server.state.db.credentials("admin").await.unwrap().unwrap();
    assert!(creds.password_hash.starts_with("$argon2id$"));
    assert!(!creds.password_hash.contains(ADMIN_PASSWORD));

    // The Radarr key from panda.toml was moved into the encrypted store...
    let stored = server.state.db.setting("radarr").await.unwrap().unwrap();
    assert!(stored.encrypted && stored.value.starts_with("v1."));
    assert!(!stored.value.contains(RADARR_KEY));
    // ...and the admin API only says whether it's set.
    let settings = admin.get("/api/admin/settings").await;
    assert_eq!(settings.json()["radarr"]["api_key_set"], true);
    assert!(!settings.text().contains(RADARR_KEY), "API must never return secrets");

    // Session cookies are HttpOnly + SameSite and contain a random token, not user data.
    let mut c = Client::new(&server.app);
    let res = c.post("/api/auth/login", json!({ "username": "admin", "password": ADMIN_PASSWORD })).await;
    let cookie = res.headers[header::SET_COOKIE].to_str().unwrap();
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Lax"), "{cookie}");
    assert!(!cookie.contains("admin"));
}

#[tokio::test]
async fn login_is_rate_limited_and_errors_are_generic() {
    if !ffmpeg_available() {
        return;
    }
    let server = server_behind_proxy().await;
    let _admin = admin(&server).await;
    // A stranger on the internet, through the HTTPS reverse proxy.
    let mut c = Client::new(&server.app);
    c.peer = Some("127.0.0.1:50000".parse().unwrap());
    c.headers =
        vec![("x-forwarded-for".into(), "203.0.113.9".into()), ("x-forwarded-proto".into(), "https".into())];

    let wrong_pw =
        c.post("/api/auth/login", json!({ "username": "admin", "password": "wrong password" })).await;
    let no_user =
        c.post("/api/auth/login", json!({ "username": "nobody", "password": "wrong password" })).await;
    assert_eq!(wrong_pw.status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong_pw.json(), no_user.json(), "don't reveal which usernames exist");

    for _ in 0..5 {
        c.post("/api/auth/login", json!({ "username": "admin", "password": "wrong password" })).await;
    }
    let locked = c.post("/api/auth/login", json!({ "username": "admin", "password": ADMIN_PASSWORD })).await;
    assert_eq!(
        locked.status,
        StatusCode::TOO_MANY_REQUESTS,
        "even the right password is refused while locked"
    );
    assert!(locked.headers.contains_key(header::RETRY_AFTER));

    // ...but the stranger can't lock the owner out at home.
    let mut home = Client::new(&server.app);
    home.peer = Some("192.168.1.20:50001".parse().unwrap());
    let ok = home.post("/api/auth/login", json!({ "username": "admin", "password": ADMIN_PASSWORD })).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.text());
}

#[tokio::test]
async fn passwords_never_cross_the_internet_unencrypted() {
    let server = server().await;
    let _admin = admin(&server).await;
    // Panda's plain HTTP port-forwarded to the internet: refused before any password check.
    let mut remote = Client::new(&server.app);
    remote.peer = Some("203.0.113.9:50000".parse().unwrap());
    let res =
        remote.post("/api/auth/login", json!({ "username": "admin", "password": ADMIN_PASSWORD })).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", res.text());
    assert!(res.text().contains("HTTPS"), "{}", res.text());
    let tv = remote
        .post(
            "/api/auth/device/login",
            json!({ "username": "admin", "password": ADMIN_PASSWORD, "device_name": "TV" }),
        )
        .await;
    assert_eq!(tv.status, StatusCode::UNPROCESSABLE_ENTITY);
    // Over Tailscale it's fine.
    let mut tailnet = Client::new(&server.app);
    tailnet.peer = Some("100.101.102.103:50000".parse().unwrap());
    let ok =
        tailnet.post("/api/auth/login", json!({ "username": "admin", "password": ADMIN_PASSWORD })).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.text());
}

#[tokio::test]
async fn cookie_requests_need_same_origin() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let body = json!({ "role": "user" });

    admin.origin = Some("http://evil.test".into());
    assert_eq!(admin.post("/api/admin/invites", body.clone()).await.status, StatusCode::FORBIDDEN);
    admin.origin = None;
    assert_eq!(admin.post("/api/admin/invites", body.clone()).await.status, StatusCode::FORBIDDEN);
    admin.origin = Some("http://panda.test".into());
    assert_eq!(admin.post("/api/admin/invites", body).await.status, StatusCode::CREATED);
}

#[tokio::test]
async fn users_are_invite_only_and_cannot_reach_admin() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let inv = admin.post("/api/admin/invites", json!({})).await.json();
    let code = inv["code"].as_str().unwrap().to_string();
    // Only the hash is stored, so the code never appears in listings.
    assert!(!admin.get("/api/admin/invites").await.text().contains(&code));

    let mut sam = Client::new(&server.app);
    let body = json!({ "code": code, "username": "sam", "password": "sams long password" });
    assert_eq!(sam.post("/api/auth/invite/accept", body.clone()).await.status, StatusCode::OK);
    let mut eve = Client::new(&server.app);
    let reused = json!({ "code": code, "username": "eve", "password": "eves long password" });
    assert_eq!(
        eve.post("/api/auth/invite/accept", reused).await.status,
        StatusCode::BAD_REQUEST,
        "single use"
    );

    assert_eq!(sam.get("/api/items").await.status, StatusCode::OK);
    assert_eq!(sam.get("/api/admin/users").await.status, StatusCode::FORBIDDEN);
    assert_eq!(sam.post("/api/admin/invites", json!({})).await.status, StatusCode::FORBIDDEN);
    // Mail settings and sign-in links for other profiles are admin-only too.
    let mail =
        json!({ "host": "smtp.example.com", "port": 587, "security": "starttls", "from": "p@example.com" });
    assert_eq!(sam.send("PUT", "/api/admin/settings/mail", Some(mail)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        sam.post("/api/admin/settings/mail/test", json!({ "to": "x@example.com" })).await.status,
        StatusCode::FORBIDDEN
    );
    // Every outside service (services/external.rs) is admin-only, set up or removed; a name
    // that isn't one is unknown even to the admin (never read as some other setting).
    for service in ["radarr", "radarr_4k", "sonarr", "sonarr_4k", "bazarr", "mail"] {
        let path = format!("/api/admin/settings/{service}");
        assert_eq!(sam.send("PUT", &path, Some(json!({}))).await.status, StatusCode::FORBIDDEN, "{service}");
        assert_eq!(sam.send("DELETE", &path, None).await.status, StatusCode::FORBIDDEN, "{service}");
    }
    for name in ["tmdb.read_access_token", "secret.key", "nope"] {
        let path = format!("/api/admin/settings/{name}");
        assert_eq!(admin.send("PUT", &path, Some(json!({}))).await.status, StatusCode::NOT_FOUND, "{name}");
        assert_eq!(admin.send("DELETE", &path, None).await.status, StatusCode::NOT_FOUND, "{name}");
    }
    let cleanup = json!({ "movies": true, "shows": true });
    assert_eq!(
        sam.send("PUT", "/api/admin/settings/cleanup", Some(cleanup)).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(sam.post("/api/admin/settings/cleanup/run", json!({})).await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        sam.send("PUT", "/api/admin/settings/providers/tvmaze", Some(json!({ "enabled": true })))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    // The providers' credits are public (About, before a profile is picked) and carry no secrets.
    let credits = Client::new(&server.app).get("/api/credits").await;
    assert_eq!(credits.status, StatusCode::OK);
    assert!(credits.json().is_array());
    assert!(!credits.text().contains(RADARR_KEY));
    // And a show's episode order.
    assert_eq!(sam.get("/api/admin/matches/episode-order?series=x").await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        sam.send("PUT", "/api/admin/matches/episode-order", Some(json!({ "series": "x", "id": null })))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    // So are the OMDb key, the metadata provider order and per-provider switches.
    assert_eq!(
        sam.send(
            "PUT",
            "/api/admin/settings/provider-switch",
            Some(json!({ "provider": "omdb", "option": "rating.imdb", "on": false }))
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        sam.send("PUT", "/api/admin/settings/providers/omdb", Some(json!({ "api_key": "k" }))).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        sam.send("DELETE", "/api/admin/settings/providers/omdb", None).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        sam.send("PUT", "/api/admin/settings/metadata-order", Some(json!({ "overview": ["omdb"] })))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(sam.get("/api/admin/settings/storage").await.status, StatusCode::FORBIDDEN);
    // Fixing matches (whole titles or one season) is for admins.
    assert_eq!(sam.get("/api/admin/matches").await.status, StatusCode::FORBIDDEN);
    assert_eq!(sam.get("/api/admin/matches/seasons?series=x").await.status, StatusCode::FORBIDDEN);
    let season = json!({ "series": "x", "season": 2, "tmdb_id": 1 });
    assert_eq!(sam.post("/api/admin/matches/season", season).await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        sam.send("DELETE", "/api/admin/matches/season?series=x&season=2", None).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        sam.post("/api/admin/users/1/sign-in-link", json!({ "email": "x@example.com" })).await.status,
        StatusCode::FORBIDDEN
    );
    // Non-admins don't see server paths.
    assert_eq!(sam.get("/api/libraries").await.json()[0]["folders"], serde_json::json!([]));

    let weak = Client::new(&server.app)
        .post("/api/auth/invite/accept", json!({ "code": "x", "username": "x", "password": "short" }))
        .await;
    assert_ne!(weak.status, StatusCode::OK);
}

#[tokio::test]
async fn signed_media_urls_are_scoped_expiring_and_revocable() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let mut sam = invited_user(&server, &mut admin, "sam").await;
    let items = sam.get("/api/items").await.json();
    let (mp4, mkv) = (item_id(&items, "Test Movie"), item_id(&items, "Other Film"));

    let url = sam.post(&format!("/api/items/{mp4}/playback"), json!({})).await.json()["url"]
        .as_str()
        .unwrap()
        .to_string();
    let mut player = Client::new(&server.app);
    player.origin = None;
    assert_eq!(player.get(&url).await.status, StatusCode::OK);

    // The token is bound to one item: reusing it for another is rejected.
    let other = url.replace(&format!("/items/{mp4}/"), &format!("/items/{mkv}/"));
    assert_eq!(player.get(&other).await.status, StatusCode::UNAUTHORIZED);
    // Tampering with the signature fails.
    let mut tampered = url.clone();
    let last = tampered.pop().unwrap();
    tampered.push(if last == 'A' { 'B' } else { 'A' });
    assert_eq!(player.get(&tampered).await.status, StatusCode::UNAUTHORIZED);

    // Disabling the user kills both their session and their outstanding signed URLs.
    let sam_id = sam.get("/api/auth/me").await.json()["user"]["id"].as_i64().unwrap();
    let res =
        admin.send("PATCH", &format!("/api/admin/users/{sam_id}"), Some(json!({ "disabled": true }))).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert_eq!(sam.get("/api/items").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(player.get(&url).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn tv_device_sign_in_flow() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let mut tv = Client::new(&server.app);
    tv.origin = None;

    let start = tv.post("/api/auth/device/start", json!({ "device_name": "Living room TV" })).await.json();
    let device_code = start["device_code"].as_str().unwrap().to_string();
    let user_code = start["user_code"].as_str().unwrap().to_string();
    let poll = json!({ "device_code": device_code });
    assert_eq!(tv.post("/api/auth/device/poll", poll.clone()).await.status, StatusCode::ACCEPTED);

    // Approving requires being signed in; typed codes are normalized.
    let mut anon = Client::new(&server.app);
    assert_eq!(
        anon.post("/api/auth/device/approve", json!({ "user_code": user_code })).await.status,
        StatusCode::UNAUTHORIZED
    );
    let typed = user_code.to_lowercase().replace('-', " ");
    let approved = admin.post("/api/auth/device/approve", json!({ "user_code": typed })).await;
    assert_eq!(approved.json()["device_name"], "Living room TV");

    let res = tv.post("/api/auth/device/poll", poll.clone()).await.json();
    assert_eq!(res["status"], "approved");
    tv.bearer = Some(res["token"].as_str().unwrap().to_string());
    assert_eq!(tv.get("/api/items").await.status, StatusCode::OK);
    assert_eq!(tv.post("/api/auth/device/poll", poll).await.status, StatusCode::GONE, "codes are single use");

    // The admin sees the device and can revoke it.
    let sessions = admin.get("/api/admin/sessions").await.json();
    let device = sessions.as_array().unwrap().iter().find(|s| s["kind"] == "device").unwrap();
    let id = device["id"].as_i64().unwrap();
    assert_eq!(
        admin.send("DELETE", &format!("/api/admin/sessions/{id}"), None).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(tv.get("/api/items").await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn last_admin_cannot_lock_themselves_out() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let me = admin.get("/api/auth/me").await.json()["user"]["id"].as_i64().unwrap();
    for body in [json!({ "role": "user" }), json!({ "disabled": true })] {
        let res = admin.send("PATCH", &format!("/api/admin/users/{me}"), Some(body)).await;
        assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    }
    assert_eq!(
        admin.send("DELETE", &format!("/api/admin/users/{me}"), None).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test]
async fn webhook_requires_its_token() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut hook = Client::new(&server.app);
    hook.origin = None;
    let body = json!({ "eventType": "Test" });
    assert_eq!(hook.post("/webhooks/arr", body.clone()).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(hook.post("/webhooks/arr?token=wrong", body.clone()).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(hook.post("/webhooks/arr?token=hook-secret", body).await.status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn responses_carry_security_headers() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let res = Client::new(&server.app).get("/health").await;
    assert_eq!(res.headers["x-content-type-options"], "nosniff");
    assert_eq!(res.headers["referrer-policy"], "no-referrer");
    assert_eq!(res.headers["x-frame-options"], "DENY");
}

#[tokio::test]
async fn unknown_api_paths_are_json_404s() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let res = Client::new(&server.app).get("/api/does-not-exist").await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.json()["error"], "not found");
}

#[tokio::test]
async fn speedtest_requires_auth_is_exact_uncompressed_and_rate_limited() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut anon = Client::new(&server.app);
    assert_eq!(anon.get("/api/speedtest?bytes=100000").await.status, StatusCode::UNAUTHORIZED);

    let c = admin(&server).await;
    let cookie = c.cookie.clone().unwrap();
    // Raw requests so we can ask for compression and see the exact body size.
    let req = |n: usize| {
        let (app, cookie) = (server.app.clone(), cookie.clone());
        async move {
            let r = axum::http::Request::get(format!("/api/speedtest?bytes={n}"))
                .header(header::HOST, "panda.test")
                .header(header::COOKIE, cookie)
                .header(header::ACCEPT_ENCODING, "gzip, br")
                .body(axum::body::Body::empty())
                .unwrap();
            let res = tower::ServiceExt::oneshot(app, r).await.unwrap();
            let enc = res.headers().get(header::CONTENT_ENCODING).cloned();
            let status = res.status();
            let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
            (status, enc, body.len())
        }
    };
    let (status, enc, len) = req(1_000_000).await;
    assert_eq!(status, StatusCode::OK);
    assert!(enc.is_none(), "speed test data must never be compressed");
    assert_eq!(len, 1_000_000);
    assert_eq!(req(usize::MAX).await.2, 64 * 1024 * 1024, "capped at 64 MiB");
    let mut limited = false;
    for _ in 0..40 {
        if req(65_536).await.0 == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
            break;
        }
    }
    assert!(limited, "speed tests are rate limited per user");
}

/// Pair a TV (approved by `approver`), returning (`device_token`, `profile_token`).
async fn pair(
    server: &TestServer,
    approver: &mut Client,
    device_token: Option<&str>,
) -> (Option<String>, String) {
    let mut tv = Client::new(&server.app);
    tv.origin = None;
    let start = tv
        .post("/api/auth/device/start", json!({ "device_name": "Living room", "device_token": device_token }))
        .await
        .json();
    let code = start["user_code"].as_str().unwrap().to_string();
    assert_eq!(
        approver.post("/api/auth/device/approve", json!({ "user_code": code })).await.status,
        StatusCode::OK
    );
    let res = tv.post("/api/auth/device/poll", json!({ "device_code": start["device_code"] })).await.json();
    (res["device_token"].as_str().map(String::from), res["token"].as_str().unwrap().to_string())
}

/// A TV's own client, and helpers to read its profile picker.
fn tv_client(server: &TestServer) -> Client {
    let mut tv = Client::new(&server.app);
    tv.origin = None;
    tv
}

fn profile_names(v: &serde_json::Value) -> Vec<String> {
    v["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["display_name"].as_str().or(p["username"].as_str()).unwrap().to_string())
        .collect()
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // One end-to-end story: pairing, PINs, switching, removal.
async fn tv_profiles_switch_with_server_side_pin() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let mut friend = invited_user(&server, &mut admin, "friend").await;
    let friend_id = friend.get("/api/auth/me").await.json()["user"]["id"].as_i64().unwrap();

    // Someone with a password sets their own PIN (needs the password; stored hashed).
    let pin = |p: &str| json!({ "current_password": "another long password", "pin": p });
    assert_eq!(friend.send("PUT", "/api/auth/pin", Some(pin("4821"))).await.status, StatusCode::NO_CONTENT);
    assert_eq!(friend.get("/api/auth/pin").await.json(), json!({ "has_pin": true }), "only a flag");
    assert_eq!(
        friend.send("PUT", "/api/auth/pin", Some(pin("12"))).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );

    // First pairing creates the device credential; signing in again reuses the device.
    let (device, admin_token) = pair(&server, &mut admin, None).await;
    let device = device.expect("first pairing returns a device credential");
    let (again, admin_token2) = pair(&server, &mut admin, Some(&device)).await;
    assert!(again.is_none(), "a paired TV keeps its credential");

    let mut tv = tv_client(&server);
    // Sam is a profile in the admin's account (added on the TV); the admin gives it a PIN.
    let sam =
        tv.post("/api/auth/device/profiles/new", json!({ "device_token": device, "name": "Sam" })).await;
    assert_eq!(sam.status, StatusCode::CREATED, "{}", sam.text());
    let sam_id = sam.json()["id"].as_i64().unwrap();
    let set =
        admin.send("PUT", &format!("/api/admin/users/{sam_id}/pin"), Some(json!({ "pin": "4821" }))).await;
    assert_eq!(set.status, StatusCode::NO_CONTENT);
    let profiles = tv.post("/api/auth/device/profiles", json!({ "device_token": device })).await.json();
    assert_eq!(profiles["admin"], true, "an admin's TV offers the Debug page");
    let listed: Vec<_> = profiles["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["user_id"].as_i64().unwrap(), p["has_pin"].clone()))
        .collect();
    let admin_id = admin.get("/api/auth/me").await.json()["user"]["id"].as_i64().unwrap();
    assert_eq!(
        listed,
        [(admin_id, json!(false)), (sam_id, json!(true))],
        "the account's profiles, owner first"
    );

    // Only one profile is signed in per TV: the second sign-in ended the first there.
    tv.bearer = Some(admin_token);
    assert_eq!(tv.get("/api/auth/me").await.status, StatusCode::UNAUTHORIZED);
    tv.bearer = Some(admin_token2.clone());
    assert_eq!(tv.get("/api/auth/me").await.status, StatusCode::OK);
    tv.bearer = None;

    // Wrong device credential, or a profile of another account.
    assert_eq!(
        tv.post("/api/auth/device/profiles", json!({ "device_token": "nope" })).await.status,
        StatusCode::UNAUTHORIZED
    );
    let sw =
        |user_id: i64, pin: Option<&str>| json!({ "device_token": device, "user_id": user_id, "pin": pin });
    assert_eq!(tv.post("/api/auth/device/switch", sw(friend_id, None)).await.status, StatusCode::FORBIDDEN);

    // PIN enforced by the server.
    assert_eq!(
        tv.post("/api/auth/device/switch", sw(sam_id, None)).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        tv.post("/api/auth/device/switch", sw(sam_id, Some("0000"))).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let ok = tv.post("/api/auth/device/switch", sw(sam_id, Some("4821"))).await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(ok.json()["user"]["id"], sam_id);
    tv.bearer = Some(admin_token2);
    assert_eq!(
        tv.get("/api/auth/me").await.status,
        StatusCode::UNAUTHORIZED,
        "switching ends the previous session"
    );
    tv.bearer = None;
    // Guessing is locked out.
    let mut locked = false;
    for _ in 0..6 {
        if tv.post("/api/auth/device/switch", sw(sam_id, Some("1111"))).await.status
            == StatusCode::TOO_MANY_REQUESTS
        {
            locked = true;
            break;
        }
    }
    assert!(locked, "PIN guessing must be rate limited");

    // Removing the TV signs everyone out and invalidates the device credential.
    let current = ok.json()["token"].as_str().unwrap().to_string();
    let dev_id = admin.get("/api/admin/devices").await.json()[0]["device"]["id"].as_i64().unwrap();
    assert_eq!(
        admin.send("DELETE", &format!("/api/admin/devices/{dev_id}"), None).await.status,
        StatusCode::NO_CONTENT
    );
    tv.bearer = Some(current);
    assert_eq!(tv.get("/api/auth/me").await.status, StatusCode::UNAUTHORIZED);
    tv.bearer = None;
    assert_eq!(
        tv.post("/api/auth/device/profiles", json!({ "device_token": device })).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // One story: two accounts, their TVs and profiles, My List, limits.
async fn accounts_keep_their_profiles_and_tvs_apart() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let mut friend = invited_user(&server, &mut admin, "friend").await;

    // Each account pairs its own TV and sees only its own profiles.
    let (home_tv, _) = pair(&server, &mut admin, None).await;
    let home_tv = home_tv.unwrap();
    let (friends_tv, _) = pair(&server, &mut friend, None).await;
    let friends_tv = friends_tv.unwrap();
    let mut tv = tv_client(&server);
    let list = |tv: &str| json!({ "device_token": tv });
    assert_eq!(profile_names(&tv.post("/api/auth/device/profiles", list(&home_tv)).await.json()), ["admin"]);
    assert_eq!(
        profile_names(&tv.post("/api/auth/device/profiles", list(&friends_tv)).await.json()),
        ["friend"]
    );
    // Only an admin's TV offers the Debug page.
    assert_eq!(tv.post("/api/auth/device/profiles", list(&friends_tv)).await.json()["admin"], false);

    // Anyone with the TV adds a profile to its account, by name; no codes, no password.
    let add = |tv: &str, name: &str| json!({ "device_token": tv, "name": name });
    let kid = tv.post("/api/auth/device/profiles/new", add(&home_tv, "Kiddo")).await;
    assert_eq!(kid.status, StatusCode::CREATED, "{}", kid.text());
    let kid = kid.json();
    assert_eq!(kid["managed"], true);
    let kid_id = kid["id"].as_i64().unwrap();
    let kid_username = kid["username"].as_str().unwrap().to_string();
    assert_eq!(
        profile_names(&tv.post("/api/auth/device/profiles", list(&home_tv)).await.json()),
        ["admin", "Kiddo"]
    );
    assert_eq!(
        profile_names(&tv.post("/api/auth/device/profiles", list(&friends_tv)).await.json()),
        ["friend"],
        "other accounts never see it"
    );
    assert_eq!(
        tv.post("/api/auth/device/profiles/new", add("nope", "X")).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert!(tv.post("/api/auth/device/profiles/new", add(&home_tv, "  ")).await.status.is_client_error());
    // It can never sign in with a password, whatever is tried.
    let mut anon = Client::new(&server.app);
    for pw in ["", "Kiddo", "password"] {
        let r = anon.post("/api/auth/login", json!({ "username": kid_username, "password": pw })).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    }

    // A TV never mixes accounts: the friend can't sign in on the admin's TV, nor reach its kid.
    let mut friends_phone_tv = tv_client(&server);
    let start = friends_phone_tv
        .post("/api/auth/device/start", json!({ "device_name": "Living room", "device_token": home_tv }))
        .await
        .json();
    let approve = friend.post("/api/auth/device/approve", json!({ "user_code": start["user_code"] })).await;
    assert_eq!(approve.status, StatusCode::OK);
    let poll =
        friends_phone_tv.post("/api/auth/device/poll", json!({ "device_code": start["device_code"] })).await;
    assert_eq!(poll.status, StatusCode::FORBIDDEN);
    let sw = |tv: &str| json!({ "device_token": tv, "user_id": kid_id });
    assert_eq!(tv.post("/api/auth/device/switch", sw(&friends_tv)).await.status, StatusCode::FORBIDDEN);
    let kid_session = tv.post("/api/auth/device/switch", sw(&home_tv)).await;
    assert_eq!(kid_session.status, StatusCode::OK);
    let mut kid_client = tv_client(&server);
    kid_client.bearer = Some(kid_session.json()["token"].as_str().unwrap().to_string());

    // My List is per profile and limited to what the account may see.
    let title = admin.get("/api/titles").await.json()[0]["id"].as_str().unwrap().to_string();
    let fav = json!({ "kind": "title", "id": title });
    assert_eq!(
        kid_client.send("PUT", "/api/favorites", Some(fav.clone())).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(kid_client.get("/api/favorites").await.json().as_array().unwrap().len(), 1);
    assert!(admin.get("/api/favorites").await.json().as_array().unwrap().is_empty(), "lists are per profile");
    // Library access is set on the account's owner and applies to its profiles.
    let empty_lib = admin
        .post(
            "/api/admin/libraries",
            json!({ "name": "Empty", "kind": "movies", "path": server.dir.path().join("data") }),
        )
        .await
        .json()["id"]
        .as_i64()
        .unwrap();
    let friend_id = friend.get("/api/auth/me").await.json()["user"]["id"].as_i64().unwrap();
    let restrict = json!({ "libraries": [empty_lib] });
    let r = admin.send("PATCH", &format!("/api/admin/users/{kid_id}"), Some(restrict.clone())).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "set on the owner, not a profile");
    let r = admin.send("PATCH", &format!("/api/admin/users/{friend_id}"), Some(restrict)).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let friends_kid = tv.post("/api/auth/device/profiles/new", add(&friends_tv, "Junior")).await.json();
    let junior = tv
        .post("/api/auth/device/switch", json!({ "device_token": friends_tv, "user_id": friends_kid["id"] }))
        .await
        .json();
    let mut junior_client = tv_client(&server);
    junior_client.bearer = Some(junior["token"].as_str().unwrap().to_string());
    assert!(junior_client.get("/api/titles").await.json().as_array().unwrap().is_empty());
    // Details pages follow the same access: none for a title outside the account's libraries.
    let details = format!("/api/titles/{title}/details");
    assert_eq!(junior_client.get(&details).await.status, StatusCode::NOT_FOUND);
    let suggestions = format!("/api/titles/{title}/suggestions");
    assert_eq!(junior_client.get(&suggestions).await.status, StatusCode::NOT_FOUND);
    // And a movie's collection.
    let collection = format!("/api/titles/{title}/collection");
    assert_eq!(junior_client.get(&collection).await.status, StatusCode::NOT_FOUND);
    // A genre's page lists only titles the account may see: none, so no page at all.
    assert_eq!(junior_client.get("/api/genres/Drama").await.status, StatusCode::NOT_FOUND);
    // Nor a Movies or Shows page.
    assert_eq!(junior_client.get("/api/browse/movies").await.status, StatusCode::NOT_FOUND);
    assert_eq!(junior_client.get("/api/browse/shows").await.status, StatusCode::NOT_FOUND);
    // Nor a library's page: not one outside the account's libraries (asked for by its id), and
    // its own empty one has none either.
    let libraries = admin.get("/api/libraries").await.json();
    let other_lib = libraries
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["id"].as_i64().unwrap())
        .find(|id| *id != empty_lib)
        .unwrap();
    let lib_page = format!("/api/browse/library/{other_lib}");
    assert_eq!(admin.get(&lib_page).await.status, StatusCode::OK, "the admin sees it");
    assert_eq!(junior_client.get(&lib_page).await.status, StatusCode::NOT_FOUND);
    let lib_page = format!("/api/browse/library/{empty_lib}");
    assert_eq!(junior_client.get(&lib_page).await.status, StatusCode::NOT_FOUND);
    // A picture from a title's art only from titles the profile can see: any other image key
    // (one it guessed, or a title outside its libraries) is refused.
    for avatar in ["art:0123456789abcdef", "art:../secret", "art:"] {
        let r = junior_client.send("PATCH", "/api/auth/profile", Some(json!({ "avatar": avatar }))).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{avatar}");
        let r = admin.send("PATCH", "/api/auth/profile", Some(json!({ "avatar": avatar }))).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{avatar}");
    }
    assert_eq!(admin.get(&suggestions).await.json(), json!([]), "no TMDB or Radarr in tests: none");
    let res = admin.get(&details).await;
    assert_eq!(res.status, StatusCode::OK, "no TMDB in tests: an empty page, not an error");
    assert!(res.json()["cast"].as_array().unwrap().is_empty());
    assert_eq!(junior_client.send("PUT", "/api/favorites", Some(fav)).await.status, StatusCode::NOT_FOUND);

    // An account holds at most eight profiles (admin + Kiddo + six more).
    for i in 0..6 {
        let r = tv.post("/api/auth/device/profiles/new", add(&home_tv, &format!("Kid {i}"))).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    }
    assert_eq!(
        tv.post("/api/auth/device/profiles/new", add(&home_tv, "One more")).await.status,
        StatusCode::CONFLICT
    );

    // Deleting an account (its owner) deletes its profiles and TVs; your own can't be.
    let me = admin.get("/api/auth/me").await.json()["user"]["id"].as_i64().unwrap();
    let r = admin.send("DELETE", &format!("/api/admin/users/{me}"), None).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = admin.send("DELETE", &format!("/api/admin/users/{friend_id}"), None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(junior_client.get("/api/auth/me").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        tv.post("/api/auth/device/profiles", list(&friends_tv)).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn profiles_delete_themselves_but_never_the_account_owner() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    // The owner (the account's primary profile) can't delete itself from a TV.
    let res = admin.send("DELETE", "/api/auth/profile", None).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN, "{}", res.text());
    let mut friend = invited_user(&server, &mut admin, "friend").await;
    assert_eq!(friend.send("DELETE", "/api/auth/profile", None).await.status, StatusCode::FORBIDDEN);

    // Another profile deletes only itself (there's no id to aim at anyone else)...
    let (tv_token, _) = pair(&server, &mut admin, None).await;
    let tv_token = tv_token.unwrap();
    let mut tv = tv_client(&server);
    let kid = tv
        .post("/api/auth/device/profiles/new", json!({ "device_token": tv_token, "name": "Kid" }))
        .await
        .json();
    let other = tv
        .post("/api/auth/device/profiles/new", json!({ "device_token": tv_token, "name": "Other" }))
        .await
        .json();
    let session = tv
        .post("/api/auth/device/switch", json!({ "device_token": tv_token, "user_id": kid["id"] }))
        .await
        .json();
    tv.bearer = Some(session["token"].as_str().unwrap().to_string());
    assert_eq!(tv.send("DELETE", "/api/auth/profile", None).await.status, StatusCode::NO_CONTENT);
    // ...and its session ends with it.
    assert_eq!(tv.get("/api/auth/me").await.status, StatusCode::UNAUTHORIZED);
    tv.bearer = None;
    let left = profile_names(
        &tv.post("/api/auth/device/profiles", json!({ "device_token": tv_token })).await.json(),
    );
    assert_eq!(left, ["admin".to_string(), other["display_name"].as_str().unwrap().to_string()]);
}

/// TVs signed in before device pairing existed upgrade themselves once; nothing else can.
#[tokio::test]
async fn legacy_tv_sessions_upgrade_to_devices_once() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    // The browser session can't register itself as a TV.
    assert_eq!(admin.post("/api/auth/device/register", json!({})).await.status, StatusCode::CONFLICT);

    // A pre-pairing TV session, as old databases have.
    let admin_id = admin.get("/api/auth/me").await.json()["user"]["id"].as_i64().unwrap();
    let raw = panda_auth::token::generate().unwrap();
    server
        .state
        .db
        .create_session(
            admin_id,
            &panda_auth::token::digest(&raw),
            panda_db::SessionKind::Device,
            Some("Old TV"),
            0,
            i64::MAX / 2,
        )
        .await
        .unwrap();
    let mut tv = Client::new(&server.app);
    tv.origin = None;
    tv.bearer = Some(raw);
    let res = tv.post("/api/auth/device/register", json!({})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    let device = res.json()["device_token"].as_str().unwrap().to_string();
    assert_eq!(
        tv.post("/api/auth/device/register", json!({})).await.status,
        StatusCode::CONFLICT,
        "only once"
    );

    // It's now a TV of the admin's account with a working profile picker.
    tv.bearer = None;
    let profiles = tv.post("/api/auth/device/profiles", json!({ "device_token": device })).await.json();
    assert_eq!(profiles["device"]["account_id"], admin_id);
    assert_eq!(profiles["profiles"][0]["username"], "admin");
}

#[tokio::test]
async fn scrub_previews_need_a_signature_for_that_item() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let items = admin.get("/api/items").await.json();
    let (mp4, mkv) = (item_id(&items, "Test Movie"), item_id(&items, "Other Film"));
    let play = admin.post(&format!("/api/items/{mp4}/playback"), json!({})).await.json();
    let url = play["preview_url"].as_str().expect("playback offers scrub previews").replace("{secs}", "0");

    let mut player = Client::new(&server.app);
    player.origin = None;
    // No signature: rejected. The item's signature: a picture.
    let bare = url.split('?').next().unwrap().to_string();
    assert_eq!(player.get(&bare).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(player.get(&url).await.status, StatusCode::OK);
    // Bound to its item.
    let other = url.replace(&format!("/items/{mp4}/"), &format!("/items/{mkv}/"));
    assert_eq!(player.get(&other).await.status, StatusCode::UNAUTHORIZED);
    // The time must be a number of seconds, nothing else.
    let token = url.split("?t=").nth(1).unwrap();
    for bad in ["..%2F..%2Fsecret.key", "-5", "abc"] {
        let res = player.get(&format!("/api/items/{mp4}/preview/{bad}?t={token}")).await;
        assert!(res.status.is_client_error() && res.status != StatusCode::OK, "{bad}: {}", res.status);
    }
}

#[tokio::test]
async fn image_subtitles_need_a_signature_for_that_item() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let items = admin.get("/api/items").await.json();
    let (mp4, mkv) = (item_id(&items, "Test Movie"), item_id(&items, "Other Film"));
    let play = admin.post(&format!("/api/items/{mp4}/playback"), json!({})).await.json();
    let token = play["preview_url"].as_str().unwrap().split("?t=").nth(1).unwrap().to_string();
    let mut player = Client::new(&server.app);
    player.origin = None;
    // Unsigned, or signed for another item: refused before anything else.
    assert_eq!(
        player.get(&format!("/api/items/{mp4}/subtitles/2/images")).await.status,
        StatusCode::UNAUTHORIZED
    );
    let other = format!("/api/items/{mkv}/subtitles/2/images?t={token}");
    assert_eq!(player.get(&other).await.status, StatusCode::UNAUTHORIZED);
    // Signed, but the test file has no PGS track: not found. Only `<n>_<n>.png` names are served.
    let none = format!("/api/items/{mp4}/subtitles/2/images?t={token}");
    assert_eq!(player.get(&none).await.status, StatusCode::NOT_FOUND);
    for file in ["track.sup", "done", "..%2F..%2Fsecret.key"] {
        let res = player.get(&format!("/api/items/{mp4}/subtitles/2/images/{file}?t={token}")).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{file}");
    }
}

#[tokio::test]
async fn subtitle_files_need_a_signature_and_are_named_by_id_only() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let items = admin.get("/api/items").await.json();
    let (mp4, mkv) = (item_id(&items, "Test Movie"), item_id(&items, "Other Film"));
    let folder = server.dir.path().join("movies/Test Movie (2020)");
    std::fs::write(folder.join("Test Movie (2020).en.srt"), "1\n00:00:00,000 --> 00:00:01,000\nHi\n")
        .unwrap();
    let play = admin.post(&format!("/api/items/{mp4}/playback"), json!({})).await.json();
    let url = play["subtitles"].as_array().unwrap().iter().find(|t| t["external"] == true).unwrap()["url"]
        .as_str()
        .unwrap()
        .to_string();
    let mut player = Client::new(&server.app);
    player.origin = None;
    assert_eq!(player.get(&url).await.status, StatusCode::OK);
    // Unsigned, or the signature moved to another item: refused.
    let bare = url.split('?').next().unwrap().to_string();
    assert_eq!(player.get(&bare).await.status, StatusCode::UNAUTHORIZED);
    let other = url.replace(&format!("/items/{mp4}/"), &format!("/items/{mkv}/"));
    assert_eq!(player.get(&other).await.status, StatusCode::UNAUTHORIZED);
    // Only the id of one of this video's sidecars works: never a name or a path.
    let token = url.split("?t=").nth(1).unwrap();
    for bad in ["Test%20Movie%20(2020).en.srt", "..%2F..%2Fdata%2Fsecret.key", "0000000000000000", "subs.srt"]
    {
        let res = player.get(&format!("/api/items/{mp4}/subtitles/files/{bad}?t={token}")).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{bad}");
    }
}

#[tokio::test]
async fn only_admins_run_the_stream_test_and_set_the_encode_limit() {
    let server = server().await;
    let mut admin = admin(&server).await;
    let mut friend = invited_user(&server, &mut admin, "friend").await;
    assert_eq!(friend.get("/api/admin/bench").await.status, StatusCode::FORBIDDEN);
    assert_eq!(friend.send("POST", "/api/admin/bench", None).await.status, StatusCode::FORBIDDEN);
    let r = friend.send("PUT", "/api/admin/settings/transcoding", Some(json!({ "max_hardware": 64 }))).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);

    // The admin sets a limit: applied at once (the dashboard shows it), and checked.
    let r = admin.send("PUT", "/api/admin/settings/transcoding", Some(json!({ "max_hardware": 6 }))).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(admin.get("/api/admin/bench").await.json()["hardware_limit"], 6);
    assert_eq!(admin.get("/api/admin/streams").await.json()["limits"]["hardware"], 6);
    for bad in [0, 65] {
        let r =
            admin.send("PUT", "/api/admin/settings/transcoding", Some(json!({ "max_hardware": bad }))).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
    }

    // A run (the test library has no long films, so it finds nothing to measure) ends with a report.
    assert_eq!(admin.send("POST", "/api/admin/bench", None).await.status, StatusCode::ACCEPTED);
    let mut done = serde_json::Value::Null;
    for _ in 0..100 {
        done = admin.get("/api/admin/bench").await.json();
        if done["progress"]["running"] == false {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(done["progress"]["running"], false, "{done}");
    assert!(done["report"]["ffmpeg"]["version"].is_string(), "{done}");
}

#[tokio::test]
async fn the_tv_app_in_a_browser_signs_in_from_that_browsers_web_session_only() {
    let server = server().await;
    let mut web = admin(&server).await; // a browser: the cookie session from signing in
    let body = json!({ "device_name": "Browser" });

    // No session at all: refused.
    let mut anon = Client::new(&server.app);
    assert_eq!(
        anon.post("/api/auth/device/from-browser", body.clone()).await.status,
        StatusCode::UNAUTHORIZED
    );

    // Another site making this browser ask (its cookie rides along): refused by the origin check.
    let mut foreign = Client::new(&server.app);
    foreign.cookie = web.cookie.clone();
    foreign.origin = Some("http://evil.example".into());
    assert_eq!(
        foreign.post("/api/auth/device/from-browser", body.clone()).await.status,
        StatusCode::FORBIDDEN
    );

    // The browser itself (same site): a device of its account and a session that works.
    let r = web.post("/api/auth/device/from-browser", body.clone()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let paired = r.json();
    let (token, device) =
        (paired["token"].as_str().unwrap().to_string(), paired["device_token"].as_str().unwrap().to_string());
    let mut tv = Client::new(&server.app);
    tv.bearer = Some(token.clone());
    assert_eq!(tv.get("/api/auth/me").await.json()["user"]["username"], "admin");

    // A token (a TV's, or this one) can't mint more devices: only a browser's own sign-in can.
    let r = tv.post("/api/auth/device/from-browser", body.clone()).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    // Paired before: the browser's device signs in again, no second device.
    let r = web.post("/api/auth/device/from-browser", json!({ "device_token": device })).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.json()["device_token"].is_null(), "no new device credential");
    // Another account's device credential can't be borrowed.
    let mut other = invited_user(&server, &mut web, "other").await;
    let r = other.post("/api/auth/device/from-browser", json!({ "device_token": device })).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn subtitle_search_needs_a_session_admin_setup_and_library_access() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let mp4 = item_id(&admin.get("/api/items").await.json(), "Test Movie");
    let bazarr = fake_bazarr(server.dir.path().join("movies/Test Movie (2020)")).await;
    // Only an admin sets Bazarr up.
    let mut friend = invited_user(&server, &mut admin, "friend").await;
    let setup = json!({ "url": bazarr, "api_key": "bazarr-key" });
    assert_eq!(
        friend.send("PUT", "/api/admin/settings/bazarr", Some(setup.clone())).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(admin.send("PUT", "/api/admin/settings/bazarr", Some(setup)).await.status, StatusCode::OK);
    // No session: refused.
    let mut anon = Client::new(&server.app);
    let r = anon.post(&format!("/api/items/{mp4}/subtitles/find"), json!({ "language": "en" })).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    // A profile that can't see the movie's library can't make Bazarr search for it.
    let empty = server.dir.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    let lib = admin
        .post("/api/admin/libraries", json!({ "name": "Empty", "kind": "movies", "path": empty }))
        .await
        .json()["id"]
        .as_i64()
        .unwrap();
    let friend_id = friend.get("/api/auth/me").await.json()["user"]["id"].as_i64().unwrap();
    let r = admin
        .send("PATCH", &format!("/api/admin/users/{friend_id}"), Some(json!({ "libraries": [lib] })))
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = friend.post(&format!("/api/items/{mp4}/subtitles/find"), json!({ "language": "en" })).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert!(
        !server.dir.path().join("movies/Test Movie (2020)/Test Movie (2020).en.srt").exists(),
        "no search ran"
    );
}

#[tokio::test]
async fn another_versions_subtitles_follow_library_access() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    // A 4K version of the movie in a second library, with an English file only there.
    let k4 = server.dir.path().join("movies4k/Test Movie (2020)");
    std::fs::create_dir_all(&k4).unwrap();
    let src = server.dir.path().join("movies/Test Movie (2020)/Test Movie (2020).mp4");
    std::fs::copy(&src, k4.join("Test Movie (2020).mp4")).unwrap();
    std::fs::write(k4.join("Test Movie (2020).en.srt"), "1\n00:00:00,000 --> 00:00:01,000\nSecret 4K\n")
        .unwrap();
    let libs_before: Vec<i64> = admin
        .get("/api/libraries")
        .await
        .json()
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["id"].as_i64().unwrap())
        .collect();
    let r = admin
        .post(
            "/api/admin/libraries",
            json!({ "name": "4K", "kind": "movies", "path": server.dir.path().join("movies4k") }),
        )
        .await;
    assert!(r.status.is_success(), "{}", r.text());
    panda_server::scan_now(&server.state).await.unwrap();
    let plain = item_id(&admin.get("/api/items").await.json(), "Test Movie");
    let english = |play: &serde_json::Value| {
        play["subtitles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["external"] == true && t["language"] == "en")
            .cloned()
    };

    // The admin sees both libraries: the 4K version's file is offered.
    let play = admin.post(&format!("/api/items/{plain}/playback"), json!({})).await.json();
    let en = english(&play).expect("offered to someone who can see the 4K library");
    let file_id = en["key"].as_str().unwrap().trim_start_matches('f').to_string();

    // A friend limited to the first library: not offered, and not served by its id either.
    let mut friend = invited_user(&server, &mut admin, "friend").await;
    let friend_id = friend.get("/api/auth/me").await.json()["user"]["id"].as_i64().unwrap();
    let r = admin
        .send("PATCH", &format!("/api/admin/users/{friend_id}"), Some(json!({ "libraries": libs_before })))
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let play = friend.post(&format!("/api/items/{plain}/playback"), json!({})).await.json();
    assert!(english(&play).is_none(), "{play}");
    let url = play["url"].as_str().unwrap();
    let token = url.split("?t=").nth(1).unwrap();
    let mut player = Client::new(&server.app);
    player.origin = None;
    let res = player.get(&format!("/api/items/{plain}/subtitles/files/{file_id}?t={token}")).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn tv_profiles_manage_their_pin_and_changes_need_the_current_one() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let (tv_token, _) = pair(&server, &mut admin, None).await;
    let tv_token = tv_token.unwrap();
    let mut tv = tv_client(&server);
    let kid = tv
        .post("/api/auth/device/profiles/new", json!({ "device_token": tv_token, "name": "Kid" }))
        .await
        .json();
    let sw = |pin: Option<&str>| json!({ "device_token": tv_token, "user_id": kid["id"], "pin": pin });
    let session = tv.post("/api/auth/device/switch", sw(None)).await.json();
    tv.bearer = Some(session["token"].as_str().unwrap().to_string());

    // A first PIN needs nothing more; a bad one is refused.
    let set = |pin: Option<&str>, current: Option<&str>| json!({ "pin": pin, "current_pin": current });
    assert_eq!(
        tv.send("PUT", "/api/auth/profile/pin", Some(set(Some("12"), None))).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        tv.send("PUT", "/api/auth/profile/pin", Some(set(Some("2468"), None))).await.status,
        StatusCode::NO_CONTENT
    );
    // Changing or removing it needs the current PIN.
    assert_eq!(
        tv.send("PUT", "/api/auth/profile/pin", Some(set(None, None))).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        tv.send("PUT", "/api/auth/profile/pin", Some(set(None, Some("0000")))).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        tv.send("PUT", "/api/auth/profile/pin", Some(set(Some("1357"), Some("2468")))).await.status,
        StatusCode::NO_CONTENT
    );
    // The new PIN is what switching asks for.
    let mut other = tv_client(&server);
    assert_eq!(
        other.post("/api/auth/device/switch", sw(Some("2468"))).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    // Guessing the current PIN here is limited too.
    let mut locked = false;
    for _ in 0..6 {
        if tv.send("PUT", "/api/auth/profile/pin", Some(set(None, Some("1111")))).await.status
            == StatusCode::TOO_MANY_REQUESTS
        {
            locked = true;
            break;
        }
    }
    assert!(locked, "PIN guessing must be rate limited");
}

#[tokio::test]
async fn tvs_sign_in_with_a_password_and_never_mix_accounts() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let friend = invited_user(&server, &mut admin, "friend").await;
    drop(friend);
    let mut tv = tv_client(&server);
    let login = |user: &str, pw: &str, device: Option<&str>| json!({ "username": user, "password": pw, "device_name": "Living room", "device_token": device });

    // A new TV: signed in, with its own device credential (no code anywhere).
    let res = tv.post("/api/auth/device/login", login("friend", "another long password", None)).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    let body = res.json();
    let device = body["device_token"].as_str().unwrap().to_string();
    tv.bearer = Some(body["token"].as_str().unwrap().to_string());
    assert_eq!(tv.get("/api/auth/me").await.json()["user"]["username"], "friend");
    tv.bearer = None;

    // Wrong passwords and unknown names look the same.
    let wrong = tv.post("/api/auth/device/login", login("friend", "nope nope nope", None)).await;
    let unknown = tv.post("/api/auth/device/login", login("nobody", "nope nope nope", None)).await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    assert_eq!((unknown.status, unknown.text()), (wrong.status, wrong.text()));

    // That TV belongs to the friend's account: the admin can't sign in on it.
    let other = tv.post("/api/auth/device/login", login("admin", ADMIN_PASSWORD, Some(&device))).await;
    assert_eq!(other.status, StatusCode::FORBIDDEN);
    // A made-up device credential is refused before any password check.
    let fake =
        tv.post("/api/auth/device/login", login("friend", "another long password", Some("nope"))).await;
    assert_eq!(fake.status, StatusCode::UNAUTHORIZED);

    // Profiles without a password (made on a TV) can never sign in this way.
    let kid = tv
        .post("/api/auth/device/profiles/new", json!({ "device_token": device, "name": "Kid" }))
        .await
        .json();
    let kid_name = kid["username"].as_str().unwrap().to_string();
    assert_eq!(
        tv.post("/api/auth/device/login", login(&kid_name, "", Some(&device))).await.status,
        StatusCode::UNAUTHORIZED
    );

    // Guessing is limited (from home: per address; from outside: also per username).
    let mut limited = false;
    for _ in 0..25 {
        if tv.post("/api/auth/device/login", login("friend", "guess guess guess", None)).await.status
            == StatusCode::TOO_MANY_REQUESTS
        {
            limited = true;
            break;
        }
    }
    assert!(limited, "password guessing must be rate limited");
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // One story: link, password, sign-in, turning it off.
async fn profiles_get_their_own_sign_in_through_a_one_time_link() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let (device, _) = pair(&server, &mut admin, None).await;
    let device = device.unwrap();
    let mut tv = tv_client(&server);
    let sam = tv
        .post("/api/auth/device/profiles/new", json!({ "device_token": device, "name": "Sam" }))
        .await
        .json();
    let sam_id = sam["id"].clone();
    let session =
        tv.post("/api/auth/device/switch", json!({ "device_token": device, "user_id": sam_id })).await.json();
    tv.bearer = Some(session["token"].as_str().unwrap().to_string());

    // Sam's profile makes a link for Sam's email (a bad address is refused).
    let bad = tv.post("/api/auth/profile/sign-in-link", json!({ "email": "not an email" })).await;
    assert_eq!(bad.status, StatusCode::UNPROCESSABLE_ENTITY);
    let link = tv.post("/api/auth/profile/sign-in-link", json!({ "email": "Sam@Example.com" })).await;
    assert_eq!(link.status, StatusCode::OK, "{}", link.text());
    let link = link.json();
    assert_eq!(link["email"], "sam@example.com", "stored lowercased");
    let code = link["code"].as_str().unwrap().to_string();

    // The link page greets Sam; a made-up code doesn't work.
    let mut anon = Client::new(&server.app);
    let check = anon.post("/api/auth/sign-in-link/check", json!({ "code": code })).await.json();
    assert_eq!((check["valid"].clone(), check["name"].clone()), (json!(true), json!("Sam")));
    assert_eq!(
        anon.post("/api/auth/sign-in-link/check", json!({ "code": "nope" })).await.json()["valid"],
        false
    );
    // A weak password is refused; a good one sets the sign-in, once.
    let weak = anon.post("/api/auth/sign-in-link/use", json!({ "code": code, "password": "short" })).await;
    assert!(weak.status.is_client_error());
    let set = anon
        .post("/api/auth/sign-in-link/use", json!({ "code": code, "password": "sams own password" }))
        .await;
    assert_eq!(set.status, StatusCode::NO_CONTENT, "{}", set.text());
    let again = anon
        .post("/api/auth/sign-in-link/use", json!({ "code": code, "password": "sams own password" }))
        .await;
    assert_eq!(again.status, StatusCode::BAD_REQUEST, "a link works once");

    // Sam signs in on a new TV with the email: it joins the household (Sam's account).
    let mut other_tv = tv_client(&server);
    let login =
        json!({ "username": "SAM@example.com", "password": "sams own password", "device_name": "Dorm" });
    let res = other_tv.post("/api/auth/device/login", login).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    let new_device = res.json()["device_token"].as_str().unwrap().to_string();
    let listed =
        other_tv.post("/api/auth/device/profiles", json!({ "device_token": new_device })).await.json();
    assert_eq!(listed["profiles"].as_array().unwrap().len(), 2, "the household's profiles: {listed}");

    // The email can't go to another profile.
    let kid = tv
        .post("/api/auth/device/profiles/new", json!({ "device_token": device, "name": "Kid" }))
        .await
        .json();
    let mut kid_tv = tv_client(&server);
    let ks = kid_tv
        .post("/api/auth/device/switch", json!({ "device_token": device, "user_id": kid["id"] }))
        .await
        .json();
    kid_tv.bearer = Some(ks["token"].as_str().unwrap().to_string());
    let taken = kid_tv.post("/api/auth/profile/sign-in-link", json!({ "email": "sam@example.com" })).await;
    assert_eq!(taken.status, StatusCode::CONFLICT);

    // Sam turns sign-in off: the password stops working.
    let session =
        tv.post("/api/auth/device/switch", json!({ "device_token": device, "user_id": sam_id })).await.json();
    tv.bearer = Some(session["token"].as_str().unwrap().to_string());
    assert_eq!(tv.send("DELETE", "/api/auth/profile/sign-in", None).await.status, StatusCode::NO_CONTENT);
    let login =
        json!({ "username": "sam@example.com", "password": "sams own password", "device_name": "Dorm" });
    assert_eq!(other_tv.post("/api/auth/device/login", login).await.status, StatusCode::UNAUTHORIZED);
    // The account owner always keeps theirs.
    assert_eq!(admin.send("DELETE", "/api/auth/profile/sign-in", None).await.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn top_shelf_token_opens_only_the_top_shelf() {
    let server = server().await;
    let mut admin = admin(&server).await;
    // Minting one needs a signed-in profile.
    let mut anon = Client::new(&server.app);
    anon.origin = None;
    assert_eq!(anon.post("/api/auth/topshelf-token", json!({})).await.status, StatusCode::UNAUTHORIZED);
    let res = admin.post("/api/auth/topshelf-token", json!({})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    let token = res.json()["token"].as_str().unwrap().to_string();

    // The extension (no session) reads its rows with it, and only with it.
    let mut shelf = Client::new(&server.app);
    shelf.origin = None;
    assert_eq!(shelf.get("/api/topshelf/items").await.status, StatusCode::UNAUTHORIZED);
    let rows = shelf.get(&format!("/api/topshelf/items?t={token}")).await;
    assert_eq!(rows.status, StatusCode::OK, "{}", rows.text());
    let rows = rows.json();
    assert_eq!(rows["sections"].as_array().unwrap().len(), 2, "{rows}");
    let mut forged = token.clone();
    forged.pop();
    forged.push(if token.ends_with('A') { 'B' } else { 'A' });
    assert_eq!(shelf.get(&format!("/api/topshelf/items?t={forged}")).await.status, StatusCode::UNAUTHORIZED);

    // It opens nothing else: no streams, no API.
    let items = admin.get("/api/items").await.json();
    let id = items[0]["id"].as_i64().unwrap();
    for path in [format!("/api/items/{id}/stream"), format!("/api/items/{id}/clip"), "/api/home".into()] {
        let res = shelf.get(&format!("{path}?t={token}")).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{path}");
    }
}

#[tokio::test]
async fn disabling_an_account_owner_shuts_the_whole_account() {
    let server = server().await;
    let mut admin = admin(&server).await;
    let mut bob = invited_user(&server, &mut admin, "bob").await;
    let bob_id = bob.get("/api/auth/me").await.json()["user"]["id"].as_i64().unwrap();
    // Bob's TV, and a household profile made on it.
    let (device, _) = pair(&server, &mut bob, None).await;
    let device = device.expect("a paired TV gets a device credential");
    let mut tv = tv_client(&server);
    let kid =
        tv.post("/api/auth/device/profiles/new", json!({ "device_token": device, "name": "Kid" })).await;
    assert_eq!(kid.status, StatusCode::CREATED, "{}", kid.text());
    let kid_id = kid.json()["id"].as_i64().unwrap();
    let switch = json!({ "device_token": device, "user_id": kid_id });
    let kid_session = tv.post("/api/auth/device/switch", switch.clone()).await.json()["token"]
        .as_str()
        .unwrap()
        .to_string();

    // The admin disables Bob, the owner: nothing of his account works any more.
    let off =
        admin.send("PATCH", &format!("/api/admin/users/{bob_id}"), Some(json!({ "disabled": true }))).await;
    assert!(off.status.is_success(), "{}", off.status);
    let mut kid_tv = tv_client(&server);
    kid_tv.bearer = Some(kid_session.clone());
    assert_eq!(kid_tv.get("/api/auth/me").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(tv.post("/api/auth/device/switch", switch.clone()).await.status, StatusCode::UNAUTHORIZED);
    let new = tv.post("/api/auth/device/profiles/new", json!({ "device_token": device, "name": "X" })).await;
    assert_eq!(new.status, StatusCode::UNAUTHORIZED, "no new profiles in a disabled account");
    // Enabling him again brings the TV back.
    admin.send("PATCH", &format!("/api/admin/users/{bob_id}"), Some(json!({ "disabled": false }))).await;
    assert_eq!(tv.post("/api/auth/device/switch", switch).await.status, StatusCode::OK);
}

#[tokio::test]
async fn deleting_a_restricted_accounts_only_library_is_refused() {
    let server = server().await;
    let mut admin = admin(&server).await;
    let mut bob = invited_user(&server, &mut admin, "bob").await;
    let bob_id = bob.get("/api/auth/me").await.json()["user"]["id"].as_i64().unwrap();
    let kids = server.dir.path().join("kids-only");
    std::fs::create_dir_all(&kids).unwrap();
    let lib =
        admin.post("/api/admin/libraries", json!({ "name": "Kids", "kind": "movies", "path": kids })).await;
    assert_eq!(lib.status, StatusCode::CREATED, "{}", lib.text());
    let kids_id = lib.json()["id"].as_i64().unwrap();
    // Bob may see only Kids.
    let set = admin
        .send("PATCH", &format!("/api/admin/users/{bob_id}"), Some(json!({ "libraries": [kids_id] })))
        .await;
    assert!(set.status.is_success(), "{}", set.text());
    // Deleting it would leave him no limit at all (= every library): refused.
    let del = admin.send("DELETE", &format!("/api/admin/libraries/{kids_id}"), None).await;
    assert_eq!(del.status, StatusCode::CONFLICT, "{}", del.text());
    assert!(del.text().contains("bob"), "{}", del.text());
}

#[tokio::test]
async fn only_admins_list_every_accounts_requests() {
    let server = server().await;
    let mut admin = admin(&server).await;
    let mut bob = invited_user(&server, &mut admin, "bob").await;
    assert_eq!(bob.get("/api/requests").await.status, StatusCode::FORBIDDEN);
    assert_eq!(bob.get("/api/requests/mine").await.status, StatusCode::OK);
    assert_eq!(admin.get("/api/requests").await.status, StatusCode::OK);
}

#[tokio::test]
async fn only_the_requester_cancels_a_request() {
    let server = server().await;
    let mut admin = admin(&server).await;
    let mut bob = invited_user(&server, &mut admin, "bob").await;
    let bob_id = bob.get("/api/auth/me").await.json()["user"]["id"].as_i64().unwrap();
    // Bob's request (made directly: no Radarr in tests to send it to).
    let new = panda_db::NewRequest {
        kind: panda_db::RequestKind::Movie,
        title: "Heat".into(),
        year: Some(1995),
        tmdb_id: Some(949),
        tvdb_id: None,
        user_id: Some(bob_id),
        poster: None,
        seasons: None,
    };
    let id = server.state.db.create_request(&new).await.unwrap().id;
    let url = format!("/api/requests/{id}");
    // Not even an admin cancels someone else's: it's theirs.
    assert_eq!(admin.send("DELETE", &url, None).await.status, StatusCode::NOT_FOUND);
    let mut anon = Client::new(&server.app);
    assert_eq!(anon.send("DELETE", &url, None).await.status, StatusCode::UNAUTHORIZED);
    // His own: past the checks, but the test's Radarr never answers, and a request is never
    // forgotten while its server may still be working on it.
    let r = bob.send("DELETE", &url, None).await;
    assert_eq!(r.status, StatusCode::BAD_GATEWAY, "{}", r.text());
    assert_eq!(bob.get("/api/requests/mine").await.json().as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_password_change_revokes_signed_urls() {
    let server = server().await;
    let mut admin = admin(&server).await;
    let mut bob = invited_user(&server, &mut admin, "bob").await;
    let token =
        bob.post("/api/auth/topshelf-token", json!({})).await.json()["token"].as_str().unwrap().to_string();
    let mut shelf = tv_client(&server);
    let url = format!("/api/topshelf/items?t={token}");
    assert_eq!(shelf.get(&url).await.status, StatusCode::OK);
    // Bob changes his password (say his TV was stolen): URLs signed before stop working.
    let res = bob
        .post(
            "/api/auth/password",
            json!({ "current_password": "another long password", "new_password": "a brand new long password" }),
        )
        .await;
    assert!(res.status.is_success(), "{}", res.text());
    assert_eq!(shelf.get(&url).await.status, StatusCode::UNAUTHORIZED);
    // A fresh one works.
    let fresh =
        bob.post("/api/auth/topshelf-token", json!({})).await.json()["token"].as_str().unwrap().to_string();
    assert_eq!(shelf.get(&format!("/api/topshelf/items?t={fresh}")).await.status, StatusCode::OK);
}

/// The web app for watching (`/watch`, clients/watch) is static and public, like the admin UI:
/// every page of it carries a CSP that forbids framing and inline scripts, and a missing asset is
/// a 404, never the app's page (a stale bundle must not load HTML as script).
#[tokio::test]
async fn the_web_app_is_framed_by_nothing_and_runs_no_inline_scripts() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut anon = Client::new(&server.app);
    for path in ["/watch/", "/watch/title/m1", "/watch/play/title/m1"] {
        let res = anon.get(path).await;
        // Built into this binary or not (then a plain 404 that says how to build it).
        if res.status != StatusCode::OK {
            assert_eq!(res.status, StatusCode::NOT_FOUND, "{path}");
            continue;
        }
        let csp =
            res.headers.get(header::CONTENT_SECURITY_POLICY).and_then(|v| v.to_str().ok()).unwrap_or("");
        assert!(csp.contains("frame-ancestors 'none'"), "{path}: {csp}");
        assert!(csp.contains("script-src 'self';"), "{path} must not allow inline scripts: {csp}");
        assert_eq!(res.headers.get(header::CACHE_CONTROL).unwrap(), "no-cache", "{path}");
    }
    assert_eq!(anon.get("/watch/assets/missing.js").await.status, StatusCode::NOT_FOUND);
    // Its pages are public; what they show still needs a session.
    assert_eq!(anon.get("/api/home").await.status, StatusCode::UNAUTHORIZED);
}
