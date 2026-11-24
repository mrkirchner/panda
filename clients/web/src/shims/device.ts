// The TV app's `#device` config, as far as its shared code reads it in a browser: nothing to
// find on the network (a browser can't browse Bonjour), and the browser itself is asked what it
// plays (`@tv/playback/profile`).
export const config = {
  discover: async () => ({ urls: [] as string[] }),
};
