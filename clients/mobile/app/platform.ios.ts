// The phone app on iOS (see platformTypes.ts).
import { Device } from "@nativescript/core";
import { findServers } from "@appletv/discovery";
import type { PhonePlatform } from "./platformTypes";
import { playClip, setPlayerOpen, setSheetOpen, stopClip } from "./clip.ios";
import { nowPlaying } from "./nowPlaying.ios";
import { pageSnap } from "./paging.ios";
import { prompt } from "./prompt.ios";
import { devSeek, play } from "./player.ios";
import { phoneProfile } from "./profile.ios";
import { attachSideways } from "./sideways.ios";
import { isListening, startListening, stopListening } from "./voice.ios";

export const platform = {
  os: "ios",
  player: { profile: phoneProfile, play, devSeek },
  clips: { play: playClip, stop: stopClip, setPlayerOpen, setSheetOpen },
  voice: { start: startListening, stop: stopListening, isListening },
  discovery: { find: async () => ({ urls: await findServers() }) },
  gestures: { sideways: attachSideways, pageSnap },
  prompt,
  // iOS gives apps only the model ("iPhone"), not the name its owner chose.
  deviceName: () => Device.model || "iPhone",
  icon: (name) => `sys://${name}`,
  nowPlaying,
} satisfies PhonePlatform as PhonePlatform;
