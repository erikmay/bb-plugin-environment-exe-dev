import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import exedev from "@exedev/sdk";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { resolveSettings } from "../../configuration.js";
import { createExeDevBackend } from "../../providers/exe-dev/backend.js";
import { vmNameForKey, type ExeDevMachineResource } from "../../providers/exe-dev/resource.js";

function readToken(): string | null {
  if (process.env.EXE_TOKEN) return process.env.EXE_TOKEN.trim();
  if (!process.env.EXE_TOKEN_FILE) return null;
  const raw = readFileSync(process.env.EXE_TOKEN_FILE, "utf8").trim();
  return raw.startsWith("{") ? (JSON.parse(raw) as { token: string }).token : raw;
}

const token = readToken();
const key = `live-${process.env.GITHUB_RUN_ID ?? "local"}-${Date.now()}`;
const report = { step: () => {}, log: () => {} };
const signal = new AbortController().signal;

describe.skipIf(token === null)("exe.dev backend against the real API", () => {
  const backend = createExeDevBackend({
    currentSettings: async () =>
      resolveSettings({ apiToken: token ?? "", idleMinutes: 15, cpu: 0, memory: "", disk: "", image: "" }),
  });
  let resource: ExeDevMachineResource | null = null;
  let executor: MachineExecutor | null = null;

  afterAll(async () => {
    await backend.reconcileCleanup({ key, report, signal });
    const leftover = await exedev({ token: token ?? "" }).ls(vmNameForKey(key));
    expect(leftover).toHaveLength(0);
  });

  it("creates a VM with bb's prerequisites", async () => {
    const created = await backend.create({
      key,
      attempt: 1,
      report,
      signal,
      checkpoint: async (checkpointed) => {
        resource = checkpointed;
      },
    });
    resource = created.resource;
    executor = created.executor;
    expect(resource.vmName).toBe(vmNameForKey(key));
  });

  it("runs commands with stdin, exit codes and Node.js >= 22.19", async () => {
    const output: string[] = [];
    const result = await executor!.exec({
      command: ["sh", "-c", 'cat; echo; node -p "process.versions.node"; ls ~/.bb-exe-dev | wc -l; exit 3'],
      stdin: "stdin-roundtrip",
      timeoutMs: 60_000,
      signal,
      onOutput: (chunk) => output.push(chunk),
    });
    const lines = output.join("").trim().split("\n").map((line) => line.trim());
    expect(result.exitCode).toBe(3);
    expect(lines[0]).toBe("stdin-roundtrip");
    const [major, minor] = (lines[1] ?? "0.0").split(".").map(Number);
    expect(major! > 22 || (major === 22 && minor! >= 19)).toBe(true);
    expect(lines[2]).toBe("1");
  });

  it("is idempotent on retry", async () => {
    const again = await backend.create({ key, attempt: 2, report, signal, checkpoint: async () => {} });
    expect(again.resource).toEqual(resource);
  });

  it("pauses and resumes", async () => {
    const context = { hostId: "host_live", resource: resource!, report, signal, checkpoint: async () => {} };
    await backend.suspend(context);
    const [paused] = await exedev({ token: token ?? "" }).ls(resource!.vmName);
    expect(paused?.info.status).toBe("paused");
    const resumed = await backend.resume(context);
    const result = await resumed.executor.exec({
      command: ["true"],
      stdin: "",
      timeoutMs: 30_000,
      signal,
      onOutput: () => {},
    });
    expect(result.exitCode).toBe(0);
  });

  it("removes the VM", async () => {
    await backend.remove({ hostId: "host_live", resource: resource!, report, signal });
    await backend.remove({ hostId: "host_live", resource: resource!, report, signal });
  });
});
