// Whether a title or show is in this profile's My List, and changing it (as on the TV).
import { api } from "@tv/api/client";
import type { MyListEntry } from "@tv/api/types";
import { createSignal } from "solid-js";

export function myListToggle(kind: MyListEntry["kind"], id: string) {
  const [inList, setInList] = createSignal(false);
  api.myList().then(
    list => setInList(list.some(e => e.kind === kind && e.id === id)),
    () => {},
  );
  const toggle = async () => {
    const next = !inList();
    setInList(next);
    await api.setInMyList(kind, id, next).catch(() => setInList(!next));
  };
  return { inList, toggle };
}
