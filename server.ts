import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { resolveSettings, SETTING_DESCRIPTORS } from "./configuration.js";
import { errorMessage } from "./error-message.js";
import { createExeDevBackend } from "./providers/exe-dev/backend.js";
import { registerSandboxBackend } from "./providers/register.js";

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const now = () => Date.now();
  const settings = bb.settings.define(SETTING_DESCRIPTORS);

  async function currentSettings() {
    return resolveSettings(await settings.get());
  }

  const backend = createExeDevBackend({ currentSettings });
  const providerId = backend.definition.id;

  const idleKey = (hostId: string) => `idle/${hostId}`;
  async function bumpIdle(hostId: string): Promise<void> {
    await bb.storage.kv.set(idleKey(hostId), now());
  }
  async function bumpOwnedMachine(hostId: string): Promise<void> {
    const host = await bb.sdk.hosts.get({ hostId });
    if (host.machineProviderId === providerId && host.lifecycle.phase === "active") {
      await bumpIdle(hostId);
    }
  }

  bb.events.on("experimental_thread.events", async ({ thread }) => {
    if (thread.status !== "starting" && thread.status !== "active") return;
    if (thread.environmentId === null) {
      for (const host of await bb.sdk.hosts.list()) {
        if (host.machineProviderId !== providerId || host.lifecycle.phase !== "active") continue;
        const resource = await bb.experimental_machines.getResource(host.id);
        if (resource !== null && backend.allocationKey(backend.parseResource(resource)) === thread.id) {
          await bumpIdle(host.id);
          return;
        }
      }
      return;
    }
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    await bumpOwnedMachine(environment.hostId);
  });

  bb.events.on("experimental_terminal.input", async ({ terminal }) => {
    await bumpOwnedMachine(terminal.hostId);
  });

  bb.background.schedule("pause-idle-machines", "* * * * *", async () => {
    const resolved = await currentSettings();
    if (!resolved.ok || resolved.settings.idleMs === null) return;
    const idleMs = resolved.settings.idleMs;
    for (const host of await bb.sdk.hosts.list()) {
      if (host.machineProviderId !== providerId || host.lifecycle.phase !== "active") continue;
      try {
        const stored = await bb.storage.kv.get<unknown>(idleKey(host.id));
        const lastActivity = stored === undefined ? null : z.number().finite().parse(stored);
        if (lastActivity === null) {
          await bumpIdle(host.id);
          continue;
        }
        if (now() < lastActivity + idleMs) continue;
        await bb.sdk.hosts.experimental_suspend({ hostId: host.id });
        bb.log.info(`Paused idle exe.dev machine ${host.id}`);
      } catch (error) {
        if (hasErrorCode(error, "machine_busy")) continue;
        const current = await bb.sdk.hosts.get({ hostId: host.id }).catch(() => null);
        const phase = current?.lifecycle.phase;
        if (phase === "suspending" || phase === "suspended" || phase === "resuming") continue;
        bb.log.warn(`Idle pause failed for ${host.id}: ${errorMessage(error)}`);
      }
    }
  });

  registerSandboxBackend(bb, backend, { now, onConnected: bumpIdle });

  const loaded = await currentSettings();
  if (!loaded.ok) {
    bb.status.needsConfiguration(loaded.message);
    return;
  }
  const status = await backend.connectionStatus();
  if (status.available) bb.log.info(status.message);
  else bb.log.warn(`exe.dev connection check failed: ${status.message}`);
}
