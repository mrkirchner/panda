// The TV client's `#device` config, as far as its shared code reads it on the phone: finding
// servers (api/discover.ts), from the phone's own platform (Bonjour on iOS, NSD on Android).
import { platform } from "../platform";

export const config = {
  discover: () => platform.discovery.find(),
};
