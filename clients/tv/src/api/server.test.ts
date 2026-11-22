import { describe, expect, it } from "vitest";
import { normalizeServer } from "./server";

describe("server address", () => {
  it("adds the scheme and Panda's default port", () => {
    expect(normalizeServer("192.168.1.20")).toBe("http://192.168.1.20:8096");
    expect(normalizeServer(" panda.local:9000/ ")).toBe("http://panda.local:9000");
    expect(normalizeServer("https://panda.example.com")).toBe("https://panda.example.com");
    expect(normalizeServer("http://10.0.0.5:8096/")).toBe("http://10.0.0.5:8096");
  });
});
