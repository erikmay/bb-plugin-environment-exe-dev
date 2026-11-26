import { describe, expect, it, vi } from "vitest";
import { ExeAPIError, type ExedevClient, type NewOptions, type VM } from "@exedev/sdk";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import type { SettingsResolution } from "../configuration.js";
import { createExeDevBackend } from "../providers/exe-dev/backend.js";
import { vmNameForKey, type ExeDevMachineResource } from "../providers/exe-dev/resource.js";

const EMAIL = "owner@example.com";

class FakeVm {
  status: "running" | "paused" = "running";
  exists = true;
  readonly calls: string[] = [];
  constructor(readonly name: string) {}
  get info() {
    return { name: this.name, tags: [], status: this.status };
  }
  async refresh() {
    if (!this.exists) throw new ExeAPIError("ls", 404, "not found");
    return this;
  }
  async pause() {
    this.calls.push("pause");
    this.status = "paused";
    return { vm_name: this.name, status: "paused" as const };
  }
  async resume() {
    this.calls.push("resume");
    this.status = "running";
    return { vm_name: this.name, status: "running" as const, cold_booted: "false" as const };
  }
  async rm() {
    this.calls.push("rm");
    if (!this.exists) throw new ExeAPIError("rm", 404, "not found");
    this.exists = false;
  }
  async ssh(_command: string, options?: { onStdout?: (data: string) => void }) {
    this.calls.push("ssh");
    options?.onStdout?.("ok\n");
    return { exitCode: 0, stdout: "", stderr: "", captured: false, stdoutBytes: new Uint8Array(), stderrBytes: new Uint8Array() };
  }
  async writeFile() {
    this.calls.push("writeFile");
  }
}

function setup(options: { email?: string } = {}) {
  const vms = new Map<string, FakeVm>();
  const created: NewOptions[] = [];
  const client = {
    whoami: vi.fn(async () => ({ email: options.email ?? EMAIL })),
    vm: (name: string) => {
      let vm = vms.get(name);
      if (vm === undefined) {
        vm = new FakeVm(name);
        vm.exists = false;
        vms.set(name, vm);
      }
      return vm as unknown as VM;
    },
    new: vi.fn(async (opts: NewOptions) => {
      created.push(opts);
      const vm = new FakeVm(opts.name ?? "generated");
      vms.set(vm.name, vm);
      return vm as unknown as VM;
    }),
  } as unknown as ExedevClient;
  const settings: SettingsResolution = {
    ok: true,
    settings: { apiToken: "t", idleMs: 60_000, cpu: 4, memory: null, disk: null, image: null },
  };
  const backend = createExeDevBackend({
    currentSettings: async () => settings,
    clientFactory: () => client,
  });
  const report = { step: vi.fn(), log: vi.fn() };
  const signal = new AbortController().signal;
  return { backend, client, vms, created, report, signal };
}

describe("exe.dev backend", () => {
  it("creates a VM named from the launch key and checkpoints it", async () => {
    const { backend, created, report, signal, vms } = setup();
    const checkpoint = vi.fn(async () => {});
    const result = await backend.create({ key: "thr_abc", attempt: 1, report, signal, checkpoint });
    const name = vmNameForKey("thr_abc");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name, cpu: 4, "no-email": true });
    expect(result.resource).toEqual({ key: "thr_abc", vmName: name, accountEmail: EMAIL });
    expect(checkpoint).toHaveBeenCalledWith(result.resource);
    expect(vms.get(name)?.calls).toContain("ssh");
  });

  it("reuses an existing VM on retry and resumes it when paused", async () => {
    const { backend, created, report, signal, vms } = setup();
    const name = vmNameForKey("thr_retry");
    const existing = new FakeVm(name);
    existing.status = "paused";
    vms.set(name, existing);
    await backend.create({ key: "thr_retry", attempt: 2, report, signal, checkpoint: async () => {} });
    expect(created).toHaveLength(0);
    expect(existing.calls).toContain("resume");
  });

  it("suspends idempotently and resumes", async () => {
    const { backend, report, signal, vms } = setup();
    const name = vmNameForKey("thr_s");
    const vm = new FakeVm(name);
    vms.set(name, vm);
    const resource: ExeDevMachineResource = { key: "thr_s", vmName: name, accountEmail: EMAIL };
    const context = { hostId: "host_1", resource, report, signal, checkpoint: async () => {} };
    await backend.suspend(context);
    await backend.suspend(context);
    expect(vm.calls.filter((call) => call === "pause")).toHaveLength(1);
    const resumed = await backend.resume(context);
    expect(vm.status).toBe("running");
    expect(resumed.resource).toEqual(resource);
  });

  it("refuses lifecycle operations for another exe.dev account", async () => {
    const { backend, report, signal, vms } = setup({ email: "someone-else@example.com" });
    const name = vmNameForKey("thr_x");
    vms.set(name, new FakeVm(name));
    const resource: ExeDevMachineResource = { key: "thr_x", vmName: name, accountEmail: EMAIL };
    await expect(
      backend.suspend({ hostId: "host_1", resource, report, signal, checkpoint: async () => {} }),
    ).rejects.toThrow(/belongs to the exe.dev account/);
  });

  it("removes and reconciles by key, treating missing VMs as removed", async () => {
    const { backend, report, signal, vms } = setup();
    const name = vmNameForKey("thr_r");
    const vm = new FakeVm(name);
    vms.set(name, vm);
    await backend.reconcileCleanup({ key: "thr_r", report, signal });
    expect(vm.exists).toBe(false);
    await backend.reconcileCleanup({ key: "thr_r", report, signal });
    const resource: ExeDevMachineResource = { key: "thr_r", vmName: name, accountEmail: EMAIL };
    await expect(backend.remove({ hostId: "host_1", resource, report, signal })).resolves.toBeUndefined();
  });

  it("runs executor commands with stdin from a temporary file", async () => {
    const { backend, report, signal, vms } = setup();
    const { executor } = await backend.create({ key: "thr_e", attempt: 1, report, signal, checkpoint: async () => {} });
    const vm = vms.get(vmNameForKey("thr_e"))!;
    const ssh = vi.spyOn(vm, "ssh");
    const run: MachineExecutor["exec"] = executor.exec.bind(executor);
    const output: string[] = [];
    const { exitCode } = await run({
      command: ["sh", "-c", "echo $1", "x", "it's"],
      stdin: "secret",
      timeoutMs: 5_000,
      signal,
      onOutput: (chunk) => output.push(chunk),
    });
    expect(exitCode).toBe(0);
    expect(vm.calls).toContain("writeFile");
    const script = ssh.mock.calls[0]?.[0] ?? "";
    expect(script).toContain("timeout -k 10 5 sh -c");
    expect(script).toContain(`'it'"'"'s'`);
    expect(script).not.toContain("secret");
  });
});

describe("vmNameForKey", () => {
  it("is deterministic, short and DNS-safe", () => {
    const name = vmNameForKey("thr_ydedrkvk9f");
    expect(name).toBe(vmNameForKey("thr_ydedrkvk9f"));
    expect(name).toMatch(/^bb-[0-9a-f]{16}$/);
    expect(vmNameForKey("other")).not.toBe(name);
  });
});
