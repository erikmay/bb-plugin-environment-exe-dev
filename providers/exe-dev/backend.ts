import exedev, { ExeAPIError, type ExedevClient, type NewOptions, type VM } from "@exedev/sdk";
import type { ResolvedSettings, SettingsResolution } from "../../configuration.js";
import type { SandboxBackend } from "../sandbox-backend.js";
import {
  createExeDevExecutor,
  ensurePrerequisites,
  findVm,
  isPaused,
} from "./client.js";
import {
  readExeDevMachineResource,
  vmNameForKey,
  type ExeDevMachineResource,
} from "./resource.js";

export const PROVIDER_ID = "exe-dev";
const USER_AGENT = "bb-plugin-environment-exe-dev/0.1.0";

export interface ExeDevConnectionStatus {
  available: boolean;
  message: string;
}

export interface ExeDevBackend extends SandboxBackend<ExeDevMachineResource> {
  connectionStatus(): Promise<ExeDevConnectionStatus>;
}

export type ExeDevClientFactory = (token: string) => ExedevClient;

export const createExeDevClient: ExeDevClientFactory = (token) =>
  exedev({ token, userAgent: USER_AGENT });

export function createExeDevBackend(deps: {
  currentSettings: () => Promise<SettingsResolution>;
  clientFactory?: ExeDevClientFactory;
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
      const whoami = await current.client.whoami();
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

  async function deleteVm(vm: VM | null): Promise<void> {
    if (vm === null) return;
    try {
      await vm.rm();
    } catch (error) {
      if (error instanceof ExeAPIError && error.status === 404) return;
      throw error;
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
        await vm.resume({ signal: context.signal });
      }
      await ensurePrerequisites(vm, context.report, context.signal);
      return { resource, executor: createExeDevExecutor(vm) };
    },
    async reconcileCleanup(context) {
      const { client } = await connect();
      context.signal.throwIfAborted();
      await deleteVm(await findVm(client.vm(vmNameForKey(context.key)), context.signal));
    },
    async suspend(context) {
      const vm = await pinnedVm(context.resource, context.signal);
      if (vm === null) {
        throw new Error(`exe.dev VM ${context.resource.vmName} no longer exists.`);
      }
      if (!isPaused(vm)) {
        context.report.step(`Pausing exe.dev VM ${vm.name}…`);
        await vm.pause({ signal: context.signal });
      }
      return context.resource;
    },
    async resume(context) {
      const vm = await pinnedVm(context.resource, context.signal);
      if (vm === null) {
        throw new Error(`exe.dev VM ${context.resource.vmName} no longer exists.`);
      }
      if (isPaused(vm)) {
        context.report.step(`Resuming exe.dev VM ${vm.name}…`);
        const resumed = await vm.resume({ signal: context.signal });
        if (resumed.cold_booted === "true") {
          context.report.log("exe.dev cold-booted the VM; restarting the bb daemon\n");
        }
      }
      await ensurePrerequisites(vm, context.report, context.signal);
      return { resource: context.resource, executor: createExeDevExecutor(vm) };
    },
    async remove(context) {
      await deleteVm(await pinnedVm(context.resource, context.signal));
    },
    displayName({ resource }) {
      return `exe.dev VM ${resource.vmName.slice(-6)}`;
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
