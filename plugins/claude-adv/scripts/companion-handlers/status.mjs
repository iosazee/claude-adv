// Generated from scripts/companion-handlers/status.mjs by scripts/release/sync-codex-bundle.mjs. Do not edit.
// scripts/companion-handlers/status.mjs
import path from "node:path";
import { parseArgs } from "../lib/args.mjs";
import { buildStatusSnapshot, buildSingleJobSnapshot } from "../lib/job-control.mjs";
import { renderStatusReport, renderJobStatusReport } from "../lib/render.mjs";

export async function handle(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"],
  });
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const reference = positionals[0] ?? "";

  let payload, rendered;
  if (reference) {
    payload = buildSingleJobSnapshot(cwd, reference);
    rendered = renderJobStatusReport(payload.job);
  } else {
    payload = buildStatusSnapshot(cwd, { all: options.all });
    rendered = renderStatusReport(payload);
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    process.stdout.write(rendered);
  }
}
