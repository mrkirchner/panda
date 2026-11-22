//! End-to-end playback tests against a real ffmpeg. Skipped when ffmpeg isn't on `$PATH`.

mod common;

use axum::http::{StatusCode, header};
use common::*;
use serde_json::json;

#[tokio::test]
async fn scan_play_transcode_and_subtitles() {
    if !ffmpeg_available() {
        eprintln!("skipping: ffmpeg not on PATH");
        return;
    }
    let server = server().await;
    let mut c = admin(&server).await;

    let items = c.get("/api/items").await;
    assert_eq!(items.status, StatusCode::OK);
    let items = items.json();
    assert_eq!(items.as_array().unwrap().len(), 2, "{items}");
    let mp4 = item_id(&items, "Test Movie");
    let mkv = item_id(&items, "Other Film");

    // MP4/H.264/AAC direct plays; the URL is signed so a <video> element can fetch it.
    let playback = c.post(&format!("/api/items/{mp4}/playback"), json!({})).await.json();
    assert_eq!(playback["method"], "direct_play", "{playback}");
    assert_eq!(playback["mime_type"], "video/mp4");
    let url = playback["url"].as_str().unwrap();
    assert!(url.contains("?t="), "stream URL must be signed: {url}");
    let mut player = Client::new(&server.app);
    player.origin = None;
    let res = player.send("GET", url, None).await;
    assert_eq!(res.status, StatusCode::OK);

    // MKV is remuxed to HLS; every segment line in the playlist carries its own signature.
    let playback = c.post(&format!("/api/items/{mkv}/playback"), json!({})).await.json();
    assert_eq!(playback["method"], "hls", "{playback}");
    assert_eq!(playback["plan"]["video"]["mode"], "copy");
    let res = player.get(playback["url"].as_str().unwrap()).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.headers[header::CONTENT_TYPE], "application/vnd.apple.mpegurl");
    let playlist = res.text();
    let segment = playlist.lines().find(|l| l.starts_with("seg_")).expect("playlist lists a segment");
    assert!(segment.contains("?t="), "{segment}");
    let session = playback["session_id"].as_str().unwrap();
    let seg = player.get(&format!("/api/hls/{session}/{segment}")).await;
    assert!(seg.status == StatusCode::OK && !seg.body.is_empty());
    // fMP4: the init segment is referenced by #EXT-X-MAP and must be signed too.
    let map = playlist
        .lines()
        .find(|l| l.starts_with("#EXT-X-MAP:URI="))
        .expect("fMP4 playlist has an init segment");
    let init = map.trim_start_matches("#EXT-X-MAP:URI=\"").split('"').next().unwrap();
    assert!(init.starts_with("init.mp4?t="), "{map}");
    assert_eq!(player.get(&format!("/api/hls/{session}/{init}")).await.status, StatusCode::OK);

    // Subtitles: an overlay track (never burned in), fetched through a signed URL.
    let track = &playback["subtitles"][0];
    assert_eq!(track["overlay"], "text");
    let vtt = player.get(track["url"].as_str().unwrap()).await;
    assert_eq!(vtt.status, StatusCode::OK);
    assert!(vtt.text().starts_with("WEBVTT") && vtt.text().contains("Hello from Panda"));

    assert_eq!(c.send("DELETE", &format!("/api/hls/{session}"), None).await.status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn subtitle_files_next_to_the_video_are_tracks() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut c = admin(&server).await;
    let mp4 = item_id(&c.get("/api/items").await.json(), "Test Movie");
    // Written after the scan, as Bazarr would: found when playback starts, no rescan needed.
    let folder = server.dir.path().join("movies/Test Movie (2020)");
    std::fs::write(
        folder.join("Test Movie (2020).en.hi.srt"),
        "1\n00:00:00,500 --> 00:00:02,000\n[door creaks] Hello\n",
    )
    .unwrap();
    // An older file in Windows-1252 ("café"), and one for another video (not this one's).
    std::fs::write(folder.join("Test Movie (2020).fr.srt"), b"1\n00:00:01,000 --> 00:00:02,000\ncaf\xe9\n")
        .unwrap();
    std::fs::write(folder.join("Test Movie (2020) - 4K.en.srt"), "1\n00:00:00,000 --> 00:00:01,000\nNo\n")
        .unwrap();

    let playback = c.post(&format!("/api/items/{mp4}/playback"), json!({})).await.json();
    let tracks = playback["subtitles"].as_array().unwrap();
    let files: Vec<_> = tracks.iter().filter(|t| t["external"] == true).collect();
    assert_eq!(files.len(), 2, "{tracks:?}");
    let (en, fr) = (files[0], files[1]);
    assert_eq!(
        (&en["language"], &en["hearing_impaired"], &en["overlay"]),
        (&json!("en"), &json!(true), &json!("text"))
    );
    assert_eq!(fr["language"], "fr");
    assert!(en["key"].as_str().unwrap().starts_with('f'));

    let mut player = Client::new(&server.app);
    player.origin = None;
    let vtt = player.get(en["url"].as_str().unwrap()).await;
    assert_eq!(vtt.status, StatusCode::OK);
    assert_eq!(vtt.headers[header::CONTENT_TYPE], "text/vtt; charset=utf-8");
    assert!(vtt.text().starts_with("WEBVTT") && vtt.text().contains("[door creaks] Hello"), "{}", vtt.text());
    let vtt = player.get(fr["url"].as_str().unwrap()).await.text();
    assert!(vtt.contains("café"), "{vtt}");

    // Bazarr swaps in a better file: the next fetch converts it again.
    std::fs::write(
        folder.join("Test Movie (2020).en.hi.srt"),
        "1\n00:00:00,500 --> 00:00:02,000\nBetter match\n",
    )
    .unwrap();
    let vtt = player.get(en["url"].as_str().unwrap()).await.text();
    assert!(vtt.contains("Better match"), "{vtt}");

    // Removed: gone from the next playback, and its URL stops working.
    std::fs::remove_file(folder.join("Test Movie (2020).fr.srt")).unwrap();
    assert_eq!(player.get(fr["url"].as_str().unwrap()).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn another_versions_subtitle_files_are_offered() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut c = admin(&server).await;
    // A second version of the movie in its own folder (as a 4K Radarr keeps it), with an English
    // file Bazarr wrote there only.
    let movies = server.dir.path().join("movies");
    let other = movies.join("Test Movie (2020) 4K");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::copy(
        movies.join("Test Movie (2020)/Test Movie (2020).mp4"),
        other.join("Test Movie (2020).mp4"),
    )
    .unwrap();
    std::fs::write(other.join("Test Movie (2020).en.srt"), "1\n00:00:00,500 --> 00:00:02,000\nFrom the 4K\n")
        .unwrap();
    panda_server::scan_now(&server.state).await.unwrap();

    let items = c.get("/api/items").await.json();
    let ids: Vec<i64> = items
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["title"].as_str().is_some_and(|t| t.contains("Test Movie")))
        .map(|i| i["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids.len(), 2, "two versions");
    let plain = ids
        .iter()
        .copied()
        .find(|id| {
            items
                .as_array()
                .unwrap()
                .iter()
                .any(|i| i["id"] == *id && !i["path"].as_str().unwrap_or("").contains("4K"))
        })
        .unwrap_or(ids[0]);
    let playback = c.post(&format!("/api/items/{plain}/playback"), json!({})).await.json();
    let files: Vec<_> =
        playback["subtitles"].as_array().unwrap().iter().filter(|t| t["external"] == true).cloned().collect();
    let en = files.iter().find(|t| t["language"] == "en").expect("the other version's English file");
    assert!(en["from_version"].is_string(), "{en}");

    let mut player = Client::new(&server.app);
    player.origin = None;
    let vtt = player.get(en["url"].as_str().unwrap()).await;
    assert_eq!(vtt.status, StatusCode::OK);
    assert!(vtt.text().contains("From the 4K"), "{}", vtt.text());
}

#[tokio::test]
async fn bazarr_finds_subtitles_on_request() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut c = admin(&server).await;
    let mp4 = item_id(&c.get("/api/items").await.json(), "Test Movie");
    let folder = server.dir.path().join("movies/Test Movie (2020)");
    assert_eq!(c.get("/api/features").await.json()["subtitle_search"], false);

    let bazarr = fake_bazarr(folder.clone()).await;
    // A wrong key is refused before anything is saved.
    let r =
        c.send("PUT", "/api/admin/settings/bazarr", Some(json!({ "url": bazarr, "api_key": "nope" }))).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
    assert!(c.get("/api/admin/settings").await.json()["bazarr"].is_null());
    let r = c
        .send("PUT", "/api/admin/settings/bazarr", Some(json!({ "url": bazarr, "api_key": "bazarr-key" })))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["version"], "1.6.2");
    let view = c.get("/api/admin/settings").await.json();
    assert_eq!(view["bazarr"], json!({ "url": bazarr, "api_key_set": true }), "the key is never sent back");
    assert_eq!(c.get("/api/features").await.json()["subtitle_search"], true);

    // Bazarr knows the file under its own mount; it saves English next to it.
    let r = c.post(&format!("/api/items/{mp4}/subtitles/find"), json!({ "language": "en" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let found = r.json();
    assert_eq!(found["found"], true);
    let en = found["subtitles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["external"] == true && t["language"] == "en");
    let mut player = Client::new(&server.app);
    player.origin = None;
    let vtt = player.get(en.expect("the new file is a track")["url"].as_str().unwrap()).await.text();
    assert!(vtt.contains("Found by Bazarr"), "{vtt}");

    let r = c.post(&format!("/api/items/{mp4}/subtitles/find"), json!({ "language": "english" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(c.send("DELETE", "/api/admin/settings/bazarr", None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(c.get("/api/features").await.json()["subtitle_search"], false);
    let r = c.post(&format!("/api/items/{mp4}/subtitles/find"), json!({ "language": "en" })).await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "not set up");
}

#[tokio::test]
async fn low_resolution_client_gets_full_encode() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut c = admin(&server).await;
    let mp4 = item_id(&c.get("/api/items").await.json(), "Test Movie");
    let res = c
        .post(
            &format!("/api/items/{mp4}/playback"),
            json!({"profile": {"containers": ["mp4"], "video_codecs": ["h264"], "audio_codecs": ["aac"],
                   "max_height": 144, "supports_hdr": false, "max_audio_channels": 2}}),
        )
        .await;
    let playback = res.json();
    assert_eq!(res.status, StatusCode::OK, "{playback}");
    assert_eq!(playback["plan"]["video"]["mode"], "encode");
    assert_eq!(playback["plan"]["video"]["target_height"], 144);
}

#[tokio::test]
async fn bitrate_cap_forces_a_smaller_hevc_stream() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut c = admin(&server).await;
    let mp4 = item_id(&c.get("/api/items").await.json(), "Test Movie");
    let profile = json!({"profile": {"containers": ["mp4"], "video_codecs": ["h264", "hevc"],
        "audio_codecs": ["aac"], "max_height": 1080, "supports_hdr": false, "max_audio_channels": 2,
        "max_bitrate_kbps": 50}});
    let res = c.post(&format!("/api/items/{mp4}/playback"), profile).await;
    let p = res.json();
    assert_eq!(res.status, StatusCode::OK, "{p}");
    assert_eq!(p["method"], "hls");
    assert_eq!(p["stream"]["mode"], "transcode");
    assert!(p["reasons"].to_string().contains("limit"), "{p}");
    let bitrate = p["stream"]["bitrate_kbps"].as_u64().unwrap();
    // The 320x180 test clip is ~100-200 kbps; the video floor is MIN_VIDEO_KBPS (300).
    assert!(bitrate <= 300, "{p}");
    // HEVC when the installed ffmpeg can encode it (hevc_videotoolbox / libx265), else H.264.
    assert!(p["stream"]["codec"] == "hevc" || p["stream"]["codec"] == "h264", "{p}");
    let mut player = Client::new(&server.app);
    player.origin = None;
    let pl = player.get(p["url"].as_str().unwrap()).await;
    assert_eq!(pl.status, StatusCode::OK);
    assert!(pl.text().contains(".m4s?t="), "{}", pl.text());
}

#[tokio::test]
async fn full_transcode_slots_return_busy_but_direct_play_and_remux_still_work() {
    if !ffmpeg_available() {
        return;
    }
    let server = server_with("[transcoding]\nmax_hardware = 0\nmax_software = 0").await;
    let mut c = admin(&server).await;
    let items = c.get("/api/items").await.json();
    let (mp4, mkv) = (item_id(&items, "Test Movie"), item_id(&items, "Other Film"));

    let small = json!({"profile": {"containers": ["mp4"], "video_codecs": ["h264"], "audio_codecs": ["aac"],
        "max_height": 144, "supports_hdr": false, "max_audio_channels": 2}});
    let busy = c.post(&format!("/api/items/{mp4}/playback"), small).await;
    assert_eq!(busy.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(busy.json()["error"].as_str().unwrap().contains("busy"));

    let direct = c.post(&format!("/api/items/{mp4}/playback"), json!({})).await.json();
    assert_eq!(direct["method"], "direct_play");
    let remux = c.post(&format!("/api/items/{mkv}/playback"), json!({})).await.json();
    assert_eq!(remux["stream"]["mode"], "remux", "{remux}");

    let streams = c.get("/api/admin/streams").await.json();
    assert_eq!(streams["limits"]["hardware"], 0);
    assert_eq!(streams["in_use"]["remux"], 1);
    assert_eq!(streams["streams"][0]["title"], "Other Film");
}

#[tokio::test]
async fn same_movie_in_two_folders_is_one_title_with_versions() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut c = admin(&server).await;

    // A second folder with an MKV copy of "Test Movie (2020)".
    let src = server.dir.path().join("movies/Test Movie (2020)/Test Movie (2020).mp4");
    let other = server.dir.path().join("movies-hd/Test Movie (2020)");
    std::fs::create_dir_all(&other).unwrap();
    let ok = std::process::Command::new("ffmpeg")
        .args(["-v", "error", "-y", "-i"])
        .arg(&src)
        .args(["-c", "copy"])
        .arg(other.join("Test Movie (2020).mkv"))
        .status()
        .unwrap();
    assert!(ok.success());

    let lib = c.get("/api/admin/libraries").await.json()[0]["id"].as_i64().unwrap();
    let folder = server.dir.path().join("movies-hd").to_string_lossy().into_owned();
    let res = c.post(&format!("/api/admin/libraries/{lib}/folders"), json!({ "path": folder })).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT, "{}", res.text());
    panda_server::scan_now(&server.state).await.unwrap();

    let titles = c.get("/api/titles").await.json();
    let test_movie: Vec<_> =
        titles.as_array().unwrap().iter().filter(|t| t["title"] == "Test Movie").collect();
    assert_eq!(test_movie.len(), 1, "one title, not two: {titles}");
    let t = test_movie[0];
    assert_eq!(t["versions"].as_array().unwrap().len(), 2, "{t}");

    // The default profile direct-plays MP4, so the MP4 version is chosen over the MKV.
    let id = t["id"].as_str().unwrap();
    let p = c.post(&format!("/api/titles/{id}/playback"), json!({})).await.json();
    assert_eq!(p["method"], "direct_play", "{p}");
    let mut mp4_item = None;
    let mut mkv_item = None;
    for v in t["versions"].as_array().unwrap() {
        let iid = v["item_id"].as_i64().unwrap();
        let detail = c.get(&format!("/api/items/{iid}")).await.json();
        if detail["media"]["container"].as_str().unwrap().starts_with("mov") {
            mp4_item = Some(iid);
        } else {
            mkv_item = Some(iid);
        }
    }
    let (mp4_item, mkv_item) = (mp4_item.unwrap(), mkv_item.unwrap());
    assert_eq!(p["item_id"], mp4_item);

    // Asking for a specific version plays that one.
    let p = c.post(&format!("/api/titles/{id}/playback"), json!({ "version": mkv_item })).await.json();
    assert_eq!(p["item_id"], mkv_item);
    assert_eq!(p["stream"]["mode"], "remux", "{p}");
}

#[tokio::test]
async fn progress_drives_continue_watching_and_home() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut c = admin(&server).await;
    let mp4 = item_id(&c.get("/api/items").await.json(), "Test Movie");
    let other = item_id(&c.get("/api/items").await.json(), "Other Film");

    // Barely started: not in Continue Watching.
    c.post("/api/progress", json!({ "item_id": other, "position_secs": 5, "duration_secs": 100 })).await;
    // Partway through.
    let p =
        c.post("/api/progress", json!({ "item_id": mp4, "position_secs": 30, "duration_secs": 100 })).await;
    assert_eq!(p.status, StatusCode::OK, "{}", p.text());
    let home = c.get("/api/home").await.json();
    let cw = home["continue_watching"].as_array().unwrap();
    assert_eq!(cw.len(), 1, "{home}");
    assert_eq!(cw[0]["title"], "Test Movie");
    assert!((cw[0]["fraction"].as_f64().unwrap() - 0.3).abs() < 1e-6);
    assert_eq!(home["recently_added_movies"].as_array().unwrap().len(), 2);

    // The title carries the same progress (across its versions).
    let titles = c.get("/api/titles").await.json();
    let t = titles.as_array().unwrap().iter().find(|t| t["title"] == "Test Movie").unwrap();
    assert_eq!(t["progress"]["position_secs"], 30.0);

    // Past 90%: finished, gone from Continue Watching, resume resets.
    c.post("/api/progress", json!({ "item_id": mp4, "position_secs": 95, "duration_secs": 100 })).await;
    let home = c.get("/api/home").await.json();
    assert!(home["continue_watching"].as_array().unwrap().is_empty(), "{home}");
    let items = c.get("/api/items").await.json();
    let it = items.as_array().unwrap().iter().find(|i| i["id"] == mp4).unwrap();
    assert_eq!(it["progress"]["finished"], true);
    assert_eq!(it["progress"]["position_secs"], 0.0);

    // Manual unwatch.
    assert_eq!(
        c.post("/api/watched", json!({ "item_id": mp4, "watched": false })).await.status,
        StatusCode::NO_CONTENT
    );
    let items = c.get("/api/items").await.json();
    assert!(items.as_array().unwrap().iter().find(|i| i["id"] == mp4).unwrap()["progress"].is_null());
}

#[tokio::test]
async fn libraries_are_named_categories_of_folders() {
    if !ffmpeg_available() {
        return;
    }
    let server = server_with("[scanning]\ninterval_minutes = 0").await;
    let mut c = admin(&server).await;
    panda_server::scan_now(&server.state).await.unwrap();

    // The list shows each library's folders and item count.
    let libs = c.get("/api/admin/libraries").await.json();
    assert_eq!(libs[0]["name"], "Movies");
    assert_eq!(libs[0]["folders"].as_array().unwrap().len(), 1);
    assert_eq!(libs[0]["items"], 2, "{libs}");
    let movies_dir = libs[0]["folders"][0].as_str().unwrap().to_string();

    // A new category pointing at its own folder.
    let kids = server.dir.path().join("kids");
    make_video(&kids.join("Cartoon (2019)/Cartoon (2019).mp4"), None);
    let res = c.post("/api/admin/libraries", json!({ "name": "Kids", "kind": "movies", "path": kids })).await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.text());

    // A folder can belong to only one library, and names are unique.
    let dup = c
        .post("/api/admin/libraries", json!({ "name": "Other", "kind": "movies", "path": movies_dir }))
        .await;
    assert_eq!(dup.status, StatusCode::CONFLICT, "{}", dup.text());
    let other = server.dir.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    let dup =
        c.post("/api/admin/libraries", json!({ "name": "kids", "kind": "movies", "path": other })).await;
    assert_eq!(dup.status, StatusCode::CONFLICT, "{}", dup.text());

    // New files in its folder show up in that category after a scan.
    panda_server::scan_now(&server.state).await.unwrap();
    let libs = c.get("/api/admin/libraries").await.json();
    let kids_lib = libs.as_array().unwrap().iter().find(|l| l["name"] == "Kids").unwrap();
    assert_eq!(kids_lib["items"], 1, "{libs}");
    let id = kids_lib["id"].as_i64().unwrap();
    make_video(&kids.join("Second Cartoon (2020)/Second Cartoon (2020).mp4"), None);
    panda_server::scan_now(&server.state).await.unwrap();
    let titles = c.get(&format!("/api/titles?library_id={id}")).await.json();
    let names: Vec<_> =
        titles.as_array().unwrap().iter().map(|t| t["title"].as_str().unwrap().to_string()).collect();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(names.iter().any(|n| n == "Second Cartoon"), "{names:?}");

    // Rename, and the TV's library list follows.
    let res =
        c.send("PATCH", &format!("/api/admin/libraries/{id}"), Some(json!({ "name": "Kids Movies" }))).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    let names: Vec<_> =
        c.get("/api/libraries").await.json().as_array().unwrap().iter().map(|l| l["name"].clone()).collect();
    assert!(names.contains(&json!("Kids Movies")), "{names:?}");

    let status = c.get("/api/admin/libraries/scan").await.json();
    assert_eq!(status["scanning"], false);
    assert!(status["last_scan_at"].as_i64().is_some(), "{status}");
    assert!(status["interval_minutes"].is_null(), "periodic scans disabled in this test: {status}");
}

#[tokio::test]
async fn scrub_previews_are_made_on_demand_and_cached() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut c = admin(&server).await;
    let mp4 = item_id(&c.get("/api/items").await.json(), "Test Movie");
    let play = c.post(&format!("/api/items/{mp4}/playback"), json!({})).await.json();
    let url = play["preview_url"].as_str().unwrap().to_string();

    let res = c.get(&url.replace("{secs}", "1")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    assert_eq!(res.headers["content-type"], "image/jpeg");
    // A JPEG (SOI marker), small.
    let body = res.body.clone();
    assert_eq!(&body[..2], &[0xFF, 0xD8]);
    assert!(body.len() < 100_000, "{} bytes", body.len());
    // Same 10-second step: the cached copy, byte for byte.
    let again = c.get(&url.replace("{secs}", "2")).await.body;
    assert_eq!(body, again);
}

#[tokio::test]
async fn find_searches_the_library_and_browses_genres() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut c = admin(&server).await;

    let res = c.get("/api/find?q=test%20mov").await.json();
    let titles: Vec<&str> =
        res["movies"].as_array().unwrap().iter().map(|t| t["title"].as_str().unwrap()).collect();
    assert_eq!(titles, ["Test Movie"], "{res}");
    // Case, accents and punctuation don't matter.
    let res = c.get("/api/find?q=TEST-m%C3%B3vie").await.json();
    assert_eq!(res["movies"].as_array().unwrap().len(), 1, "{res}");
    // No TMDB configured in tests: nothing "not in your library", and no error.
    assert!(res["more"].as_array().unwrap().is_empty());
    // Empty query: empty results.
    let res = c.get("/api/find?q=").await.json();
    assert!(res["movies"].as_array().unwrap().is_empty());
    // Top picks: library titles (none finished yet), whatever was typed.
    let picks = c.get("/api/find?picks=true").await.json();
    assert_eq!(picks["movies"].as_array().unwrap().len(), 2, "{picks}");
    // Genres come from the library (none are matched in tests) and browsing an unknown one is empty.
    assert!(c.get("/api/genres").await.json().is_array());
    let res = c.get("/api/find?genre=Nope").await.json();
    assert!(res["movies"].as_array().unwrap().is_empty());
}

/// A tiny Radarr: lookup, add, status by TMDB id and a download queue at 60%.
async fn fake_radarr() -> (String, std::sync::Arc<std::sync::Mutex<Vec<i64>>>) {
    use axum::extract::{Query, State};
    use axum::routing::get;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    let added: Arc<Mutex<Vec<i64>>> = Arc::default();
    let app = axum::Router::new()
        .route("/api/v3/system/status", get(|| async { axum::Json(json!({ "version": "5.0" })) }))
        .route("/api/v3/qualityprofile", get(|| async { axum::Json(json!([{ "id": 1, "name": "Any" }])) }))
        .route("/api/v3/rootfolder", get(|| async { axum::Json(json!([{ "id": 1, "path": "/movies" }])) }))
        // Like Radarr: a lookup result carries Radarr's id once the movie has been added.
        .route(
            "/api/v3/movie/lookup",
            get(|State(a): State<Arc<Mutex<Vec<i64>>>>| async move {
                let id = a.lock().unwrap().contains(&603).then_some(7);
                axum::Json(json!([{ "id": id, "title": "The Matrix", "year": 1999, "tmdbId": 603 }]))
            }),
        )
        .route(
            "/api/v3/movie",
            get(|State(a): State<Arc<Mutex<Vec<i64>>>>, Query(q): Query<HashMap<String, String>>| async move {
                let tmdb: i64 = q.get("tmdbId").and_then(|v| v.parse().ok()).unwrap_or(0);
                let has = a.lock().unwrap().contains(&tmdb);
                axum::Json(if has {
                    json!([{ "id": 7, "title": "The Matrix", "tmdbId": tmdb, "hasFile": false }])
                } else {
                    json!([])
                })
            })
            .post(|State(a): State<Arc<Mutex<Vec<i64>>>>, axum::Json(body): axum::Json<serde_json::Value>| async move {
                a.lock().unwrap().push(body["tmdbId"].as_i64().unwrap());
                axum::Json(json!({ "id": 7, "title": body["title"], "tmdbId": body["tmdbId"] }))
            }),
        )
        .route(
            "/api/v3/queue/details",
            get(|| async {
                axum::Json(json!([{ "size": 100.0, "sizeleft": 40.0, "trackedDownloadState": "downloading" }]))
            }),
        )
        .with_state(added.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, added)
}

#[tokio::test]
async fn requests_go_to_hd_and_4k_and_report_progress_to_their_owner() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let (hd, hd_added) = fake_radarr().await;
    let (uhd, uhd_added) = fake_radarr().await;
    for (service, url) in [("radarr", &hd), ("radarr_4k", &uhd)] {
        let res = admin
            .send(
                "PUT",
                &format!("/api/admin/settings/{service}"),
                Some(
                    json!({ "url": url, "api_key": "k", "quality_profile_id": 1, "root_folder": "/movies" }),
                ),
            )
            .await;
        assert_eq!(res.status, StatusCode::NO_CONTENT, "{service}: {}", res.text());
    }

    // Search offers it (from Radarr's own search), not yet requested.
    let found = admin.get("/api/find?q=matrix").await.json();
    let more = found["more"].as_array().unwrap();
    assert_eq!(more[0]["title"], "The Matrix", "{found}");
    assert_eq!(more[0]["can_request"], true);

    // One request reaches both servers.
    let res = admin
        .post(
            "/api/requests",
            json!({ "kind": "movie", "title": "The Matrix", "year": 1999, "tmdb_id": 603 }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.text());
    assert_eq!(*hd_added.lock().unwrap(), [603]);
    assert_eq!(*uhd_added.lock().unwrap(), [603]);
    // Asking twice is refused.
    let again =
        admin.post("/api/requests", json!({ "kind": "movie", "title": "The Matrix", "tmdb_id": 603 })).await;
    assert_eq!(again.status, StatusCode::BAD_REQUEST);

    // The owner sees it with each server's progress.
    let mine = admin.get("/api/requests/mine").await.json();
    let r = &mine.as_array().unwrap()[0];
    assert_eq!(r["title"], "The Matrix", "{mine}");
    let tiers = r["tiers"].as_array().unwrap();
    assert_eq!(tiers.len(), 2);
    assert_eq!(tiers[0]["tier"], "hd");
    assert_eq!(tiers[1]["tier"], "4k");
    for t in tiers {
        assert_eq!(t["progress"]["state"], "downloading", "{t}");
        assert!((t["progress"]["fraction"].as_f64().unwrap() - 0.6).abs() < 1e-9);
    }
    // Now on the server: search shows it as on its way, not requestable.
    let found = admin.get("/api/find?q=matrix").await.json();
    assert_eq!(found["more"][0]["requested"], true, "{found}");
    assert_eq!(found["more"][0]["can_request"], false);
    // The TV asks for library results alone, then the slow lookups separately.
    let library_only = admin.get("/api/find?q=matrix&more=false").await.json();
    assert!(library_only["more"].as_array().unwrap().is_empty(), "{library_only}");
    let more = admin.get("/api/find/more?q=matrix").await.json();
    assert_eq!(more["more"][0]["requested"], true, "{more}");
    assert_eq!(more["more"][0]["can_request"], false);

    // Someone else doesn't see it.
    let mut sam = invited_user(&server, &mut admin, "sam").await;
    assert!(sam.get("/api/requests/mine").await.json().as_array().unwrap().is_empty());

    // It arrives (a library file matches TMDB 603): it joins the requester's My List, once.
    let file = admin.get("/api/titles").await.json()[0]["versions"][0]["item_id"].as_i64().unwrap();
    let db = &server.state.db;
    let meta = db
        .upsert_metadata(&panda_db::NewMetadata {
            kind: panda_db::MetadataKind::Movie,
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
    db.set_item_metadata(&[file], Some(meta)).await.unwrap();
    let mine = admin.get("/api/requests/mine").await.json();
    assert_eq!(mine[0]["title_id"], "m603", "{mine}");
    let listed = |v: &serde_json::Value| v.as_array().unwrap().iter().any(|e| e["id"] == "m603");
    assert!(listed(&admin.get("/api/favorites").await.json()), "arrived requests join My List");
    // Removing it sticks: it isn't added again.
    let gone = admin.send("DELETE", "/api/favorites", Some(json!({ "kind": "title", "id": "m603" }))).await;
    assert_eq!(gone.status, StatusCode::NO_CONTENT, "{}", gone.text());
    assert_eq!(admin.get("/api/requests/mine").await.json()[0]["listed"], true);
    assert!(!listed(&admin.get("/api/favorites").await.json()));
}

#[tokio::test]
async fn profiles_edit_their_own_name_language_and_avatar() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut c = admin(&server).await;
    let res = c
        .send(
            "PATCH",
            "/api/auth/profile",
            Some(json!({ "display_name": " Chi ", "language": "es", "avatar": "fox" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    let me = c.get("/api/auth/me").await.json();
    assert_eq!(me["user"]["display_name"], "Chi");
    assert_eq!(me["user"]["language"], "es");
    assert_eq!(me["user"]["avatar"], "fox");
    // Omitted fields stay; null resets.
    c.send("PATCH", "/api/auth/profile", Some(json!({ "avatar": null }))).await;
    let me = c.get("/api/auth/me").await.json();
    assert!(me["user"]["avatar"].is_null());
    assert_eq!(me["user"]["language"], "es");
    // Preview sound is on until the profile turns it off.
    assert_eq!(me["user"]["preview_sound"], true);
    c.send("PATCH", "/api/auth/profile", Some(json!({ "preview_sound": false }))).await;
    let me = c.get("/api/auth/me").await.json();
    assert_eq!(me["user"]["preview_sound"], false);
    assert_eq!(me["user"]["language"], "es");
    // Only known languages and avatars, sensible names.
    for bad in [json!({ "language": "xx" }), json!({ "avatar": "../x" }), json!({ "display_name": "" })] {
        let res = c.send("PATCH", "/api/auth/profile", Some(bad.clone())).await;
        assert!(res.status.is_client_error(), "{bad}: {}", res.status);
    }
}

/// A tiny Sonarr recording what it was asked: the added series, its season monitoring, and
/// the season searches.
async fn fake_sonarr() -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    use axum::extract::State;
    use axum::routing::get;
    use std::sync::{Arc, Mutex};

    type Log = State<Arc<Mutex<Vec<String>>>>;
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let seasons = || json!([{ "seasonNumber": 1, "monitored": false }, { "seasonNumber": 2, "monitored": false }, { "seasonNumber": 3, "monitored": false }]);
    let app = axum::Router::new()
        .route("/api/v3/system/status", get(|| async { axum::Json(json!({ "version": "4.0" })) }))
        .route("/api/v3/qualityprofile", get(|| async { axum::Json(json!([{ "id": 1, "name": "Any" }])) }))
        .route("/api/v3/rootfolder", get(|| async { axum::Json(json!([{ "id": 1, "path": "/tv" }])) }))
        .route(
            "/api/v3/series/lookup",
            get(move || async move {
                axum::Json(json!([{ "title": "Severance", "tvdbId": 371_980, "seasons": seasons() }]))
            }),
        )
        .route(
            "/api/v3/series",
            get(|| async { axum::Json(json!([])) }).post(
                |State(l): Log, axum::Json(b): axum::Json<serde_json::Value>| async move {
                    let monitored: Vec<i64> = b["seasons"]
                        .as_array()
                        .map(|s| {
                            s.iter()
                                .filter(|s| s["monitored"] == true)
                                .filter_map(|s| s["seasonNumber"].as_i64())
                                .collect()
                        })
                        .unwrap_or_default();
                    l.lock()
                        .unwrap()
                        .push(format!("add monitor={} seasons={monitored:?}", b["addOptions"]["monitor"]));
                    axum::Json(json!({ "id": 9, "title": b["title"], "tvdbId": b["tvdbId"] }))
                },
            ),
        )
        .route(
            "/api/v3/series/9",
            get(move || async move {
                axum::Json(json!({ "id": 9, "title": "Severance", "monitored": true, "seasons": seasons() }))
            })
            .put(|State(l): Log, axum::Json(b): axum::Json<serde_json::Value>| async move {
                let on: Vec<i64> = b["seasons"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|s| s["monitored"] == true)
                    .filter_map(|s| s["seasonNumber"].as_i64())
                    .collect();
                l.lock().unwrap().push(format!("monitor {on:?}"));
                axum::Json(b)
            }),
        )
        .route(
            "/api/v3/command",
            axum::routing::post(|State(l): Log, axum::Json(b): axum::Json<serde_json::Value>| async move {
                l.lock().unwrap().push(format!("{} {}", b["name"].as_str().unwrap(), b["seasonNumber"]));
                axum::Json(json!({ "id": 1 }))
            }),
        )
        .with_state(log.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, log)
}

#[tokio::test]
async fn show_requests_can_choose_seasons() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let (url, log) = fake_sonarr().await;
    let res = admin
        .send(
            "PUT",
            "/api/admin/settings/sonarr",
            Some(json!({ "url": url, "api_key": "k", "quality_profile_id": 1, "root_folder": "/tv" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT, "{}", res.text());

    // Seasons 3 and 1 (any order, repeats ignored): added with only those monitored, searched.
    let res = admin
        .post(
            "/api/requests",
            json!({ "kind": "series", "title": "Severance", "tvdb_id": 371_980, "seasons": [3, 1, 3] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.text());
    assert_eq!(
        *log.lock().unwrap(),
        ["add monitor=\"none\" seasons=[1, 3]", "monitor [1, 3]", "SeasonSearch 1", "SeasonSearch 3",]
    );
}

#[tokio::test]
async fn features_follow_what_is_set_up() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    // The test server has a Radarr and nothing else.
    let f = admin.get("/api/features").await.json();
    assert_eq!(
        f,
        json!({ "request_movies": true, "request_shows": false, "tmdb": false, "mail": false, "subtitle_search": false })
    );
    // No Sonarr: show requests are refused, not half-sent.
    let res = admin.post("/api/requests", json!({ "kind": "series", "title": "X", "tvdb_id": 1 })).await;
    assert!(res.status.is_client_error() || res.status.is_server_error(), "{}", res.status);
    assert_ne!(res.status, StatusCode::CREATED);
    assert!(admin.get("/api/requests/mine").await.json().as_array().unwrap().is_empty(), "nothing saved");
}

#[tokio::test]
async fn an_unreachable_share_never_empties_the_library() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut c = admin(&server).await;
    let before = c.get("/api/items").await.json().as_array().unwrap().len();
    assert!(before > 0);
    let id = item_id(&c.get("/api/items").await.json(), "Test Movie");

    // The share drops, leaving its empty mount folder behind.
    let movies = server.dir.path().join("movies");
    std::fs::rename(&movies, server.dir.path().join("movies-away")).unwrap();
    std::fs::create_dir(&movies).unwrap();

    // Apps are told which library is offline.
    panda_server::check_library_health(&server.state).await;
    assert_eq!(c.get("/api/libraries/offline").await.json(), json!(["Movies"]));

    // Playing fails fast with a clear "offline", not a hang or a 500.
    let res = c.post(&format!("/api/items/{id}/playback"), json!({})).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE, "{}", res.text());
    assert!(res.text().contains("isn't reachable"), "{}", res.text());

    // A rescan finds nothing, and keeps everything.
    c.post("/api/admin/libraries/scan", json!({})).await;
    for _ in 0..100 {
        if c.get("/api/admin/libraries/scan").await.json()["scanning"] == false {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(c.get("/api/items").await.json().as_array().unwrap().len(), before, "nothing pruned");

    // Back: the notice goes.
    std::fs::remove_dir(&movies).unwrap();
    std::fs::rename(server.dir.path().join("movies-away"), &movies).unwrap();
    panda_server::check_library_health(&server.state).await;
    assert_eq!(c.get("/api/libraries/offline").await.json(), json!([]));
}

#[tokio::test]
async fn arr_cleanup_is_off_until_turned_on() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let s = admin.get("/api/admin/settings").await.json();
    assert_eq!(s["cleanup"], json!({ "movies": false, "shows": false }));
    let res = admin
        .send("PUT", "/api/admin/settings/cleanup", Some(json!({ "movies": true, "shows": false })))
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert_eq!(
        admin.get("/api/admin/settings").await.json()["cleanup"],
        json!({ "movies": true, "shows": false })
    );
}

#[tokio::test]
async fn the_cache_ceiling_is_set_in_settings() {
    if !ffmpeg_available() {
        return;
    }
    let server = server().await;
    let mut admin = admin(&server).await;
    let s = admin.get("/api/admin/settings/storage").await.json();
    assert_eq!(s["cache_max_gb"], 20.0, "{s}");
    assert!(s["data_dir"].as_str().is_some() && s["cache_used_bytes"].is_u64(), "{s}");
    let res = admin.send("PUT", "/api/admin/settings/storage", Some(json!({ "cache_max_gb": 5 }))).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert_eq!(admin.get("/api/admin/settings/storage").await.json()["cache_max_gb"], 5.0);
    let bad = admin.send("PUT", "/api/admin/settings/storage", Some(json!({ "cache_max_gb": -1 }))).await;
    assert_eq!(bad.status, StatusCode::UNPROCESSABLE_ENTITY);
}
