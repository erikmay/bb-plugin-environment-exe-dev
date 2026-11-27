import exedev, { ExeAPIError, type ExedevClient, type NewOptions, type VM } from "@exedev/sdk";
import type { ResolvedSettings, SettingsResolution } from "../../configuration.js";
import type { SandboxBackend } from "../sandbox-backend.js";
import {
  createExeDevExecutor,
  ensurePrerequisites,
  ensureTailnet,
  leaveTailnet,
  findVm,
  isPaused,
} from "./client.js";
import { authKeyForJoin, type Fetch } from "./tailscale.js";
import {
  readExeDevMachineResource,
  vmNameForKey,
  type ExeDevMachineResource,
} from "./resource.js";

export const PROVIDER_ID = "exe-dev";
const USER_AGENT = "bb-plugin-environment-exe-dev";

export interface ExeDevConnectionStatus {
  available: boolean;
  message: string;
}

export interface ExeDevBackend extends SandboxBackend<ExeDevMachineResource> {
  connectionStatus(): Promise<ExeDevConnectionStatus>;
  /**
   * Pauses the VM if it runs although bb records the machine as suspended
   * (a failed pause or resume). Returns true when it had to pause.
   */
  pauseIfRunning(
    resource: ExeDevMachineResource,
    signal: AbortSignal,
    stillWanted?: () => Promise<boolean>,
  ): Promise<boolean>;
}

const API_TIMEOUT_MS = 30_000;
const REMOVE_TIMEOUT_MS = 120_000;
const BOOT_TIMEOUT_MS = 180_000;
const PAUSE_RETRY_DELAYS_MS = [2_000, 5_000];

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal === undefined ? AbortSignal.timeout(ms) : AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export type ExeDevClientFactory = (token: string) => ExedevClient;

export const createExeDevClient: ExeDevClientFactory = (token) =>
  exedev({ token, userAgent: USER_AGENT });

export function createExeDevBackend(deps: {
  currentSettings: () => Promise<SettingsResolution>;
  clientFactory?: ExeDevClientFactory;
  /** The address machines use to reach the bb server, checked after a tailnet join. */
  serverUrl?: () => Promise<string | null>;
  fetch?: Fetch;
}): ExeDevBackend {
  const clientFactory = deps.clientFactory ?? createExeDevClient;
  let cached: { token: string; client: ExedevClient; email: string | null } | null = null;

  async function requireSettings(): Promise<ResolvedSettings> {
    const resolved = await deps.currentSettings();
    if (!resolved.ok) throw new Error(resolved.message);
    return resolved.settings;
  }

  async function connect(): Promise<{ client: ExedevClient; email: string }> {
    const settings = await requireSettings();
    if (cached?.token !== settings.apiToken) {
      cached = {
        token: settings.apiToken,
        client: clientFactory(settings.apiToken),
        email: null,
      };
    }
    const current = cached;
    if (current.email === null) {
      const whoami = await current.client.whoami({ signal: AbortSignal.timeout(API_TIMEOUT_MS) });
      current.email = whoami.email;
    }
    return { client: current.client, email: current.email };
  }

  async function pinnedVm(resource: ExeDevMachineResource, signal: AbortSignal): Promise<VM | null> {
    const { client, email } = await connect();
    if (email !== resource.accountEmail) {
      throw new Error(
        `This machine belongs to the exe.dev account ${resource.accountEmail}; the configured token is for ${email}.`,
      );
    }
    return findVm(client.vm(resource.vmName), signal);
  }

  async function newVm(
    client: ExedevClient,
    name: string,
    key: string,
    settings: ResolvedSettings,
    signal: AbortSignal,
  ): Promise<VM> {
    const options: NewOptions = {
      name,
      timeoutMs: BOOT_TIMEOUT_MS,
      comment: `bb machine ${key}`.slice(0, 200),
      "no-email": true,
      signal,
    };
    if (settings.cpu !== null) options.cpu = settings.cpu;
    if (settings.memory !== null) options.memory = settings.memory;
    if (settings.disk !== null) options.disk = settings.disk;
    if (settings.image !== null) options.image = settings.image;
    try {
      return await client.new(options);
    } catch (error) {
      if (error instanceof ExeAPIError && error.status !== 404) {
        const existing = await findVm(client.vm(name), signal);
        if (existing !== null) return existing;
      }
      throw error;
    }
  }

  async function deleteVm(vm: VM | null, signal: AbortSignal): Promise<void> {
    if (vm === null) return;
    await leaveTailnet(vm, signal);
    try {
      await vm.rm({ signal: withTimeout(signal, REMOVE_TIMEOUT_MS) });
    } catch (error) {
      if (error instanceof ExeAPIError && error.status === 404) return;
      throw error;
    }
  }

  async function joinTailnet(
    vm: VM,
    settings: ResolvedSettings,
    report: Parameters<typeof ensureTailnet>[2],
    signal: AbortSignal,
  ): Promise<void> {
    const tailnet = settings.tailnet;
    if (tailnet === null) return;
    const serverUrl = deps.serverUrl === undefined ? null : await deps.serverUrl().catch(() => null);
    await ensureTailnet(
      vm,
      {
        authKey: () => authKeyForJoin(tailnet, { fetch: deps.fetch, signal }),
        tags: tailnet.tags,
        serverUrl,
      },
      report,
      signal,
    );
  }

  async function pauseWithRetry(vm: VM, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await vm.pause({ signal: withTimeout(signal, API_TIMEOUT_MS * 2) });
        return;
      } catch (error) {
        const delay = PAUSE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || signal.aborted) throw error;
        await sleep(delay, signal);
        await vm.refresh({ signal: withTimeout(signal, API_TIMEOUT_MS) }).catch(() => {});
        if (isPaused(vm)) return;
      }
    }
  }

  return {
    definition: {
      id: PROVIDER_ID,
      displayName: "exe.dev VM",
      description: "Create a VM in your exe.dev account.",
      environmentDescription: "Create a project checkout in a new exe.dev VM.",
      projectlessEnvironmentDescription: "Create a personal workspace in a new exe.dev VM.",
      runtimeName: "exe.dev",
      icon: "./assets/exe-dev.svg",
      ephemeral: true,
    },
    parseResource: readExeDevMachineResource,
    allocationKey(resource) {
      return resource.key;
    },
    async availability() {
      const resolved = await deps.currentSettings();
      return resolved.ok
        ? { status: "available" }
        : { status: "setup-required", message: resolved.message };
    },
    async create(context) {
      const settings = await requireSettings();
      const { client, email } = await connect();
      context.signal.throwIfAborted();
      const name = vmNameForKey(context.key);
      let vm = await findVm(client.vm(name), context.signal);
      if (vm === null) {
        vm = await newVm(client, name, context.key, settings, context.signal);
      } else {
        context.report.step(`Reusing exe.dev VM ${vm.name}…`);
      }
      const resource: ExeDevMachineResource = {
        key: context.key,
        vmName: vm.name,
        accountEmail: email,
      };
      await context.checkpoint(resource);
      context.signal.throwIfAborted();
      if (isPaused(vm)) {
        context.report.step(`Resuming exe.dev VM ${vm.name}…`);
        await vm.resume({ signal: context.signal, timeoutMs: BOOT_TIMEOUT_MS });
      }
      await ensurePrerequisites(vm, context.report, context.signal);
      await joinTailnet(vm, settings, context.report, context.signal);
      return { resource, executor: createExeDevExecutor(vm) };
    },
    async reconcileCleanup(context) {
      const { client } = await connect();
      context.signal.throwIfAborted();
      await deleteVm(await findVm(client.vm(vmNameForKey(context.key)), context.signal), context.signal);
    },
    async suspend(context) {
      const vm = await pinnedVm(context.resource, context.signal);
      if (vm === null) {
        throw new Error(`exe.dev VM ${context.resource.vmName} no longer exists.`);
      }
      if (!isPaused(vm)) {
        context.report.step(`Pausing exe.dev VM ${vm.name}…`);
        await pauseWithRetry(vm, context.signal);
      }
      return context.resource;
    },
    async resume(context) {
      const vm = await pinnedVm(context.resource, context.signal);
      if (vm === null) {
        throw new Error(`exe.dev VM ${context.resource.vmName} no longer exists.`);
      }
      const wasPaused = isPaused(vm);
      if (wasPaused) {
        context.report.step(`Resuming exe.dev VM ${vm.name}…`);
        const resumed = await vm.resume({ signal: context.signal, timeoutMs: BOOT_TIMEOUT_MS });
        if (resumed.cold_booted === "true") {
          context.report.log("exe.dev cold-booted the VM; restarting the bb daemon\n");
        }
      }
      try {
        await ensurePrerequisites(vm, context.report, context.signal);
        await joinTailnet(vm, await requireSettings(), context.report, context.signal);
      } catch (error) {
        // bb keeps the machine suspended after a failed resume; don't leave
        // the VM running (and billed) behind its back.
        if (wasPaused) await vm.pause({ signal: AbortSignal.timeout(API_TIMEOUT_MS * 2) }).catch(() => {});
        throw error;
      }
      return { resource: context.resource, executor: createExeDevExecutor(vm) };
    },
    async remove(context) {
      await deleteVm(await pinnedVm(context.resource, context.signal), context.signal);
    },
    displayName({ resource }) {
      return `exe.dev VM ${resource.vmName.slice(-6)}`;
    },
    async pauseIfRunning(resource, signal, stillWanted) {
      const vm = await pinnedVm(resource, withTimeout(signal, API_TIMEOUT_MS));
      if (vm === null || vm.info.status !== "running") return false;
      // A resume may have started since the caller looked; don't fight it.
      if (stillWanted !== undefined && !(await stillWanted())) return false;
      await pauseWithRetry(vm, signal);
      return true;
    },
    async connectionStatus() {
      try {
        const { email } = await connect();
        return { available: true, message: `Connected to exe.dev as ${email}` };
      } catch (error) {
        return {
          available: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
