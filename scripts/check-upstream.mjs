#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"));
const target = process.argv[2] ?? "main";
const keep = process.argv.includes("--keep");
const checkout = mkdtempSync(join(tmpdir(), "bb-upstream-"));

const git = (...args) =>
  execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });

try {
  execFileSync("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", upstream.repository, checkout], {
    stdio: "inherit",
  });
  git("fetch", "--quiet", "origin", target);
  const targetCommit = git("rev-parse", "FETCH_HEAD").trim();
  const paths = upstream.tracked.map((entry) => entry.upstream);

  console.log(`Synced: ${upstream.syncedCommit.slice(0, 12)} (${upstream.syncedAt})`);
  console.log(`Target: ${targetCommit.slice(0, 12)} (${target})\n`);

  const stat = git("diff", "--stat", upstream.syncedCommit, targetCommit, "--", ...paths);
  console.log(stat.trim().length === 0 ? "Tracked upstream files are unchanged." : stat);

  const patch = git("diff", upstream.syncedCommit, targetCommit, "--", ...paths);
  const patchFile = join(root, "upstream-diff.patch");
  writeFileSync(patchFile, patch);
  if (patch.length > 0) console.log(`Full diff written to upstream-diff.patch`);

  const sdkPackage = JSON.parse(git("show", `${targetCommit}:packages/plugin-sdk/package.json`));
  console.log(`\nUpstream @get-bb/plugin-sdk: ${sdkPackage.version} (synced against ${upstream.testedPluginSdk})`);

  const sdkHits = [];
  for (const symbol of upstream.watchForPublicApis) {
    let out = "";
    try {
      out = git("grep", "-l", symbol, targetCommit, "--", "packages/plugin-sdk/src");
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    if (out.trim().length > 0) sdkHits.push(`${symbol}: ${out.trim().split("\n").length} file(s)`);
  }
  console.log(sdkHits.length === 0 ? "No watched symbols in the public SDK." : `Watched symbols in the public SDK:\n  ${sdkHits.join("\n  ")}`);

  const renamed = git("diff", "--name-status", "--diff-filter=DR", upstream.syncedCommit, targetCommit, "--", ...paths).trim();
  if (renamed.length > 0) console.log(`\nMoved or deleted upstream files (update upstream.json):\n${renamed}`);
} finally {
  if (keep) console.log(`\nUpstream checkout kept at ${checkout}`);
  else rmSync(checkout, { recursive: true, force: true });
}
