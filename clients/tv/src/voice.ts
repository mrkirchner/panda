import { createSignal } from "solid-js";
import { t } from "./i18n";

/**
 * Voice search inside Panda. One entry point for every platform: `startVoiceSearch` listens,
 * then hands the words to `onResult` (the app opens Search with them).
 *
 * Browser: the Web Speech API (Chrome, Edge, Safari). TV remotes (LG Magic Remote mic, Samsung
 * voice) plug in here later, via their own platform voice APIs, as further sources.
 */
export type VoiceState = "idle" | "listening" | "error";
export const [voiceState, setVoiceState] = createSignal<VoiceState>("idle");
/** What was heard so far (interim words while listening). */
export const [voiceHeard, setVoiceHeard] = createSignal("");

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult:
    ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

function recognitionClass(): (new () => Recognition) | undefined {
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const voiceSupported = () => recognitionClass() !== undefined;

let active: Recognition | null = null;
/** How long to wait for you to start speaking. */
const START_TIMEOUT_MS = 8000;
/** Once you've spoken, stop after this much quiet. */
const SILENCE_MS = 1500;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Listen once; `onResult` gets the final words (not called if nothing was understood). */
export function startVoiceSearch(onResult: (text: string) => void) {
  const Cls = recognitionClass();
  if (!Cls) {
    setVoiceState("error");
    setVoiceHeard(t("Voice search isn't available here"));
    setTimeout(() => setVoiceState("idle"), 2000);
    return;
  }
  stopVoiceSearch();
  // Browsers only allow the microphone on https:// or localhost.
  if (!window.isSecureContext) {
    showVoiceError(t("Voice needs a secure address (https:// or localhost)"));
    return;
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  let heard = "";
  let finished = false;
  let failed: string | null = null;

  // Browsers end recognition at the first pause (sometimes before you've said anything), so
  // listen continuously and decide when to stop: after a short silence once you've spoken, or
  // after a while if you never do.
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    active?.stop();
    active = null;
    const words = heard.trim();
    if (!failed && words) {
      setVoiceState("idle");
      onResult(words);
    } else {
      showVoiceError(failed ?? t("Didn't catch that"));
    }
  };
  const quietThenFinish = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(finish, ms);
  };

  const listen = () => {
    const rec = new Cls();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = e => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      heard = text;
      setVoiceHeard(text);
      // Words are coming in: wait for a pause before stopping.
      quietThenFinish(SILENCE_MS);
    };
    rec.onerror = err => {
      // "no-speech" just means nothing yet; anything else (no mic, denied) ends it.
      if (err.error && err.error !== "no-speech" && err.error !== "aborted") {
        console.warn("[voice] recognition error:", err.error);
        failed =
          err.error === "not-allowed" || err.error === "service-not-allowed"
            ? t("Microphone access is blocked for this page")
            : err.error === "audio-capture"
              ? t("No microphone found")
              : err.error === "network"
                ? t("Can't reach the speech service")
                : t("Voice search isn't available here");
        finish();
      }
    };
    rec.onend = () => {
      if (finished) return;
      // Ended on its own: keep listening while there's time and nothing was said.
      if (!heard && Date.now() < deadline) listen();
      else finish();
    };
    active = rec;
    rec.start();
  };

  setVoiceHeard("");
  setVoiceState("listening");
  listen();
  quietThenFinish(START_TIMEOUT_MS);
}

/** Show why voice search stopped, for a few seconds. */
function showVoiceError(text: string) {
  setVoiceState("error");
  setVoiceHeard(text);
  setTimeout(() => setVoiceState("idle"), 4000);
}

export function stopVoiceSearch() {
  clearTimeout(timer);
  const rec = active;
  active = null;
  if (rec) rec.onend = null;
  rec?.stop();
  active = null;
  setVoiceState("idle");
}
