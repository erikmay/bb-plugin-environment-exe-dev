import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createExeDevBackend } from "../providers/exe-dev/backend.js";
import { registerSandboxBackend } from "../providers/register.js";

function fakeBb() {
  const environments: Array<{ id: string; machineProviderId: string; environmentProviderId: string }> = [];
  const machines: Array<{ id: string; ephemeral?: boolean }> = [];
  const bb = {
    experimental_environments: { register: (entry: (typeof environments)[number]) => environments.push(entry) },
    experimental_machines: { register: (entry: (typeof machines)[number]) => machines.push(entry) },
  } as unknown as BbPluginApi;
  return { bb, environments, machines };
}

describe("registerSandboxBackend", () => {
  it("registers an ephemeral machine provider with project and projectless environments", () => {
    const { bb, environments, machines } = fakeBb();
    const backend = createExeDevBackend({
      currentSettings: async () => ({ ok: false, message: "unset" }),
    });
    registerSandboxBackend(bb, backend, { now: () => 0, onConnected: async () => {} });

    expect(machines).toEqual([expect.objectContaining({ id: "exe-dev", ephemeral: true })]);
    expect(environments).toEqual([
      expect.objectContaining({ id: "exe-dev", machineProviderId: "exe-dev", environmentProviderId: "project-checkout" }),
      expect.objectContaining({ id: "exe-dev-workspace", machineProviderId: "exe-dev", environmentProviderId: "personal-workspace" }),
    ]);
  });
});
