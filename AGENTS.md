# Agent instructions

This repository is a bb plugin that adds an **exe.dev VM** machine provider to
[bb](https://github.com/get-bb/bb): every thread started with the "exe.dev VM"
environment gets its own exe.dev VM, which bb pauses when idle and deletes when
the thread is archived.

The plugin is a port of bb's official Modal sandbox plugin
(`plugins/environment-modal-sandbox`) onto the exe.dev HTTPS API. Keeping it
close to that upstream shape is what keeps it maintainable. Prefer porting
upstream changes over inventing new structure.

## Layout

| Path | Role | Upstream counterpart |
|---|---|---|
| `server.ts` | Plugin entry: settings, idle tracking, pause-idle schedule, registration | `plugins/environment-modal-sandbox/server.ts` |
| `idle-sweep.ts` | Decides which machines the pause-idle schedule pauses; unit tested | the schedule in `plugins/environment-modal-sandbox/server.ts` |
| `configuration.ts` | Settings descriptors and validation | `plugins/environment-modal-sandbox/configuration.ts` |
| `providers/sandbox-backend.ts` | Vendor-neutral backend interface | `plugins/environment-modal-sandbox/providers/sandbox-backend.ts` |
| `providers/register.ts` | Maps a backend onto `bb.experimental_machines` / `bb.experimental_environments`; registers a project environment (`project-checkout`) and a projectless one (`personal-workspace`, id `<provider>-workspace`) | `plugins/environment-modal-sandbox/providers/register.ts`, `plugins/environment-personal-workspace/server.ts` |
| `providers/exe-dev/backend.ts` | exe.dev lifecycle: create, suspend, resume, remove, reconcile | `providers/modal/backend.ts` |
| `providers/exe-dev/client.ts` | Executor over `vm.ssh`, VM prerequisites script | `providers/modal/client.ts` |
| `providers/exe-dev/resource.ts` | Persisted machine resource and VM naming | `providers/modal/resource.ts` |
| `upstream.json` | Upstream commit this port is synced to, and the files it tracks | — |
| `scripts/check-upstream.mjs` | Diffs tracked upstream files since the synced commit | — |
| `scripts/doctor.mjs` | Local health check: bb plugin/providers/machines, plugin log, exe.dev VMs, orphan detection, VM internals | — |
| `docs/VALIDATION.md` | How to validate and debug against a local bb | — |
| `skills/exe-dev-vms/SKILL.md` | Skill bb exposes to agents running inside bb | `skills/modal-sandboxes/SKILL.md` |

## Invariants (do not break)

These come from `plugins/environment-modal-sandbox/providers/README.md` upstream:

- `create` converges on the durable launch key: the VM name is
  `vmNameForKey(key)`, so a retried launch reuses the VM. Checkpoint the
  resource before returning the executor.
- `reconcileCleanup` removes an uncertain allocation by key only. It never
  creates or bootstraps.
- `suspend`/`resume` are idempotent. A paused VM is not paused again; a running
  VM is not resumed again.
- Missing VMs (`ExeAPIError` 404) count as removed in `remove` and
  `reconcileCleanup`, but are errors in `suspend`/`resume`.
- The resource pins the exe.dev account email. Refuse lifecycle operations when
  the configured token belongs to another account.
- Bootstrap stdin carries enrollment credentials. It travels through a 0600
  temp file that the command deletes; it must never appear in the command
  line, logs, or the persisted resource.
- Never store secrets in the machine resource; it is readable by every plugin.
- Secrets reach a VM only as 0600 files that the same script deletes
  (bootstrap stdin, Tailscale auth key), never as command-line arguments.
- Never idle-pause a machine with a running turn (`bb.sdk.threads.listRunning`).
  bb's suspend interrupts running turns, and a long silent tool call emits no
  thread events, so event timestamps alone are not proof of idleness. Upstream
  Modal plugin has the same gap. Likewise, after the bb server was frozen
  (sweep gap > 3 min, laptop asleep) restart all idle clocks instead of pausing.

## Commands

```sh
npm install
npm run typecheck
npm test                      # unit tests, fake exe.dev client, no secrets
npm run test:live             # real exe.dev API; needs EXE_TOKEN or EXE_TOKEN_FILE; creates and deletes one VM
npm run build                 # bb plugin build (needs the bb CLI)
npm run upstream:check        # diff tracked upstream files against bb main
npm run doctor                # health check against the local bb and exe.dev (see docs/VALIDATION.md)
npm run doctor -- --vm <name> # plus node/linger/daemon/stdin checks on one running VM
node scripts/check-upstream.mjs <ref> [--json] [--markdown out.md]   # against a tag or commit
```

## Definition of done

A change is done when all of these hold, and the PR says how each was checked:

1. `npm run typecheck` and `npm test` pass.
2. Behaviour changes in `providers/` or `configuration.ts` have unit tests
   against the fake client (`test/backend.test.ts`), and `npm run test:live`
   passes when an exe.dev token is available.
3. User-visible changes are reflected in `README.md`, `PLUGIN_OVERVIEW.md`,
   `skills/exe-dev-vms/SKILL.md` and `docs/VALIDATION.md` where relevant.
4. `CHANGELOG.md` has a `## X.Y.Z — YYYY-MM-DD` section and `package.json`
   carries that version. Below 1.0: new features and anything that changes
   settings or behaviour bump the minor version; fixes bump the patch.
5. Merging to `main` releases automatically (see Automation); never tag by
   hand.

## Adding a feature

1. Restate the goal and acceptance criteria from the issue. Ask on the issue
   when a user decision is missing instead of guessing.
2. Find where it belongs:
   - a new setting: `configuration.ts` (descriptor, validation,
     `ResolvedSettings`) plus `test/configuration.test.ts`;
   - VM lifecycle or exe.dev calls: `providers/exe-dev/backend.ts` or
     `client.ts`, keeping the invariants above;
   - something every sandbox provider would want (not exe.dev specific):
     `providers/register.ts` / `sandbox-backend.ts`, and check whether bb's
     Modal plugin already does it upstream so the port stays close;
   - bb-side behaviour (idle tracking, events, schedules): `server.ts`.
3. Read the exact API before using it: `node_modules/@exedev/sdk/dist/*.d.ts`
   and `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`. Do
   not guess signatures.
4. Write the test first against the fake client, then the code.
5. Meet the definition of done, open a PR.

## Automation

| Workflow | Trigger | What it does | Needs |
|---|---|---|---|
| `ci.yml` | push, PR, manual | typecheck + unit tests | — |
| `live.yml` | weekly, manual, pushes touching `providers/` | `npm run test:live` against real exe.dev | secret `EXE_TOKEN` (token tagged e.g. `bb-ci`, cmds `whoami,ls,new,rm,pause,resume,ssh,stat`) |
| `upstream-watch.yml` | weekly, manual | runs `check-upstream.mjs`, opens or updates one `upstream-drift` issue, starts the agent on real drift | — (agent part needs agent secret) |
| `agent.yml` | label `agent`, `@claude` comment by the owner, dispatched by upstream-watch | Claude Code works the issue per this file and opens a PR on `agent/issue-N` | secret `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` |
| `release.yml` | push to `main` changing `package.json` | tags `vX.Y.Z` and publishes a GitHub release from the CHANGELOG section, if the tag does not exist yet | — |
| Dependabot | weekly | npm and Actions updates, except packages `bb plugin types` manages | — |

Workflows without their secret skip with a notice instead of failing. Pull
requests opened by the agent use the workflow token, so GitHub does not start
CI for them automatically; the agent dispatches `ci.yml` on its branch.

## Upgrading to a newer bb

Do this when bb releases, when `npm run upstream:check` reports changes, or
when a user reports breakage after a bb update.

1. **Sync the SDK.** With the target bb installed, run `bb plugin types` in this
   directory, then `npm install`. Raise `engines.bb` and `engines.bbPluginSdk`
   in `package.json` only if the code now needs newer APIs.
2. **Diff upstream.** Run `npm run upstream:check` (or pass the release tag).
   Read `upstream-diff.patch`. For each tracked file:
   - `local` set: port behaviour changes into the local counterpart. Keep
     Modal-specific parts (images, presets, allocation sweep, snapshots) out.
   - `local` null: it is a contract. Check the executor, the prerequisites
     script, and the lifecycle against it. Typical breakages: a new required
     tool on the machine (add it to `PREREQUISITES_SCRIPT`), a raised Node.js
     floor (update the version check), new `MachineExecutorRequest` fields, new
     required provider callbacks.
   - Moved or deleted files: find the new location, update `upstream.json`.
3. **Check for promoted APIs.** If `SandboxBackend`/`registerSandboxBackend`
   (or an equivalent) appear in `@get-bb/plugin-sdk`, delete the local copies in
   `providers/` and implement the public interface instead. If
   `experimental_machines`/`experimental_environments` lose the `experimental_`
   prefix, rename the calls.
4. **Verify.** `npm run typecheck && npm test`, then the manual checklist below.
5. **Record.** Update `upstream.json` (`syncedCommit`, `syncedAt`,
   `testedBbVersion`, `testedPluginSdk`), add a `CHANGELOG.md` entry, bump the
   version, commit, and tag `vX.Y.Z`. Never move an existing tag: bb refuses a
   plugin whose tag changed commit.

## Validating and getting insights

`docs/VALIDATION.md` is the full procedure: `npm run doctor`, the CLI
lifecycle walk, the UI end-to-end run against http://127.0.0.1:38886/ with a
browser automation tool, and how to look inside a VM. Use it to verify any
change yourself before reporting it done, and to diagnose user reports (start
with `npm run doctor` and `bb plugin logs environment-exe-dev`).

## Manual end-to-end checklist

Run against a real bb with this plugin installed from the working tree
(`bb plugin install .`, then `bb plugin reload environment-exe-dev`), a
configured `apiToken`, and bb connect ready:

- [ ] `bb machine providers` lists `exe-dev`.
- [ ] `bb machine create --provider exe-dev --key e2e-<date> --json` reaches
      `status: connected` (about 20 s on exeuntu).
- [ ] `bb machine suspend <id>` → exe.dev shows the VM `paused`;
      `bb machine resume <id>` → `connected` again.
- [ ] New thread with environment "exe.dev VM": provisioning succeeds, the
      composer chip reads "exe.dev VM xxxxxx", the agent can run `hostname`.
- [ ] Same with "Don't work in a project": the environment picker offers
      "exe.dev VM" and the agent's working directory is a personal workspace.
- [ ] Idle pause: set `idleMinutes` to 1, wait about 2 minutes, the machine is
      `suspended`. A thread running `sleep 180` is not paused while it
      runs. Restore the value.
- [ ] Archive the thread → the VM disappears from `ssh exe.dev ls` within
      seconds; `bb machine remove <id> --yes` for standalone machines.

## Rules

- No secrets in the repository, tests, logs or issues. Tokens live in bb's
  secret settings only.
- Keep the exe.dev token scope minimal: `whoami,ls,new,rm,pause,resume,ssh,stat`
  with `--tag=bb`. If the plugin needs another command, document it in the
  README and the setting description.
- Unit tests use the fake client in `test/backend.test.ts` and never call the
  real exe.dev API. Only `test/live/` does, and it must delete what it creates.
