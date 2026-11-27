# Changelog

## 0.4.0 — 2026-11-27

Changes from an independent code review.

- Tailscale: OAuth client support (`tailscaleOAuthClientId`,
  `tailscaleOAuthClientSecret`). Every join gets its own single-use,
  ephemeral, pre-approved, five-minute key, so nothing reusable reaches a VM.
  The static `tailscaleAuthKey` stays as a fallback and must be a
  `tskey-auth-` key. New `tailscaleTags` (default `tag:bb-sandbox`, required).
- Tailscale join is checked, not assumed: the plugin probes the VM first and
  sends a key only when needed, joins with `--reset --force-reauth
  --advertise-tags --shields-up --accept-routes=false`, and requires the VM to
  reach the bb server. This fixes VMs whose ephemeral node expired during a
  long pause.
- Before a running VM is deleted it runs `tailscale logout`, so its node
  leaves the tailnet at once.
- No more VMs billed behind bb's back: pauses retry, a failed resume pauses
  the VM again, and the idle sweep pauses VMs that still run while bb shows
  their machine as suspended.
- The time of the last idle sweep is stored, so a bb restart no longer pauses
  VMs before their daemons reconnect. A corrupt idle value no longer warns
  every minute.
- Client-side timeouts on every exe.dev call (account check, boot, pause,
  delete, commands); executor errors are shown in the provisioning log.
- Stale secret files in `~/.bb-exe-dev` are purged; the Tailscale installer is
  downloaded before it runs, so a failed download reports correctly.

## 0.3.0 — 2026-11-27

- Tailscale: new optional secret setting `tailscaleAuthKey`. When set, every
  VM installs Tailscale and joins your tailnet (key from a 0600 file, never on
  a command line) before bb bootstraps, so a bb server served only on the
  tailnet works without bb connect. Resume rejoins when the ephemeral node
  expired during a pause.

## 0.2.2 — 2026-11-26

- Fix: idle pause no longer interrupts a working agent. A turn that waited on
  one slow tool call (for example a hanging web fetch) emitted no events for
  longer than `idleMinutes`, so the VM was paused mid-turn and bb stopped the
  turn with "Machine preservation is interrupting this turn". Machines with a
  running turn are now never paused, and their idle clock restarts.
- Fix: no idle pause right after the bb server was frozen (for example the
  laptop running bb slept). VMs keep working while bb sleeps but cannot report;
  after more than three minutes without a sweep every idle clock restarts so
  the VMs can reconnect and deliver their events first.

## 0.2.1 — 2026-11-26

- Pin Node.js to 24.22.3 with built-in SHA-256 checksums instead of
  `latest-v24.x`, so every VM gets the same, reviewed build. The upstream
  watch reports newer Node.js releases.
- Fail clearly on unsupported CPU architectures instead of guessing x64.
- Cleaner provisioning log: no duplicate "Creating" step, the VM name is part
  of each step, npm's update and funding notices are silenced.

## 0.2.0 — 2026-11-26

- Projectless threads ("Don't work in a project") can now run in an exe.dev
  VM: a second environment, `exe-dev-workspace`, pairs the exe.dev machine
  provider with bb's built-in Personal workspace.

## 0.1.0 — 2026-11-26

- First release: `exe-dev` machine provider and "exe.dev VM" environment.
- One VM per thread, named from bb's launch key; idempotent create and
  key-based cleanup.
- Pause/resume via exe.dev, automatic idle pause (default 15 minutes).
- Installs Node.js 24 and enables a persistent systemd user session on VMs.
- Tested with bb 0.50.1 / plugin SDK 0.6.157, synced to bb fb045a0.
