import { describe, expect, it } from "vitest";
import { sweepIdleMachines, type IdleSweepDeps, type SweepHost } from "../idle-sweep.js";

const IDLE_MS = 15 * 60_000;

function setup(options: {
  hosts: SweepHost[];
  running?: { id: string; hostId: string | null }[];
  lastActivity?: Record<string, number>;
  now?: number;
  suspendError?: Error;
  phase?: string;
  previousSweepAt?: number | null;
  stillRunning?: string[];
}) {
  const suspended: string[] = [];
  const bumped: string[] = [];
  const warnings: string[] = [];
  const repaused: string[] = [];
  const deps: IdleSweepDeps = {
    providerId: "exe-dev",
    idleMs: IDLE_MS,
    now: () => options.now ?? IDLE_MS * 2,
    previousSweepAt: options.previousSweepAt === undefined ? (options.now ?? IDLE_MS * 2) - 60_000 : options.previousSweepAt,
    pauseIfStillRunning: async (hostId) => {
      if (!options.stillRunning?.includes(hostId)) return false;
      repaused.push(hostId);
      return true;
    },
    listHosts: async () => options.hosts,
    listRunningThreads: async () => options.running ?? [],
    getLastActivity: async (hostId) => options.lastActivity?.[hostId] ?? null,
    bump: async (hostId) => void bumped.push(hostId),
    suspend: async (hostId) => {
      if (options.suspendError) throw options.suspendError;
      suspended.push(hostId);
    },
    getPhase: async () => options.phase ?? "active",
    log: { info: () => {}, warn: (message) => void warnings.push(message) },
  };
  return { deps, suspended, bumped, warnings, repaused };
}

const host = (id: string, phase = "active", machineProviderId: string | null = "exe-dev"): SweepHost => ({
  id,
  machineProviderId,
  lifecycle: { phase },
});

describe("sweepIdleMachines", () => {
  it("pauses a machine idle for longer than the limit", async () => {
    const t = setup({ hosts: [host("h1")], lastActivity: { h1: 0 } });
    await sweepIdleMachines(t.deps);
    expect(t.suspended).toEqual(["h1"]);
  });

  it("keeps a machine whose idle limit has not passed", async () => {
    const t = setup({ hosts: [host("h1")], lastActivity: { h1: IDLE_MS * 2 - 1000 } });
    await sweepIdleMachines(t.deps);
    expect(t.suspended).toEqual([]);
  });

  it("never pauses a machine with a running turn, even after a long silent tool call", async () => {
    const t = setup({
      hosts: [host("h1"), host("h2")],
      running: [{ id: "thr_busy", hostId: "h1" }, { id: "thr_unplaced", hostId: null }],
      lastActivity: { h1: 0, h2: 0 },
    });
    await sweepIdleMachines(t.deps);
    expect(t.suspended).toEqual(["h2"]);
    expect(t.bumped).toEqual(["h1"]);
  });

  it("restarts every idle clock after the bb server was frozen (computer asleep)", async () => {
    const t = setup({ hosts: [host("h1")], lastActivity: { h1: 0 }, previousSweepAt: 60_000 });
    await sweepIdleMachines(t.deps);
    expect(t.suspended).toEqual([]);
    expect(t.bumped).toEqual(["h1"]);
  });

  it("restarts every idle clock when no sweep is recorded (bb restarted)", async () => {
    const t = setup({ hosts: [host("h1")], lastActivity: { h1: 0 }, previousSweepAt: null });
    await sweepIdleMachines(t.deps);
    expect(t.suspended).toEqual([]);
    expect(t.bumped).toEqual(["h1"]);
  });

  it("pauses VMs that still run behind a suspended machine", async () => {
    const t = setup({ hosts: [host("s1", "suspended"), host("s2", "suspended")], stillRunning: ["s2"] });
    await sweepIdleMachines(t.deps);
    expect(t.repaused).toEqual(["s2"]);
    expect(t.warnings).toEqual(["exe.dev VM of s2 was still running while bb showed it paused; paused it"]);
  });

  it("pauses normally when the previous sweep was a minute ago", async () => {
    const t = setup({ hosts: [host("h1")], lastActivity: { h1: 0 }, previousSweepAt: IDLE_MS * 2 - 60_000 });
    await sweepIdleMachines(t.deps);
    expect(t.suspended).toEqual(["h1"]);
  });

  it("starts the idle clock for a machine without one", async () => {
    const t = setup({ hosts: [host("h1")] });
    await sweepIdleMachines(t.deps);
    expect(t.suspended).toEqual([]);
    expect(t.bumped).toEqual(["h1"]);
  });

  it("ignores other providers and inactive machines", async () => {
    const t = setup({
      hosts: [host("other", "active", "modal-sandbox"), host("paused", "suspended"), host("local", "active", null)],
      lastActivity: { other: 0, paused: 0, local: 0 },
    });
    await sweepIdleMachines(t.deps);
    expect(t.suspended).toEqual([]);
  });

  it("retries machine_busy silently on the next sweep", async () => {
    const t = setup({
      hosts: [host("h1")],
      lastActivity: { h1: 0 },
      suspendError: Object.assign(new Error("busy"), { code: "machine_busy" }),
    });
    await sweepIdleMachines(t.deps);
    expect(t.warnings).toEqual([]);
  });

  it("warns on other failures unless the machine is already changing state", async () => {
    const failing = { hosts: [host("h1")], lastActivity: { h1: 0 }, suspendError: new Error("boom") };
    const t = setup(failing);
    await sweepIdleMachines(t.deps);
    expect(t.warnings).toEqual(["Idle pause failed for h1: boom"]);
    const changing = setup({ ...failing, phase: "suspending" });
    await sweepIdleMachines(changing.deps);
    expect(changing.warnings).toEqual([]);
  });
});
