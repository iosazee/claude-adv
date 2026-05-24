// scripts/companion-handlers/cancel.mjs
import path from "node:path";
import { parseJobReferenceArgs } from "../lib/args.mjs";
import { maybeWarnCrossSession, resolveCancelableJob, readStoredJob } from "../lib/job-control.mjs";
import { writeJobFile, upsertJob } from "../lib/state.mjs";
import { terminateProcessTree, isProcessAlive } from "../lib/process.mjs";
import { renderCancelReport } from "../lib/render.mjs";

function nowIso() {
  return new Date().toISOString();
}

export async function handle(argv) {
  const { options, positionals } = parseJobReferenceArgs(argv);
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  if (reference) {
    maybeWarnCrossSession("cancel", job, { env: process.env });
  }
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  // For one-shot foreground/background subprocess jobs, kill the PID tree —
  // but only when the recorded PID is still the SAME process we launched.
  // PIDs are recycled by the OS; a stale job record could otherwise name a
  // PID now owned by an unrelated process and we'd SIGKILL it. isProcessAlive
  // cross-checks the OS start-time captured at launch (job.startTime) before
  // we signal, the same guard the background-job reaper uses.
  const cancelPid = job.pid ?? Number.NaN;
  if (isProcessAlive(cancelPid, job.startTime ?? null)) {
    terminateProcessTree(cancelPid);
  }

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user.",
  };
  writeJobFile(workspaceRoot, job.id, { ...existing, ...nextJob, cancelledAt: completedAt });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt,
  });

  const payload = { jobId: job.id, status: "cancelled", title: job.title };
  if (options.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    process.stdout.write(renderCancelReport(nextJob));
  }
}
