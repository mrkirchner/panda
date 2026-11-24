// Which seasons, as the TV's SeasonPicker (Request a show, More seasons): all, or any of them.
// Resolves with the seasons chosen, null for all of them, or undefined when cancelled.
import { t } from "@tv/i18n";
import { pickMany } from "./ui";

export async function pickSeasons(
  seasons: number[],
  title: string,
  action: string,
): Promise<number[] | null | undefined> {
  const r = await pickMany(
    title,
    seasons.map((n) => t("Season {n}", { n })),
    action,
  );
  if (r === null) return undefined;
  return r.length === seasons.length ? null : r.map((i) => seasons[i]);
}
