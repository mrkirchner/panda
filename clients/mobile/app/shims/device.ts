// The TV client's `#device` config, as far as its shared code reads it on the phone: finding
// servers (api/discover.ts). Bonjour comes from the Apple TV host (../appletv/app/discovery.ts).
export const config = {
  discover: async () => {
    const find = (globalThis as { pandaDiscover?: () => Promise<string[]> }).pandaDiscover;
    return { urls: find ? await find() : [] };
  },
};
