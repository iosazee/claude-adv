import fs from "node:fs";

import { getSessionRuntimeStatus } from "./claude-cli.mjs";
import { isProcessAlive } from "./process.mjs";
import {
  getConfig,
  listJobs,
  readJobFile,
  resolveJobFile,
  upsertJob,
  writeJobFile,
} from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
export const WARN_CROSS_SESSION_ENV = "CLAUDE_ADV_WARN_CROSS_SESSION";

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function inferLegacyJobPhase(progressPreview = []) {
  // For each line in the progress preview (typically the last N stdout lines
  // captured by tracked-jobs), try to parse it as a stream-json event and
  // map to a legacy phase string the rest of the codebase already expects.
  for (const line of progressPreview) {
    const trimmed = String(line ?? "").trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "system" && event.subtype === "init") return "starting";
    if (event.type === "assistant") return "running";
    if (event.type === "result") {
      return event.subtype === "success" ? "completed" : "failed";
    }
  }
  return null;
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null,
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched.progressPreview),
  };
}

// Detect background-job records that say status="running" (or "queued") but
// whose recorded PID is no longer alive. The worker died abnormally (SIGKILL,
// OOM, parent killed mid-write) so the catch/finally block that normally
// rewrites the record to "failed" never fired. Without this, the job sticks
// at "running" forever and /claude-adv:status keeps lying about it.
//
// Called from status-read paths (buildStatusSnapshot, buildSingleJobSnapshot)
// before snapshots are produced. Mutates the on-disk record and state index.
// Returns the list of jobs that were reaped, with their new patched fields.
//
// Conservative under uncertainty: a job without a pid (legacy records or
// queued state where the spawn hasn't recorded a pid yet) is left untouched.
// A live PID is left untouched even if there's no startTime stored — only
// definitive deadness gets reaped.
export function reapDeadJobs(workspaceRoot, jobs) {
  const reaped = [];
  for (const job of jobs ?? []) {
    if (job.status !== "running" && job.status !== "queued") continue;
    if (!Number.isFinite(job.pid) || job.pid <= 0) continue;
    if (isProcessAlive(job.pid, job.startTime ?? null)) continue;

    const completedAt = new Date().toISOString();
    const patched = {
      ...job,
      status: "failed",
      phase: "failed",
      errorMessage:
        job.errorMessage ??
        "worker process exited without writing a result (likely SIGKILL, OOM, or parent died mid-write)",
      completedAt,
      pid: null,
    };
    try {
      writeJobFile(workspaceRoot, job.id, patched);
      upsertJob(workspaceRoot, {
        id: job.id,
        status: "failed",
        phase: "failed",
        errorMessage: patched.errorMessage,
        completedAt,
        pid: null,
      });
    } catch {
      /* best-effort; if disk write fails we'll just probe again next time */
    }
    reaped.push(patched);
  }
  return reaped;
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export function maybeWarnCrossSession(operation, job, options = {}) {
  const env = options.env ?? process.env;
  const expected = env[WARN_CROSS_SESSION_ENV];
  if (!expected || !job?.sessionId || job.sessionId === expected) {
    return;
  }
  process.stderr.write(
    `claude-adv-runtime: warning: cross-session ${operation} ` +
      `(expected=${expected} target=${job.sessionId} job=${job.id})\n`
  );
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /claude-adv:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  // Reap dead-PID jobs first so the snapshot never reports stale-running jobs
  // whose worker died without writing a result.
  reapDeadJobs(workspaceRoot, listJobs(workspaceRoot));
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw =
    jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw
    ? enrichJob(latestFinishedRaw, { maxProgressLines })
    : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter(
      (job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id
    )
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate),
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reapDeadJobs(workspaceRoot, listJobs(workspaceRoot));
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(
      `No job found for "${reference}". Run /claude-adv:status to inspect known jobs.`
    );
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines }),
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // If the user asks for a job's result and its worker died abnormally, the
  // reaper turns the record into status="failed" here so /result can render
  // it instead of refusing with "still running."
  reapDeadJobs(workspaceRoot, listJobs(workspaceRoot));
  const jobs = sortJobsNewestFirst(
    reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot))
  );
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "queued" || job.status === "running"
  );
  if (active) {
    throw new Error(
      `Job ${active.id} is still ${active.status}. Check /claude-adv:status and try again once it finishes.`
    );
  }

  if (reference) {
    throw new Error(
      `No finished job found for "${reference}". Run /claude-adv:status to inspect active jobs.`
    );
  }

  throw new Error("No finished Claude-adv jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Claude-adv jobs are active. Pass a job id to /claude-adv:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Claude-adv jobs to cancel for this session.");
  }

  throw new Error("No active Claude-adv jobs to cancel.");
}
