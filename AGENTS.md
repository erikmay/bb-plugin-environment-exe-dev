# Agent instructions

A bb plugin that gives each [bb](https://github.com/get-bb/bb) thread its own
exe.dev VM: created on demand, paused when idle, deleted with the thread. It is
a port of bb's Modal sandbox plugin (`plugins/environment-modal-sandbox`) onto
the exe.dev HTTPS API; keep that shape so upstream changes stay easy to port.

## Layout

| Path | Role |
|---|---|
| `server.ts` | Entry: settings, idle tracking, the pause-idle schedule, registration |
| `idle-sweep.ts` | Which machines the schedule pauses (and which suspended VMs it re-pauses) |
| `configuration.ts` | Settings and their validation |
| `providers/register.ts`, `providers/sandbox-backend.ts` | Maps the backend onto bb's machine and environment providers (project and projectless) |
| `providers/exe-dev/backend.ts` | VM lifecycle: create, suspend, resume, remove, reconcile |
| `providers/exe-dev/client.ts` | Command executor over `vm.ssh`, VM preparation, tailnet join/leave |
| `providers/exe-dev/tailscale.ts` | Mints single-use Tailscale auth keys from the OAuth client |
| `providers/exe-dev/resource.ts` | Persisted machine resource and VM naming |
| `skills/exe-dev-vms/SKILL.md` | Skill bb gives agents running inside bb |
| `scripts/remote-dev.sh` | Copy this checkout to a bb server on another machine, build and reload there |

## Invariants

- `create` converges on the launch key (`vmNameForKey`), so retries reuse the
  VM; checkpoint the resource before bootstrapping. `reconcileCleanup` only
  deletes by key.
- `suspend`/`resume`/`remove` are idempotent. A missing VM (404) counts as
  removed in `remove`/`reconcileCleanup` and is an error in `suspend`/`resume`.
- The resource pins the exe.dev account email; refuse lifecycle calls for
  another account. Never store secrets in the resource (every plugin can read
  it).
- Secrets reach a VM only as 0600 files that the same script deletes. The
  exe.dev exec API has no stdin, so they briefly show in the VM's process
  list: send only short-lived ones (bootstrap stdin, single-use Tailscale
  keys), and only when needed.
- No VM keeps running behind a machine bb shows as suspended: pauses retry, a
  failed resume pauses again, the sweep repairs the rest.
- Never idle-pause a machine with a running turn, or right after the bb server
  was frozen or restarted. bb's suspend interrupts running turns.
- Every exe.dev call has a timeout.

## Working on it

```sh
npm install
npm run typecheck && npm test   # unit tests against a fake exe.dev client
npm run test:live               # real exe.dev, needs EXE_TOKEN or EXE_TOKEN_FILE; creates and deletes one VM
bb plugin install .             # local bb: install this checkout, then
npm run build && bb plugin reload environment-exe-dev
npm run remote:reload           # bb on another machine (SSH alias bb-remote): copy, build there, reload
npm run remote:logs
```

On a remote bb, install the copy once: the first `remote:reload` creates
`~/Code/bb-plugins/<repo>` there; then `bb plugin install` that path (after
`bb plugin remove environment-exe-dev`, which deletes the plugin's settings).

Read the real APIs before using them:
`node_modules/@exedev/sdk/dist/*.d.ts` and
`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`.

To check a change end to end: start a thread with the "exe.dev VM"
environment (with and without a project), let the agent run `hostname`, pause
and resume it (`bb machine suspend|resume <host>`), archive it, and confirm
the VM is gone (`ssh exe.dev ls`). `bb plugin logs environment-exe-dev` shows
connection and idle-pause events.

## Releasing

1. `npm run typecheck && npm test` pass; behaviour changes have tests.
2. `CHANGELOG.md` gets a `## X.Y.Z — YYYY-MM-DD` section and `package.json`
   that version (below 1.0: features and behaviour changes bump the minor,
   fixes the patch). Update `README.md` for user-visible changes.
3. Push to `main`. `release.yml` tags `vX.Y.Z` and publishes the release; never
   tag by hand or move a tag (bb refuses a plugin whose tag moved).

CI runs typecheck and tests on every push; `live.yml` runs the live test when
`providers/` changes and weekly (secret `EXE_TOKEN`).

## Upgrading to a newer bb

Run `bb plugin types` with the new bb installed, then `npm install`, and fix
what typecheck reports. Then diff the upstream files this port follows
against the last release you checked:

- `plugins/environment-modal-sandbox/` (`server.ts`, `providers/`)
- `plugins/environment-personal-workspace/server.ts`
- `apps/server/src/assets/install-machine.sh` (what bootstrap needs on a VM)
- `plugins/bb-guide/skills/bb-plugin-authoring/references/backend-machines.md`

Port behaviour changes; keep Modal-specific parts out. If `experimental_`
APIs lose the prefix, rename the calls.

## Rules

- No secrets in the repository, tests, logs or issues.
- exe.dev token scope stays `whoami,ls,new,rm,pause,resume,ssh,stat` with
  `--tag=bb`.
- Unit tests never call real exe.dev or Tailscale; only `test/live/` calls
  exe.dev, and it deletes what it creates.
