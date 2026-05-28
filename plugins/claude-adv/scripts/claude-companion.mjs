#!/usr/bin/env node
// Generated from scripts/claude-companion.mjs by scripts/release/sync-codex-bundle.mjs. Do not edit.
// scripts/claude-companion.mjs — main entry point for the claude-adv plugin.
// Dispatches subcommands to handler functions.

import process from "node:process";

import { normalizeArgv } from "./lib/args.mjs";

export { normalizeArgv };

const SUBCOMMANDS = new Set([
  "setup",
  "review",
  "adversarial-review",
  "task",
  "status",
  "result",
  "cancel",
]);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/claude-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--set-budget-usd <N>] [--set-rescue-budget-usd <N>] [--set-worker-budget-multiplier <N>] [--json]",
      "  node scripts/claude-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--json]",
      "  node scripts/claude-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--json] [focus text]",
      "  node scripts/claude-companion.mjs task [--background] [--model <model>] [--effort <low|medium|high|xhigh|max>] [prompt]",
      "  node scripts/claude-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/claude-companion.mjs result [job-id] [--json]",
      "  node scripts/claude-companion.mjs cancel [job-id] [--json]",
    ].join("\n")
  );
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  if (!SUBCOMMANDS.has(subcommand)) {
    throw new Error(`Unknown subcommand: ${subcommand}. Run with --help for usage.`);
  }

  // Lazy-load handler so a single misbehaving import doesn't break --help.
  const mod = await import(`./companion-handlers/${subcommand}.mjs`);
  await mod.handle(normalizeArgv(rest));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
