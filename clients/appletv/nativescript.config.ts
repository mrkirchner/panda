import { NativeScriptConfig } from "@nativescript/core";

export default {
  id: "app.panda.tv",
  projectName: "Panda",
  appPath: "app",
  appResourcesPath: "App_Resources",
  bundler: "webpack",
  cli: {
    packageManager: "pnpm",
  },
} as NativeScriptConfig;
