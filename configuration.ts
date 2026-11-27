export const SETTING_DESCRIPTORS = {
  apiToken: {
    type: "string",
    secret: true,
    label: "exe.dev API token",
    description:
      "A tag-scoped exe.dev API token: ssh exe.dev ssh-key generate-api-key --tag=bb --cmds='whoami,ls,new,rm,pause,resume,ssh,stat' --json",
  },
  tailscaleOAuthClientId: {
    type: "string",
    label: "Tailscale OAuth client ID",
    description:
      "Optional, recommended for a bb server reachable only over Tailscale. With the secret below, every VM joins your tailnet with its own single-use, five-minute auth key. The client needs the auth_keys scope and must own the tags below.",
    default: "",
  },
  tailscaleOAuthClientSecret: {
    type: "string",
    secret: true,
    label: "Tailscale OAuth client secret",
    description: "The secret of the OAuth client above (tskey-client-…).",
    default: "",
  },
  tailscaleTags: {
    type: "string",
    label: "Tailscale tags",
    description:
      "Comma-separated tags every VM joins with. Your tailnet policy should let them reach only the bb server.",
    default: "tag:bb-sandbox",
  },
  idleMinutes: {
    type: "number",
    label: "Pause after idle (minutes)",
    description:
      "Pause an idle VM after this long (RAM and disk are kept). Use 0 to never pause automatically.",
    default: 15,
  },
  cpu: {
    type: "number",
    label: "CPUs per VM",
    description: "Number of CPUs for new VMs. 0 uses exe.dev's default.",
    default: 0,
  },
  memory: {
    type: "string",
    label: "Memory per VM",
    description: "Memory for new VMs, e.g. 8GB. Empty uses exe.dev's default.",
    default: "",
  },
  disk: {
    type: "string",
    label: "Disk per VM",
    description: "Disk size for new VMs, e.g. 50GB. Empty uses exe.dev's default.",
    default: "",
  },
  image: {
    type: "string",
    label: "Container image",
    description:
      "Image for new VMs. Empty uses exeuntu, which ships Claude Code, Codex, git and build tools.",
    default: "",
  },
} as const;

export interface TailnetSettings {
  clientId: string;
  clientSecret: string;
  tags: readonly string[];
}

export interface ResolvedSettings {
  apiToken: string;
  tailnet: TailnetSettings | null;
  idleMs: number | null;
  cpu: number | null;
  memory: string | null;
  disk: string | null;
  image: string | null;
}

export type SettingsResolution =
  | { ok: true; settings: ResolvedSettings }
  | { ok: false; message: string };

export interface RawSettings {
  apiToken: string | undefined;
  tailscaleOAuthClientId?: string | undefined;
  tailscaleOAuthClientSecret?: string | undefined;
  tailscaleTags?: string | undefined;
  idleMinutes: number;
  cpu: number;
  memory: string;
  disk: string;
  image: string;
}

const MAX_IDLE_MINUTES = 7 * 24 * 60;
const SIZE_PATTERN = /^\d+(\.\d+)?\s*(G|GB|GiB|M|MB|MiB)?$/iu;

function optionalSize(
  name: string,
  value: string,
): { ok: true; value: string | null } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (!SIZE_PATTERN.test(trimmed)) {
    return { ok: false, message: `${name} must look like 8GB, not "${trimmed}".` };
  }
  return { ok: true, value: trimmed.replace(/\s+/gu, "") };
}

export function resolveSettings(raw: RawSettings): SettingsResolution {
  const apiToken = (raw.apiToken ?? "").trim();
  if (apiToken.length === 0) {
    return { ok: false, message: "Set apiToken in the plugin's settings." };
  }
  if (
    !Number.isInteger(raw.idleMinutes) ||
    raw.idleMinutes < 0 ||
    raw.idleMinutes > MAX_IDLE_MINUTES
  ) {
    return {
      ok: false,
      message: `idleMinutes must be a whole number between 0 and ${MAX_IDLE_MINUTES}, not ${raw.idleMinutes}.`,
    };
  }
  if (!Number.isInteger(raw.cpu) || raw.cpu < 0 || raw.cpu > 64) {
    return { ok: false, message: `cpu must be a whole number between 0 and 64, not ${raw.cpu}.` };
  }
  const memory = optionalSize("memory", raw.memory);
  if (!memory.ok) return memory;
  const disk = optionalSize("disk", raw.disk);
  if (!disk.ok) return disk;
  const image = raw.image.trim();
  const tailnet = resolveTailnet(raw);
  if (!tailnet.ok) return tailnet;
  return {
    ok: true,
    settings: {
      apiToken,
      tailnet: tailnet.value,
      idleMs: raw.idleMinutes === 0 ? null : raw.idleMinutes * 60_000,
      cpu: raw.cpu === 0 ? null : raw.cpu,
      memory: memory.value,
      disk: disk.value,
      image: image.length === 0 ? null : image,
    },
  };
}

const TAG_PATTERN = /^tag:[A-Za-z0-9][A-Za-z0-9-]*$/u;

function resolveTailnet(
  raw: RawSettings,
): { ok: true; value: TailnetSettings | null } | { ok: false; message: string } {
  const clientId = (raw.tailscaleOAuthClientId ?? "").trim();
  const clientSecret = (raw.tailscaleOAuthClientSecret ?? "").trim();
  if (clientId.length === 0 && clientSecret.length === 0) return { ok: true, value: null };
  if (clientId.length === 0 || clientSecret.length === 0) {
    return { ok: false, message: "Set both tailscaleOAuthClientId and tailscaleOAuthClientSecret." };
  }
  if (!clientSecret.startsWith("tskey-client-")) {
    return { ok: false, message: "tailscaleOAuthClientSecret must be an OAuth client secret (tskey-client-…)." };
  }
  const tags = (raw.tailscaleTags ?? "tag:bb-sandbox")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (tags.length === 0 || !tags.every((tag) => TAG_PATTERN.test(tag))) {
    return {
      ok: false,
      message: "tailscaleTags must list at least one tag like tag:bb-sandbox; untagged VMs would act as you on the tailnet.",
    };
  }
  return { ok: true, value: { clientId, clientSecret, tags } };
}
