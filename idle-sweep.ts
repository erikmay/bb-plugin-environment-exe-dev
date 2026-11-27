import { errorMessage } from "./error-message.js";

export interface SweepHost {
  id: string;
  machineProviderId: string | null;
  lifecycle: { phase: string };
}

export interface IdleSweepDeps {
  providerId: string;
  idleMs: number;
  now: () => number;
  /** When the previous sweep ran (persisted), or null when none is recorded. */
  previousSweepAt: number | null;
  listHosts: () => Promise<readonly SweepHost[]>;
  /** Threads with a running turn (status `starting` or `active`) and their host. */
  listRunningThreads: () => Promise<readonly { id: string; hostId: string | null }[]>;
  getLastActivity: (hostId: string) => Promise<number | null>;
  bump: (hostId: string) => Promise<void>;
  suspend: (hostId: string) => Promise<void>;
  /**
   * For a machine bb records as suspended: pause its VM if it still runs
   * (a pause or resume that failed halfway). Returns true when it paused.
   */
  pauseIfStillRunning: (hostId: string) => Promise<boolean>;
  getPhase: (hostId: string) => Promise<string | null>;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

const TRANSITION_PHASES = new Set(["suspending", "suspended", "resuming"]);

/**
 * The sweep runs every minute. A much longer gap means the bb server itself was
 * frozen (the computer slept): machines kept working but could not report, so
 * the missing events say nothing about idleness.
 */
export const SERVER_STALL_MS = 3 * 60_000;

/**
 * Pauses this provider's active machines that have been idle for `idleMs`.
 *
 * A machine with a running turn is never idle, even when the turn has emitted
 * nothing for a long time (a slow tool call, a hung fetch): bb's suspend drains
 * running turns by interrupting them, so pausing one would kill the agent's
 * work. Such machines get their idle clock reset instead.
 *
 * After the bb server was frozen (laptop asleep) or restarted, every
 * machine's idle clock restarts: the daemons need time to reconnect and
 * deliver what happened while the server could not listen.
 *
 * Machines bb records as suspended are checked too: a VM still running there
 * (a failed pause, or a failed resume after the VM was already started) is
 * paused, because nothing else would notice it.
 */
export async function sweepIdleMachines(deps: IdleSweepDeps): Promise<void> {
  const owned = (await deps.listHosts()).filter((host) => host.machineProviderId === deps.providerId);
  for (const host of owned.filter((candidate) => candidate.lifecycle.phase === "suspended")) {
    try {
      if (await deps.pauseIfStillRunning(host.id)) {
        deps.log.warn(`exe.dev VM of ${host.id} was still running while bb showed it paused; paused it`);
      }
    } catch (error) {
      deps.log.warn(`Checking the paused exe.dev VM of ${host.id} failed: ${errorMessage(error)}`);
    }
  }
  const hosts = owned.filter((host) => host.lifecycle.phase === "active");
  if (hosts.length === 0) return;
  const serverWasFrozen =
    deps.previousSweepAt === null || deps.now() - deps.previousSweepAt > SERVER_STALL_MS;
  const busyHosts = new Set(
    (await deps.listRunningThreads()).flatMap((thread) => (thread.hostId === null ? [] : [thread.hostId])),
  );
  for (const host of hosts) {
    try {
      if (serverWasFrozen || busyHosts.has(host.id)) {
        await deps.bump(host.id);
        continue;
      }
      const lastActivity = await deps.getLastActivity(host.id);
      if (lastActivity === null) {
        await deps.bump(host.id);
        continue;
      }
      if (deps.now() < lastActivity + deps.idleMs) continue;
      await deps.suspend(host.id);
      deps.log.info(`Requested pause of idle exe.dev machine ${host.id}`);
    } catch (error) {
      if (hasErrorCode(error, "machine_busy")) continue;
      const phase = await deps.getPhase(host.id).catch(() => null);
      if (phase !== null && TRANSITION_PHASES.has(phase)) continue;
      deps.log.warn(`Idle pause failed for ${host.id}: ${errorMessage(error)}`);
    }
  }
}
