// Home's building blocks: a titled row that scrolls sideways, posters and wide cards.
import { imageUrl } from "@tv/api/client";
import type { JSX } from "@nativescript-community/solid-js/jsx-runtime";
import { Show } from "solid-js";

export function Row(props: { title: string; children: JSX.Element }) {
  return (
    <stacklayout>
      <label class="section-title" text={props.title} />
      <scrollview orientation="horizontal" scrollBarIndicatorVisible={false}>
        <stacklayout orientation="horizontal" class="row-items">
          {props.children}
        </stacklayout>
      </scrollview>
    </stacklayout>
  );
}

export function Poster(props: { image: string | null; title: string; onTap: () => void }) {
  return (
    <gridlayout class="poster" on:tap={props.onTap}>
      <Show when={!props.image}>
        <label class="small center" textWrap={true} verticalAlignment="middle" text={props.title} />
      </Show>
      <image class="poster" src={imageUrl(props.image)} stretch="aspectFill" />
    </gridlayout>
  );
}

export function WideCard(props: {
  image: string | null;
  title: string;
  subtitle?: string;
  fraction?: number;
  onTap: () => void;
}) {
  return (
    <stacklayout class="wide-cell" on:tap={props.onTap}>
      <image class="wide" src={imageUrl(props.image)} stretch="aspectFill" />
      <Show when={(props.fraction ?? 0) > 0}>
        <gridlayout class="progress-track" columns={`${props.fraction}*, ${1 - (props.fraction ?? 0)}*`}>
          <stacklayout class="progress-fill" col={0} />
        </gridlayout>
      </Show>
      <label class="card-label" text={props.title} />
      <Show when={props.subtitle}>
        <label class="small card-sub" text={props.subtitle ?? ""} />
      </Show>
    </stacklayout>
  );
}
