// The platform's version is bundled (discovery.ios.ts / discovery.android.ts: NativeScript picks the file for
// the platform being built). This file only gives TypeScript one to read; platformCheck.ts checks
// both export the same.
export * from "./discovery.ios";
