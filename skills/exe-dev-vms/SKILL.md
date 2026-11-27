---
name: exe-dev-vms
description: Create, pause, resume and remove exe.dev VMs as bb machines, and troubleshoot threads that run on them.
---

# exe.dev VMs

The `environment-exe-dev` plugin registers the machine provider `exe-dev` and
the environment "exe.dev VM".

1. Check configuration with `bb plugin list` (the plugin must be `running`, not
   `needs-configuration`) and `bb machine providers` (lists `exe-dev`). Never
   print `apiToken`.
2. A new thread on its own VM: choose the "exe.dev VM" environment, in a
   project (project checkout) or without one (personal workspace,
   `bb thread spawn --environment-provider exe-dev-workspace`). From the
   CLI, a standalone machine: `bb machine create --provider exe-dev --json`
   (pass `--key <stable-key>` when retrying).
3. Lifecycle: `bb machine suspend <id>`, `bb machine resume <id>`,
   `bb machine remove <id> --yes`. Thread VMs are deleted when their last
   thread is archived. `bb machine list --all` shows thread VMs.
4. Idle VMs pause after `idleMinutes` (default 15):
   `bb plugin config environment-exe-dev set idleMinutes <n>`.

Troubleshooting:

- "Not logged in" from the agent: the VM has no agent credentials. Use the
  Account Pooler plugin or a `CLAUDE_CODE_OAUTH_TOKEN` machine environment
  variable.
- Provisioning cannot reach the server: the VM needs a route to bb, either
  bb connect or the tailnet (the plugin's Tailscale OAuth client settings).
- `bb plugin logs environment-exe-dev` shows connection and idle-pause events.
