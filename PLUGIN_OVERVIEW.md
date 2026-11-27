Run bb threads in their own exe.dev VM.

## What you get

- **exe.dev VM** in the new-thread environment picker: each thread gets a fresh
  VM with the project checked out, shown as "exe.dev VM xxxxxx" under the
  composer.
- Idle VMs pause automatically (default 15 minutes; RAM and disk are kept) and
  resume on the next message. Archiving the last thread deletes the VM.
- `bb machine create --provider exe-dev` for standalone machines.

## How it works

The plugin creates a VM through the exe.dev HTTPS API (named from bb's launch
key, so retries reuse it), installs Node.js 24 if the image lacks it, enables a
persistent systemd user session, and hands bb a command runner so bb installs
and enrolls its own daemon. Pause and resume use exe.dev's pause/resume, which
keep memory and disk. The idle check runs on the bb server.

## Setup

1. Create a tag-scoped API token:
   `ssh exe.dev "ssh-key generate-api-key --label=bb --tag=bb --cmds='whoami,ls,new,rm,pause,resume,ssh,stat' --exp=365d --json"`
2. Set it: Settings → Plugins → exe.dev VMs → apiToken, or
   `bb plugin config environment-exe-dev set apiToken <token>`.
3. The VM must reach the bb server: through bb connect, or through Tailscale
   (bb served on your tailnet plus a Tailscale OAuth client in the plugin
   settings; each VM then joins the tailnet with its own single-use key and
   leaves it when deleted).
4. Agents need credentials on the VM: Account Pooler or `CLAUDE_CODE_OAUTH_TOKEN`
   in Settings → Environment variables.
