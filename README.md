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
    access `direct`) and set a Tailscale OAuth client. Each VM then joins the
    tailnet before bb starts. See "Tailscale" below.
- An exe.dev account.
- Agent credentials for the VM, because your local Claude Code / Codex login
  does not travel with it. Use bb's Account Pooler plugin, or set
  `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) under Settings →
  Environment variables.

## Install

```sh
bb plugin install git:https://github.com/erikmay/bb-plugin-environment-exe-dev.git@^0.4.0
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
| `tailscaleOAuthClientId`, `tailscaleOAuthClientSecret` | empty | Tailscale OAuth client (secret); when set, every VM joins your tailnet with its own single-use key |
| `tailscaleTags` | `tag:bb-sandbox` | Tags every VM joins with (required) |
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

With a Tailscale OAuth client configured, the plugin installs Tailscale on
each VM and joins it to your tailnet before bb bootstraps its daemon:

1. It asks the VM for its Tailscale state first. A VM that is connected and
   reaches the bb server gets no key at all.
2. Otherwise it mints a fresh auth key through the Tailscale API: single use,
   ephemeral, pre-approved, with `tailscaleTags`, valid for five minutes.
3. The VM runs `tailscale up --reset --force-reauth` with that key,
   `--advertise-tags`, `--shields-up` and `--accept-routes=false`, then must
   reach the bb server (`machineServerUrl`) within 30 seconds.

This also repairs a VM whose ephemeral node expired while it was paused
(Tailscale removes offline ephemeral nodes after 30 to 60 minutes). Before a
running VM is deleted, the plugin runs `tailscale logout`, so its node
disappears at once.

Create the OAuth client in the Tailscale admin (Settings → Trust credentials
→ OAuth client) with the **Auth Keys: write** scope and your sandbox tag. Limit
the tag in your policy to the bb server only:

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

## Known limitations

- Idle detection counts thread activity and terminal input. A build or dev
  server running in a bb terminal without keystrokes can be paused after
  `idleMinutes`; raise it or set it to `0` for such work.
- A turn that hangs as "working" keeps its VM from being paused.
- A VM whose bb machine is gone (for example after the exe.dev token changed)
  is not deleted automatically; `ssh exe.dev ls` shows it.

## Development

```sh
npm install
npm run typecheck && npm test
npm run test:live          # against real exe.dev, needs EXE_TOKEN
bb plugin install .        # from this checkout
```

`AGENTS.md` describes the architecture, invariants, releasing, and how to
follow bb upstream.

## License

MIT. Parts of `providers/` and `server.ts` are adapted from bb's Modal sandbox
plugin (MIT, © 2026 Michael Yong). See [LICENSE](LICENSE).
