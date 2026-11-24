// Whether a title or show is in this profile's My List, and changing it (as on the TV). One list
// for the whole app (asked once, again on refreshAll), not a download per page.
import { api } from "@tv/api/client";
import type { MyListEntry } from "@tv/api/types";
import { createRoot, createSignal } from "solid-js";
import { refreshAll, refreshHooks } from "./data";

const store = createRoot(() => {
  const [list, setList] = createSignal<MyListEntry[] | null>(null);
  return { list, setList };
});
let asked = false;
const refresh = () =>
  api.myList().then(
    (l) => store.setList(l),
    () => {},
  );
refreshHooks.add(() => {
  if (asked) void refresh();
});

export function myListToggle(kind: MyListEntry["kind"], id: string) {
  if (!asked) {
    asked = true;
    void refresh();
  }
  const inList = () => !!store.list()?.some((e) => e.kind === kind && e.id === id);
  const toggle = async () => {
    const next = !inList();
    // Shown at once; put right if the server says no.
    const before = store.list() ?? [];
    store.setList(
      next
        ? [...before, { kind, id, title: "", year: null, poster: null, backdrop: null }]
        : before.filter((e) => !(e.kind === kind && e.id === id)),
    );
    await api.setInMyList(kind, id, next).catch(() => store.setList(before));
    refreshAll();
  };
  return { inList, toggle };
}
