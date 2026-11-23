// The phone app on Android (see platformTypes.ts).
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
  // The SF Symbol names drawn as vector drawables (App_Resources/Android/src/main/res/drawable/sym_*.xml).
  icon: (name) => `res://sym_${name.replace(/\./g, "_")}`,
  nowPlaying,
} satisfies PhonePlatform as PhonePlatform;
