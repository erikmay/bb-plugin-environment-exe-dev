# Changelog

## 0.1.0 — 2026-11-26

- First release: `exe-dev` machine provider and "exe.dev VM" environment.
- One VM per thread, named from bb's launch key; idempotent create and
  key-based cleanup.
- Pause/resume via exe.dev, automatic idle pause (default 15 minutes).
- Installs Node.js 24 and enables a persistent systemd user session on VMs.
- Tested with bb 0.50.1 / plugin SDK 0.6.157, synced to bb fb045a0.
