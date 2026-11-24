//! Playback: decide direct play vs. HLS, serve files/segments, serve subtitles.
//!
//! Subtitles are never burned in. Every playback response lists the subtitle tracks and the
//! client draws the selected one on top of the video.

use std::path::PathBuf;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use panda_db::Item;
use panda_media::playback::{self, ClientProfile, Decision};
use panda_media::probe::MediaInfo;
use panda_media::sidecar::{self, Sidecar};
use panda_media::subtitles;
use panda_media::transcode::{
    self, HlsOptions, HwPipeline, Software, TranscodePlan, TranscodeSession, VideoCodec, VideoPlan,
};
use serde::{Deserialize, Serialize};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::auth::middleware::MediaGrant;
use crate::auth::{self, CurrentUser, ensure_item_access, with_token};
use crate::error::{ApiError, ApiResult};
use crate::services::bitmap_subs;
use crate::services::markers::ItemMarkers;
use crate::services::sessions::{Slot, StreamInfo, Ticket, now_unix};
use crate::state::AppState;

const FIRST_SEGMENT_TIMEOUT: Duration = Duration::from_secs(30);
/// A seek waits at most this long to find the keyframe before a remux restart.
const KEYFRAME_LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);

/// Signed-in API calls.
pub(super) fn user_routes() -> Router<AppState> {
    Router::new()
        .route("/items/{id}/playback", post(start_playback))
        .route("/items/{id}/subtitles/find", post(find_subtitles))
        .route("/items/{id}/markers", get(item_markers))
        .route("/hls/{session}", delete(stop_session))
}

/// Fetched by video players: session auth *or* a signed `?t=` URL.
pub(super) fn media_routes() -> Router<AppState> {
    Router::new()
        .route("/items/{id}/stream", get(direct_stream))
        .route("/items/{id}/subtitles/{index}", get(subtitle_vtt))
        .route("/items/{id}/subtitles/files/{file}", get(sidecar_vtt))
        .route("/items/{id}/preview/{secs}", get(preview_frame))
        .route("/items/{id}/subtitles/{index}/images", get(bitmap_manifest))
        .route("/items/{id}/subtitles/{index}/images/{file}", get(bitmap_image))
        .route("/hls/{session}/{file}", get(hls_file))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct PlaybackRequest {
    /// Omitted -> a conservative H.264/AAC/MP4 profile.
    pub(super) profile: Option<ClientProfile>,
    pub(super) start_secs: f64,
    pub(super) audio_index: Option<u32>,
    /// Title playback only: play this version (item id) instead of auto-picking.
    pub(super) version: Option<i64>,
}

#[derive(Serialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub(super) enum PlaybackResponse {
    DirectPlay {
        /// The file being played (the chosen version, for title playback).
        item_id: i64,
        url: String,
        /// Lets the player pick the right pipeline (the URL has no file extension).
        mime_type: &'static str,
        stream: StreamSummary,
        subtitles: Vec<SubtitleTrack>,
        /// The file's audio tracks, and the one playing.
        audio: Vec<AudioTrack>,
        audio_index: Option<u32>,
        /// Scrub preview of any moment: replace `{secs}` with the time (see [`preview_frame`]).
        /// `None` without a video stream.
        preview_url: Option<String>,
        /// Where the intro and credits are ("Skip intro", "Up next").
        markers: ItemMarkers,
        /// An episode's next one, to offer at its end.
        next: Option<NextUp>,
    },
    Hls {
        item_id: i64,
        url: String,
        session_id: String,
        /// The HLS timeline starts at 0. Add this to the player position for the real position.
        start_secs: f64,
        plan: TranscodePlan,
        stream: StreamSummary,
        reasons: Vec<String>,
        subtitles: Vec<SubtitleTrack>,
        audio: Vec<AudioTrack>,
        audio_index: Option<u32>,
        preview_url: Option<String>,
        /// Where the intro and credits are ("Skip intro", "Up next").
        markers: ItemMarkers,
        /// An episode's next one, to offer at its end.
        next: Option<NextUp>,
    },
}

/// One audio track the player can switch to (`audio_index` in the playback request).
#[derive(Debug, Clone, Serialize)]
pub(super) struct AudioTrack {
    index: u32,
    language: Option<String>,
    codec: String,
    channels: u32,
    default: bool,
    /// Its title in the file ("Director's commentary"), when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

/// Direct play with another audio track than the default: the file repackaged (video and that
/// audio copied), since players only play a file's default track.
fn other_audio(media: &MediaInfo, requested: Option<u32>) -> ApiResult<(TranscodePlan, Vec<String>)> {
    let index = audio_track(media, requested)?;
    let plan =
        TranscodePlan { video: transcode::VideoPlan::Copy, audio: transcode::AudioPlan::Copy { index } };
    Ok((plan, vec!["non-default audio track selected".into()]))
}

/// The file's audio tracks (the one that plays: `audio_track`, the one asked for or the default).
fn audio_tracks(media: &MediaInfo) -> Vec<AudioTrack> {
    media
        .audio
        .iter()
        .map(|a| AudioTrack {
            index: a.index,
            language: a.language.clone(),
            codec: a.codec.clone(),
            channels: a.channels,
            default: a.default,
            title: a.title.clone(),
        })
        .collect()
}

/// What the viewer is actually getting, for the player's info line.
#[derive(Debug, Clone, Serialize)]
pub(super) struct StreamSummary {
    /// `direct`, `remux` (video copied) or `transcode`.
    mode: &'static str,
    codec: String,
    height: u32,
    bitrate_kbps: Option<u32>,
    pipeline: Option<&'static str>,
}

impl StreamSummary {
    fn original(mode: &'static str, media: &MediaInfo) -> Self {
        Self {
            mode,
            codec: media.video.as_ref().map_or_else(String::new, |v| v.codec.clone()),
            height: media.video.as_ref().map_or(0, |v| v.height),
            bitrate_kbps: media.bit_rate.map(|b| (b / 1000) as u32),
            pipeline: None,
        }
    }

    fn label(&self) -> String {
        let rate =
            self.bitrate_kbps.map(|k| format!(" {:.1} Mbps", f64::from(k) / 1000.0)).unwrap_or_default();
        format!("{}p {}{rate}", self.height, self.codec.to_uppercase())
    }
}

/// Sent as JSON to players: each flag is its own field.
#[allow(clippy::struct_excessive_bools)]
#[derive(Serialize)]
pub(super) struct SubtitleTrack {
    /// The stream index in the file; for a sidecar, its place in the list of sidecars.
    index: u32,
    /// Tells tracks apart across playbacks (the client remembers per-track timing by it):
    /// `s<index>` for a track in the file, `f<id>` for a sidecar file.
    key: String,
    language: Option<String>,
    codec: String,
    default: bool,
    forced: bool,
    /// For the deaf and hard of hearing (SDH). Only known for sidecars so far.
    hearing_impaired: bool,
    /// A subtitle file next to the video (`Movie.en.srt`, as Bazarr writes them).
    external: bool,
    /// `text`: fetch `url` (`WebVTT`) and draw cues. `bitmap`: PGS/VobSub, client rendering TBD.
    overlay: &'static str,
    url: Option<String>,
    /// A subtitle file of another version of the movie ("4K Dolby Vision"): Bazarr may only
    /// manage one of them, and releases of a film usually share timing.
    #[serde(skip_serializing_if = "Option::is_none")]
    from_version: Option<String>,
    /// Its title in the file ("Forced French subtitles"), when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

/// A subtitle file for an item: next to it, or next to another version of the same movie.
struct FoundSidecar {
    side: Sidecar,
    path: PathBuf,
    from_version: Option<String>,
}

/// The subtitle files next to `item`, then those next to the other versions of the same movie
/// (in libraries `user_id` may see), each folder listed under its own timeout. `Offline` only
/// when the item's own folder doesn't answer.
async fn item_sidecars(state: &AppState, user_id: i64, item: &Item) -> ApiResult<Vec<FoundSidecar>> {
    let mut out: Vec<FoundSidecar> = list_sidecars(&item.path)
        .await?
        .into_iter()
        .map(|(side, path)| FoundSidecar { side, path, from_version: None })
        .collect();
    let catalog = crate::catalog::get(state).await?;
    let Some(title) = catalog.movies.iter().find(|t| t.title.versions.iter().any(|v| v.item_id == item.id))
    else {
        return Ok(out);
    };
    let allowed = crate::auth::allowed_libraries(state, user_id).await?;
    for (v, lib) in title.title.versions.iter().zip(&title.libraries) {
        if v.item_id == item.id || allowed.as_ref().is_some_and(|a| !a.contains(lib)) {
            continue;
        }
        let Some(other) = state.db.item(v.item_id).await? else { continue };
        for (side, path) in sidecars(&other.path).await {
            if !out.iter().any(|f| f.side.id() == side.id()) {
                out.push(FoundSidecar { side, path, from_version: Some(v.label.clone()) });
            }
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
pub(super) struct FindSubtitles {
    /// ISO 639-1 ("en").
    language: String,
}

/// What a subtitle search found: the item's subtitle tracks now (with any new file).
#[derive(Serialize)]
pub(super) struct FoundSubtitles {
    /// A file in that language is there now.
    found: bool,
    subtitles: Vec<SubtitleTrack>,
}

/// Bazarr searches its providers while this waits; usually a few seconds.
const SUBTITLE_SEARCH_TIMEOUT: Duration = Duration::from_secs(90);

/// Ask Bazarr for subtitles in a language for this file: the movie (or, when Bazarr only knows
/// another version of it, that version: its file is shared, see `item_sidecars`) or the episode,
/// found by its file name (Bazarr mounts the share elsewhere). Then the tracks as playback lists
/// them. `NotConfigured` without Bazarr; not found when Bazarr doesn't know the file.
async fn find_subtitles(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<i64>,
    Json(body): Json<FindSubtitles>,
) -> ApiResult<Json<FoundSubtitles>> {
    let bazarr = state.integrations().bazarr.clone().ok_or(ApiError::NotConfigured("bazarr"))?;
    let language = body.language.trim().to_ascii_lowercase();
    if language.len() != 2 || !language.bytes().all(|b| b.is_ascii_lowercase()) {
        return Err(ApiError::Validation("language must be a two-letter code".into()));
    }
    let (item, media) = load(&state, id).await?;
    ensure_item_access(&state, me.user.id, &item).await?;
    let search = async {
        if item.kind == "episode" {
            let shows = bazarr.series().await?;
            let parts: Vec<&str> = item.path.split(['/', '\\']).collect();
            let show = shows
                .iter()
                .find(|s| parts.contains(&panda_arr::bazarr::tail(&s.path, 1).as_str()))
                .ok_or(ApiError::NotFound)?;
            let file = panda_arr::bazarr::tail(&item.path, 1);
            let ep = bazarr
                .episodes(show.sonarr_series_id)
                .await?
                .into_iter()
                .find(|e| panda_arr::bazarr::tail(&e.path, 1) == file)
                .ok_or(ApiError::NotFound)?;
            bazarr.download_episode(ep.sonarr_series_id, ep.sonarr_episode_id, &language).await?;
        } else {
            // This file, else another version of the movie Bazarr knows (one Radarr per Bazarr).
            let mut paths = vec![item.path.clone()];
            paths.extend(other_version_paths(&state, me.user.id, &item).await?);
            let movies = bazarr.movies().await?;
            let movie = paths
                .iter()
                .find_map(|p| {
                    let t = panda_arr::bazarr::tail(p, 2);
                    movies.iter().find(|m| panda_arr::bazarr::tail(&m.path, 2) == t)
                })
                .ok_or(ApiError::NotFound)?;
            bazarr.download_movie(movie.radarr_id, &language).await?;
        }
        Ok::<(), ApiError>(())
    };
    tokio::time::timeout(SUBTITLE_SEARCH_TIMEOUT, search)
        .await
        .map_err(|_| ApiError::Io(std::io::Error::other("Bazarr's search timed out")))??;
    let item_token = auth::sign_media(&state, (&me.user).into(), &format!("/api/items/{id}/"));
    let files = item_sidecars(&state, me.user.id, &item).await.unwrap_or_default();
    let found = files.iter().any(|f| f.side.language.as_deref().is_some_and(|l| l.starts_with(&language)));
    Ok(Json(FoundSubtitles { found, subtitles: subtitle_tracks(id, &media, &files, &item_token) }))
}

/// The files of the other versions of `item`'s movie, in libraries `user_id` may see.
async fn other_version_paths(state: &AppState, user_id: i64, item: &Item) -> ApiResult<Vec<String>> {
    let catalog = crate::catalog::get(state).await?;
    let Some(title) = catalog.movies.iter().find(|t| t.title.versions.iter().any(|v| v.item_id == item.id))
    else {
        return Ok(Vec::new());
    };
    let allowed = crate::auth::allowed_libraries(state, user_id).await?;
    let mut out = Vec::new();
    for (v, lib) in title.title.versions.iter().zip(&title.libraries) {
        if v.item_id != item.id
            && allowed.as_ref().is_none_or(|a| a.contains(lib))
            && let Some(other) = state.db.item(v.item_id).await?
        {
            out.push(other.path);
        }
    }
    Ok(out)
}

/// How long re-reading an old analysis may take before playback goes on with the old one.
const REPROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// `media` re-read from the file when it's an older analysis than Panda makes now (no track
/// titles), and stored; a header read, so quick even from a network share. The old one when the
/// file doesn't answer in time.
async fn refreshed(state: &AppState, item: &Item, media: MediaInfo) -> MediaInfo {
    if media.version >= panda_media::probe::PROBE_VERSION {
        return media;
    }
    let probe = panda_media::probe::probe(&state.ffmpeg, std::path::Path::new(&item.path));
    let Ok(Ok(fresh)) = tokio::time::timeout(REPROBE_TIMEOUT, probe).await else { return media };
    let summary = panda_db::ProbeSummary {
        duration_secs: fresh.duration_secs,
        video_codec: fresh.video.as_ref().map(|v| v.codec.clone()),
        width: fresh.video.as_ref().map(|v| i64::from(v.width)),
        height: fresh.video.as_ref().map(|v| i64::from(v.height)),
        dynamic_range: fresh.video.as_ref().map(|v| format!("{:?}", v.range).to_lowercase()),
    };
    if let Ok(json) = serde_json::to_string(&fresh)
        && let Err(e) = state.db.set_probe(item.id, &summary, &json).await
    {
        tracing::warn!(item = item.id, error = %e, "saving a fresh probe failed");
    }
    fresh
}

pub(super) async fn load(state: &AppState, id: i64) -> ApiResult<(Item, MediaInfo)> {
    let item = state.db.item(id).await?.ok_or(ApiError::NotFound)?;
    let media = item
        .probe_json
        .as_deref()
        .and_then(|j| serde_json::from_str(j).ok())
        .ok_or_else(|| ApiError::BadRequest("item has not been probed yet".into()))?;
    Ok((item, media))
}

fn subtitle_tracks(
    id: i64,
    media: &MediaInfo,
    sidecars: &[FoundSidecar],
    item_token: &str,
) -> Vec<SubtitleTrack> {
    let embedded = media.subtitles.iter().map(|s| SubtitleTrack {
        index: s.index,
        key: format!("s{}", s.index),
        language: s.language.clone(),
        codec: s.codec.clone(),
        default: s.default,
        forced: s.forced,
        hearing_impaired: s.hearing_impaired,
        external: false,
        overlay: if s.text_based { "text" } else { "bitmap" },
        // Text: a WebVTT document. Bitmap (PGS): a manifest of timed images.
        url: if s.text_based {
            Some(with_token(&format!("/api/items/{id}/subtitles/{}", s.index), item_token))
        } else {
            bitmap_subs::supported(&s.codec)
                .then(|| with_token(&format!("/api/items/{id}/subtitles/{}/images", s.index), item_token))
        },
        from_version: None,
        title: s.title.clone(),
    });
    // Files are numbered after every stream in the video, so no two tracks share an index.
    let first_file = media
        .video
        .iter()
        .map(|v| v.index)
        .chain(media.audio.iter().map(|a| a.index))
        .chain(media.subtitles.iter().map(|s| s.index))
        .max()
        .map_or(0, |i| i + 1);
    let files =
        sidecars.iter().zip(first_file..).map(|(f, n)| (&f.side, f, n)).map(|(s, f, n)| SubtitleTrack {
            index: n,
            key: format!("f{}", s.id()),
            language: s.language.clone(),
            codec: s.format.clone(),
            default: s.default,
            forced: s.forced,
            hearing_impaired: s.hearing_impaired,
            external: true,
            overlay: "text",
            url: Some(with_token(&format!("/api/items/{id}/subtitles/files/{}", s.id()), item_token)),
            from_version: f.from_version.clone(),
            title: None,
        });
    embedded.chain(files).collect()
}

/// A folder listing gets this long before playback goes on without sidecars.
const SIDECAR_LIST_TIMEOUT: Duration = Duration::from_secs(3);

/// The subtitle files next to `path` (none if the folder doesn't answer in time).
async fn sidecars(path: &str) -> Vec<(Sidecar, PathBuf)> {
    list_sidecars(path).await.unwrap_or_default()
}

/// The subtitle files next to `path`, or `Offline` when the folder doesn't answer in time.
async fn list_sidecars(path: &str) -> ApiResult<Vec<(Sidecar, PathBuf)>> {
    let p = PathBuf::from(path);
    let listing = tokio::task::spawn_blocking(move || sidecar::find(&p));
    match tokio::time::timeout(SIDECAR_LIST_TIMEOUT, listing).await {
        Ok(Ok(Ok(found))) => Ok(found),
        // The folder didn't answer (a dropped share: EIO, ESTALE, an unmounted volume).
        Ok(Ok(Err(e))) => {
            tracing::warn!(path, error = %e, "listing subtitle files failed");
            Err(ApiError::Offline("This title's storage isn't reachable right now.".into()))
        }
        Ok(Err(e)) => {
            tracing::warn!(path, error = %e, "listing subtitle files failed");
            Ok(Vec::new())
        }
        Err(_) => {
            tracing::warn!(path, "listing subtitle files timed out");
            Err(ApiError::Offline("This title's storage isn't reachable right now.".into()))
        }
    }
}

async fn start_playback(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<i64>,
    body: Option<Json<PlaybackRequest>>,
) -> ApiResult<Json<PlaybackResponse>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    Ok(Json(play(&state, &me, id, req).await?))
}

/// Text subtitle extractions read the whole file: this many at once, each within the timeout.
static SUBTITLE_JOBS: std::sync::LazyLock<tokio::sync::Semaphore> =
    std::sync::LazyLock::new(|| tokio::sync::Semaphore::new(2));
const SUBTITLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// How long the file may take to answer before its storage is treated as offline.
const FILE_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// The file is there and answering (a NAS that dropped would otherwise hang playback, or
/// fail deep inside ffmpeg with a confusing error).
async fn ensure_reachable(path: &str) -> ApiResult<()> {
    let p = std::path::PathBuf::from(path);
    match tokio::time::timeout(FILE_CHECK_TIMEOUT, tokio::task::spawn_blocking(move || p.is_file())).await {
        Ok(Ok(true)) => Ok(()),
        _ => Err(ApiError::Offline(
            "This title's storage isn't reachable right now. Check that the NAS is on and connected.".into(),
        )),
    }
}

/// The requested audio track if it really is one of this file's (it goes to ffmpeg's `-map`,
/// so never a video or subtitle stream index), else the default one.
fn audio_track(media: &MediaInfo, requested: Option<u32>) -> ApiResult<u32> {
    requested
        .filter(|i| media.audio.iter().any(|a| a.index == *i))
        .or_else(|| media.audio.iter().find(|a| a.default).or(media.audio.first()).map(|a| a.index))
        .ok_or_else(|| ApiError::BadRequest("this file has no audio track".into()))
}

/// Start playing one file (item) for `me`.
pub(super) async fn play(
    state: &AppState,
    me: &CurrentUser,
    id: i64,
    req: PlaybackRequest,
) -> ApiResult<PlaybackResponse> {
    let state = state.clone();
    let me = me.clone();
    let (item, media) = load(&state, id).await?;
    ensure_item_access(&state, me.user.id, &item).await?;
    ensure_reachable(&item.path).await?;
    let media = refreshed(&state, &item, media).await;
    let profile = req.profile.unwrap_or_default();
    // Players fetch these URLs without auth headers, so they carry signatures scoped to
    // this item (stream + subtitles) or this HLS session.
    let item_token = auth::sign_media(&state, (&me.user).into(), &format!("/api/items/{id}/"));
    let files = item_sidecars(&state, me.user.id, &item).await.unwrap_or_default();
    let subtitles = subtitle_tracks(id, &media, &files, &item_token);
    let preview_url =
        media.video.is_some().then(|| with_token(&format!("/api/items/{id}/preview/{{secs}}"), &item_token));

    // Direct play can't honour a non-default audio track. Browsers pick the default.
    let (audio, audio_index) = (audio_tracks(&media), audio_track(&media, req.audio_index).ok());
    let (markers, next) = skips(&state, me.user.id, &item, &media).await;
    let decision = playback::decide(&media, &profile, req.audio_index);
    let (plan, reasons) = match decision {
        Decision::DirectPlay if req.audio_index.is_none() => {
            return Ok(PlaybackResponse::DirectPlay {
                item_id: id,
                url: with_token(&format!("/api/items/{id}/stream"), &item_token),
                mime_type: playback::mime_type(&media.container),
                stream: StreamSummary::original("direct", &media),
                subtitles,
                audio,
                audio_index,
                preview_url,
                markers,
                next,
            });
        }
        Decision::DirectPlay => other_audio(&media, req.audio_index)?,
        Decision::Transcode { plan, reasons } => (plan, reasons),
    };

    let session_id = uuid::Uuid::new_v4().simple().to_string();
    let dir = state.config.transcode_dir().join(&session_id);
    let mut opts = HlsOptions { start_secs: req.start_secs.max(0.0), ..Default::default() };
    let input = PathBuf::from(&item.path);

    // Pick a pipeline and reserve a slot for it, falling back from hardware to software
    // when hardware is full. Remuxes never wait.
    let mut plan = plan;
    let mut pipeline = transcode::select_pipeline(&state.caps, &media, &plan);
    transcode::adapt_plan(&mut plan, pipeline.as_ref());
    let mut ticket = reserve(&state, &plan, pipeline.as_ref())?;
    if ticket.slot == Slot::Software && pipeline.name() != "software" {
        pipeline = Box::new(Software::from_caps(&state.caps));
        transcode::adapt_plan(&mut plan, pipeline.as_ref());
    }

    if matches!(plan.video, VideoPlan::Copy) && opts.start_secs > 0.0 {
        opts.start_secs = remux_start(&state, &input, &media, id, opts.start_secs).await;
    }

    let mut used = pipeline.name();
    let session = match start_hls(&state, &input, &dir, &media, &plan, &opts, pipeline.as_ref()).await {
        Ok(s) => s,
        // Hardware can fail on odd files or drivers; software always works, just slower.
        Err(e) if ticket.slot == Slot::Hardware => {
            tracing::warn!(item = id, pipeline = used, error = %e, "hardware transcode failed; retrying in software");
            let software = Software::from_caps(&state.caps);
            transcode::adapt_plan(&mut plan, &software);
            ticket = state.sessions.try_reserve(Slot::Software).ok_or_else(busy)?;
            used = software.name();
            start_hls(&state, &input, &dir, &media, &plan, &opts, &software).await?
        }
        Err(e) => return Err(e.into()),
    };

    let stream = stream_summary(&plan, used, &media);
    tracing::info!(
        item = id, session = %session_id, start_secs = opts.start_secs, pipeline = used,
        output = %stream.label(), ?reasons, "started stream"
    );
    let info = StreamInfo {
        user_id: me.user.id,
        item_id: id,
        pipeline: if ticket.slot == Slot::Remux { "copy" } else { used },
        output: stream.label(),
        started_at: now_unix(),
    };
    state.sessions.insert(session_id.clone(), session, info, ticket).await;

    let hls_token = auth::sign_media(&state, (&me.user).into(), &format!("/api/hls/{session_id}/"));
    Ok(PlaybackResponse::Hls {
        item_id: id,
        url: with_token(&format!("/api/hls/{session_id}/{}", transcode::PLAYLIST), &hls_token),
        session_id,
        start_secs: opts.start_secs,
        plan,
        stream,
        reasons,
        subtitles,
        audio,
        audio_index,
        preview_url,
        markers,
        next,
    })
}

/// What an HLS stream is: an encode's codec, size and bitrate, or the original copied.
fn stream_summary(plan: &TranscodePlan, used: &'static str, media: &MediaInfo) -> StreamSummary {
    match plan.video {
        VideoPlan::Encode { target_height, codec, bitrate_kbps, .. } => StreamSummary {
            mode: "transcode",
            codec: match codec {
                VideoCodec::H264 => "h264".into(),
                VideoCodec::Hevc => "hevc".into(),
            },
            height: target_height,
            bitrate_kbps: Some(bitrate_kbps),
            pipeline: Some(used),
        },
        _ => StreamSummary::original("remux", media),
    }
}

/// Where to skip (intro, credits) and what plays next. An episode's season (and the next one's)
/// is checked for intros and credits soon, if it hasn't been.
async fn skips(
    state: &AppState,
    user_id: i64,
    item: &Item,
    media: &MediaInfo,
) -> (ItemMarkers, Option<NextUp>) {
    let markers = crate::services::markers::for_item(state, item, media).await;
    let next = next_episode(state, user_id, item).await.unwrap_or_default();
    if item.kind == "episode" {
        crate::services::markers::want(item);
        if let Some(n) = &next
            && n.season != item.season.unwrap_or(0)
            && let Ok(Some(next_item)) = state.db.item(n.item_id).await
        {
            crate::services::markers::want(&next_item);
        }
    }
    (markers, next)
}

/// The episode after `item` in its show (by season and number; specials only after specials),
/// one the profile can see: the same library's copy when there are several.
#[derive(Debug, Serialize)]
pub(super) struct NextUp {
    item_id: i64,
    series: String,
    season: i64,
    episode: i64,
    /// The episode's name and still (image key), when TMDB has them, and the show's backdrop.
    title: Option<String>,
    still: Option<String>,
    backdrop: Option<String>,
}

async fn next_episode(state: &AppState, user_id: i64, item: &Item) -> ApiResult<Option<NextUp>> {
    let Some(series) = item.series.clone().filter(|_| item.kind == "episode") else { return Ok(None) };
    let filter = panda_db::ItemFilter {
        series: Some(series.clone()),
        kind: Some(panda_db::ItemKind::Episode),
        allowed_libraries: auth::allowed_libraries(state, user_id).await?,
        limit: Some(10_000),
        ..Default::default()
    };
    let here = (item.season.unwrap_or(0), item.episode.unwrap_or(0));
    let next = state
        .db
        .items(&filter)
        .await?
        .into_iter()
        .filter(|e| {
            let at = (e.season.unwrap_or(0), e.episode.unwrap_or(0));
            at > here && (here.0 == 0 || at.0 != 0)
        })
        .min_by_key(|e| {
            (e.season.unwrap_or(0), e.episode.unwrap_or(0), e.library_id != item.library_id, e.id)
        });
    Ok(next.map(|e| NextUp {
        item_id: e.id,
        series: e.meta_title.clone().unwrap_or(series),
        season: e.season.unwrap_or(0),
        episode: e.episode.unwrap_or(0),
        title: e.episode_title.clone(),
        // An image key (downloaded in the background if it isn't yet: shown at the episode's end).
        still: e
            .episode_still
            .as_deref()
            .and_then(|p| super::images::promise(state, panda_metadata::ImageSize::Still, p)),
        backdrop: e.backdrop.clone(),
    }))
}

/// A file's intro and credits again (`pending` at playback: its season was being checked).
async fn item_markers(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> ApiResult<Json<ItemMarkers>> {
    let (item, media) = load(&state, id).await?;
    ensure_item_access(&state, me.user.id, &item).await?;
    Ok(Json(crate::services::markers::for_item(&state, &item, &media).await))
}

/// Where a remux (copied video) seeking to `at` really starts: the keyframe at or before it.
/// Starting exactly there (audio too) and telling the player keeps picture, sound, subtitles
/// and the clock together after a seek. Falls back to `at` (ffmpeg then snaps to a keyframe
/// itself, with `-noaccurate_seek` keeping the audio with it) if the lookup fails or is slow.
async fn remux_start(state: &AppState, input: &std::path::Path, media: &MediaInfo, id: i64, at: f64) -> f64 {
    let Some(v) = &media.video else { return at };
    let lookup = panda_media::probe::keyframe_at_or_before(&state.ffmpeg, input, v.index, at);
    match tokio::time::timeout(KEYFRAME_LOOKUP_TIMEOUT, lookup).await {
        Ok(Ok(Some(k))) => k,
        Ok(Ok(None)) => at,
        Ok(Err(e)) => {
            tracing::debug!(item = id, error = %e, "keyframe lookup failed; ffmpeg seeks itself");
            at
        }
        Err(_) => {
            tracing::debug!(item = id, "keyframe lookup timed out; ffmpeg seeks itself");
            at
        }
    }
}

fn busy() -> ApiError {
    ApiError::Busy(
        "The server is busy: every transcoding slot is in use. Try again in a moment, or choose \
         Original quality if this device can play the file directly."
            .into(),
    )
}

/// Reserve the slot this plan needs: none-ish for remuxes, hardware (or software when
/// hardware is full) for encodes.
fn reserve(state: &AppState, plan: &TranscodePlan, pipeline: &dyn HwPipeline) -> ApiResult<Ticket> {
    let sessions = &state.sessions;
    let ticket = match plan.video {
        VideoPlan::Encode { .. } if pipeline.name() != "software" => {
            sessions.try_reserve(Slot::Hardware).or_else(|| sessions.try_reserve(Slot::Software))
        }
        VideoPlan::Encode { .. } => sessions.try_reserve(Slot::Software),
        _ => sessions.try_reserve(Slot::Remux),
    };
    ticket.ok_or_else(busy)
}

/// Spawn ffmpeg and wait for the first segment; on failure the session is cleaned up.
async fn start_hls(
    state: &AppState,
    input: &std::path::Path,
    dir: &std::path::Path,
    media: &MediaInfo,
    plan: &TranscodePlan,
    opts: &HlsOptions,
    pipeline: &dyn transcode::HwPipeline,
) -> panda_media::Result<TranscodeSession> {
    let args = transcode::build_hls_args(input, dir, media, plan, opts, pipeline);
    let mut session =
        TranscodeSession::spawn(&state.ffmpeg, args, dir.to_path_buf(), opts.start_secs).await?;
    if let Err(e) = session.wait_ready(FIRST_SEGMENT_TIMEOUT).await {
        session.stop().await;
        return Err(e);
    }
    Ok(session)
}

/// Original file with HTTP range support (seeking works without a transcode).
async fn direct_stream(
    State(state): State<AppState>,
    Extension(grant): Extension<MediaGrant>,
    Path(id): Path<i64>,
    req: Request,
) -> ApiResult<Response> {
    let item = state.db.item(id).await?.ok_or(ApiError::NotFound)?;
    ensure_item_access(&state, grant.user_id, &item).await?;
    let res =
        ServeFile::new(&item.path).oneshot(req).await.map_err(|e| ApiError::Io(std::io::Error::other(e)))?;
    Ok(res.map(Body::new))
}

async fn hls_file(
    State(state): State<AppState>,
    Extension(grant): Extension<MediaGrant>,
    Path((session, file)): Path<(String, String)>,
    req: Request,
) -> ApiResult<Response> {
    // Only plain names written by ffmpeg are allowed (no traversal).
    let valid =
        |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
    if !valid(&session) || !valid(&file) || file.starts_with('.') {
        return Err(ApiError::NotFound);
    }
    let content_type = match std::path::Path::new(&file).extension().and_then(|e| e.to_str()) {
        Some("m3u8") => "application/vnd.apple.mpegurl",
        Some("m4s" | "mp4") => "video/mp4",
        Some("ts") => "video/mp2t",
        _ => return Err(ApiError::NotFound),
    };
    let dir = state.sessions.touch(&session, grant.user_id, &file).await.ok_or(ApiError::NotFound)?;
    if content_type == "application/vnd.apple.mpegurl" {
        // Players resolve segment URIs relative to the playlist and drop its query string,
        // so every segment line gets its own signed `?t=`.
        let text = match tokio::fs::read_to_string(dir.join(&file)).await {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ApiError::NotFound),
            Err(e) => return Err(e.into()),
        };
        let token = auth::sign_media(&state, (&grant).into(), &format!("/api/hls/{session}/"));
        let body = sign_playlist(&text, &token);
        return Ok((
            [
                (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
                (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            ],
            body,
        )
            .into_response());
    }
    // Stream from disk (no buffering whole segments in memory). ServeFile also handles ranges.
    let mut res = ServeFile::new(dir.join(&file))
        .oneshot(req)
        .await
        .map_err(|e| ApiError::Io(std::io::Error::other(e)))?
        .map(Body::new);
    let headers = res.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    // The playlist grows while ffmpeg runs. Finished segments never change.
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600, immutable"));
    Ok(res)
}

/// Players resolve URIs relative to the playlist and drop its query string, so every segment
/// line, and the fMP4 init segment in `#EXT-X-MAP`, gets its own signed `?t=`.
fn sign_playlist(text: &str, token: &str) -> String {
    text.lines()
        .map(|l| {
            if let Some(rest) = l.strip_prefix("#EXT-X-MAP:URI=\"")
                && let Some((uri, tail)) = rest.split_once('"')
            {
                format!("#EXT-X-MAP:URI=\"{}\"{tail}\n", with_token(uri, token))
            } else if l.is_empty() || l.starts_with('#') {
                format!("{l}\n")
            } else {
                format!("{}\n", with_token(l, token))
            }
        })
        .collect()
}

/// Owners stop their own sessions; admins can stop any.
async fn stop_session(
    State(state): State<AppState>,
    Extension(me): Extension<CurrentUser>,
    Path(session): Path<String>,
) -> StatusCode {
    let owner = if me.is_admin() { None } else { Some(me.user.id) };
    if state.sessions.stop(&session, owner).await { StatusCode::NO_CONTENT } else { StatusCode::NOT_FOUND }
}

/// `?from=<secs>`: the part of a subtitle track around there (see [`subtitle_vtt`]).
/// `?shift=<secs>`: cues moved that much earlier (a Chromecast's stream begun mid-file, plus the
/// viewer's timing). `?ready=1`: answer at once, the track if it's extracted, else 404 while it
/// extracts (a receiver that fetches once can't wait minutes).
#[derive(Deserialize)]
pub(super) struct SubtitleQuery {
    from: Option<f64>,
    shift: Option<f64>,
    ready: Option<bool>,
}

/// The `WebVTT` response, shifted when asked.
fn vtt_body(vtt: String, shift: Option<f64>) -> Response {
    let vtt = match shift.filter(|s| s.is_finite() && *s != 0.0) {
        Some(s) => panda_media::subtitles::shift_webvtt(&vtt, s),
        None => vtt,
    };
    ([(header::CONTENT_TYPE, "text/vtt; charset=utf-8")], vtt).into_response()
}

/// Seconds of subtitles one windowed request returns.
const SUBTITLE_WINDOW: u32 = 600;
/// A window is usually under a second. A sparse track (signs only) makes ffmpeg read on to its
/// next line, which can be far into the file: past this, the player is told to ask again later
/// (`NOTE panda pending`) while the whole track extracts in the background.
const SUBTITLE_WINDOW_WAIT: Duration = Duration::from_secs(10);
const NOTE_PENDING: &str = "WEBVTT\n\nNOTE panda pending\n";
/// Marks on the `WebVTT` (players skip NOTE blocks): the whole track, or the window it holds.
const NOTE_COMPLETE: &str = "NOTE panda complete";

/// Whole-track extractions under way (one per cache file), so requests don't start another.
static FULL_EXTRACTIONS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
    std::sync::LazyLock::new(Default::default);

/// A text subtitle track as `WebVTT`. Getting a whole embedded track out reads the whole file
/// (minutes for a large one on a network share), so with `?from=` the player gets the
/// `SUBTITLE_WINDOW` seconds around there at once (a seek, under a second), while the whole
/// track is extracted in the background and cached; once it is, every request gets it all,
/// marked `NOTE panda complete`. Without `from`: the whole track, waiting for it.
async fn subtitle_vtt(
    State(state): State<AppState>,
    Extension(grant): Extension<MediaGrant>,
    Path((id, index)): Path<(i64, u32)>,
    Query(q): Query<SubtitleQuery>,
) -> ApiResult<Response> {
    let (item, media) = load(&state, id).await?;
    ensure_item_access(&state, grant.user_id, &item).await?;
    if subtitles::find_text_track(&media, index).is_none() {
        return Err(ApiError::NotFound);
    }
    let vtt_response = |v: String| vtt_body(v, q.shift);
    let complete = |v: String| vtt_response(mark_complete(&v));
    // The file size is in the name: a replaced file (an upgrade) gets fresh subtitles.
    let dir = state.config.cache_dir().join("subtitles");
    let cache = dir.join(format!("{id}-{}_{index}.vtt", item.size_bytes));
    if let Ok(v) = tokio::fs::read_to_string(&cache).await {
        return Ok(complete(v));
    }
    let input = PathBuf::from(&item.path);
    if q.ready == Some(true) {
        spawn_full_extraction(&state, cache, &item.path, index);
        return Err(ApiError::NotFound);
    }
    let Some(from) = q.from else {
        let _permit = SUBTITLE_JOBS.acquire().await.map_err(|e| ApiError::Io(std::io::Error::other(e)))?;
        let vtt = cached_vtt(&cache, full_extraction(&state, &item.path, input, index)).await?;
        return Ok(complete(vtt));
    };
    spawn_full_extraction(&state, cache, &item.path, index);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let start = (from.max(0.0) as u32) / SUBTITLE_WINDOW * SUBTITLE_WINDOW;
    let end = start + SUBTITLE_WINDOW;
    let window = dir.join(format!("{id}-{}_{index}_w{start}.vtt", item.size_bytes));
    if let Ok(v) = tokio::fs::read_to_string(&window).await {
        return Ok(vtt_response(v));
    }
    ensure_reachable(&item.path).await?;
    // Slow (a sparse track): finished in the background and cached for the next ask.
    let (state2, window2) = (state.clone(), window.clone());
    let job = tokio::spawn(async move {
        cached_vtt(&window2, async {
            Ok(tokio::time::timeout(
                SUBTITLE_TIMEOUT,
                subtitles::extract_webvtt_window(&state2.ffmpeg, &input, index, start, end),
            )
            .await
            .map_err(|_| ApiError::Io(std::io::Error::other("subtitle window timed out")))??)
        })
        .await
    });
    match tokio::time::timeout(SUBTITLE_WINDOW_WAIT, job).await {
        Ok(Ok(vtt)) => Ok(vtt_response(vtt?)),
        Ok(Err(e)) => Err(ApiError::Io(std::io::Error::other(e))),
        Err(_) => Ok(vtt_response(NOTE_PENDING.to_string())),
    }
}

/// `vtt` marked as the whole track (a NOTE after the header).
fn mark_complete(vtt: &str) -> String {
    match vtt.split_once('\n') {
        Some((head, rest)) => format!("{head}\n\n{NOTE_COMPLETE}\n{rest}"),
        None => format!("{vtt}\n\n{NOTE_COMPLETE}\n"),
    }
}

/// The whole of one text track: a full pass over the file, never hanging on a dropped share.
async fn full_extraction(state: &AppState, path: &str, input: PathBuf, index: u32) -> ApiResult<String> {
    ensure_reachable(path).await?;
    Ok(tokio::time::timeout(SUBTITLE_TIMEOUT, subtitles::extract_webvtt(&state.ffmpeg, &input, index))
        .await
        .map_err(|_| ApiError::Io(std::io::Error::other("subtitle extraction timed out")))??)
}

/// Extract the whole track into `cache` in the background (once at a time per track; a couple
/// of tracks at a time overall).
fn spawn_full_extraction(state: &AppState, cache: PathBuf, path: &str, index: u32) {
    if !FULL_EXTRACTIONS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(cache.clone()) {
        return;
    }
    let (state, path) = (state.clone(), path.to_string());
    tokio::spawn(async move {
        let result = async {
            let _permit =
                SUBTITLE_JOBS.acquire().await.map_err(|e| ApiError::Io(std::io::Error::other(e)))?;
            let input = PathBuf::from(&path);
            cached_vtt(&cache, full_extraction(&state, &path, input, index)).await
        }
        .await;
        if let Err(e) = result {
            tracing::warn!(path, index, error = %e, "extracting a subtitle track failed");
        }
        FULL_EXTRACTIONS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&cache);
    });
}

/// A sidecar converts in well under a second; this is only for a share that stops answering.
const SIDECAR_TIMEOUT: Duration = Duration::from_secs(20);

/// A subtitle file next to the video (`Movie.en.srt`) as `WebVTT`, converted once and cached.
/// `file` is the sidecar's id from the playback response, never a name or path: it must match
/// one of the video's sidecars as listed right now.
async fn sidecar_vtt(
    State(state): State<AppState>,
    Extension(grant): Extension<MediaGrant>,
    Path((id, file)): Path<(i64, String)>,
    Query(q): Query<SubtitleQuery>,
) -> ApiResult<Response> {
    let item = state.db.item(id).await?.ok_or(ApiError::NotFound)?;
    ensure_item_access(&state, grant.user_id, &item).await?;
    let FoundSidecar { side, path, .. } = item_sidecars(&state, grant.user_id, &item)
        .await?
        .into_iter()
        .find(|f| f.side.id() == file)
        .ok_or(ApiError::NotFound)?;
    // Only its size and time for the cache name: the bytes are read only to convert it.
    let stat = {
        let path = path.clone();
        tokio::task::spawn_blocking(move || -> std::io::Result<(u64, u128)> {
            let meta = std::fs::metadata(&path)?;
            let modified =
                meta.modified()?.duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
            Ok((meta.len(), modified))
        })
    };
    let (file_size, modified) = read_or_offline(stat).await?;
    // Size and time in the name: a subtitle Bazarr replaces (a better match) is converted again.
    let cache = state
        .config
        .cache_dir()
        .join("subtitles")
        .join(format!("{id}-f{}-{file_size}-{modified}.vtt", side.id()));
    if let Ok(v) = tokio::fs::read_to_string(&cache).await {
        return Ok(vtt_body(v, q.shift));
    }
    // Conversions share the extraction slots; one that waited may find the cache made meanwhile.
    let _permit = SUBTITLE_JOBS.acquire().await.map_err(|e| ApiError::Io(std::io::Error::other(e)))?;
    if let Ok(v) = tokio::fs::read_to_string(&cache).await {
        return Ok(vtt_body(v, q.shift));
    }
    let bytes = {
        let path = path.clone();
        read_or_offline(tokio::task::spawn_blocking(move || std::fs::read(&path))).await?
    };
    let vtt = cached_vtt(&cache, async {
        Ok(tokio::time::timeout(
            SIDECAR_TIMEOUT,
            sidecar::extract_webvtt(&state.ffmpeg, &path, sidecar::charset(&bytes)),
        )
        .await
        .map_err(|_| ApiError::Io(std::io::Error::other("subtitle conversion timed out")))??)
    })
    .await?;
    Ok(vtt_body(vtt, q.shift))
}

/// A blocking file call on the library's storage: `Offline` if it doesn't answer in time,
/// `NotFound` if the file went away meanwhile.
async fn read_or_offline<T>(task: tokio::task::JoinHandle<std::io::Result<T>>) -> ApiResult<T> {
    match tokio::time::timeout(FILE_CHECK_TIMEOUT, task).await {
        Err(_) => Err(ApiError::Offline("This title's storage isn't reachable right now.".into())),
        Ok(Err(e)) => Err(ApiError::Io(std::io::Error::other(e))),
        Ok(Ok(Err(e))) if e.kind() == std::io::ErrorKind::NotFound => Err(ApiError::NotFound),
        Ok(Ok(r)) => Ok(r?),
    }
}

/// Temp files of cache writes in progress: each its own name.
static CACHE_WRITES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The `WebVTT` cached at `cache`, or `make` it and cache it.
async fn cached_vtt(
    cache: &std::path::Path,
    make: impl std::future::Future<Output = ApiResult<String>>,
) -> ApiResult<String> {
    if let Ok(v) = tokio::fs::read_to_string(cache).await {
        return Ok(v);
    }
    let v = make.await?;
    if let Some(parent) = cache.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    // Written aside, then renamed: never a half file in the cache.
    let n = CACHE_WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = cache.with_extension(format!("{}-{n}.tmp", std::process::id()));
    tokio::fs::write(&tmp, &v).await?;
    tokio::fs::rename(&tmp, cache).await?;
    Ok(v)
}

/// A small JPEG of the frame at `secs` (rounded down to 10 s), for scrub previews. Made on
/// first request (about a second, even from a network share), then cached.
async fn preview_frame(
    State(state): State<AppState>,
    Extension(grant): Extension<MediaGrant>,
    Path((id, secs)): Path<(i64, u32)>,
) -> ApiResult<Response> {
    let (item, media) = load(&state, id).await?;
    ensure_item_access(&state, grant.user_id, &item).await?;
    if media.video.is_none() {
        return Err(ApiError::NotFound);
    }
    let jpeg = state.trickplay.frame(&state, &item, &media, secs).await?;
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg")),
            // Same item file + time = same picture.
            (header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400")),
        ],
        jpeg,
    )
        .into_response())
}

/// Image (PGS) subtitle cues for a track: timings, positions and image names. Extraction
/// starts on the first request; while `complete` is false, ask again for more cues.
async fn bitmap_manifest(
    State(state): State<AppState>,
    Extension(grant): Extension<MediaGrant>,
    Path((id, index)): Path<(i64, u32)>,
) -> ApiResult<Response> {
    let (item, media) = load(&state, id).await?;
    ensure_item_access(&state, grant.user_id, &item).await?;
    if !media.subtitles.iter().any(|s| s.index == index && bitmap_subs::supported(&s.codec)) {
        return Err(ApiError::NotFound);
    }
    let manifest = state.bitmap_subs.manifest(&state, &item, index).await?;
    let token = auth::sign_media(&state, (&grant).into(), &format!("/api/items/{id}/"));
    // Image URLs carry the item signature, like the manifest itself.
    let mut value = serde_json::to_value(&manifest).map_err(|e| ApiError::Internal(e.to_string()))?;
    if let Some(cues) = value["cues"].as_array_mut() {
        for cue in cues {
            if let Some(images) = cue["images"].as_array_mut() {
                for img in images {
                    let file = img["file"].as_str().unwrap_or_default().to_string();
                    img["url"] =
                        with_token(&format!("/api/items/{id}/subtitles/{index}/images/{file}"), &token)
                            .into();
                }
            }
        }
    }
    Ok(Json(value).into_response())
}

/// One cue image. Only `<cue>_<image>.png` names, never paths.
async fn bitmap_image(
    State(state): State<AppState>,
    Extension(grant): Extension<MediaGrant>,
    Path((id, index, file)): Path<(i64, u32, String)>,
    req: Request,
) -> ApiResult<Response> {
    if !bitmap_subs::is_image_name(&file) {
        return Err(ApiError::NotFound);
    }
    let item = state.db.item(id).await?.ok_or(ApiError::NotFound)?;
    ensure_item_access(&state, grant.user_id, &item).await?;
    let path = bitmap_subs::dir(&state.config.cache_dir(), &item, index).join(&file);
    if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
        return Err(ApiError::NotFound);
    }
    let mut res = ServeFile::new(path)
        .oneshot(req)
        .await
        .map_err(|e| ApiError::Io(std::io::Error::other(e)))?
        .map(Body::new);
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400"));
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playlist_signing_covers_segments_and_init() {
        let pl = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6.0,\nseg_00000.m4s\n";
        let out = sign_playlist(pl, "TOK");
        assert_eq!(out, "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4?t=TOK\"\n#EXTINF:6.0,\nseg_00000.m4s?t=TOK\n");
    }
}
