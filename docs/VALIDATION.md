# Validating the plugin locally

Everything here runs against your own bb on this computer and your exe.dev
account. Agents can follow it without help: every step has a command and an
expected result.

The desktop app and `npx bb-app` serve bb at **http://127.0.0.1:38886/**. A bb
source checkout (`pnpm dev`) uses its own ports; `bb status` and the launcher
output show them.

## 1. One-command health check

```sh
EXE_TOKEN_FILE=~/.config/bb-exe-dev/token.json npm run doctor
npm run doctor -- --vm bb-0123456789abcdef   # also inspect one running VM
```

`scripts/doctor.mjs` finds the `bb` CLI (`$BB_CLI`, `bb` on PATH, or
`~/.bb/bin/bb`) and checks:

| Check | Expected |
|---|---|
| plugin status | `environment-exe-dev <version> running` |
| machine provider | `exe-dev` registered |
| environments | `exe-dev` (project) and `exe-dev-workspace` (projectless) |
| bb machines | every `exe-dev` machine with phase and connection |
| plugin log | last lines, emails redacted |
| exe.dev | token accepted; every `bb-*` VM matched to a bb machine |
| `--vm` | `node` ≥ 22.19, linger enabled, `bb-host-daemon-*` service active, no leftover bootstrap stdin files |

It exits 1 and prints `WARN` lines for problems, for example an orphaned VM
that still counts toward your exe.dev pool, or a bb machine whose VM is gone.

The exe.dev part needs a token: `EXE_TOKEN` (the token) or `EXE_TOKEN_FILE` (a
file with the bare token or the JSON that `generate-api-key --json` prints).
Without one it checks only bb. It never reads bb's secret settings.

## 2. Development loop

```sh
bb plugin install .                       # once, from this checkout
npm run build && bb plugin reload environment-exe-dev
bb plugin logs environment-exe-dev -f     # follow the plugin log
bb plugin config environment-exe-dev      # settings (secrets show as [set])
```

### When bb runs on another machine

When your bb server runs on another machine (a VM, a home server), the plugin
has to live there. You keep editing this checkout, without releases:

1. Give the server an SSH alias, `bb-remote` by default (`BB_REMOTE` picks
   another), and install [Mutagen](https://mutagen.io) here.
2. `sh scripts/remote-dev.sh setup` mirrors this checkout to
   `~/Code/bb-plugins/<repo>` on the server (one way, this computer wins;
   `node_modules`, `dist` and `.git` stay out). Then install the mirror there
   once: `bb plugin remove environment-exe-dev && bb plugin install ~/Code/bb-plugins/<repo>`.
   Removing deletes the plugin's settings, so set them again.
3. The loop:

```sh
npm run remote:reload   # sync, build on the server, reload (a few seconds)
npm run remote:dev      # sync on save; bb plugin dev rebuilds and reloads there
npm run remote:logs     # follow the plugin log on the server
npm run remote:doctor   # the health check, run on the server
```

The server runs whatever this checkout holds, so it is live for you at once.
Publishing is still a version bump merged to `main`; the server keeps its path
install.

`npm run typecheck && npm test` must pass before any manual check.
`EXE_TOKEN_FILE=… npm run test:live` exercises the exe.dev side (create,
stdin, exit codes, Node.js, retry, pause/resume, delete) against the real API
in about 25 seconds without needing bb.

## 3. Lifecycle through the CLI

Create a standalone machine with a stable key, then walk its lifecycle:

```sh
bb machine create --provider exe-dev --key validate-$(date +%s) --json
#   expect "status": "connected", "phase": "active" after about 20 s
bb machine suspend <host-id> --json       # expect "phase": "suspended"
ssh exe.dev ls                            # expect the VM listed as "paused"
bb machine resume <host-id> --json        # expect "phase": "active", "connected"
npm run doctor -- --vm <vm-name>          # all checks pass
bb machine remove <host-id> --yes         # expect the VM gone from `ssh exe.dev ls`
```

Idle pause: `bb plugin config environment-exe-dev set idleMinutes 1`, wait
about two minutes, `bb machine show <host-id> --json` shows `"phase":
"suspended"` and the plugin log says `Paused idle exe.dev machine`. Set it back
to 15 afterwards.

## 4. End to end in the UI

Drive the real app with a browser automation tool. With
[agent-browser](https://github.com/vercel-labs/agent-browser):

```sh
S=exe-dev-e2e
agent-browser --session $S open http://127.0.0.1:38886/
agent-browser --session $S snapshot -i -c          # find the refs below
```

1. **Project thread.** Click `Project: …`, pick a project with a git remote,
   click `Environment`, pick option **exe.dev VM**, fill the `Ask anything.`
   textbox with `run hostname and node --version` and press Enter.
   `agent-browser --session $S wait --text "Provisioned thread" --timeout 240000`.
   Expect the answer to show a `bb-…` hostname and Node v24, and the composer
   footer to read `exe.dev VM xxxxxx`.
2. **Projectless thread.** Same, but pick **Don't work in a project** first.
   The `Environment` picker must list `Personal workspace` and **exe.dev VM**.
   `pwd` on the VM is under
   `~/.bb-machines/<server>/plugins/environment-personal-workspace/…`.
3. **Pause/resume from the thread header** (needs the separate Sandbox Power
   plugin): `Pause sandbox` → `ssh exe.dev ls` shows `paused`; `Resume sandbox`
   → the machine is `connected` again.
4. **Cleanup.** `bb thread archive <thread-id>` (the id is in the URL). The VM
   disappears from `ssh exe.dev ls` within seconds.

Close the browser session with `agent-browser --session $S close`.

"Not logged in" from the agent means the VM has no agent credentials (Account
Pooler or `CLAUDE_CODE_OAUTH_TOKEN`); provisioning itself still succeeded.

## 5. Looking inside a VM

```sh
ssh exe.dev ls                                   # all VMs, tags, status
npm run doctor -- --vm <vm-name>                 # health facts as JSON
ssh <vm-name>.exe.xyz                            # a shell, with your own exe.dev SSH key
```

On the VM: `systemctl --user status 'bb-host-daemon*'`, the daemon log under
`~/.bb-machines/<server>/`, and bb's checkouts under
`~/.bb-machines/<server>/checkouts/`.

## Where state lives

| What | Where |
|---|---|
| Machine resource (`key`, `vmName`, `accountEmail`) | bb, per host: `bb.experimental_machines.getResource` |
| Last activity per machine (idle pause) | plugin kv `idle/<hostId>` |
| API token | bb secret settings for this plugin |
| VM name | `bb-` + first 16 hex chars of sha256(launch key) |

Clean up after validating: no `bb-*` VMs left in `ssh exe.dev ls` that you did
not mean to keep, and `npm run doctor` passes.
