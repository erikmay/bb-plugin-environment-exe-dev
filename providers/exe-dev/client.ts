import { randomUUID } from "node:crypto";
import { ExeAPIError, quote, type VM } from "@exedev/sdk";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderProgress } from "@get-bb/plugin-sdk/machine-provider";

const STDIN_DIR = ".bb-exe-dev";
const KILL_GRACE_SECONDS = 10;

const SESSION_ENV = `uid=$(id -u)
if [ -d "/run/user/$uid" ]; then
  export XDG_RUNTIME_DIR="/run/user/$uid"
  [ -S "$XDG_RUNTIME_DIR/bus" ] && export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi
export PATH="/usr/local/bin:$PATH"`;

const PREREQUISITES_SCRIPT = `set -eu
${SESSION_ENV}
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
  echo "Installing Node.js 24 for the bb daemon"
  case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; *) arch=x64 ;; esac
  dist=https://nodejs.org/dist/latest-v24.x
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 3 "$dist/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file=$(awk -v f="linux-$arch.tar.xz" '$2 ~ f"$" { print $2 }' "$tmp/SHASUMS256.txt")
  curl -fsSL --retry 3 "$dist/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\\$" SHASUMS256.txt | sha256sum -c --quiet)
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
  report.step("Preparing the exe.dev VM…");
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
      const result = await vm.ssh(script, {
        signal,
        capture: false,
        onStdout: onOutput,
        onStderr: onOutput,
      });
      return { exitCode: result.exitCode };
    },
  };
}
