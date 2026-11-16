import { describe, expect, it } from "vitest";
import { sharedCommand, setupKey, type SharedSetup } from "./integration";
const base: SharedSetup = { method: "stable", scope: "user", path: "", ip: "192.168.31.81", port: 7823, token: "PREVIEW_ONLY", multiDevice: false };
describe("unified Claude Code setup", () => {
  it("switches only the endpoint while retaining scope and token", () => {
    const stable = sharedCommand(base);
    const direct = sharedCommand({ ...base, method: "direct" });
    expect(stable).toContain("http://127.0.0.1:7823/mcp");
    expect(direct).toContain("http://192.168.31.81:7823/mcp");
    for (const command of [stable, direct]) { expect(command).toContain("--scope user"); expect(command).toContain("PREVIEW_ONLY"); }
  });
  it("ignores changed VPN IP for stable connections and uses the confirmed port", () => {
    const confirmed = { ...base, port: 17823 };
    expect(sharedCommand({ ...confirmed, ip: "10.203.5.99" })).toBe(sharedCommand(confirmed));
    expect(sharedCommand(confirmed)).toContain("127.0.0.1:17823");
  });
  it("quotes project directories using the production path builder", () => {
    const command = sharedCommand({ ...base, scope: "project", path: "/home/demo/my project" });
    expect(command).toContain('cd "/home/demo/my project"');
    expect(command).toContain("--scope project");
  });
  it("detects configuration changes without treating irrelevant global paths as changes", () => {
    expect(setupKey("user", "", "a", false)).toBe(setupKey("user", "/ignored", "a", false));
    expect(setupKey("user", "", "a", false)).not.toBe(setupKey("project", "/work", "a", false));
    expect(setupKey("user", "", "a", false)).not.toBe(setupKey("user", "", "b", false));
  });
});
