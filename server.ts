import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { resolveSettings, SETTING_DESCRIPTORS } from "./configuration.js";
import { sweepIdleMachines } from "./idle-sweep.js";
import { createExeDevBackend } from "./providers/exe-dev/backend.js";
import { registerSandboxBackend } from "./providers/register.js";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const now = () => Date.now();
  const settings = bb.settings.define(SETTING_DESCRIPTORS);

  async function currentSettings() {
    return resolveSettings(await settings.get());
  }

  const backend = createExeDevBackend({
    currentSettings,
    serverUrl: async () => (await bb.sdk.system.config()).generalSettings.machineServerUrl,
  });
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

  const SWEEP_KEY = "sweep/last";
  bb.background.schedule("pause-idle-machines", "* * * * *", async () => {
    const stored = z.number().finite().safeParse(await bb.storage.kv.get<unknown>(SWEEP_KEY));
    await bb.storage.kv.set(SWEEP_KEY, now());
    const resolved = await currentSettings();
    if (!resolved.ok) return;
    await sweepIdleMachines({
      previousSweepAt: stored.success ? stored.data : null,
      providerId,
      idleMs: resolved.settings.idleMs ?? Number.POSITIVE_INFINITY,
      now,
      listHosts: () => bb.sdk.hosts.list(),
      listRunningThreads: () => bb.sdk.threads.listRunning(),
      getLastActivity: async (hostId) => {
        const value = z.number().finite().safeParse(await bb.storage.kv.get<unknown>(idleKey(hostId)));
        return value.success ? value.data : null;
      },
      bump: bumpIdle,
      suspend: async (hostId) => {
        await bb.sdk.hosts.experimental_suspend({ hostId });
      },
      pauseIfStillRunning: async (hostId) => {
        const resource = await bb.experimental_machines.getResource(hostId);
        if (resource === null) return false;
        return backend.pauseIfRunning(
          backend.parseResource(resource),
          AbortSignal.timeout(120_000),
          async () => (await bb.sdk.hosts.get({ hostId })).lifecycle.phase === "suspended",
        );
      },
      getPhase: async (hostId) => (await bb.sdk.hosts.get({ hostId })).lifecycle.phase,
      log: bb.log,
    });
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
