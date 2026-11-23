// JSX types for @nativescript-community/solid-js, which ships none: NativeScript views by tag
// (stacklayout, label, image, ...) with any attributes, `on:<event>` handlers included.
declare module "@nativescript-community/solid-js/jsx-runtime" {
  export namespace JSX {
    type Element = any;
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicElements {
      [tag: string]: Record<string, any>;
    }
  }
}
