// Generated from scripts/companion-handlers/result.mjs by scripts/release/sync-codex-bundle.mjs. Do not edit.
// scripts/companion-handlers/result.mjs
import path from "node:path";
import { parseJobReferenceArgs } from "../lib/args.mjs";
import { maybeWarnCrossSession, resolveResultJob, readStoredJob } from "../lib/job-control.mjs";
import { renderStoredJobResult } from "../lib/render.mjs";

export async function handle(argv) {
  const { options, positionals } = parseJobReferenceArgs(argv);
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  if (reference) {
    maybeWarnCrossSession("result", job, { env: process.env });
  }
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = { job, storedJob };
  if (options.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    process.stdout.write(renderStoredJobResult(job, storedJob));
  }
}
