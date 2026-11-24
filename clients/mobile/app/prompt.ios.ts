// Asking for a line of text on iOS: a UIAlertController with one field (a PIN hidden, on the
// number pad; NativeScript's prompt shows the digits).
import { Application } from "@nativescript/core";
import type { PromptOptions } from "./platformTypes";

/** The view controller on top (a sheet or the player above the app), to present from. */
function topController(): UIViewController | null {
  let vc = (Application.ios.rootController as UIViewController | undefined) ?? null;
  while (vc?.presentedViewController) vc = vc.presentedViewController;
  return vc;
}

export function prompt(o: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const from = topController();
    if (!from) return resolve(null);
    const alert = UIAlertController.alertControllerWithTitleMessagePreferredStyle(
      o.title,
      o.message ?? null,
      UIAlertControllerStyle.Alert,
    );
    alert.addTextFieldWithConfigurationHandler((field) => {
      field.text = o.text ?? "";
      if (o.kind === "pin") {
        field.secureTextEntry = true;
        field.keyboardType = UIKeyboardType.NumberPad;
      } else if (o.kind === "password") {
        field.secureTextEntry = true;
        field.autocapitalizationType = UITextAutocapitalizationType.None;
        field.autocorrectionType = UITextAutocorrectionType.No;
      } else if (o.kind === "email") {
        field.keyboardType = UIKeyboardType.EmailAddress;
        field.autocapitalizationType = UITextAutocapitalizationType.None;
        field.autocorrectionType = UITextAutocorrectionType.No;
      } else {
        field.autocapitalizationType = UITextAutocapitalizationType.Words;
      }
    });
    alert.addAction(UIAlertAction.actionWithTitleStyleHandler(o.cancel, UIAlertActionStyle.Cancel, () => resolve(null)));
    alert.addAction(
      UIAlertAction.actionWithTitleStyleHandler(o.ok, UIAlertActionStyle.Default, () =>
        resolve(alert.textFields?.firstObject?.text ?? ""),
      ),
    );
    from.presentViewControllerAnimatedCompletion(alert, true, () => {});
  });
}
