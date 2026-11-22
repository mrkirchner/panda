import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { activeElement, Text, View, type ElementNode } from "@solidtv/solid";
import { absolute, api, HttpError } from "../api/client";
import type { AudioTrack, Item, Playback, SubtitleTrack } from "../api/types";
import { Loader } from "../components/Loader";
import { PlayerControls, type PreviewFrame } from "../components/PlayerControls";
import { Dropdown } from "../components/Dropdown";
import { SubtitleOverlay } from "../components/SubtitleOverlay";
import { SubtitleTiming } from "../components/SubtitleTiming";
import { device } from "../device";
import { episodeMeta, languageName, movieMeta } from "../format";
import { detectProfile } from "../playback/profile";
import {
  describeStream,
  profileFor,
  QUALITIES,
  saveQuality,
  savedQuality,
  type QualityId,
} from "../playback/quality";
import { planSeek } from "../playback/seek";
import { previewUrl } from "../playback/trickplay";
import { activeBitmapCue, type BitmapCue, type BitmapManifest } from "../playback/bitmapSubs";
import { StallMonitor, stepDownBudget, DEFAULT_STALLS } from "../playback/stalls";
import { activeText, parseWebVtt, type Cue } from "../playback/webvtt";
import { clampTiming, saveTiming, savedTiming, shortTiming, trackLabels } from "../playback/subtitles";
import { audioLabels } from "../playback/audio";
import { theme } from "../theme";

const QUALITY_MENU_W = 420;
/** Built-in text subtitles come in windows of this many seconds (the server's SUBTITLE_WINDOW). */
const TEXT_WINDOW = 600;
/** The next window is fetched this many seconds before the current one ends. */
const TEXT_WINDOW_AHEAD = 120;
/** The server's mark on a whole track (not a window). */
const TRACK_COMPLETE = "NOTE panda complete";
/** The server's "not ready yet" (a sparse track's window): asked again this much later. */
const TRACK_PENDING = "NOTE panda pending";
const PENDING_RETRY_MS = 20_000;
/** A timing change is remembered this long after the last press. */
const TIMING_SAVE_MS = 500;
/** The Quality button's right edge, from the screen's center, with Quality alone in the settings
 * group. The controls are centered, so each more button (Subtitles, Audio) moves it half a
 * button + gap right. */
const QUALITY_ALONE_RIGHT = 520;
/** One settings button and the gap after it. */
const SETTINGS_STEP = 84 + 40;
const AUDIO_MENU_W = 520;
const SUBTITLE_MENU_W = 520;

import { lang, t } from "../i18n";

/** A scrub lands this long after the last Left/Right press (OK lands it at once). */
const SEEK_COMMIT_MS = 900;
/** Presses closer together than this count as one held scrub, which speeds up. */
const SCRUB_STREAK_MS = 400;
/** Scrub step by streak length: 10 s, then 30 s, then 60 s per press. */
const scrubStep = (streak: number) => (streak < 6 ? 10 : streak < 16 ? 30 : 60);
/** The server deletes segments 120 s behind the viewer; seeking further back restarts. */
const KEEP_BEHIND_SECS = 90;
const CONTROLS_HIDE_MS = 4000;
/** The preview follows the scrub target once it's held still this long (fewer requests). */
const PREVIEW_SETTLE_MS = 150;
/** While the server is still extracting image subtitles, fetch new cues this often. */
const BITMAP_POLL_MS = 10_000;
/** How often to save watch progress while playing. */
const PROGRESS_EVERY_MS = 10_000;

export default function Player() {
  // /play/item/:id (a file) or /play/title/:id (a movie; the server picks the best version).
  const params = useParams<{ kind: string; id: string }>();
  // `back`: where leaving goes (Continue Watching passes the title's page, so you land where
  // you can mark it watched); otherwise the previous page.
  const [search] = useSearchParams<{ start?: string; version?: string; back?: string }>();
  const navigate = useNavigate();
  /** A message over the video (connection check, errors). Loading itself shows the Loader. */
  const [status, setStatus] = createSignal("");
  const [subtitle, setSubtitle] = createSignal("");
  /** Image (PGS) subtitles of the selected track, and the cue showing now. */
  const [bitmap, setBitmap] = createSignal<BitmapManifest | null>(null);
  const [bitmapCue, setBitmapCue] = createSignal<BitmapCue | null>(null);
  let bitmapTimer: ReturnType<typeof setTimeout> | undefined;
  const [toast, setToast] = createSignal("");
  const [controls, setControls] = createSignal(true);
  const [playing, setPlaying] = createSignal(false);
  const [buffering, setBuffering] = createSignal(true);
  const [position, setPosition] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [item, setItem] = createSignal<Item | null>(null);
  const [quality, setQuality] = createSignal<QualityId>(savedQuality());
  const [streamInfo, setStreamInfo] = createSignal("");
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [subMenuOpen, setSubMenuOpen] = createSignal(false);
  const [audioMenuOpen, setAudioMenuOpen] = createSignal(false);
  /** The file's audio tracks and the one playing (its stream index). */
  const [audioTracks, setAudioTracks] = createSignal<AudioTrack[]>([]);
  const [audioSel, setAudioSel] = createSignal<number | null>(null);
  const [timingOpen, setTimingOpen] = createSignal(false);
  /** Subtitle timing for the selected track, seconds (positive: shown later). */
  const [timing, setTiming] = createSignal(0);
  /** The selected subtitle track (index into `tracks()`), -1 = off. */
  const [trackSel, setTrackSel] = createSignal(-1);
  const [tracks, setTracks] = createSignal<SubtitleTrack[]>([]);
  /** A menu or panel is open: the controls stay put and keys go to it. */
  /** Buttons with something to choose (PlayerControls hides the others), and where they sit. */
  /** Subtitles can be searched for (Bazarr), and it's worth offering: nothing in your language
   * among the tracks, and the audio playing isn't in it either. */
  const [features] = createResource(() => api.features().catch(() => null));
  const mine = (code: string | null | undefined) => !!code && languageName(code) === languageName(lang());
  const canFind = () =>
    !!features()?.subtitle_search &&
    !tracks().some(tr => mine(tr.language)) &&
    !mine(audioTracks().find(a => a.index === audioSel())?.language);
  const [finding, setFinding] = createSignal(false);
  const showSubtitles = () => tracks().length > 0 || canFind();
  const showAudio = () => audioTracks().length > 1;
  const qualityRight = () =>
    QUALITY_ALONE_RIGHT + ((Number(showSubtitles()) + Number(showAudio())) * SETTINGS_STEP) / 2;
  const audioRight = () => qualityRight() - SETTINGS_STEP;
  const subtitlesRight = () => qualityRight() - SETTINGS_STEP * (showAudio() ? 2 : 1);
  const overlayOpen = () => menuOpen() || subMenuOpen() || audioMenuOpen() || timingOpen();
  /** Where a pending scrub would land (file seconds), or null. */
  const [scrubTarget, setScrubTarget] = createSignal<number | null>(null);
  /** Playback's preview template (`{secs}`), when the item has video. */
  const [previewTemplate, setPreviewTemplate] = createSignal<string | null>(null);
  /** The scrub target the preview shows: follows `scrubTarget` after a short settle. */
  const [previewAt, setPreviewAt] = createSignal<number | null>(null);
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(scrubTarget, at => {
      clearTimeout(previewTimer);
      if (at === null) return void setPreviewAt(null);
      previewTimer = setTimeout(() => setPreviewAt(at), PREVIEW_SETTLE_MS);
    }),
  );
  const preview = createMemo<PreviewFrame | null>(() => {
    const template = previewTemplate();
    const at = previewAt();
    return template && at !== null ? { src: previewUrl(template, at) } : null;
  });
  let rootRef: ElementNode | undefined;
  let menuRef: ElementNode | undefined;
  let subMenuRef: ElementNode | undefined;
  let audioMenuRef: ElementNode | undefined;
  let timingRef: ElementNode | undefined;
  let barRef: ElementNode | undefined;
  let playRef: ElementNode | undefined;
  let starting = false;
  const stalls = new StallMonitor();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  /** Session-only bitrate cap set by stall step-downs (the saved quality choice is untouched). */
  let stallCap: number | null = null;

  let playback: Playback | undefined;
  let cues: Cue[] = [];
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let player: Awaited<ReturnType<Awaited<typeof device>["getPlayer"]>> | undefined;

  /** HLS sessions started mid-file have a 0-based timeline; this maps back to the file. */
  const offset = () => (playback?.method === "hls" ? playback.start_secs : 0);
  const filePosition = () => (player?.video.currentTime ?? 0) + offset();

  let lastReport = 0;
  /** Save watch progress (keyed server-side to the movie/episode, not the file). */
  function reportProgress(force = false) {
    const id = playback?.item_id;
    if (!id || (!force && Date.now() - lastReport < PROGRESS_EVERY_MS)) return;
    lastReport = Date.now();
    const d = duration();
    void api.progress(id, filePosition(), d > 0 ? d : undefined).catch(() => {});
  }

  /** Show the controls, and hide them again after a while unless paused, scrubbing or in a menu. */
  function poke() {
    setControls(true);
    // Visible controls always hold focus (the page only handles keys while they're hidden).
    if (activeElement() === rootRef && !overlayOpen()) playRef?.setFocus();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (player && !player.video.paused && scrubTarget() === null && !overlayOpen()) hideControls();
    }, CONTROLS_HIDE_MS);
  }

  /** Bring up the controls with focus on the play button (or the seek bar). */
  function showControls(on: "play" | "bar" = "play") {
    poke();
    (on === "bar" ? barRef : playRef)?.setFocus();
  }

  /** Hide the controls; keys go to the page again (any key brings them back). */
  function hideControls() {
    setControls(false);
    clearTimeout(hideTimer);
    rootRef?.setFocus();
  }

  // `timeupdate` fires ~4x/s: enough for subtitles and the progress bar, far cheaper than rAF.
  const onTime = () => {
    const pos = filePosition();
    // Subtitles shown `timing` seconds later: look up the cue from that long ago.
    const subPos = pos - timing();
    if (text) keepTextWindows(subPos);
    setSubtitle(cues.length ? activeText(cues, subPos) : "");
    const m = bitmap();
    const cue = m ? activeBitmapCue(m.cues, subPos) : null;
    if (cue !== bitmapCue()) setBitmapCue(cue);
    if (controls() && scrubTarget() === null) setPosition(pos);
    // HLS event playlists grow while transcoding; prefer the probed duration.
    const d = item()?.duration_secs ?? (player?.video.duration ?? 0) + offset();
    if (Number.isFinite(d) && d > 0) setDuration(d);
    if (player && !player.video.paused) reportProgress();
  };
  const onPlay = () => {
    setPlaying(true);
    // The timing panel keeps the controls hidden (the subtitles stay where they normally sit).
    if (!timingOpen()) poke();
  };
  const onPause = () => {
    reportProgress(true);
    setPlaying(false);
    if (timingOpen()) return;
    setControls(true);
    clearTimeout(hideTimer);
    // Paused from a media key with the controls hidden: put focus on them.
    if (activeElement() === rootRef) playRef?.setFocus();
  };
  /** Buffering started (from shaka; see CommonPlayer.onBuffering). */
  const onStall = () => {
    setBuffering(true);
    if (stalls.waiting(Date.now())) return void stepDown();
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (stalls.stillWaiting(Date.now())) stepDown();
    }, DEFAULT_STALLS.longMs);
  };
  const onPlaying = () => {
    setStatus("");
    setBuffering(false);
  };
  const onStallEnd = () => {
    setBuffering(false);
    stalls.playing();
    clearTimeout(stallTimer);
  };

  /** The connection can't keep up: restart at ~60% of the current bitrate. */
  function stepDown() {
    if (!playback || starting) return;
    const next = stepDownBudget(playback.stream.bitrate_kbps);
    if (next === null) return;
    stallCap = next;
    const at = filePosition();
    showToast(t("Slow connection: lowering quality to {mbps} Mbps", { mbps: (next / 1000).toFixed(1) }));
    stopStream();
    void start(at, false);
  }

  const showToast = (text: string) => {
    setToast(text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(""), 2000);
  };

  /** Image subtitles: the server extracts them as it goes, so ask again until complete. */
  async function loadBitmap(url: string, idx: number) {
    const m = await api.bitmapSubtitles(url).catch(() => null);
    if (trackSel() !== idx) return; // switched tracks meanwhile
    if (m) setBitmap(m);
    onTime();
    if (!m?.complete) bitmapTimer = setTimeout(() => void loadBitmap(url, idx), BITMAP_POLL_MS);
  }

  /** The text track being loaded window by window (built-in tracks; see loadTextWindow). */
  let text: { url: string; idx: number; complete: boolean; asked: Set<number> } | null = null;

  /** Load the window holding `at` and, near its end, the next one (each once). */
  function keepTextWindows(at: number) {
    if (!text || text.complete) return;
    const w = Math.max(0, Math.floor(at / TEXT_WINDOW) * TEXT_WINDOW);
    void loadTextWindow(w);
    if (at - w > TEXT_WINDOW - TEXT_WINDOW_AHEAD) void loadTextWindow(w + TEXT_WINDOW);
  }

  /** One window of a built-in text track: the server reads only that part of the file (the whole
   * track takes minutes from a large file on a network share). Once the server has the whole
   * track (`NOTE panda complete`), it replaces the windows. */
  async function loadTextWindow(start: number) {
    const cur = text;
    if (!cur || cur.complete || cur.asked.has(start)) return;
    cur.asked.add(start);
    const sep = cur.url.includes("?") ? "&" : "?";
    let body: string;
    try {
      body = await api.subtitles(`${cur.url}${sep}from=${start}`);
    } catch {
      cur.asked.delete(start); // asked again as playback moves on
      if (text === cur && !cues.length) showToast(t("These subtitles couldn't be loaded"));
      return;
    }
    if (text !== cur || cur.complete) return; // switched tracks meanwhile
    if (body.includes(TRACK_PENDING)) {
      // Still being read from the file: ask again shortly (no error; it's on its way).
      setTimeout(() => {
        cur.asked.delete(start);
        if (text === cur) keepTextWindows(filePosition() - timing());
      }, PENDING_RETRY_MS);
      return;
    }
    const parsed = parseWebVtt(body);
    if (body.includes(TRACK_COMPLETE)) {
      cur.complete = true;
      cues = parsed;
    } else {
      const seen = new Set(cues.map(c => `${c.start}|${c.text}`));
      cues = [...cues, ...parsed.filter(c => !seen.has(`${c.start}|${c.text}`))].sort(
        (a, b) => a.start - b.start,
      );
    }
    onTime();
  }

  async function selectTrack(idx: number) {
    setTrackSel(idx);
    const track = tracks()[idx];
    clearTimeout(bitmapTimer);
    setBitmap(null);
    setBitmapCue(null);
    cues = [];
    text = null;
    setSubtitle("");
    // Each track of each file keeps its own timing.
    setTiming(track && playback ? savedTiming(playback.item_id, track) : 0);
    showToast(track ? t("Subtitles: {name}", { name: trackLabels(tracks())[idx] }) : t("Subtitles off"));
    if (track?.url && track.overlay === "bitmap") void loadBitmap(track.url, idx);
    else if (track?.url && !track.external) {
      // Built-in: window by window from where you are (onTime keeps the windows coming).
      text = { url: track.url, idx, complete: false, asked: new Set() };
      keepTextWindows(filePosition() - timing());
    } else if (track?.url) {
      // A subtitle file: small, converted whole.
      const parsed = parseWebVtt(await api.subtitles(track.url).catch(() => ""));
      if (trackSel() !== idx) return; // switched tracks meanwhile
      cues = parsed;
      if (!parsed.length) showToast(t("These subtitles couldn't be loaded"));
    }
    onTime();
  }

  /** Your audio track for this title (or file), remembered on this TV. */
  const audioKey = () => `panda.audio.${params.kind}.${params.id}`;
  function savedAudio(): number | null {
    try {
      const v = localStorage.getItem(audioKey());
      return v === null ? null : Number(v);
    } catch {
      return null;
    }
  }

  function openAudioMenu() {
    if (audioTracks().length < 2) return void (poke(), showToast(t("This title has one audio track")));
    setAudioMenuOpen(true);
    poke();
    clearTimeout(hideTimer);
    audioMenuRef?.setFocus();
  }

  function closeAudioMenu() {
    setAudioMenuOpen(false);
    showControls("play");
  }

  /** Another audio track: playback restarts where you are with it (the server repackages the
   * file, or converts that track when this TV can't play it). */
  function chooseAudio(index: number) {
    closeAudioMenu();
    if (index === audioSel()) return;
    setAudioSel(index);
    try {
      localStorage.setItem(audioKey(), String(index));
    } catch {
      // Not remembered; it still plays.
    }
    const at = audioTracks().findIndex(a => a.index === index);
    showToast(t("Audio: {name}", { name: audioLabels(audioTracks())[at] ?? "" }));
    const position = filePosition();
    stopStream();
    void start(position, false);
  }

  /** Ask the server (Bazarr) for subtitles in your language; the new file is chosen when found. */
  async function findSubtitles() {
    closeSubtitleMenu();
    if (!playback || finding()) return;
    const language = languageName(lang()) ?? lang();
    setFinding(true);
    showToast(t("Looking for {language} subtitles...", { language }));
    try {
      const r = await api.findSubtitles(playback.item_id, lang());
      const shown = r.subtitles.filter(tr => tr.overlay === "text" || tr.url);
      const before = new Set(tracks().map(tr => tr.key));
      setTracks(shown);
      const fresh = shown.findIndex(tr => !before.has(tr.key) && mine(tr.language));
      if (fresh >= 0) void selectTrack(fresh);
      else showToast(t("No {language} subtitles found", { language }));
    } catch {
      showToast(t("No {language} subtitles found", { language }));
    } finally {
      setFinding(false);
    }
  }

  function openSubtitleMenu() {
    if (!tracks().length && !canFind()) return void (poke(), showToast(t("No subtitles for this title")));
    setSubMenuOpen(true);
    poke();
    clearTimeout(hideTimer);
    subMenuRef?.setFocus();
  }

  function closeSubtitleMenu() {
    setSubMenuOpen(false);
    showControls("play");
  }

  /** The timing panel: the controls step away so the subtitles sit where they normally do. */
  function openTiming() {
    setSubMenuOpen(false);
    setTimingOpen(true);
    setControls(false);
    clearTimeout(hideTimer);
    timingRef?.setFocus();
  }

  /** Remember the timing for this file and track: as it changes (shortly after the last press),
   * so leaving with the panel open (the episode ends) keeps it. */
  let timingSave: ReturnType<typeof setTimeout> | undefined;
  const keepTiming = () => {
    clearTimeout(timingSave);
    const track = tracks()[trackSel()];
    if (track && playback) saveTiming(playback.item_id, track, timing());
  };
  onCleanup(keepTiming);

  function changeTiming(secs: number) {
    setTiming(clampTiming(secs));
    onTime();
    clearTimeout(timingSave);
    timingSave = setTimeout(keepTiming, TIMING_SAVE_MS);
  }

  function closeTiming() {
    setTimingOpen(false);
    keepTiming();
    showControls("play");
  }

  function togglePlay() {
    player?.togglePlayPause();
    poke();
  }

  let seekTimer: ReturnType<typeof setTimeout> | undefined;
  let lastScrubAt = 0;
  let streak = 0;

  /** Skip by a fixed amount (the skip buttons): lands right away. */
  function skip(delta: number) {
    seek(delta);
    commitSeek();
  }

  /** One scrub press: holding or repeating speeds it up. */
  function scrub(direction: number) {
    const now = Date.now();
    streak = now - lastScrubAt < SCRUB_STREAK_MS ? streak + 1 : 0;
    lastScrubAt = now;
    seek(direction * scrubStep(streak));
  }

  /** Move the scrub target (the bar and preview follow it); it lands after a pause or OK. */
  function seek(delta: number) {
    if (!player || !playback) return;
    const end = duration() > 0 ? duration() - 1 : Number.MAX_SAFE_INTEGER;
    const target = Math.min(end, Math.max(0, (scrubTarget() ?? filePosition()) + delta));
    setScrubTarget(target);
    setPosition(target);
    poke();
    clearTimeout(seekTimer);
    seekTimer = setTimeout(commitSeek, SEEK_COMMIT_MS);
  }

  /** Pointer: jump to a fraction of the way through. */
  function scrubTo(fraction: number) {
    if (duration() <= 0) return;
    setScrubTarget(null);
    seek(fraction * duration() - filePosition());
    commitSeek();
  }

  function commitSeek() {
    clearTimeout(seekTimer);
    const target = scrubTarget();
    if (!player || !playback || target === null) return;
    setScrubTarget(null);
    streak = 0;
    const action = planSeek(target, {
      method: playback.method,
      offset: offset(),
      availableEnd: offset() + player.seekableEnd(),
      current: filePosition(),
      keepBehind: KEEP_BEHIND_SECS,
    });
    stalls.reset(Date.now());
    if (action.kind === "jump") {
      player.video.currentTime = action.mediaTime;
    } else {
      // Outside what this transcode has: start a new one right at the target.
      stopStream();
      void start(action.at, false);
    }
    poke();
  }

  const events: [string, () => void][] = [
    ["timeupdate", onTime],
    ["play", onPlay],
    ["pause", onPause],
    ["waiting", () => setBuffering(true)],
    ["playing", onPlaying],
  ];

  /** End the current stream: stop the player and free the server's transcode slot. */
  function stopStream() {
    if (playback) reportProgress(true);
    player?.stop();
    if (playback?.method === "hls") void api.stopSession(playback.session_id);
    playback = undefined;
  }

  /** Start (or restart) playback at `position` seconds with the current quality setting. */
  async function start(position: number, firstStart: boolean) {
    if (starting || !player) return;
    starting = true;
    setBuffering(true);
    try {
      const label = QUALITIES.find(q => q.id === quality())?.label ?? "";
      if (quality() === "auto") setStatus(firstStart ? t("Checking your connection...") : "");
      const chosen = await profileFor(detectProfile(), quality());
      const profile =
        stallCap === null
          ? chosen
          : { ...chosen, max_bitrate_kbps: Math.min(chosen.max_bitrate_kbps ?? Infinity, stallCap) };
      const version = search.version ? Number(search.version) : undefined;
      const audioIndex = audioSel() ?? savedAudio() ?? undefined;
      playback =
        params.kind === "title"
          ? await api.playTitle(params.id, profile, position, version, audioIndex)
          : await api.startPlayback(Number(params.id), profile, position, audioIndex);
      setAudioTracks(playback.audio ?? []);
      setAudioSel(playback.audio_index ?? null);
      if (firstStart) {
        void api
          .item(playback.item_id)
          .then(setItem)
          .catch(() => {});
      }
      setStatus("");
      setStreamInfo(`Quality: ${label.split(" ")[0]} · ${describeStream(playback.stream)}`);
      if (firstStart) {
        setPreviewTemplate(playback.preview_url ?? null);
        // Text tracks, and image (PGS) tracks the server can serve.
        const shown = playback.subtitles.filter(t => t.overlay === "text" || t.url);
        setTracks(shown);
        const preferred = shown.findIndex(t => t.forced || t.default);
        if (preferred >= 0) void selectTrack(preferred);
      }
      await player.load(absolute(playback.url), {
        autoPlay: true,
        // Direct play seeks in the file; HLS sessions already start at `position`.
        startTime: playback.method === "direct_play" && position > 0 ? position : undefined,
        mimeType: playback.method === "hls" ? "application/x-mpegurl" : playback.mime_type,
      });
      stalls.reset(Date.now());
      poke();
    } catch (e) {
      // 503: the library's storage (NAS) is offline: the server's message says so plainly.
      setStatus(
        e instanceof HttpError && e.status === 503
          ? t("This title's storage isn't reachable right now. Check that the NAS is on and connected.")
          : t("Playback failed: {error}", { error: (e as Error).message }),
      );
    } finally {
      starting = false;
    }
  }

  function openMenu() {
    setMenuOpen(true);
    poke();
    clearTimeout(hideTimer);
    menuRef?.setFocus();
  }

  function closeMenu() {
    setMenuOpen(false);
    showControls("play");
  }

  function chooseQuality(id: QualityId) {
    closeMenu();
    if (id === quality()) return;
    stallCap = null; // An explicit choice overrides automatic step-downs.
    setQuality(id);
    saveQuality(id);
    const position = filePosition();
    stopStream();
    showToast(t("Quality: {name}", { name: QUALITIES.find(q => q.id === id)?.label ?? id }));
    void start(position, false);
  }

  /** Any key while the controls are up keeps them up. */
  const onAnyKey = () => {
    if (controls()) poke();
  };

  onMount(async () => {
    player = (await device).getPlayer();
    player.video.crossOrigin = "anonymous"; // CORS mode: required by the COEP dev headers.
    player.onBuffering = b => (b ? onStall() : onStallEnd());
    // Safety net: if the stream breaks (a missing segment, or the NAS dropping), start again
    // where we are; the server says plainly if the storage is offline. A few tries a minute,
    // so a file that keeps failing doesn't loop.
    let retries: number[] = [];
    player.onError = () => {
      if (starting) return;
      const now = Date.now();
      retries = retries.filter(at => now - at < 60_000);
      if (retries.length >= 3) {
        setStatus(t("Playback stopped. Check that the NAS is on and connected, then try again."));
        return;
      }
      retries.push(now);
      const at = filePosition();
      stopStream();
      void start(at, false);
    };
    for (const [name, fn] of events) player.video.addEventListener(name, fn);
    window.addEventListener("keydown", onAnyKey, true);
    const at = Number(search.start ?? 0);
    await start(Number.isFinite(at) && at > 0 ? at : 0, true);
  });

  onCleanup(() => {
    clearTimeout(toastTimer);
    clearTimeout(hideTimer);
    clearTimeout(seekTimer);
    clearTimeout(stallTimer);
    clearTimeout(previewTimer);
    clearTimeout(bitmapTimer);
    window.removeEventListener("keydown", onAnyKey, true);
    if (player) {
      player.onError = null;
      player.onBuffering = null;
    }
    for (const [name, fn] of events) player?.video.removeEventListener(name, fn);
    stopStream();
  });

  const title = () => {
    const i = item();
    if (!i) return "";
    return i.kind === "episode" ? (i.meta_title ?? i.series ?? i.title) : (i.meta_title ?? i.title);
  };
  const detail = () => {
    const i = item();
    if (!i) return "";
    return i.kind === "episode" ? `${i.episode_title ?? ""}  ${episodeMeta(i)}`.trim() : movieMeta(i);
  };

  return (
    <View
      ref={rootRef}
      autofocus
      // Back hides the controls first, then leaves.
      onBack={() => {
        if (menuOpen()) return (closeMenu(), true);
        if (subMenuOpen()) return (closeSubtitleMenu(), true);
        if (audioMenuOpen()) return (closeAudioMenu(), true);
        if (timingOpen()) return (closeTiming(), true);
        if (controls() && !player?.video.paused) return (hideControls(), true);
        if (search.back) navigate(search.back, { replace: true });
        else navigate(-1);
        return true;
      }}
      // With the controls hidden, focus is here: OK plays/pauses and brings them up, Left/Right
      // skip (and focus the seek bar), Up/Down just bring them up. With the controls showing,
      // these only arrive when a row runs out of buttons, so they're swallowed.
      onEnter={() => (controls() ? null : (togglePlay(), showControls("play")), true)}
      onLeft={() => (controls() ? null : (showControls("bar"), scrub(-1)), true)}
      onRight={() => (controls() ? null : (showControls("bar"), scrub(1)), true)}
      onUp={() => (controls() ? null : showControls("play"), true)}
      onDown={() => (controls() ? null : showControls("play"), true)}
      // With a menu or the timing panel open, media keys play and pause in place (no controls
      // over the panel) and don't scrub: the panel keeps focus.
      onPlayPause={() => (overlayOpen() ? player?.togglePlayPause() : togglePlay(), true)}
      onPlay={() => (player?.play(), overlayOpen() || poke(), true)}
      onPause={() => (player?.pause(), true)}
      onRewind={() => (overlayOpen() || (controls() || showControls("bar"), scrub(-1)), true)}
      onFastForward={() => (overlayOpen() || (controls() || showControls("bar"), scrub(1)), true)}
    >
      {/* Starting or buffering: the loading dots in the middle of the picture. */}
      <Show when={buffering() && !status().startsWith("Playback failed")}>
        <Loader x={theme.screen.width / 2} y={theme.screen.height / 2} size={22} zIndex={25} />
      </Show>
      <SubtitleOverlay
        text={subtitle()}
        raised={controls()}
        bitmap={bitmapCue()}
        frame={bitmap() ?? undefined}
      />
      <PlayerControls
        visible={controls()}
        title={title()}
        subtitle={detail()}
        position={position()}
        duration={duration()}
        playing={playing()}
        buffering={buffering() && !status()}
        info={streamInfo()}
        scrubTarget={scrubTarget()}
        preview={preview()}
        barRef={el => (barRef = el)}
        playRef={el => (playRef = el)}
        onTogglePlay={togglePlay}
        onSkip={skip}
        onScrub={scrub}
        onScrubCommit={commitSeek}
        onScrubTo={scrubTo}
        onSubtitles={openSubtitleMenu}
        onAudio={openAudioMenu}
        showSubtitles={showSubtitles()}
        showAudio={showAudio()}
        onQuality={openMenu}
      />
      {/* The app's dropdown, opening above the Quality button, right edges lined up. */}
      <Dropdown
        open={menuOpen()}
        x={theme.screen.width / 2 + qualityRight() - QUALITY_MENU_W}
        y={theme.screen.height - 300 - QUALITIES.length * 60}
        width={QUALITY_MENU_W}
        ref={el => (menuRef = el)}
        options={QUALITIES.map(q => ({
          label: q.label,
          active: q.id === quality(),
          choose: () => chooseQuality(q.id),
        }))}
        onClose={closeMenu}
      />
      {/* Subtitles: off, each track, then the selected track's timing. Opens above its button. */}
      <Dropdown
        open={subMenuOpen()}
        x={theme.screen.width / 2 + subtitlesRight() - SUBTITLE_MENU_W}
        y={Math.max(120, theme.screen.height - 300 - (tracks().length + 3) * 60)}
        width={SUBTITLE_MENU_W}
        ref={el => (subMenuRef = el)}
        options={[
          {
            label: t("Off"),
            active: trackSel() < 0,
            choose: () => (closeSubtitleMenu(), void selectTrack(-1)),
          },
          ...trackLabels(tracks()).map((label, i) => ({
            label,
            active: trackSel() === i,
            choose: () => {
              closeSubtitleMenu();
              if (i !== trackSel()) void selectTrack(i);
            },
          })),
          ...(canFind()
            ? [
                {
                  label: finding()
                    ? t("Looking for {language} subtitles...", { language: languageName(lang()) ?? lang() })
                    : t("Find {language} subtitles", { language: languageName(lang()) ?? lang() }),
                  active: false,
                  choose: () => void findSubtitles(),
                },
              ]
            : []),
          ...(trackSel() >= 0
            ? [
                {
                  label: t("Timing: {secs}", { secs: shortTiming(timing()) }),
                  active: false,
                  choose: openTiming,
                },
              ]
            : []),
        ]}
        onClose={closeSubtitleMenu}
      />
      {/* Audio: each track of the file. Opens above its button. */}
      <Dropdown
        open={audioMenuOpen()}
        x={theme.screen.width / 2 + audioRight() - AUDIO_MENU_W}
        y={Math.max(120, theme.screen.height - 300 - audioTracks().length * 60)}
        width={AUDIO_MENU_W}
        ref={el => (audioMenuRef = el)}
        options={audioLabels(audioTracks()).map((label, i) => ({
          label,
          active: audioTracks()[i].index === audioSel(),
          choose: () => chooseAudio(audioTracks()[i].index),
        }))}
        onClose={closeAudioMenu}
      />
      <SubtitleTiming
        open={timingOpen()}
        value={timing()}
        onChange={changeTiming}
        onClose={closeTiming}
        ref={el => (timingRef = el)}
      />
      {/* Overlays stay mounted and toggle alpha: cheaper than creating/destroying nodes, and
          avoids stale text being left on the canvas when a node is removed right after creation. */}
      <Text
        x={theme.screen.gutter}
        y={80}
        fontSize={theme.font.body}
        color={theme.color.text}
        alpha={status() ? 1 : 0}
      >
        {status() || " "}
      </Text>
      <Text
        x={theme.screen.gutter}
        y={80}
        fontSize={theme.font.caption}
        color={theme.color.text}
        alpha={toast() && !status() ? 1 : 0}
      >
        {toast() || " "}
      </Text>
    </View>
  );
}
