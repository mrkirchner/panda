// Type-level only (nothing runs): each platform-specific module exports what the other does, so
// code importing "./player" (etc.) works on both iOS and Android.
import type * as PlayerIos from "./player.ios";
import type * as PlayerAndroid from "./player.android";
import type * as ClipIos from "./clip.ios";
import type * as ClipAndroid from "./clip.android";
import type * as VoiceIos from "./voice.ios";
import type * as VoiceAndroid from "./voice.android";
import type * as ProfileIos from "./profile.ios";
import type * as ProfileAndroid from "./profile.android";
import type * as DiscoveryIos from "./discovery.ios";
import type * as DiscoveryAndroid from "./discovery.android";
import type * as SidewaysIos from "./sideways.ios";
import type * as SidewaysAndroid from "./sideways.android";
import type * as PagingIos from "./paging.ios";
import type * as PagingAndroid from "./paging.android";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Exports<M> = { [K in keyof M]: M[K] };

export const platformsMatch: [
  Same<keyof Exports<typeof PlayerIos>, keyof Exports<typeof PlayerAndroid>>,
  Same<keyof Exports<typeof ClipIos>, keyof Exports<typeof ClipAndroid>>,
  Same<keyof Exports<typeof VoiceIos>, keyof Exports<typeof VoiceAndroid>>,
  Same<keyof Exports<typeof ProfileIos>, keyof Exports<typeof ProfileAndroid>>,
  Same<keyof Exports<typeof DiscoveryIos>, keyof Exports<typeof DiscoveryAndroid>>,
  Same<keyof Exports<typeof SidewaysIos>, keyof Exports<typeof SidewaysAndroid>>,
  Same<keyof Exports<typeof PagingIos>, keyof Exports<typeof PagingAndroid>>,
] = [true, true, true, true, true, true, true];
