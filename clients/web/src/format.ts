/** "3 minutes ago" style relative time from unix seconds. */
export function ago(unix: number | null | undefined, now = Date.now() / 1000): string {
  if (!unix) return "never";
  const s = Math.max(0, Math.round(now - unix));
  if (s < 60) return "just now";
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, "year"],
    [60 * 60 * 24 * 30, "month"],
    [60 * 60 * 24, "day"],
    [60 * 60, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

/** "in 6 days" style for future timestamps. */
export function until(unix: number, now = Date.now() / 1000): string {
  const d = Math.round((unix - now) / 86400);
  if (d <= 0) return "today";
  return d === 1 ? "in 1 day" : `in ${d} days`;
}

/** Matches the server's password policy (panda-auth: 10..=256 characters). */
export const PASSWORD_MIN = 10;
export const passwordProblem = (pw: string, confirm?: string): string | null => {
  if ([...pw].length < PASSWORD_MIN)
    return `Use at least ${PASSWORD_MIN} characters (a short phrase works well).`;
  if ([...pw].length > 256) return "That's too long (max 256 characters).";
  if (confirm !== undefined && pw !== confirm) return "The passwords don't match.";
  return null;
};

/** "1.8 TB", "512 GB", "740 MB" (powers of 1000, like drive makers and Radarr). */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
