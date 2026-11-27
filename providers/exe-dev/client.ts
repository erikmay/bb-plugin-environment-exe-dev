import { randomUUID } from "node:crypto";
import { ExeAPIError, quote, type VM } from "@exedev/sdk";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderProgress } from "@get-bb/plugin-sdk/machine-provider";

const STDIN_DIR = ".bb-exe-dev";
const KILL_GRACE_SECONDS = 10;

export const NODE_VERSION = "24.22.3";
export const NODE_SHA256: Readonly<Record<"x64" | "arm64", string>> = {
  x64: "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb",
  arm64: "6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c",
};

const SESSION_ENV = `uid=$(id -u)
if [ -d "/run/user/$uid" ]; then
  export XDG_RUNTIME_DIR="/run/user/$uid"
  [ -S "$XDG_RUNTIME_DIR/bus" ] && export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi
export PATH="/usr/local/bin:$PATH"
export NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false`;

const PREREQUISITES_SCRIPT = `set -eu
${SESSION_ENV}
# Secret files (bootstrap stdin, auth keys) live here only while a command
# runs; remove any left behind by an interrupted call.
mkdir -p "$HOME/${STDIN_DIR}"
chmod 700 "$HOME/${STDIN_DIR}"
find "$HOME/${STDIN_DIR}" -type f -mmin +15 -delete 2>/dev/null || true
need_node=1
if command -v node >/dev/null 2>&1; then
  version=$(node -p 'process.versions.node')
  major=\${version%%.*}
  rest=\${version#*.}
  minor=\${rest%%.*}
  if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 19 ]; }; then
    need_node=0
  fi
fi
if [ "$need_node" = 1 ]; then
  case "$(uname -m)" in
    x86_64|amd64) arch=x64; sha=${NODE_SHA256.x64} ;;
    aarch64|arm64) arch=arm64; sha=${NODE_SHA256.arm64} ;;
    *) echo "Unsupported CPU architecture $(uname -m) for the bb daemon" >&2; exit 1 ;;
  esac
  file="node-v${NODE_VERSION}-linux-$arch.tar.xz"
  echo "Installing Node.js ${NODE_VERSION} for the bb daemon"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/$file" -o "$tmp/$file"
  echo "$sha  $tmp/$file" | sha256sum -c --quiet
  sudo tar -xJf "$tmp/$file" -C /usr/local --strip-components=1 --no-same-owner \\
    --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'
fi
user=$(id -un)
if [ ! -e "/var/lib/systemd/linger/$user" ]; then
  echo "Enabling a persistent systemd user session for $user"
  sudo loginctl enable-linger "$user"
fi
for _ in $(seq 30); do
  [ -S "/run/user/$(id -u)/bus" ] && break
  sleep 1
done
echo "node $(node --version) ready"`;

export async function findVm(vm: VM, signal: AbortSignal): Promise<VM | null> {
  try {
    await vm.refresh({ signal });
    return vm;
  } catch (error) {
    if (error instanceof ExeAPIError && error.status === 404) return null;
    throw error;
  }
}

export function isPaused(vm: VM): boolean {
  return vm.info.status === "paused";
}

export async function ensurePrerequisites(
  vm: VM,
  report: PluginMachineProviderProgress,
  signal: AbortSignal,
): Promise<void> {
  report.step(`Preparing exe.dev VM ${vm.name}…`);
  const result = await vm.ssh(PREREQUISITES_SCRIPT, {
    signal,
    capture: false,
    onStdout: (chunk) => report.log(chunk),
    onStderr: (chunk) => report.log(chunk),
  });
  if (result.exitCode !== 0) {
    throw new Error(`Preparing the exe.dev VM failed (exit ${result.exitCode}).`);
  }
}

// Prints "online" when tailscaled runs, is connected and reaches the bb
// server; otherwise the backend state (NeedsLogin, Starting, ...) or "none".
const TAILNET_FUNCS = `state() {
  sudo tailscale status --json 2>/dev/null | python3 -c 'import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("none"); sys.exit()
s = d.get("BackendState") or "none"
print("online" if s == "Running" and (d.get("Self") or {}).get("Online") else s)' 2>/dev/null || echo none
}
reachable() { [ -z "$url" ] || curl -fsS -o /dev/null --max-time 10 "$url"; }`;

export interface TailnetJoin {
  /** Mints or returns the auth key; called only when the VM must (re)join. */
  authKey: () => Promise<string>;
  tags: readonly string[];
  /** The bb server address the VM must reach, or null to skip the check. */
  serverUrl: string | null;
}

/**
 * Makes sure the VM is on the tailnet and reaches the bb server before bb
 * bootstraps its daemon. A first call installs Tailscale and only reports
 * the state; the auth key is minted and sent only when a join is needed (a
 * new VM, or one whose ephemeral node expired while it was paused, which
 * tailscaled may still believe is Running right after a restore, so the
 * server's reachability decides). The key travels in a file that the join
 * script deletes, and the join is verified before returning.
 */
export async function ensureTailnet(
  vm: VM,
  join: TailnetJoin,
  report: PluginMachineProviderProgress,
  signal: AbortSignal,
): Promise<void> {
  report.step(`Connecting exe.dev VM ${vm.name} to the tailnet…`);
  const url = `url=${quote(join.serverUrl ?? "")}`;
  let output = "";
  const probe = await vm.ssh(
    `set -eu
${url}
if ! command -v tailscale >/dev/null 2>&1; then
  echo "Installing Tailscale"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 3 https://tailscale.com/install.sh -o "$tmp/install.sh"
  sudo sh "$tmp/install.sh" >/dev/null
fi
sudo systemctl enable --now tailscaled >/dev/null 2>&1 || true
${TAILNET_FUNCS}
result=join
for _ in $(seq 20); do
  s=$(state)
  case "$s" in
    online) if reachable; then result=online; fi; break ;;
    NeedsLogin|NeedsMachineAuth|Stopped|NoState) break ;;
  esac
  sleep 1
done
echo "STATE=$result"`,
    {
      signal,
      capture: false,
      onStdout: (chunk) => {
        output += chunk;
        report.log(chunk.replace(/^STATE=.*$/gmu, ""));
      },
      onStderr: (chunk) => report.log(chunk),
    },
  );
  if (probe.exitCode !== 0) {
    throw new Error(`Installing or starting Tailscale on the VM failed (exit ${probe.exitCode}).`);
  }
  if (/^STATE=online$/mu.test(output)) {
    report.log("Already on the tailnet\n");
    return;
  }
  const keyPath = `${STDIN_DIR}/tailscale-${randomUUID()}`;
  await vm.writeFile(keyPath, await join.authKey(), { mode: 0o600, signal });
  try {
    const result = await vm.ssh(
      `set -eu
${url}
f="$HOME/${keyPath}"
trap 'rm -f "$f"' EXIT
sudo tailscale up --reset --force-reauth --auth-key="file:$f" --hostname=${quote(vm.name)} \\
  --advertise-tags=${quote(join.tags.join(","))} --shields-up --accept-routes=false --timeout=90s
rm -f "$f"
${TAILNET_FUNCS}
for _ in $(seq 30); do
  if [ "$(state)" = online ] && reachable; then
    echo "tailnet address $(tailscale ip -4 | head -n 1)"
    exit 0
  fi
  sleep 1
done
echo "The VM joined the tailnet but cannot reach the bb server\${url:+ at $url}" >&2
exit 3`,
      {
        signal,
        capture: false,
        onStdout: (chunk) => report.log(chunk),
        onStderr: (chunk) => report.log(chunk),
      },
    );
    if (result.exitCode === 3) {
      throw new Error("The VM joined the tailnet but cannot reach the bb server. Check the tailnet policy for the VM's tags.");
    }
    if (result.exitCode !== 0) {
      throw new Error(`Joining the tailnet failed (exit ${result.exitCode}). Check the Tailscale settings of the plugin.`);
    }
  } finally {
    await vm.ssh(`rm -f "$HOME/${keyPath}"`, { signal: AbortSignal.timeout(15_000), capture: false }).catch(() => {});
  }
}

const LEAVE_TAILNET_TIMEOUT_MS = 20_000;

/**
 * Best effort before a VM is deleted: `tailscale logout` removes its
 * ephemeral node from the tailnet at once instead of 30-60 minutes later.
 * Skipped for paused VMs (their node is already offline and expires on its
 * own); failures never block the deletion.
 */
export async function leaveTailnet(vm: VM, signal: AbortSignal): Promise<void> {
  if (isPaused(vm)) return;
  try {
    await vm.ssh("if command -v tailscale >/dev/null 2>&1; then sudo tailscale logout >/dev/null 2>&1 || true; fi", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(LEAVE_TAILNET_TIMEOUT_MS)]),
      capture: false,
    });
  } catch {
    // The VM is about to be deleted; its node expires on its own.
  }
}

export function createExeDevExecutor(vm: VM): MachineExecutor {
  return {
    async exec({ command, stdin, timeoutMs, signal, onOutput }) {
      const stdinPath = `${STDIN_DIR}/stdin-${randomUUID()}`;
      await vm.writeFile(stdinPath, stdin, { mode: 0o600, signal });
      const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      const script = `${SESSION_ENV}
f="$HOME/${stdinPath}"
trap 'rm -f "$f"' EXIT
timeout -k ${KILL_GRACE_SECONDS} ${seconds} ${command.map(quote).join(" ")} < "$f"`;
      try {
        const result = await vm.ssh(script, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs + (KILL_GRACE_SECONDS + 30) * 1000)]),
          capture: false,
          onStdout: onOutput,
          onStderr: onOutput,
        });
        return { exitCode: result.exitCode };
      } catch (error) {
        // bb shows only a generic message for a thrown executor error.
        onOutput(`exe.dev: ${error instanceof Error ? error.message : String(error)}\n`);
        throw error;
      }
    },
  };
}
