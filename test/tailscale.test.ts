import { describe, expect, it, vi } from "vitest";
import { authKeyForJoin } from "../providers/exe-dev/tailscale.js";

const oauth = { clientId: "kid", clientSecret: "tskey-client-supersecret", tags: ["tag:bb-sandbox"] } as const;

describe("authKeyForJoin", () => {
  it("explains a refused OAuth client without echoing the secret", async () => {
    const fakeFetch = vi.fn(async () => new Response("denied", { status: 401 }));
    const error = await authKeyForJoin(oauth, { fetch: fakeFetch as unknown as typeof fetch }).catch((e: Error) => e);
    expect(String(error)).toMatch(/refused the OAuth client \(HTTP 401\)/);
    expect(String(error)).not.toContain("supersecret");
  });

  it("names the scope and tags when Tailscale refuses to create a key", async () => {
    const fakeFetch = vi.fn(async (url: string) =>
      url.endsWith("/oauth/token")
        ? new Response(JSON.stringify({ access_token: "at" }), { status: 200 })
        : new Response(JSON.stringify({ message: "tag not permitted" }), { status: 403 }),
    );
    await expect(authKeyForJoin(oauth, { fetch: fakeFetch as unknown as typeof fetch })).rejects.toThrow(
      /HTTP 403: tag not permitted\).*auth_keys scope and must own tag:bb-sandbox/,
    );
  });
});
