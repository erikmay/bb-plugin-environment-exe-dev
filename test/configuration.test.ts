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
        tailnet: null,
        idleMs: 15 * 60_000,
        cpu: null,
        memory: null,
        disk: null,
        image: null,
      },
    });
  });

  it("needs a complete OAuth client and at least one tag", () => {
    const oauth = resolveSettings({
      ...base,
      tailscaleOAuthClientId: "kid",
      tailscaleOAuthClientSecret: "tskey-client-abc",
      tailscaleTags: "tag:bb-sandbox, tag:ci",
    });
    expect(oauth.ok && oauth.settings.tailnet).toEqual({
      clientId: "kid",
      clientSecret: "tskey-client-abc",
      tags: ["tag:bb-sandbox", "tag:ci"],
    });
    const complete = { ...base, tailscaleOAuthClientId: "kid", tailscaleOAuthClientSecret: "tskey-client-abc" };
    expect(resolveSettings({ ...complete, tailscaleTags: " " }).ok).toBe(false);
    expect(resolveSettings({ ...complete, tailscaleOAuthClientSecret: "tskey-auth-abc" }).ok).toBe(false);
    expect(resolveSettings({ ...base, tailscaleOAuthClientId: "kid" }).ok).toBe(false);
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
