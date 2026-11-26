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
| `configuration.ts` | Settings descriptors and validation | `plugins/environment-modal-sandbox/configuration.ts` |
| `providers/sandbox-backend.ts` | Vendor-neutral backend interface | `plugins/environment-modal-sandbox/providers/sandbox-backend.ts` |
| `providers/register.ts` | Maps a backend onto `bb.experimental_machines` / `bb.experimental_environments`; registers a project environment (`project-checkout`) and a projectless one (`personal-workspace`, id `<provider>-workspace`) | `plugins/environment-modal-sandbox/providers/register.ts`, `plugins/environment-personal-workspace/server.ts` |
| `providers/exe-dev/backend.ts` | exe.dev lifecycle: create, suspend, resume, remove, reconcile | `providers/modal/backend.ts` |
| `providers/exe-dev/client.ts` | Executor over `vm.ssh`, VM prerequisites script | `providers/modal/client.ts` |
| `providers/exe-dev/resource.ts` | Persisted machine resource and VM naming | `providers/modal/resource.ts` |
| `upstream.json` | Upstream commit this port is synced to, and the files it tracks | — |
| `scripts/check-upstream.mjs` | Diffs tracked upstream files since the synced commit | — |
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

## Commands

```sh
npm install
npm run typecheck
npm test
npm run build                 # bb plugin build (needs the bb CLI)
npm run upstream:check        # diff tracked upstream files against bb main
node scripts/check-upstream.mjs <ref>   # against a tag or commit, e.g. v0.51.0
```

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
      `suspended`. Restore the value.
- [ ] Archive the thread → the VM disappears from `ssh exe.dev ls` within
      seconds; `bb machine remove <id> --yes` for standalone machines.

## Rules

- No secrets in the repository, tests, logs or issues. Tokens live in bb's
  secret settings only.
- Keep the exe.dev token scope minimal: `whoami,ls,new,rm,pause,resume,ssh,stat`
  with `--tag=bb`. If the plugin needs another command, document it in the
  README and the setting description.
- Tests use the fake client in `test/backend.test.ts`; never call the real
  exe.dev API from tests.
