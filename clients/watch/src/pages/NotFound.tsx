import { t } from "@tv/i18n";
import { href } from "../nav";

export default function NotFound() {
  return (
    <div class="empty page-top stack">
      <h1>{t("Nothing here")}</h1>
      <a class="btn primary" href={href("/")}>
        {t("Home")}
      </a>
    </div>
  );
}
