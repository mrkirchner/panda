// Text entry on Apple TV through tvOS's own keyboard. The TV client draws its own keyboard
// everywhere else, but here a native UITextField takes over: focusing it brings up the system
// keyboard, which has Siri dictation (hold the Siri button and speak) and typing from an iPhone
// ("Use iPhone to type"); neither reaches an app any other way (tvOS gives apps no microphone
// and no speech recognition). The client reaches it through `globalThis.pandaNativeTextInput`
// (see ../tv/components/Keyboard.tsx), so its source never imports NativeScript.
import type { GridLayout } from "@nativescript/core";

export interface NativeTextOptions {
  value: string;
  /** Shown by the system keyboard as its prompt. */
  title?: string;
  secure?: boolean;
  kind?: "text" | "email" | "url";
}

export interface NativeTextInput {
  /** Opens the keyboard; `onChange` gets the whole text on every edit, `onDone` once at the end. */
  open(options: NativeTextOptions, onChange: (text: string) => void, onDone: () => void): void;
  close(): void;
}

// Objective-C target for the field's "editing changed" control event.
const ChangeTarget = (NSObject as unknown as {
  extend(methods: object, info: object): { new (): NSObject & { onChange?: (t: string) => void } };
}).extend(
  {
    changed(this: { onChange?: (t: string) => void }, sender: UITextField) {
      this.onChange?.(sender.text ?? "");
    },
  },
  { exposedMethods: { changed: { returns: interop.types.void, params: [UITextField] } } },
);

// Ends editing on Done/return and reports when the keyboard goes away (Done or Menu).
const FieldDelegate = (NSObject as unknown as {
  extend(methods: object, info: object): { new (): NSObject & { onDone?: () => void } };
}).extend(
  {
    textFieldShouldReturn(field: UITextField) {
      field.resignFirstResponder();
      return true;
    },
    textFieldDidEndEditing(this: { onDone?: () => void }) {
      const done = this.onDone;
      this.onDone = undefined;
      done?.();
    },
  },
  { protocols: [UITextFieldDelegate] },
);

/** After dictation, the keyboard closes by itself this long after the last change. */
const AFTER_DICTATION_MS = 700;

/** Set while a field is open: what dictation (Siri button) produced, for the current field. */
let onDictated: ((text: string) => void) | null = null;

// UITextField that hands dictation to us instead of inserting it at the cursor: dictation
// replaces the text (say a new search), then the keyboard closes. UIKit calls this when
// dictated text arrives (UITextInput's insertDictationResult).
const DictationField = (UITextField as unknown as {
  extend(methods: object): { alloc(): UITextField };
}).extend({
  insertDictationResult(phrases: NSArray<UIDictationPhrase>) {
    let text = "";
    for (let i = 0; i < phrases.count; i++) text += phrases.objectAtIndex(i).text;
    onDictated?.(text.trim());
  },
});

export function installNativeTextInput(root: GridLayout): void {
  let field: UITextField | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  /** Dictation done: show the words, then close (as if Done were pressed). */
  const dictated = (text: string) => {
    if (!field) return;
    field.text = text;
    (target as { onChange?: (t: string) => void }).onChange?.(text);
    clearTimeout(finishTimer);
    finishTimer = setTimeout(() => field?.resignFirstResponder(), AFTER_DICTATION_MS);
  };
  const target = new ChangeTarget();
  const delegate = new FieldDelegate();

  const ensureField = (): UITextField | null => {
    const host = root.ios as UIView | undefined;
    if (!host) return null;
    if (!field) {
      // Out of sight: tvOS shows the text in its own keyboard screen.
      field = DictationField.alloc().initWithFrame(CGRectMake(-10, -10, 1, 1));
      field.alpha = 0.01;
      field.autocorrectionType = UITextAutocorrectionType.No;
      field.spellCheckingType = UITextSpellCheckingType.No;
      field.addTargetActionForControlEvents(target, "changed", UIControlEvents.EditingChanged);
      field.delegate = delegate as unknown as UITextFieldDelegate;
      host.addSubview(field);
    }
    return field;
  };

  const input: NativeTextInput = {
    open(options, onChange, onDone) {
      const f = ensureField();
      if (!f) return onDone();
      (target as { onChange?: (t: string) => void }).onChange = onChange;
      onDictated = options.secure ? null : dictated;
      clearTimeout(finishTimer);
      finishTimer = undefined;
      (delegate as { onDone?: () => void }).onDone = () => {
        (target as { onChange?: (t: string) => void }).onChange = undefined;
        onDictated = null;
        clearTimeout(finishTimer);
        finishTimer = undefined;
        onDone();
      };
      f.text = options.value;
      f.placeholder = options.title ?? "";
      f.secureTextEntry = !!options.secure;
      f.keyboardType =
        options.kind === "email"
          ? UIKeyboardType.EmailAddress
          : options.kind === "url"
            ? UIKeyboardType.URL
            : UIKeyboardType.Default;
      f.autocapitalizationType =
        options.kind === "text" && !options.secure
          ? UITextAutocapitalizationType.Sentences
          : UITextAutocapitalizationType.None;
      f.becomeFirstResponder();
    },
    close() {
      field?.resignFirstResponder();
    },
  };
  (globalThis as unknown as { pandaNativeTextInput: NativeTextInput }).pandaNativeTextInput = input;
}
