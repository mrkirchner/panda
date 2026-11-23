// Voice search on Android, as the TV's Voice key (../tv/src/voice.ts) and the iPhone's: Android's
// SpeechRecognizer listens in the profile's language (else the phone's), hands the words over as
// they're heard, and stops on a pause or a second tap. The microphone is asked for the first time.
import { AndroidApplication, Application, Utils } from "@nativescript/core";
import { lang } from "@tv/i18n";

/** And never listen longer than this. */
const MAX_MS = 15_000;
const MIC_REQUEST = 7311;

export type VoiceEvents = {
  /** The words so far (they change while you speak). */
  onText: (text: string) => void;
  /** Listening started / stopped. */
  onListening: (on: boolean) => void;
  /** Not allowed or not available, said plainly. */
  onError: (message: string) => void;
};

let stopCurrent: (() => void) | null = null;
export const isListening = () => stopCurrent !== null;
export const stopListening = () => stopCurrent?.();

/** The microphone (Android asks the first time). */
function micAllowed(): Promise<boolean> {
  const activity = (Application.android.foregroundActivity ?? Application.android.startActivity) as unknown as android.app.Activity;
  const perm = android.Manifest.permission.RECORD_AUDIO;
  if (androidx.core.content.ContextCompat.checkSelfPermission(activity as unknown as android.content.Context, perm) === android.content.pm.PackageManager.PERMISSION_GRANTED) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onResult = (args: { requestCode: number; grantResults: number[] }) => {
      if (args.requestCode !== MIC_REQUEST) return;
      Application.android.off(AndroidApplication.activityRequestPermissionsEvent, onResult as never);
      resolve(args.grantResults?.[0] === android.content.pm.PackageManager.PERMISSION_GRANTED);
    };
    Application.android.on(AndroidApplication.activityRequestPermissionsEvent, onResult as never);
    androidx.core.app.ActivityCompat.requestPermissions(activity, [perm], MIC_REQUEST);
  });
}

export async function startListening(events: VoiceEvents): Promise<void> {
  if (stopCurrent) return stopCurrent();
  const ctx = Utils.android.getApplicationContext() as android.content.Context;
  if (!android.speech.SpeechRecognizer.isRecognitionAvailable(ctx)) {
    return events.onError("Voice search isn't available right now.");
  }
  if (!(await micAllowed())) return events.onError("The microphone is off for Panda (Settings > Panda).");

  const recognizer = android.speech.SpeechRecognizer.createSpeechRecognizer(ctx);
  const intent = new android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
  intent.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
  intent.putExtra(android.speech.RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
  if (lang() === "es") intent.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, "es-ES");

  const words = (bundle: android.os.Bundle | null) => {
    const list = bundle?.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
    return list && list.size() > 0 ? String(list.get(0)) : "";
  };
  const limit = setTimeout(() => stop(), MAX_MS);
  const stop = () => {
    if (stopCurrent !== stop) return;
    stopCurrent = null;
    clearTimeout(limit);
    try {
      recognizer.stopListening();
      recognizer.destroy();
    } catch {
      // Already finished.
    }
    events.onListening(false);
  };
  recognizer.setRecognitionListener(
    new android.speech.RecognitionListener({
      onReadyForSpeech() {},
      onBeginningOfSpeech() {},
      onRmsChanged() {},
      onBufferReceived() {},
      // Android's recognizer ends by itself after a pause.
      onEndOfSpeech() {},
      onError() {
        stop();
      },
      onResults(results: android.os.Bundle) {
        const text = words(results);
        if (text) events.onText(text);
        stop();
      },
      onPartialResults(partial: android.os.Bundle) {
        const text = words(partial);
        if (text) events.onText(text);
      },
      onEvent() {},
      onSegmentResults() {},
      onEndOfSegmentedSession() {},
      onLanguageDetection() {},
    } as unknown as android.speech.RecognitionListener),
  );
  stopCurrent = stop;
  events.onListening(true);
  recognizer.startListening(intent);
}
