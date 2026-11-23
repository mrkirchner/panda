// Voice search on the phone, as the TV's Voice key (../tv/src/voice.ts): listen with iOS's
// speech recognition, hand the words over as they're heard, and stop on a pause or a second tap.
// Recognition runs on Apple's speech service in the profile's language (else the phone's).
import { Utils } from "@nativescript/core";
import { lang } from "@tv/i18n";
import type { VoiceEvents } from "@tv/platform/types";

/** Stop this long after the last new words. */
const SILENCE_MS = 1500;
/** Stop this long after starting if nothing is said. */
const NOTHING_SAID_MS = 5000;
/** And never listen longer than this. */
const MAX_MS = 15_000;


let stopCurrent: (() => void) | null = null;
export const isListening = () => stopCurrent !== null;
export const stopListening = () => stopCurrent?.();

/** Ask for the microphone and speech recognition (iOS shows its prompts the first time). */
async function allowed(): Promise<string | null> {
  const speech = await new Promise<SFSpeechRecognizerAuthorizationStatus>(resolve =>
    SFSpeechRecognizer.requestAuthorization(s => Utils.executeOnMainThread(() => resolve(s))),
  );
  if (speech !== SFSpeechRecognizerAuthorizationStatus.Authorized) {
    return "Speech recognition is off for Panda (Settings > Panda).";
  }
  const mic = await new Promise<boolean>(resolve =>
    AVAudioSession.sharedInstance().requestRecordPermission(ok => Utils.executeOnMainThread(() => resolve(ok))),
  );
  return mic ? null : "The microphone is off for Panda (Settings > Panda).";
}

export async function startListening(events: VoiceEvents): Promise<void> {
  if (stopCurrent) return stopCurrent();
  const refused = await allowed();
  if (refused) return events.onError(refused);

  const locale = NSLocale.localeWithLocaleIdentifier(lang() === "es" ? "es-ES" : NSLocale.currentLocale.localeIdentifier);
  const recognizer = SFSpeechRecognizer.alloc().initWithLocale(locale) ?? SFSpeechRecognizer.new();
  if (!recognizer?.available) return events.onError("Voice search isn't available right now.");

  const session = AVAudioSession.sharedInstance();
  const before = session.category;
  session.setCategoryModeOptionsError(
    AVAudioSessionCategoryPlayAndRecord,
    AVAudioSessionModeMeasurement,
    AVAudioSessionCategoryOptions.DefaultToSpeaker | AVAudioSessionCategoryOptions.DuckOthers,
  );
  session.setActiveWithOptionsError(true, AVAudioSessionSetActiveOptions.NotifyOthersOnDeactivation);

  const request = SFSpeechAudioBufferRecognitionRequest.new();
  request.shouldReportPartialResults = true;
  const engine = AVAudioEngine.new();
  const input = engine.inputNode;
  input.installTapOnBusBufferSizeFormatBlock(0, 1024, input.outputFormatForBus(0), buffer =>
    request.appendAudioPCMBuffer(buffer),
  );
  engine.prepare();
  if (!engine.startAndReturnError()) {
    input.removeTapOnBus(0);
    return events.onError("The microphone couldn't start.");
  }

  let silence: ReturnType<typeof setTimeout> | undefined;
  let task: SFSpeechRecognitionTask | null = null;
  const limit = setTimeout(() => stop(), MAX_MS);
  const stop = () => {
    if (stopCurrent !== stop) return;
    stopCurrent = null;
    clearTimeout(silence);
    clearTimeout(limit);
    engine.stop();
    input.removeTapOnBus(0);
    request.endAudio();
    task?.finish();
    // Back to playback (the player's and the clips' category).
    session.setCategoryModeOptionsError(before, AVAudioSessionModeDefault, 0 as AVAudioSessionCategoryOptions);
    events.onListening(false);
  };
  stopCurrent = stop;
  events.onListening(true);
  // Nothing said at all: give up sooner.
  silence = setTimeout(stop, NOTHING_SAID_MS);
  task = recognizer.recognitionTaskWithRequestResultHandler(request, (result, error) =>
    // Called off the main thread.
    Utils.executeOnMainThread(() => {
      if (result) {
        events.onText(result.bestTranscription.formattedString);
        clearTimeout(silence);
        silence = setTimeout(stop, SILENCE_MS);
      }
      if (error || result?.final) stop();
    }),
  );
}
