import { describe, expect, it } from "vitest";
import { TIERS, tierFor } from "./tier";

const LG_2019 =
  "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.34 Safari/537.36 WebAppManager";
const LG_2022 =
  "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager";
const TIZEN_2018 =
  "Mozilla/5.0 (SMART-TV; LINUX; Tizen 4.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 TV Safari/537.36";
const TIZEN_2022 =
  "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36";
const FIRE_LITE =
  "Mozilla/5.0 (Linux; Android 9; AFTSSS Build/PS7633) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const FIRE_CUBE =
  "Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7633) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

describe("performance tiers", () => {
  it("puts 2020-and-earlier LG and Samsung TVs on the low tier", () => {
    expect(tierFor(LG_2019)).toBe("low");
    expect(tierFor(LG_2022)).toBe("high");
    expect(tierFor(TIZEN_2018)).toBe("low");
    expect(tierFor(TIZEN_2022)).toBe("high");
  });
  it("puts entry Fire TV sticks and small devices on the low tier", () => {
    expect(tierFor(FIRE_LITE)).toBe("low");
    expect(tierFor(FIRE_CUBE)).toBe("high");
    expect(tierFor(DESKTOP, 2)).toBe("low");
    expect(tierFor(DESKTOP, 8, 2)).toBe("low");
    expect(tierFor(DESKTOP, 8, 8)).toBe("high");
  });
  it("makes the low tier lighter in every setting", () => {
    const { low, high } = TIERS;
    expect(low.resolution).toBe(720);
    expect(low.textureMemory.criticalThreshold).toBeLessThan(high.textureMemory.criticalThreshold);
    expect(low.animations).toBe(false);
    expect(low.listBuffer).toBeLessThan(high.listBuffer);
    expect(low.heroAutoAdvance).toBe(false);
    expect(low.previews).toBe(false);
  });
});
