# exe.dev VMs for bb

A [bb](https://github.com/get-bb/bb) plugin that runs every thread in its own
[exe.dev](https://exe.dev) VM.

- **One VM per thread.** Pick **exe.dev VM** in the new-thread environment
  picker. bb creates a VM, installs its daemon, checks out the project, and
  shows the machine as "exe.dev VM xxxxxx" under the composer.
- **With or without a project.** In a project the VM gets a project checkout;
  with "Don't work in a project" it gets a personal workspace directory.
- **Pause when idle.** After 15 idle minutes (configurable) the VM is paused.
  A VM whose agent is still working is never paused.
  exe.dev keeps its memory and disk; the next message resumes it.
- **Cleaned up with the thread.** Archiving the last thread on a VM deletes it.
- **No session cap.** Unlike Modal (24 h) or Vercel Sandbox, exe.dev VMs are
  ordinary long-lived VMs with persistent disks and real SSH.

> [!NOTE]
> Experimental. Built on bb's `experimental_machines` /
> `experimental_environments` plugin APIs, which may change. Not affiliated
> with exe.dev or bb.

## Requirements

- bb ≥ 0.50 and a server address the VM can reach. Either:
  - **bb connect** (Settings → bb connect): the VM reaches your server through
    getbb.app; or
  - **Tailscale**: serve bb on your tailnet (`tailscale serve --https=443
    http://127.0.0.1:38886`, `BB_APP_URL` and Settings → Machines → Server URL
    set to the `https://<machine>.<tailnet>.ts.net` address, default machine
    access `direct`) and set `tailscaleAuthKey`. Each VM then joins the
    tailnet before bb starts. See "Tailscale" below.
- An exe.dev account.
- Agent credentials for the VM, because your local Claude Code / Codex login
  does not travel with it. Use bb's Account Pooler plugin, or set
  `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) under Settings →
  Environment variables.

## Install

```sh
bb plugin install git:https://github.com/erikmay/bb-plugin-environment-exe-dev.git@^0.3.0
```

Create an API token that can only manage VMs tagged `bb`:

```sh
ssh exe.dev "ssh-key generate-api-key --label=bb --tag=bb \
  --cmds='whoami,ls,new,rm,pause,resume,ssh,stat' --exp=365d --json"
```

Paste the `token` into Settings → Plugins → exe.dev VMs → **apiToken**, or:

```sh
bb plugin config environment-exe-dev set apiToken <token>
```

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `apiToken` | — | exe.dev API token (secret) |
| `tailscaleAuthKey` | empty | Tailscale auth key (secret); when set, every VM joins your tailnet |
| `idleMinutes` | `15` | Pause a VM after this many idle minutes; `0` disables |
| `cpu` | `0` (exe.dev default) | CPUs for new VMs |
| `memory` | exe.dev default | e.g. `8GB` |
| `disk` | exe.dev default | e.g. `50GB` |
| `image` | `exeuntu` | Image for new VMs; exeuntu ships Claude Code, Codex, git and build tools |

## How it works

1. `create` makes a VM named `bb-<hash of bb's launch key>` (retries reuse it),
   then installs Node.js 24 when missing and enables a persistent systemd user
   session so bb's daemon runs as a service.
2. bb's own bootstrap installs and enrolls its daemon through the plugin's
   command runner (`vm.ssh`; stdin goes through a temporary 0600 file).
3. Pause and resume map to exe.dev `pause`/`resume`. Delete maps to `rm`.
4. Idle tracking runs on your bb server, like bb's Modal plugin. **If the bb
   server is asleep or stopped, nothing pauses idle VMs.**

## Tailscale

With `tailscaleAuthKey` set, the plugin installs Tailscale on each VM and runs
`tailscale up` with the key (from a 0600 file that is deleted right after,
never on a command line) before bb bootstraps its daemon. On resume it checks
the connection and joins again if the node expired while the VM was paused.
The VM's tailnet name is its exe.dev name.

Create the key in the Tailscale admin (Settings → Keys → Generate auth key):
**reusable**, **ephemeral** (nodes disappear after the VM is deleted),
**pre-approved**, tagged e.g. `tag:bb-sandbox`. Limit the tag in your policy
to the bb server only:

```jsonc
"tagOwners": { "tag:bb-server": ["autogroup:admin"], "tag:bb-sandbox": ["autogroup:admin"] },
"grants": [
  { "src": ["autogroup:member"], "dst": ["tag:bb-server"], "ip": ["tcp:443"] },
  { "src": ["tag:bb-sandbox"], "dst": ["tag:bb-server"], "ip": ["tcp:443"] },
],
```

## Security notes

- Agents on a VM run with the permission mode you choose (often Full Access)
  and can read everything on that VM, including injected credentials.
- bb forwards the server's `gh` login to non-primary machines as `GH_TOKEN` by
  default. Prefer a fine-grained token scoped to the repositories you use
  (Settings → Environment variables).
- The token scope above is the minimum this plugin needs.

## Development

```sh
npm install
npm run typecheck
npm test                   # unit tests, no secrets
npm run test:live          # against real exe.dev, needs EXE_TOKEN
bb plugin install .        # from this checkout
```

Maintenance is mostly automated: a weekly job compares the plugin against
bb's upstream code and opens an issue on drift, an optional Claude Code
workflow turns such issues (or any issue labelled `agent`) into pull
requests, and merging a version bump publishes the release. See
**Automation** in `AGENTS.md`.

`npm run doctor` checks a local install end to end (bb plugin, providers,
machines, logs, and with `EXE_TOKEN`/`EXE_TOKEN_FILE` the matching exe.dev VMs).
[docs/VALIDATION.md](docs/VALIDATION.md) covers CLI and UI validation against
http://127.0.0.1:38886/. `AGENTS.md` describes the architecture, invariants,
and how to upgrade the plugin when bb changes (`npm run upstream:check`).

## License

MIT. Parts of `providers/` and `server.ts` are adapted from bb's Modal sandbox
plugin (MIT, © 2026 Michael Yong). See [LICENSE](LICENSE).
