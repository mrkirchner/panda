import { describe, expect, it } from "vitest";
import { subnetHosts } from "./subnet";

describe("subnetHosts", () => {
  it("lists the rest of a home network", () => {
    const hosts = subnetHosts("192.168.1.20");
    expect(hosts).toHaveLength(253);
    expect(hosts[0]).toBe("192.168.1.1");
    expect(hosts).not.toContain("192.168.1.20");
    expect(hosts[hosts.length - 1]).toBe("192.168.1.254");
  });
  it("skips what isn't an IPv4 address", () => {
    expect(subnetHosts("fe80::1")).toEqual([]);
    expect(subnetHosts("")).toEqual([]);
  });
});
