import type { TailnetSettings } from "../../configuration.js";

const API = "https://api.tailscale.com/api/v2";
const KEY_EXPIRY_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 30_000;

export type Fetch = typeof fetch;

/**
 * A fresh auth key for one join: single use, ephemeral, pre-approved, tagged,
 * valid for five minutes. A VM can read whatever reaches it (an agent runs
 * there with full permissions), so only a key that the join spends and that
 * expires minutes later is worth sending.
 */
export async function authKeyForJoin(
  tailnet: TailnetSettings,
  options: { fetch?: Fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const fetchImpl = options.fetch ?? fetch;
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ]);
  const tokenResponse = await fetchImpl(`${API}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: tailnet.clientId,
      client_secret: tailnet.clientSecret,
      grant_type: "client_credentials",
    }),
    signal,
  });
  if (!tokenResponse.ok) {
    throw new Error(
      `Tailscale refused the OAuth client (HTTP ${tokenResponse.status}). Check tailscaleOAuthClientId and tailscaleOAuthClientSecret.`,
    );
  }
  const { access_token: accessToken } = (await tokenResponse.json()) as { access_token?: unknown };
  if (typeof accessToken !== "string") throw new Error("Tailscale returned no OAuth access token.");
  const keyResponse = await fetchImpl(`${API}/tailnet/-/keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      capabilities: {
        devices: {
          create: { reusable: false, ephemeral: true, preauthorized: true, tags: tailnet.tags },
        },
      },
      expirySeconds: KEY_EXPIRY_SECONDS,
      // Tailscale allows only letters, digits, spaces and dashes here.
      description: "bb exe-dev VM",
    }),
    signal,
  });
  if (!keyResponse.ok) {
    const detail = await apiMessage(keyResponse);
    throw new Error(
      `Tailscale did not create an auth key (HTTP ${keyResponse.status}${detail}). The OAuth client needs the auth_keys scope and must own ${tailnet.tags.join(", ")}.`,
    );
  }
  const { key } = (await keyResponse.json()) as { key?: unknown };
  if (typeof key !== "string" || !key.startsWith("tskey-auth-")) {
    throw new Error("Tailscale returned no auth key.");
  }
  return key;
}

/** Tailscale's own error message, e.g. ": invalid description" (never secrets). */
async function apiMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" ? `: ${body.message.slice(0, 200)}` : "";
  } catch {
    return "";
  }
}
