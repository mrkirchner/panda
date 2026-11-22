/** The addresses of `ip`'s network to try: x.y.z.1-254 (a home network), minus `ip` itself. */
export function subnetHosts(ip: string): string[] {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p))) return [];
  const base = parts.slice(0, 3).join(".");
  return Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`).filter(h => h !== ip);
}
