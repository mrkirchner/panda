import { createResource, Show } from "solid-js";
import { useNavigate } from "../nav";
import { useParams } from "@solidjs/router";
import { api } from "../api/client";
import { BrowsePage } from "../components/BrowsePage";
import { displayText } from "../format";
import { t } from "../i18n";
import { genreTint } from "../theme";

/**
 * A genre (from Home's genre tiles), like a store's genre page: its name over a backdrop
 * washed in the genre's color, then featured titles, the top ten (ranked), what's new and the
 * genres it's most often paired with. Movies and shows together, all from the library; "See
 * all" opens the full list filtered to it.
 */
function GenreView() {
  const params = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [page] = createResource(() => params.name, api.genrePage);
  const name = () => (page.error ? undefined : page()?.name) ?? params.name;
  return (
    <BrowsePage
      page={page}
      name={displayText(name())}
      tint={genreTint(params.name)}
      allLabel={t("See all")}
      onAll={() =>
        navigate(
          `/${(page.error ? undefined : page()?.kind) ?? "movies"}/all?genre=${encodeURIComponent(name())}`,
        )
      }
      topTitle={p => t("Top 10 {genre}", { genre: displayText(p.name) })}
      empty={t("Nothing in this genre yet.")}
    />
  );
}

/** Rebuilt for each genre. */
export default function Genre() {
  const params = useParams<{ name: string }>();
  return (
    <Show when={params.name} keyed>
      <GenreView />
    </Show>
  );
}
