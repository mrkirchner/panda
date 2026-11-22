import { createResource } from "solid-js";
import { api } from "./api/client";
import type { MyListEntry } from "./api/types";

/** "My List" state for one title or show on the current profile, plus a toggle for its button. */
export function createMyListToggle(kind: MyListEntry["kind"], id: () => string) {
  const [list, { refetch }] = createResource(() => api.myList().catch(() => [] as MyListEntry[]));
  const inList = () => !!list()?.some(e => e.kind === kind && e.id === id());
  const toggle = async () => {
    await api.setInMyList(kind, id(), !inList()).catch(() => {});
    void refetch();
  };
  return { inList, toggle };
}
