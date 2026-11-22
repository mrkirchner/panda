import { describe, expect, it } from "vitest";
import { setLang, t, tn, tServer } from "./i18n";

describe("i18n", () => {
  it("translates to Spanish and fills placeholders", () => {
    setLang("es");
    expect(t("Continue Watching")).toBe("Seguir viendo");
    expect(t("Downloading {p}%", { p: 42 })).toBe("Descargando 42%");
    expect(tn(1, "{n} season", "{n} seasons")).toBe("1 temporada");
    expect(tn(3, "{n} season", "{n} seasons")).toBe("3 temporadas");
    expect(tServer("Popular on Netflix")).toBe("Popular en Netflix");
    expect(tServer("Trending this week")).toBe("Tendencias de la semana");
  });
  it("falls back to English for anything untranslated, and English is the text itself", () => {
    setLang("es");
    expect(t("Something new")).toBe("Something new");
    setLang("en");
    expect(t("Continue Watching")).toBe("Continue Watching");
    expect(t("Popular on {name}", { name: "Max" })).toBe("Popular on Max");
  });
});
