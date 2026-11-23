import { t } from "@tv/i18n";
import { href } from "../nav";

export default function NotFound() {
  return (
    <div class="empty" style={{ "padding-top": "calc(var(--topbar-h) + 64px)" }}>
      <h1 style={{ "margin-bottom": "12px" }}>{t("Nothing here")}</h1>
      <a class="btn primary" href={href("/")}>
        {t("Home")}
      </a>
    </div>
  );
}
