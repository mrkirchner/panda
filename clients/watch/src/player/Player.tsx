// The player, as the TV's and the phone's: the picture fills the window; controls (title, seek bar
// with scrub previews, play, ±10 s, Subtitles and Audio when there's a choice, Quality, Picture in
// Picture, full screen, volume) show on movement and hide while playing. Subtitles are drawn over
// the picture (text, and image subtitles where they were authored), with per-track timing. Keys:
// Space/K play-pause, ←/→ or J/L 10 s, ↑/↓ volume, M mute, F full screen, C subtitles, Esc back.
import { useParams, useSearchParams } from "@solidjs/router";
import { absolute, api, imageUrl } from "@tv/api/client";
import type { SubtitleTrack } from "@tv/api/types";
import { formatTime, languageName } from "@tv/format";
import { lang, t } from "@tv/i18n";
import { audioLabels } from "@tv/playback/audio";
import { QUALITIES, describeStream, saveQuality } from "@tv/playback/quality";
import {
  clampTiming,
  describeTiming,
  savedTiming,
  saveTiming,
  shortTiming,
  trackLabels,
} from "@tv/playback/subtitles";
import { previewUrl } from "@tv/playback/trickplay";
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import { setPlayerOpen } from "../clip";
import { Icon } from "../components/icons";
import { closeOverlay, overlayOpen, pick, type Choice } from "../components/ui";
import { message, refreshAll } from "../data";
import { features } from "../features";
import { back, go } from "../nav";
import { Engine } from "./engine";
import type { PlayTarget } from "./launch";
import { SubtitleSource, initialTrack, rememberSubtitles, type Showing } from "./subtitles";

const CONTROLS_HIDE_MS = 3500;
const SKIP_SECS = 10;
const PREVIEW_SETTLE_MS = 150;

export default function Player() {
  const params = useParams<{ kind: string; id: string }>();
  const [search] = useSearchParams<{ start?: string; version?: string; back?: string }>();
  let video: HTMLVideoElement | undefined;
  let engine: Engine | null = null;

  /** Bumped by the engine's events and a 4 Hz clock: everything time-based reads it. */
  const [tick, setTick] = createSignal(0);
  const bump = () => setTick((n) => n + 1);
  const [loading, setLoading] = createSignal(true);
  const [fatal, setFatal] = createSignal("");
  const [toastText, setToastText] = createSignal("");
  const [controls, setControls] = createSignal(true);
  const [subs, setSubs] = createSignal<SubtitleSource | null>(null);
  const [timing, setTiming] = createSignal(0);
  const [timingOpen, setTimingOpen] = createSignal(false);
  const [canSearch, setCanSearch] = createSignal(false);
  const [finding, setFinding] = createSignal(false);
  const [fullscreen, setFullscreen] = createSignal(false);
  const [muted, setMuted] = createSignal(false);
  const [volume, setVolume] = createSignal(1);
  /** Scrubbing: where the pointer is on the bar (file seconds), and whether it's held down. */
  const [hoverAt, setHoverAt] = createSignal<number | null>(null);
  const [dragging, setDragging] = createSignal(false);
  const [previewAt, setPreviewAt] = createSignal<number | null>(null);
  /** The video's drawn picture inside the element (for image subtitles). */
  const [picture, setPicture] = createSignal({ x: 0, y: 0, w: 0, h: 0 });

  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  /** When a tap last brought the controls back: the click that follows the tap mustn't press
   * the button that just appeared under the finger. */
  let revealedAt = 0;

  const toast = (text: string) => {
    setToastText(text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToastText(""), 3500);
  };
  const showControls = () => {
    setControls(true);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (engine?.playing() && !dragging() && !overlayOpen() && !timingOpen()) setControls(false);
    }, CONTROLS_HIDE_MS);
  };

  const pb = () => (tick(), engine?.pb ?? null);
  const position = () => (tick(), engine?.position() ?? 0);
  const duration = () => (tick(), engine?.duration() ?? 0);
  const buffered = () => (tick(), engine?.bufferedEnd() ?? 0);
  const playing = () => (tick(), engine?.playing() ?? false);
  const waiting = () => (tick(), engine?.waiting() ?? true);
  const info = () => (tick(), engine?.info ?? null);
  const title = () => {
    const i = info();
    if (!i) return "";
    return i.kind === "episode" ? (i.series ?? i.title) : (i.meta_title ?? i.title);
  };
  const subtitle = () => {
    const i = info();
    return i?.kind === "episode"
      ? `S${i.season ?? 0}:E${i.episode ?? 0}  ${i.episode_title ?? ""}`.trim()
      : (i?.year?.toString() ?? "");
  };
  const tracks = () => (pb()?.subtitles ?? []).filter((s) => s.url);
  const audioTracks = () => pb()?.audio ?? [];
  const audioLanguage = () => audioTracks().find((a) => a.index === pb()?.audio_index)?.language ?? null;
  const mine = (code: string | null | undefined) => !!code && languageName(code) === languageName(lang());
  /** Subtitles can be searched for (Bazarr), and it's worth it: nothing in your language among
   * the tracks, and the audio isn't in it either (the TV's rule). */
  const canFind = () => canSearch() && !tracks().some((s) => mine(s.language)) && !mine(audioLanguage());
  const showing = createMemo<Showing>(() => {
    tick();
    const s = subs();
    return s ? s.at(position() - timing()) : null;
  });

  // ---- Subtitles ----

  const chooseSubs = (track: SubtitleTrack | null, announce: boolean) => {
    subs()?.close();
    setSubs(
      track ? new SubtitleSource(track, bump, () => toast(t("These subtitles couldn't be loaded"))) : null,
    );
    setTiming(track && engine?.pb ? savedTiming(engine.pb.item_id, track) : 0);
    if (announce) {
      const list = tracks();
      const i = track ? list.findIndex((s) => s.key === track.key) : -1;
      toast(i >= 0 ? t("Subtitles: {name}", { name: trackLabels(list)[i] }) : t("Subtitles off"));
    }
  };
  let lastTrack: SubtitleTrack | null = null;
  const toggleSubs = () => {
    const cur = subs()?.track ?? null;
    if (cur) {
      lastTrack = cur;
      chooseSubs(null, true);
    } else {
      const next = lastTrack ?? initialTrack(tracks(), audioLanguage()) ?? tracks()[0] ?? null;
      if (next) chooseSubs(next, true);
    }
  };
  const findSubtitles = async () => {
    if (finding() || !engine?.pb) return;
    const language = languageName(lang()) ?? lang();
    setFinding(true);
    toast(t("Looking for {language} subtitles...", { language }));
    try {
      const r = await api.findSubtitles(engine.pb.item_id, lang());
      const before = new Set(engine.pb.subtitles.map((s) => s.key));
      engine.pb.subtitles = r.subtitles;
      bump();
      const fresh = r.subtitles.find((s) => s.url && !before.has(s.key) && mine(s.language));
      if (fresh) {
        chooseSubs(fresh, true);
        rememberSubtitles(fresh);
      } else toast(t("No {language} subtitles found", { language }));
    } catch {
      toast(t("No {language} subtitles found", { language }));
    } finally {
      setFinding(false);
    }
  };
  const subtitleMenu = async (e: MouseEvent) => {
    const list = tracks();
    const labels = trackLabels(list);
    const language = languageName(lang()) ?? lang();
    const options: (Choice & { run: () => void })[] = [
      ...(canFind()
        ? [{ label: t("Find {language} subtitles", { language }), run: () => void findSubtitles() }]
        : []),
      ...(subs()
        ? [{ label: `${t("Subtitle timing")}: ${shortTiming(timing())}`, run: () => setTimingOpen(true) }]
        : []),
      {
        label: t("Off"),
        selected: !subs(),
        run: () => {
          chooseSubs(null, true);
          rememberSubtitles(null);
        },
      },
      ...list.map((track, i) => ({
        label: labels[i],
        selected: subs()?.track.key === track.key,
        run: () => {
          chooseSubs(track, true);
          rememberSubtitles(track);
        },
      })),
    ];
    const i = await pick(t("Subtitles"), options, e.currentTarget as Element);
    if (i >= 0) options[i].run();
    showControls();
  };
  const nudge = (by: number | null) => {
    const track = subs()?.track;
    if (!track || !engine?.pb) return;
    const next = by === null ? 0 : clampTiming(timing() + by);
    setTiming(next);
    saveTiming(engine.pb.item_id, track, next);
    toast(describeTiming(next));
  };

  // ---- Audio, quality ----

  const audioMenu = async (e: MouseEvent) => {
    const labels = audioLabels(audioTracks());
    const i = await pick(
      t("Audio"),
      audioTracks().map((a, n) => ({ label: labels[n], selected: a.index === pb()?.audio_index })),
      e.currentTarget as Element,
    );
    if (i >= 0 && audioTracks()[i].index !== pb()?.audio_index) {
      engine?.chooseAudio(audioTracks()[i].index);
      toast(t("Audio: {name}", { name: labels[i] }));
    }
    showControls();
  };
  const qualityMenu = async (e: MouseEvent) => {
    const i = await pick(
      t("Quality"),
      [...QUALITIES.map((q) => ({ label: t(q.label), selected: q.id === engine?.quality }))],
      e.currentTarget as Element,
    );
    if (i >= 0 && engine) {
      saveQuality(QUALITIES[i].id);
      engine.chooseQuality(QUALITIES[i].id);
      toast(t("Quality: {name}", { name: t(QUALITIES[i].label) }));
    }
    showControls();
  };

  // ---- Window, full screen, Picture in Picture ----

  /** iPhone has no page full screen, only the video's own (with its own controls). */
  const iosVideo = () =>
    video as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitSupportsFullscreen?: boolean })
      | undefined;
  const canFullscreen = () => document.fullscreenEnabled || !!iosVideo()?.webkitSupportsFullscreen;
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else if (document.fullscreenEnabled) void document.documentElement.requestFullscreen().catch(() => {});
    else iosVideo()?.webkitEnterFullscreen?.();
  };
  const pipSupported = () => typeof document !== "undefined" && !!document.pictureInPictureEnabled;
  const togglePip = () => {
    if (!video) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
    else void video.requestPictureInPicture().catch(() => {});
  };
  const measurePicture = () => {
    if (!video) return;
    const W = video.clientWidth;
    const H = video.clientHeight;
    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    const scale = Math.min(W / vw, H / vh);
    const w = vw * scale;
    const h = vh * scale;
    setPicture({ x: (W - w) / 2, y: (H - h) / 2, w, h });
  };

  // ---- Leaving ----

  const leave = () => {
    if (closing) return;
    closing = true;
    engine?.close();
    subs()?.close();
    setPlayerOpen(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    refreshAll();
    if (search.back) go(search.back, { replace: true });
    else back();
  };

  // ---- Scrubbing ----

  let bar: HTMLDivElement | undefined;
  const atPointer = (clientX: number) => {
    if (!bar) return 0;
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration();
  };
  const settlePreview = (at: number | null) => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => setPreviewAt(at), PREVIEW_SETTLE_MS);
  };
  const shownAt = () => (dragging() || hoverAt() !== null ? (hoverAt() ?? position()) : position());

  onSettled(() => {
    setPlayerOpen(true);
    const target: PlayTarget =
      params.kind === "title"
        ? { kind: "title", id: params.id, version: search.version ? Number(search.version) : undefined }
        : { kind: "item", id: Number(params.id) };
    const v = video!;
    engine = new Engine(v, target, {
      onState: bump,
      onToast: toast,
      onFatal: (text) => {
        engine?.close();
        setFatal(text);
      },
      onEnded: leave,
      onInfo: mediaSession,
      // A new stream (a restart): the same subtitle track again, with its new address.
      onStream: () => {
        const key = subs()?.track.key;
        if (!key || !engine?.pb) return;
        const again = engine.pb.subtitles.find((s) => s.key === key) ?? null;
        subs()?.close();
        setSubs(
          again
            ? new SubtitleSource(again, bump, () => toast(t("These subtitles couldn't be loaded")))
            : null,
        );
      },
    });
    const start = Number(search.start ?? 0) || 0;
    engine.open(start).then(
      () => {
        if (closing || !engine?.pb) return;
        setLoading(false);
        chooseSubs(initialTrack(engine.pb.subtitles, audioLanguage()), false);
        showControls();
      },
      (e) => {
        if (closing) return;
        setLoading(false);
        setFatal(t("Playback failed: {error}", { error: message(e) }));
      },
    );
    void features().then((f) => setCanSearch(!!f?.subtitle_search));

    const clock = setInterval(bump, 250);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement) return;
      if (overlayOpen()) return;
      const k = e.key.toLowerCase();
      const handled = () => {
        e.preventDefault();
        showControls();
      };
      if (k === " " || k === "k") {
        engine?.togglePlay();
        handled();
      } else if (k === "arrowleft" || k === "j") {
        engine?.seekTo(engine.position() - SKIP_SECS);
        handled();
      } else if (k === "arrowright" || k === "l") {
        engine?.seekTo(engine.position() + SKIP_SECS);
        handled();
      } else if (k === "arrowup" || k === "arrowdown") {
        v.volume = Math.max(0, Math.min(1, v.volume + (k === "arrowup" ? 0.1 : -0.1)));
        handled();
      } else if (k === "m") {
        v.muted = !v.muted;
        handled();
      } else if (k === "f") {
        toggleFullscreen();
        handled();
      } else if (k === "c") {
        toggleSubs();
        handled();
      } else if (k === "escape") {
        if (timingOpen()) setTimingOpen(false);
        else if (!document.fullscreenElement && !closeOverlay()) leave();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    const onVolume = () => {
      setMuted(v.muted);
      setVolume(v.volume);
    };
    v.addEventListener("volumechange", onVolume);
    v.addEventListener("loadedmetadata", measurePicture);
    const ro = new ResizeObserver(measurePicture);
    ro.observe(v);
    // Phones rarely fire pagehide when a tab is left: save when the page is hidden too.
    const onHide = () => void engine?.save();
    const onVisibility = () => {
      if (document.hidden) onHide();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(clock);
      clearTimeout(hideTimer);
      clearTimeout(toastTimer);
      clearTimeout(previewTimer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("fullscreenchange", onFs);
      ro.disconnect();
      // Left by the browser's Back: close properly.
      if (!closing) {
        closing = true;
        engine?.close();
        subs()?.close();
        setPlayerOpen(false);
        refreshAll();
      }
      if ("mediaSession" in navigator) {
        const ms = navigator.mediaSession;
        ms.metadata = null;
        for (const a of ["play", "pause", "seekbackward", "seekforward", "seekto"] as const) {
          try {
            ms.setActionHandler(a, null);
          } catch {
            // Not every browser knows every action.
          }
        }
      }
    };
  });

  /** The system's media controls (keyboard media keys, lock screen, notifications). */
  const mediaSession = () => {
    if (!("mediaSession" in navigator) || !engine) return;
    const ms = navigator.mediaSession;
    const i = engine.info;
    const art = i ? (i.backdrop ?? i.poster) : null;
    ms.metadata = new MediaMetadata({
      title: i ? (i.kind === "episode" ? (i.episode_title ?? i.title) : (i.meta_title ?? i.title)) : "Panda",
      artist: i?.kind === "episode" ? `${i.series ?? ""} S${i.season ?? 0}:E${i.episode ?? 0}` : "",
      artwork: imageUrl(art) ? [{ src: imageUrl(art)! }] : [],
    });
    ms.setActionHandler("play", () => engine?.play());
    ms.setActionHandler("pause", () => engine?.pause());
    ms.setActionHandler("seekbackward", () => engine?.seekTo(engine.position() - SKIP_SECS));
    ms.setActionHandler("seekforward", () => engine?.seekTo(engine.position() + SKIP_SECS));
    try {
      ms.setActionHandler("seekto", (d) => d.seekTime !== undefined && engine?.seekTo(d.seekTime));
    } catch {
      // Not every browser knows seekto.
    }
  };

  const fraction = (secs: number) => (duration() > 0 ? Math.min(1, Math.max(0, secs / duration())) : 0);

  return (
    <div
      class={["player", { "controls-on": controls() || !playing(), idle: !controls() && playing() }]}
      onPointerMove={(e) => {
        // A mouse moving shows the controls (touches show them by tapping, below).
        if (e.pointerType === "mouse") showControls();
      }}
    >
      <video
        ref={(el) => (video = el)}
        playsinline
        onPointerUp={(e) => {
          // A mouse click plays or pauses; a tap shows or hides the controls.
          if (e.pointerType === "mouse") {
            engine?.togglePlay();
            showControls();
          } else if (controls()) {
            clearTimeout(hideTimer);
            setControls(false);
          } else {
            revealedAt = Date.now();
            showControls();
          }
        }}
        onDblClick={toggleFullscreen}
      />

      {/* Subtitles: text near the bottom, image subtitles where they were authored. */}
      <Show when={showing()?.kind === "text"}>
        <div class="player-subs">
          <span class="text">{(showing() as { text: string }).text}</span>
        </div>
      </Show>
      <Show when={showing()?.kind === "bitmap" ? (showing() as Extract<Showing, { kind: "bitmap" }>) : null}>
        {(s) => (
          <div
            class="player-subs-bitmap"
            style={{
              left: `${picture().x}px`,
              top: `${picture().y}px`,
              width: `${picture().w}px`,
              height: `${picture().h}px`,
            }}
          >
            <For each={s().cue.images}>
              {(img) => {
                const sx = () => picture().w / (s().frame.video_width || 1920);
                const sy = () => picture().h / (s().frame.video_height || 1080);
                return (
                  <img
                    src={absolute(img.url)}
                    alt=""
                    style={{
                      left: `${img.x * sx()}px`,
                      top: `${img.y * sy()}px`,
                      width: `${img.width * sx()}px`,
                      height: `${img.height * sy()}px`,
                    }}
                  />
                );
              }}
            </For>
          </div>
        )}
      </Show>

      <Show when={(loading() || waiting()) && !fatal()}>
        <div class="player-status">
          <div class="spinner" />
          {/* Auto quality measures the connection first (the TV says so too). */}
          <Show when={loading() && (engine as Engine | null)?.quality === "auto"}>
            <p class="muted">{t("Checking your connection...")}</p>
          </Show>
        </div>
      </Show>
      <Show when={fatal()}>
        <div class="player-status" style={{ "pointer-events": "auto" }}>
          <p>{fatal()}</p>
          <button class="btn primary" onClick={leave}>
            {t("Back")}
          </button>
        </div>
      </Show>
      <Show when={toastText()}>
        <div class="player-toast" role="status">
          {toastText()}
        </div>
      </Show>

      <div
        class="player-ui"
        ref={(el) =>
          el.addEventListener(
            "click",
            (e) => {
              if (Date.now() - revealedAt < 500) {
                e.stopPropagation();
                e.preventDefault();
              }
            },
            true,
          )
        }
      >
        <div class="player-top">
          <button class="icon-btn" aria-label={t("Back")} onClick={leave}>
            <Icon name="left" size={28} />
          </button>
          <div class="player-title">
            <b>{title()}</b>
            <span>{subtitle()}</span>
          </div>
        </div>

        <div class="player-center">
          <button
            class="icon-btn skip"
            aria-label={t("Back 10 seconds")}
            onClick={() => {
              engine?.seekTo(engine.position() - SKIP_SECS);
              showControls();
            }}
          >
            <Icon name="back10" size={36} />
          </button>
          <button
            class="icon-btn big"
            aria-label={playing() ? t("Pause") : t("Play")}
            onClick={() => {
              engine?.togglePlay();
              showControls();
            }}
          >
            <Icon name={playing() ? "pause" : "play"} size={44} />
          </button>
          <button
            class="icon-btn skip"
            aria-label={t("Forward 10 seconds")}
            onClick={() => {
              engine?.seekTo(engine.position() + SKIP_SECS);
              showControls();
            }}
          >
            <Icon name="fwd10" size={36} />
          </button>
        </div>

        <div class="player-bottom">
          <div
            class={["scrub", { dragging: dragging() }]}
            ref={(el) => (bar = el)}
            role="slider"
            aria-label={t("Position")}
            aria-valuemin="0"
            aria-valuemax={String(Math.round(duration()))}
            aria-valuenow={String(Math.round(position()))}
            tabindex="0"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              setDragging(true);
              const at = atPointer(e.clientX);
              setHoverAt(at);
              settlePreview(at);
              showControls();
            }}
            onPointerMove={(e) => {
              const at = atPointer(e.clientX);
              if (dragging() || e.pointerType === "mouse") {
                setHoverAt(at);
                settlePreview(at);
              }
              if (dragging()) showControls();
            }}
            onPointerUp={(e) => {
              if (!dragging()) return;
              setDragging(false);
              engine?.seekTo(atPointer(e.clientX));
              setHoverAt(null);
              settlePreview(null);
              showControls();
            }}
            onPointerLeave={() => {
              if (dragging()) return;
              setHoverAt(null);
              settlePreview(null);
            }}
            onPointerCancel={() => {
              setDragging(false);
              setHoverAt(null);
              settlePreview(null);
            }}
          >
            <div class="scrub-track">
              <div class="scrub-buffered" style={{ width: `${fraction(buffered()) * 100}%` }} />
              <div class="scrub-played" style={{ width: `${fraction(shownAt()) * 100}%` }} />
              <div class="scrub-knob" style={{ left: `${fraction(shownAt()) * 100}%` }} />
            </div>
            <Show when={hoverAt() !== null}>
              <div class="scrub-preview" style={{ left: `${fraction(hoverAt()!) * 100}%` }}>
                <Show when={pb()?.preview_url && previewAt() !== null}>
                  <img src={previewUrl(pb()!.preview_url!, previewAt()!)} alt="" />
                </Show>
                <span>{formatTime(hoverAt()!)}</span>
              </div>
            </Show>
          </div>
          <div class="player-row">
            <button
              class="icon-btn row-play"
              aria-label={playing() ? t("Pause") : t("Play")}
              onClick={() => engine?.togglePlay()}
            >
              <Icon name={playing() ? "pause" : "play"} />
            </button>
            <button
              class="icon-btn"
              aria-label={muted() ? t("Sound on") : t("Mute")}
              onClick={() => {
                if (video) video.muted = !video.muted;
              }}
            >
              <Icon name={muted() || volume() === 0 ? "mute" : "volume"} />
            </button>
            <input
              class="volume"
              type="range"
              min="0"
              max="1"
              step="0.05"
              aria-label={t("Volume")}
              value={muted() ? 0 : volume()}
              onInput={(e) => {
                if (!video) return;
                video.volume = Number(e.currentTarget.value);
                video.muted = video.volume === 0;
              }}
            />
            <span class="player-time">
              {formatTime(shownAt())} / {formatTime(duration())}
            </span>
            <Show when={pb()}>
              <span class="stream-info">
                {t(QUALITIES.find((q) => q.id === engine?.quality)?.label ?? "Auto")} ·{" "}
                {describeStream(pb()!.stream)}
              </span>
            </Show>
            <span class="spacer" />
            <Show when={tracks().length > 0 || canFind()}>
              <button
                class={["icon-btn", { on: !!subs() }]}
                aria-label={t("Subtitles")}
                onClick={(e) => void subtitleMenu(e)}
              >
                <Icon name="captions" />
              </button>
            </Show>
            <Show when={audioTracks().length > 1}>
              <button class="icon-btn" aria-label={t("Audio")} onClick={(e) => void audioMenu(e)}>
                <Icon name="audio" />
              </button>
            </Show>
            <button class="icon-btn" aria-label={t("Quality")} onClick={(e) => void qualityMenu(e)}>
              <Icon name="gear" />
            </button>
            <Show when={pipSupported()}>
              <button class="icon-btn" aria-label={t("Picture in Picture")} onClick={togglePip}>
                <Icon name="pip" />
              </button>
            </Show>
            <Show when={(tick(), canFullscreen())}>
              <button
                class="icon-btn"
                aria-label={fullscreen() ? t("Exit full screen") : t("Full screen")}
                onClick={toggleFullscreen}
              >
                <Icon name={fullscreen() ? "shrink" : "expand"} />
              </button>
            </Show>
          </div>
        </div>
      </div>

      <Show when={timingOpen()}>
        <div class="timing-panel" role="dialog" aria-label={t("Subtitle timing")}>
          <b>{t("Subtitle timing")}</b>
          <div class="value">{shortTiming(timing())}</div>
          <div class="btns">
            <button class="btn small" onClick={() => nudge(-0.5)}>
              −0.5
            </button>
            <button class="btn small" onClick={() => nudge(-0.1)}>
              −0.1
            </button>
            <button class="btn small" onClick={() => nudge(0.1)}>
              +0.1
            </button>
            <button class="btn small" onClick={() => nudge(0.5)}>
              +0.5
            </button>
          </div>
          <div class="dialog-actions">
            <button class="btn small" onClick={() => nudge(null)}>
              {t("No adjustment")}
            </button>
            <button class="btn small primary" onClick={() => setTimingOpen(false)}>
              {t("Done")}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
