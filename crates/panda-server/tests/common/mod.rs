//! Test harness: real ffmpeg, temp library, and a tiny HTTP client that keeps cookies.
#![allow(dead_code, unreachable_pub)]

use std::path::Path;
use std::process::Command;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Request, StatusCode, header};
use panda_server::{AppState, Config};
use serde_json::{Value, json};
use tower::ServiceExt;

pub const ADMIN_PASSWORD: &str = "correct horse battery staple";
pub const RADARR_KEY: &str = "radarr-api-key-SHOULD-NEVER-LEAK";

pub fn ffmpeg_available() -> bool {
    Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success())
}

/// 3 s of H.264/AAC test video. `srt` adds a text subtitle track (mkv only).
pub fn make_video(path: &Path, srt: Option<&Path>) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x180:rate=24"]).args([
        "-f",
        "lavfi",
        "-i",
        "sine=duration=3",
    ]);
    if let Some(srt) = srt {
        cmd.arg("-i").arg(srt).args(["-map", "0:v", "-map", "1:a", "-map", "2:s", "-c:s", "srt"]);
    }
    cmd.args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "24", "-c:a", "aac", "-shortest"]).arg(path);
    assert!(cmd.status().unwrap().success(), "ffmpeg failed to create {}", path.display());
}

pub struct TestServer {
    pub dir: tempfile::TempDir,
    pub app: Router,
    pub state: AppState,
}

pub async fn server() -> TestServer {
    server_with("").await
}

/// Like [`server`], with extra TOML appended to the config (e.g. a `[transcoding]` section).
pub async fn server_with(extra: &str) -> TestServer {
    server_full("", extra).await
}

/// Like [`server`], behind a trusted reverse proxy (`trust_proxy = true`).
pub async fn server_behind_proxy() -> TestServer {
    server_full("trust_proxy = true", "").await
}

async fn server_full(server_extra: &str, extra: &str) -> TestServer {
    let dir = tempfile::tempdir().unwrap();
    let movies = dir.path().join("movies");
    let srt = dir.path().join("subs.srt");
    std::fs::write(&srt, "1\n00:00:00,000 --> 00:00:02,000\nHello from Panda\n").unwrap();
    make_video(&movies.join("Test Movie (2020)/Test Movie (2020).mp4"), None);
    make_video(&movies.join("Other Film (2021)/Other Film (2021).mkv"), Some(&srt));

    let config: Config = toml::from_str(&format!(
        r#"
        [server]
        data_dir = "{data}"
        webhook_token = "hook-secret"
        {server_extra}

        [[libraries]]
        name = "Movies"
        kind = "movies"
        path = "{movies}"

        [radarr]
        url = "http://127.0.0.1:9"
        api_key = "{RADARR_KEY}"
        quality_profile_id = 1
        root_folder = "/movies"

        {extra}
        "#,
        data = dir.path().join("data").display(),
        movies = movies.display(),
    ))
    .unwrap();

    let state = AppState::init(config).await.unwrap();
    panda_server::scan_now(&state).await.unwrap();
    TestServer { app: panda_server::router(state.clone()), state, dir }
}

pub struct Res {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Res {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Minimal client: remembers the session cookie, optionally sends a bearer token, and sends
/// a same-origin `Origin` header like a browser would (toggle with `origin`).
#[derive(Clone)]
pub struct Client {
    pub app: Router,
    pub cookie: Option<String>,
    pub bearer: Option<String>,
    pub origin: Option<String>,
    /// The client's address as the server sees it (none: unknown, treated as local).
    pub peer: Option<std::net::SocketAddr>,
    /// Extra request headers (e.g. a proxy's `X-Forwarded-*`).
    pub headers: Vec<(String, String)>,
}

impl Client {
    pub fn new(app: &Router) -> Self {
        Self {
            app: app.clone(),
            cookie: None,
            bearer: None,
            origin: Some("http://panda.test".into()),
            peer: None,
            headers: Vec::new(),
        }
    }

    pub async fn send(&mut self, method: &str, uri: &str, body: Option<Value>) -> Res {
        let mut req = Request::builder().method(method).uri(uri).header(header::HOST, "panda.test");
        if let Some(o) = &self.origin {
            req = req.header(header::ORIGIN, o);
        }
        if let Some(c) = &self.cookie {
            req = req.header(header::COOKIE, c);
        }
        if let Some(t) = &self.bearer {
            req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        for (k, v) in &self.headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(peer) = self.peer {
            req = req.extension(axum::extract::ConnectInfo(peer));
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let (parts, body) = res.into_parts();
        if let Some(set) = parts.headers.get(header::SET_COOKIE).and_then(|v| v.to_str().ok()) {
            let pair = set.split(';').next().unwrap().to_string();
            self.cookie = if pair.ends_with('=') { None } else { Some(pair) };
        }
        Res {
            status: parts.status,
            headers: parts.headers,
            body: to_bytes(body, usize::MAX).await.unwrap().to_vec(),
        }
    }

    pub async fn get(&mut self, uri: &str) -> Res {
        self.send("GET", uri, None).await
    }

    pub async fn post(&mut self, uri: &str, body: Value) -> Res {
        self.send("POST", uri, Some(body)).await
    }
}

/// Complete first-run setup and return a signed-in admin client.
pub async fn admin(server: &TestServer) -> Client {
    let token = server.state.pending_setup_token().await.expect("fresh server has a setup token");
    let mut c = Client::new(&server.app);
    let res = c
        .post("/api/setup", json!({ "token": token, "username": "admin", "password": ADMIN_PASSWORD }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    c
}

/// Invite + accept a regular user, returning their signed-in client.
pub async fn invited_user(server: &TestServer, admin: &mut Client, username: &str) -> Client {
    let inv = admin.post("/api/admin/invites", json!({ "role": "user", "note": username })).await;
    assert_eq!(inv.status, StatusCode::CREATED, "{}", inv.text());
    let code = inv.json()["code"].as_str().unwrap().to_string();
    let mut c = Client::new(&server.app);
    let res = c
        .post(
            "/api/auth/invite/accept",
            json!({ "code": code, "username": username, "password": "another long password" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    c
}

pub fn item_id(items: &Value, title: &str) -> i64 {
    items.as_array().unwrap().iter().find(|i| i["title"] == title).unwrap()["id"].as_i64().unwrap()
}

/// A stand-in Bazarr on a local port: knows one movie, the test library's
/// `Test Movie (2020).mp4` (as Bazarr sees it, under its own mount), and "downloads" English
/// subtitles by writing `Test Movie (2020).en.srt` next to the test's copy, as Bazarr would.
/// Its API key is `bazarr-key`. Returns its address.
#[allow(dead_code)]
pub async fn fake_bazarr(movie_folder: std::path::PathBuf) -> String {
    use axum::extract::Query;
    use axum::routing::get;
    let key_ok = |h: &HeaderMap| h.get("x-api-key").is_some_and(|k| k == "bazarr-key");
    let app = Router::new()
        .route(
            "/api/system/status",
            get(move |h: HeaderMap| async move {
                if key_ok(&h) {
                    (StatusCode::OK, axum::Json(json!({ "data": { "bazarr_version": "1.6.2" } })))
                } else {
                    (StatusCode::UNAUTHORIZED, axum::Json(json!({})))
                }
            }),
        )
        .route(
            "/api/movies",
            get(|| async {
                axum::Json(json!({ "data": [
                    { "radarrId": 7, "path": "/mnt/media/movies/Test Movie (2020)/Test Movie (2020).mp4" }
                ] }))
            }),
        )
        .route(
            "/api/movies/subtitles",
            axum::routing::patch(move |Query(q): Query<std::collections::HashMap<String, String>>| {
                let folder = movie_folder.clone();
                async move {
                    if q.get("radarrid").map(String::as_str) != Some("7") {
                        return StatusCode::NOT_FOUND;
                    }
                    let lang = q.get("language").cloned().unwrap_or_default();
                    std::fs::write(
                        folder.join(format!("Test Movie (2020).{lang}.srt")),
                        "1\n00:00:00,500 --> 00:00:02,000\nFound by Bazarr\n",
                    )
                    .unwrap();
                    StatusCode::NO_CONTENT
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}
