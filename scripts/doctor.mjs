#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const vmToCheck = flag("--vm");
const logLines = flag("--log-lines") ?? "15";

const PLUGIN_ID = "environment-exe-dev";
const PROVIDER_ID = "exe-dev";
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const redact = (text) => text.replace(EMAIL, "<email>");

let problems = 0;
const ok = (message) => console.log(`  ok    ${message}`);
const warn = (message) => {
  problems += 1;
  console.log(`  WARN  ${message}`);
};
const info = (message) => console.log(`        ${message}`);
const section = (title) => console.log(`\n== ${title}`);

function findBb() {
  if (process.env.BB_CLI) return process.env.BB_CLI;
  try {
    execFileSync("bb", ["--version"], { stdio: "ignore" });
    return "bb";
  } catch {
    const bundled = join(homedir(), ".bb", "bin", "bb");
    return existsSync(bundled) ? bundled : null;
  }
}

function bbJson(bb, ...command) {
  return JSON.parse(execFileSync(bb, [...command, "--json"], { encoding: "utf8", maxBuffer: 32 << 20 }));
}

function readToken() {
  if (process.env.EXE_TOKEN) return process.env.EXE_TOKEN.trim();
  const file =
    process.env.EXE_TOKEN_FILE ?? join(homedir(), ".config", "bb-exe-dev", "token.json");
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8").trim();
  return raw.startsWith("{") ? JSON.parse(raw).token : raw;
}

const bb = findBb();
section("bb");
if (bb === null) {
  warn("bb CLI not found (set BB_CLI, put bb on PATH, or install the desktop app)");
  process.exit(1);
}
info(`CLI: ${bb} (${execFileSync(bb, ["--version"], { encoding: "utf8" }).trim()})`);

let bbMachines = [];
try {
  const plugins = bbJson(bb, "plugin", "list");
  const plugin = (Array.isArray(plugins) ? plugins : plugins.plugins).find((entry) => entry.id === PLUGIN_ID);
  if (plugin === undefined) warn(`plugin ${PLUGIN_ID} is not installed`);
  else if (plugin.status !== "running") warn(`plugin ${PLUGIN_ID} ${plugin.version} is ${plugin.status}${plugin.statusDetail ? `: ${plugin.statusDetail}` : ""}`);
  else ok(`plugin ${PLUGIN_ID} ${plugin.version} running (${plugin.sourceDisplay ?? plugin.source})`);

  const machineProviders = bbJson(bb, "machine", "providers");
  if (machineProviders.some((entry) => entry.id === PROVIDER_ID)) ok(`machine provider ${PROVIDER_ID} registered`);
  else warn(`machine provider ${PROVIDER_ID} missing from bb machine providers`);

  const environmentProviders = bbJson(bb, "environment", "providers");
  const environments = Array.isArray(environmentProviders) ? environmentProviders : environmentProviders.providers ?? [];
  for (const [id, projectless] of [[PROVIDER_ID, false], [`${PROVIDER_ID}-workspace`, true]]) {
    const entry = environments.find((candidate) => candidate.id === id);
    if (entry === undefined) warn(`environment ${id} missing from bb environment providers`);
    else if (Boolean(entry.requires?.projectless) !== projectless) warn(`environment ${id} has projectless=${entry.requires?.projectless}`);
    else ok(`environment ${id} (${projectless ? "projectless" : "project"} threads)`);
  }

  bbMachines = bbJson(bb, "machine", "list", "--all").filter((host) => host.machineProviderId === PROVIDER_ID);
  info(`bb machines from ${PROVIDER_ID}: ${bbMachines.length}`);
  for (const host of bbMachines) {
    info(`- ${host.id}  ${host.name}  ${host.type}  ${host.lifecycle.phase}/${host.status}`);
  }
} catch (error) {
  warn(`bb query failed: ${redact(error.message.split("\n")[0])}`);
}

section("plugin log");
try {
  const log = execFileSync(bb, ["plugin", "logs", PLUGIN_ID, "-n", logLines], { encoding: "utf8" });
  for (const line of log.trim().split("\n")) {
    try {
      const entry = JSON.parse(line);
      info(`${new Date(entry.ts).toISOString()} ${entry.level.padEnd(5)} ${redact(entry.message)}`);
    } catch {
      info(redact(line));
    }
  }
} catch (error) {
  warn(`could not read plugin log: ${redact(error.message.split("\n")[0])}`);
}

section("exe.dev");
const token = readToken();
if (token === null) {
  info("skipped: set EXE_TOKEN or EXE_TOKEN_FILE (bare token or JSON with token) to compare against exe.dev");
} else {
  const { default: exedev } = await import("@exedev/sdk");
  const exe = exedev({ token, userAgent: "bb-plugin-environment-exe-dev-doctor" });
  try {
    await exe.whoami();
    ok("API token accepted");
    const vms = (await exe.ls()).filter((vm) => vm.name.startsWith("bb-"));
    info(`bb-* VMs visible to the token: ${vms.length}`);
    const bySuffix = new Map(bbMachines.map((host) => [host.name.slice(-6), host]));
    for (const vm of vms) {
      const host = bySuffix.get(vm.name.slice(-6));
      info(`- ${vm.name}  ${vm.info.status ?? "?"}  ${vm.info.comment ?? ""}${host ? `  -> ${host.id}` : ""}`);
      if (host === undefined) warn(`${vm.name} has no bb machine (orphan, still counts toward your exe.dev pool)`);
      else if (vm.info.status === "paused" && host.lifecycle.phase === "active") warn(`${vm.name} is paused but bb thinks ${host.id} is active`);
    }
    for (const host of bbMachines) {
      if (!vms.some((vm) => vm.name.endsWith(host.name.slice(-6)))) {
        warn(`${host.id} (${host.name}) has no exe.dev VM; remove it with: bb machine remove ${host.id} --yes`);
      }
    }

    if (vmToCheck !== undefined) {
      section(`VM ${vmToCheck}`);
      const vm = exe.vm(vmToCheck);
      await vm.refresh();
      if (vm.info.status !== "running") {
        warn(`VM is ${vm.info.status}; resume it first (bb machine resume <id>)`);
      } else {
        const result = await vm.ssh(`export XDG_RUNTIME_DIR=/run/user/$(id -u)
echo "node=$(node --version 2>/dev/null || echo missing)"
echo "linger=$(ls /var/lib/systemd/linger 2>/dev/null | tr '\\n' ' ')"
echo "service=$(systemctl --user list-units --type=service --no-legend 2>/dev/null | grep -o 'bb-host-daemon[^ ]*' | head -1) $(systemctl --user is-active 'bb-host-daemon*' 2>/dev/null | head -1)"
echo "stdin_leftovers=$(ls ~/.bb-exe-dev 2>/dev/null | wc -l | tr -d ' ')"
echo "disk=$(df -h ~ | tail -1 | awk '{print $3"/"$2}')"
echo "uptime=$(uptime -p)"`);
        const facts = Object.fromEntries(
          result.stdout.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
        );
        info(JSON.stringify(facts));
        if (facts.node === "missing") warn("node is missing; bb's daemon needs Node.js >= 22.19");
        if (!facts.linger) warn("systemd linger is off; the daemon will not survive a cold boot");
        if (!facts.service?.includes("active")) warn("bb host daemon service is not active");
        if (facts.stdin_leftovers !== "0") warn("bootstrap stdin files were left in ~/.bb-exe-dev");
      }
    }
  } catch (error) {
    warn(`exe.dev query failed: ${redact(error.message)}`);
  }
}

console.log(problems === 0 ? "\nAll checks passed." : `\n${problems} problem(s) found.`);
process.exit(problems === 0 ? 0 : 1);
