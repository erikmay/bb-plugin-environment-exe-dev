import type { MachineExecutor } from "@get-bb/plugin-sdk";
import type {
  PluginMachineProviderAvailability,
  PluginMachineProviderProgress,
  PluginMachineProviderResource,
} from "@get-bb/plugin-sdk/machine-provider";

export interface SandboxOperationContext {
  report: PluginMachineProviderProgress;
  signal: AbortSignal;
}

export interface SandboxCheckpointContext<
  Resource extends PluginMachineProviderResource,
> extends SandboxOperationContext {
  checkpoint(resource: Resource): Promise<void>;
}

export interface SandboxCreateContext<
  Resource extends PluginMachineProviderResource,
> extends SandboxCheckpointContext<Resource> {
  key: string;
  attempt: number;
}

export interface SandboxLifecycleContext<
  Resource extends PluginMachineProviderResource,
> extends SandboxCheckpointContext<Resource> {
  hostId: string;
  resource: Resource;
}

export interface SandboxResourceContext<
  Resource extends PluginMachineProviderResource,
> extends SandboxOperationContext {
  hostId: string;
  resource: Resource;
}

export interface SandboxBackendDefinition {
  id: string;
  displayName: string;
  description: string;
  environmentDescription: string;
  projectlessEnvironmentDescription?: string;
  runtimeName: string;
  icon: string;
  ephemeral: boolean;
}

export interface SandboxBackend<Resource extends PluginMachineProviderResource> {
  definition: SandboxBackendDefinition;
  parseResource(value: PluginMachineProviderResource): Resource;
  allocationKey(resource: Resource): string;
  availability(): Promise<PluginMachineProviderAvailability>;
  create(
    context: SandboxCreateContext<Resource>,
  ): Promise<{ resource: Resource; executor: MachineExecutor }>;
  reconcileCleanup(context: SandboxOperationContext & { key: string }): Promise<void>;
  suspend(context: SandboxLifecycleContext<Resource>): Promise<Resource>;
  resume(
    context: SandboxLifecycleContext<Resource>,
  ): Promise<{ resource: Resource; executor: MachineExecutor }>;
  remove(context: SandboxResourceContext<Resource>): Promise<void>;
  displayName(context: { hostId: string; resource: Resource }): string;
}
