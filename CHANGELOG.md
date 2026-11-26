# Changelog

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
