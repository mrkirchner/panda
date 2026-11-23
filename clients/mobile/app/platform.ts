// Never bundled: the build takes platform.ios.ts or platform.android.ts for "./platform". This
// file only gives the type check one to read (both satisfy PhonePlatform, so either will do).
export { platform } from "./platform.ios";
