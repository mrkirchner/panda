#!/usr/bin/env node
// Build and package the TV app for a device: `pnpm package:lg|tizen|android`.
// Output goes to dist/packages/. Sideloading steps: docs/DEVICES.md (repo root).
//
// Vendor tools are used from your machine, never downloaded by this script:
// - LG: `ares-package` (npm i -g @webos-tools/cli)
// - Samsung: Tizen Studio's `tizen` CLI and a certificate profile (TIZEN_PROFILE)
// - Android TV / Fire TV: a JDK 17 and the Android SDK (ANDROID_HOME), plus `gradle`
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const device = process.argv[2];
if (!["lg", "tizen", "android"].includes(device)) {
  console.error("usage: node scripts/package.mjs <lg|tizen|android>");
  process.exit(1);
}
const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
const has = cmd => {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const out = join("dist", device);
const packages = join("dist", "packages");
mkdirSync(packages, { recursive: true });

console.log(`\n== Building for ${device} ==`);
run("pnpm", ["exec", "vite", "build", "--mode", "production"], { TARGET_DEVICE: device });
if (existsSync(join("devices", device, "package"))) {
  cpSync(join("devices", device, "package"), out, { recursive: true });
}

if (device === "lg") {
  if (!has("ares-package")) {
    console.error(
      `\nInstall LG's CLI to make the .ipk: npm i -g @webos-tools/cli\nThe app build is in ${out}`,
    );
    process.exit(2);
  }
  console.log("\n== Packaging .ipk ==");
  run("ares-package", [out, "-o", packages, "--no-minify"]);
}

if (device === "tizen") {
  // Samsung only installs signed packages: Tizen Studio's CLI plus your certificate profile.
  const tizen = has("tizen") ? "tizen" : join(process.env.HOME ?? "", "tizen-studio/tools/ide/bin/tizen");
  const profile = process.env.TIZEN_PROFILE;
  if (!existsSync(tizen) && tizen !== "tizen") {
    console.error(
      `\nInstall Tizen Studio (with the TV extension) to sign the .wgt.\nThe app build is in ${out}`,
    );
    process.exit(2);
  }
  if (!profile) {
    console.error(
      `\nSet TIZEN_PROFILE to your certificate profile name (docs/DEVICES.md).\nThe app build is in ${out}`,
    );
    process.exit(2);
  }
  console.log("\n== Packaging signed .wgt ==");
  run(tizen, ["package", "-t", "wgt", "-s", profile, "-o", packages, "--", out]);
}

if (device === "android") {
  // The WebView wrapper in clients/androidtv bundles this build as its assets.
  const project = join("..", "androidtv");
  const www = join(project, "app", "src", "main", "assets", "www");
  rmSync(www, { recursive: true, force: true });
  cpSync(out, www, { recursive: true });
  const gradle = existsSync(join(project, "gradlew")) ? "./gradlew" : has("gradle") ? "gradle" : null;
  if (!gradle || !process.env.ANDROID_HOME) {
    console.error(
      `\nInstall a JDK 17, the Android SDK (set ANDROID_HOME) and Gradle to build the APK.\n` +
        `The app build is copied into ${www}`,
    );
    process.exit(2);
  }
  console.log("\n== Building APK (debug-signed, for sideloading) ==");
  execFileSync(gradle, ["assembleDebug"], { cwd: project, stdio: "inherit" });
  cpSync(join(project, "app/build/outputs/apk/debug/app-debug.apk"), join(packages, "panda-android-tv.apk"));
}

console.log(`\nPackages in ${packages}: ${readdirSync(packages).join(", ")}`);
