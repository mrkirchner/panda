import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import { Text, View, type ElementNode } from "@solidtv/solid";
import { api, imageUrl } from "../api/client";
import type { Discover, SeriesSummary, Title } from "../api/types";
import { Backdrop } from "../components/Backdrop";
import { PillButton } from "../components/Button";
import { CardRow } from "../components/CardRow";
import { Label } from "../components/Label";
import { Loader } from "../components/Loader";
import { HEADER_H, HeaderArea, PageRows } from "../components/PageRows";
import { TextSheet } from "../components/TextSheet";
import { TopBar } from "../components/TopBar";
import { displayText, longDate } from "../format";
import { t } from "../i18n";
import { focusTopBar, useNavigate } from "../nav";
import { createDiscoverStatus } from "../discoverStatus";
import { theme } from "../theme";

const { screen, color, font } = theme;
const PHOTO = 300;
const PHOTO_Y = 300;
const TEXT_X = screen.gutter + PHOTO + 64;
const TEXT_W = screen.width - TEXT_X - screen.gutter - 200;
const BUTTONS_Y = HEADER_H - 170;

/** One of theirs in your library: a movie or a show. */
interface Mine {
  title?: Title;
  show?: SeriesSummary;
}

/** Whole years from `from` to `to` (ISO dates; `to` defaults to today). */
function yearsBetween(from: string, to?: string | null): number | null {
  const a = new Date(`${from}T12:00:00`);
  const b = to ? new Date(`${to}T12:00:00`) : new Date();
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  let years = b.getFullYear() - a.getFullYear();
  if (b.getMonth() < a.getMonth() || (b.getMonth() === a.getMonth() && b.getDate() < a.getDate())) years--;
  return years;
}

/**
 * A person (from Cast & Crew), laid out like a title's page: their photo and name over one
 * of their titles, who they are and the start of their story (Biography opens it all), then
 * theirs in your library and the rest of their work by role (Movies, Shows, Directed...,
 * requestable), their main role first.
 */
function PersonView() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [person] = createResource(
    () => Number(params.id),
    id => api.person(id),
  );
  const mine = createMemo<Mine[]>(() => [
    ...(person()?.movies ?? []).map(title => ({ title })),
    ...(person()?.shows ?? []).map(show => ({ show })),
  ]);
  const [onHeader, setOnHeader] = createSignal(true);
  const [reading, setReading] = createSignal(false);
  let buttonsRef: ElementNode | undefined;
  const status = createDiscoverStatus();
  /** "Acting · Born March 1, 1970 (55) · Chicago, Illinois, USA". */
  const facts = () => {
    const p = person();
    if (!p) return "";
    const born = longDate(p.birthday);
    const age = p.birthday ? yearsBetween(p.birthday, p.deathday) : null;
    return [
      p.known_for ? t(p.known_for) : null,
      born ? t("Born {date}", { date: born }) + (age !== null && !p.deathday ? ` (${age})` : "") : null,
      p.deathday
        ? t("Died {date}", { date: longDate(p.deathday) ?? p.deathday }) + (age !== null ? ` (${age})` : "")
        : null,
      p.place_of_birth,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const initials = () =>
    (person()?.name ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(w => w[0]!.toUpperCase())
      .join("");
  const mineCard = (m: Mine) =>
    m.title
      ? {
          width: 0,
          height: 0,
          image: imageUrl(m.title.poster),
          title: m.title.title,
          progress: m.title.progress && !m.title.progress.finished ? m.title.progress.fraction : 0,
          watched: m.title.progress?.finished,
          onSelect: () => navigate(`/title/${encodeURIComponent(m.title!.id)}`),
        }
      : {
          width: 0,
          height: 0,
          image: imageUrl(m.show!.poster),
          title: m.show!.meta_title ?? m.show!.series,
          onSelect: () => navigate(`/series/${encodeURIComponent(m.show!.series)}`),
        };
  const workCard = (d: Discover) => ({
    width: 0,
    height: 0,
    image: imageUrl(d.poster),
    title: d.title,
    badge: status(d).label,
    badgeTone: status(d).tone,
    progress: status(d).progress,
    onSelect: () => navigate(`/discover/${d.kind}/${d.tmdb_id}`),
  });

  return (
    <View>
      <Backdrop src={imageUrl(person()?.backdrop)} dim />
      <Show when={person.loading && !person()}>
        <Loader x={screen.width / 2} y={screen.height / 2} />
      </Show>
      <Show when={person.error}>
        <Text x={screen.gutter} y={200} fontSize={font.body} color={color.error}>
          {t("Couldn't load this person.")}
        </Text>
      </Show>
      <Show when={person()}>
        {p => (
          <PageRows onHeaderFocused={setOnHeader} onTopUp={focusTopBar}>
            <HeaderArea visible={onHeader()}>
              {/* First: the header forwards focus to its first child. */}
              <View
                ref={buttonsRef}
                x={TEXT_X}
                y={BUTTONS_Y}
                width={400}
                height={64}
                forwardFocus={0}
                autofocus
              >
                <Show
                  when={p().biography}
                  // Nothing to open: still something to land on (Down goes on to the rows).
                  fallback={<View width={1} height={1} onEnter={() => true} />}
                >
                  <PillButton label={t("Biography")} width={260} onSelect={() => setReading(true)} />
                </Show>
              </View>
              <View
                x={screen.gutter}
                y={PHOTO_Y}
                width={PHOTO}
                height={PHOTO}
                borderRadius={PHOTO / 2}
                color={theme.glass.regular}
              >
                <Label
                  text={initials()}
                  width={PHOTO}
                  height={PHOTO}
                  size={84}
                  color={color.textMuted}
                  alpha={p().image ? 0 : 1}
                />
                <Show when={p().image}>
                  <View
                    width={PHOTO}
                    height={PHOTO}
                    borderRadius={PHOTO / 2}
                    src={imageUrl(p().image)}
                    textureOptions={{ resizeMode: { type: "cover" } }}
                  />
                </Show>
              </View>
              <Text
                x={TEXT_X}
                y={PHOTO_Y - 6}
                width={TEXT_W}
                contain="width"
                maxLines={1}
                fontSize={84}
                fontFamily="Roboto700"
                color={color.text}
              >
                {displayText(p().name)}
              </Text>
              <Text
                x={TEXT_X}
                y={PHOTO_Y + 104}
                width={TEXT_W}
                contain="width"
                maxLines={1}
                fontSize={font.caption}
                color={color.textMuted}
              >
                {displayText(facts()) || " "}
              </Text>
              <Text
                x={TEXT_X}
                y={PHOTO_Y + 152}
                width={TEXT_W}
                contain="width"
                maxLines={4}
                lineHeight={font.body * 1.35}
                fontSize={font.body}
                color={color.text}
              >
                {displayText(p().biography) || " "}
              </Text>
              <TopBar visible={onHeader()} onDown={() => (buttonsRef?.setFocus(), true)} />
            </HeaderArea>

            <Show when={mine().length > 0}>
              <CardRow<Mine> title={t("In your library")} items={mine()} card={mineCard} />
            </Show>
            <For each={p().roles}>
              {row => <CardRow<Discover> title={t(row.role)} items={row.items} card={workCard} />}
            </For>
          </PageRows>
        )}
      </Show>
      <Show when={reading() && person()}>
        <TextSheet
          title={person()!.name}
          subtitle={facts()}
          text={person()!.biography ?? ""}
          onClose={() => {
            setReading(false);
            buttonsRef?.setFocus();
          }}
        />
      </Show>
    </View>
  );
}

/** Rebuilt for each person (another one opened from here keeps the same route). */
export default function Person() {
  const params = useParams<{ id: string }>();
  return (
    <Show when={params.id} keyed>
      <PersonView />
    </Show>
  );
}
