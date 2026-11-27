import { describe, expect, it } from "vitest";
import { resolveSettings, type RawSettings } from "../configuration.js";

const base: RawSettings = {
  apiToken: "token",
  idleMinutes: 15,
  cpu: 0,
  memory: "",
  disk: "",
  image: "",
};

describe("resolveSettings", () => {
  it("requires an API token", () => {
    expect(resolveSettings({ ...base, apiToken: "  " })).toEqual({
      ok: false,
      message: "Set apiToken in the plugin's settings.",
    });
  });

  it("maps defaults to exe.dev's own defaults", () => {
    expect(resolveSettings(base)).toEqual({
      ok: true,
      settings: {
        apiToken: "token",
        tailscaleAuthKey: null,
        idleMs: 15 * 60_000,
        cpu: null,
        memory: null,
        disk: null,
        image: null,
      },
    });
  });

  it("accepts a Tailscale auth key and rejects anything else", () => {
    const withKey = resolveSettings({ ...base, tailscaleAuthKey: " tskey-auth-abc " });
    expect(withKey.ok && withKey.settings.tailscaleAuthKey).toBe("tskey-auth-abc");
    expect(resolveSettings({ ...base, tailscaleAuthKey: "abc" })).toEqual({
      ok: false,
      message: "tailscaleAuthKey must be a Tailscale auth key (tskey-…).",
    });
  });

  it("turns idleMinutes 0 into no automatic pause", () => {
    const resolved = resolveSettings({ ...base, idleMinutes: 0 });
    expect(resolved.ok && resolved.settings.idleMs).toBeNull();
  });

  it.each([-1, 1.5, 7 * 24 * 60 + 1])("rejects idleMinutes %s", (idleMinutes) => {
    expect(resolveSettings({ ...base, idleMinutes }).ok).toBe(false);
  });

  it("normalizes sizes and rejects malformed ones", () => {
    const resolved = resolveSettings({ ...base, cpu: 4, memory: "8 GB", disk: "50G" });
    expect(resolved.ok && resolved.settings).toMatchObject({ cpu: 4, memory: "8GB", disk: "50G" });
    expect(resolveSettings({ ...base, memory: "lots" }).ok).toBe(false);
    expect(resolveSettings({ ...base, cpu: 65 }).ok).toBe(false);
  });
});
