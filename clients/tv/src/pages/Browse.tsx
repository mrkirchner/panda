import { createResource, Show } from "solid-js";
import { useLocation, useParams } from "@solidjs/router";
import { useNavigate } from "../nav";
import { api } from "../api/client";
import { BrowsePage } from "../components/BrowsePage";
import { displayText } from "../format";
import { t } from "../i18n";

/**
 * A main section (a top bar tab): a library (`/library/{id}`), or Movies / Shows (every
 * library of that kind). Laid out like a genre page (Featured, Top 10, Recently added, a row
 * per genre), with a button to the full grid (Library, `.../all`).
 */
function BrowseView(props: { section: string }) {
  const navigate = useNavigate();
  const kind = props.section === "movies" || props.section === "shows" ? props.section : null;
  const [page] = createResource(() =>
    kind ? api.browsePage(kind) : api.libraryPage(props.section.slice("library/".length)),
  );
  const name = () => (page.error ? undefined : page()?.name);
  const fallback = kind === "movies" ? t("Movies") : kind === "shows" ? t("Shows") : "";
  return (
    <BrowsePage
      main
      page={page}
      name={kind ? fallback : displayText(name() ?? "")}
      allLabel={kind === "movies" ? t("All movies") : kind === "shows" ? t("All shows") : t("See all")}
      onAll={() => navigate(`/${props.section}/all`)}
      topTitle={p =>
        kind
          ? kind === "movies"
            ? t("Top 10 Movies")
            : t("Top 10 Shows")
          : t("Top 10 {genre}", { genre: displayText(p.name) })
      }
      empty={t("Nothing here yet.")}
    />
  );
}

/** Rebuilt for each section. */
export default function Browse() {
  const location = useLocation();
  const params = useParams<{ id?: string }>();
  const section = () =>
    params.id ? `library/${params.id}` : location.pathname === "/shows" ? "shows" : "movies";
  return (
    <Show when={section()} keyed>
      {s => <BrowseView section={s} />}
    </Show>
  );
}
