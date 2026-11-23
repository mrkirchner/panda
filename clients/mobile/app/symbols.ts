// Icons by their SF Symbol name ("house.fill"): Apple's own on iPhone, and on Android the same
// line icons drawn as vector drawables (App_Resources/Android/src/main/res/drawable/sym_*.xml).
export const symbol = (name: string): string =>
  __IOS__ ? `sys://${name}` : `res://sym_${name.replace(/\./g, "_")}`;
