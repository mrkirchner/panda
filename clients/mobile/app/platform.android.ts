// The phone app on Android (see platformTypes.ts).
import { Utils } from "@nativescript/core";
import type { PhonePlatform } from "./platformTypes";
import {
  playClip,
  setPlayerOpen,
  setSheetOpen,
  stopClip,
} from "./clip.android";
import { findServers } from "./discovery.android";
import { nowPlaying } from "./nowPlaying.android";
import { pageSnap } from "./paging.android";
import { prompt } from "./prompt.android";
import { devSeek, play } from "./player.android";
import { phoneProfile } from "./profile.android";
import { attachSideways } from "./sideways.android";
import { isListening, startListening, stopListening } from "./voice.android";

export const platform = {
  os: "android",
  player: { profile: phoneProfile, play, devSeek },
  clips: { play: playClip, stop: stopClip, setPlayerOpen, setSheetOpen },
  voice: { start: startListening, stop: stopListening, isListening },
  discovery: { find: async () => ({ urls: await findServers() }) },
  gestures: { sideways: attachSideways, pageSnap },
  prompt,
  // The name its owner sees in Settings and Bluetooth ("Pixel 8"), else maker and model.
  deviceName: () => {
    const resolver = (Utils.android.getApplicationContext() as android.content.Context).getContentResolver();
    const named = android.provider.Settings.Global.getString(resolver, "device_name");
    if (named) return String(named);
    const maker = String(android.os.Build.MANUFACTURER ?? "");
    const model = String(android.os.Build.MODEL ?? "Android");
    return model.toLowerCase().startsWith(maker.toLowerCase()) ? model : `${maker.charAt(0).toUpperCase()}${maker.slice(1)} ${model}`;
  },
  // The SF Symbol names drawn as vector drawables (App_Resources/Android/src/main/res/drawable/sym_*.xml).
  icon: (name) => `res://sym_${name.replace(/\./g, "_")}`,
  nowPlaying,
} satisfies PhonePlatform as PhonePlatform;
