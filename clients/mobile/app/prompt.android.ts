// Asking for a line of text on Android: an AlertDialog of our own (NativeScript's prompt can't
// hide a number, and its field sits flush against the dialog's edge). Styled by the app theme's
// PandaDialog (res/values/styles.xml).
import { Application, Utils } from "@nativescript/core";
import type { PromptOptions } from "./platformTypes";

export function prompt(o: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const activity = (Application.android.foregroundActivity ?? Application.android.startActivity) as android.app.Activity;
    if (!activity) return resolve(null);
    const ctx = activity as unknown as android.content.Context;
    const T = android.text.InputType;
    const input = new android.widget.EditText(ctx);
    input.setSingleLine(true);
    input.setInputType(
      o.kind === "pin"
        ? T.TYPE_CLASS_NUMBER | T.TYPE_NUMBER_VARIATION_PASSWORD
        : o.kind === "email"
          ? T.TYPE_CLASS_TEXT | T.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
          : T.TYPE_CLASS_TEXT | T.TYPE_TEXT_FLAG_CAP_WORDS,
    );
    if (o.kind === "pin") {
      const filters = Array.create(android.text.InputFilter, 1);
      filters[0] = new android.text.InputFilter.LengthFilter(4);
      input.setFilters(filters);
    }
    if (o.text) {
      input.setText(o.text);
      input.setSelection(o.text.length);
    }
    // The field lines up with the title (the dialog's own 24 dp inset).
    const dp = Utils.layout.getDisplayDensity();
    const box = new android.widget.FrameLayout(ctx);
    box.setPadding(Math.round(20 * dp), Math.round(8 * dp), Math.round(20 * dp), 0);
    box.addView(input);

    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const click = (fn: () => void) => new android.content.DialogInterface.OnClickListener({ onClick: fn });
    const builder = new androidx.appcompat.app.AlertDialog.Builder(ctx).setTitle(o.title).setView(box);
    if (o.message) builder.setMessage(o.message);
    const dialog = builder
      .setPositiveButton(o.ok, click(() => finish(String(input.getText()))))
      .setNegativeButton(o.cancel, click(() => finish(null)))
      .setOnDismissListener(new android.content.DialogInterface.OnDismissListener({ onDismiss: () => finish(null) }))
      .create();
    // The keyboard's own Done/Go answers too.
    input.setOnEditorActionListener(
      new android.widget.TextView.OnEditorActionListener({
        onEditorAction: () => {
          finish(String(input.getText()));
          dialog.dismiss();
          return true;
        },
      }),
    );
    dialog.getWindow()?.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
    dialog.show();
    input.requestFocus();
  });
}
