// Generated from scripts/companion-handlers/task.mjs by scripts/release/sync-codex-bundle.mjs. Do not edit.
// scripts/companion-handlers/task.mjs
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { parseArgs } from "../lib/args.mjs";
import { buildRescueArgs, detectReviewerAuthClass, spawnAndCollect } from "../lib/claude-cli.mjs";
import { captureProcessStartTime } from "../lib/process.mjs";
import {
  generateJobId,
  getConfig,
  upsertJob,
  upsertJobUnlessStatus,
  writeJobFile,
  writeJobFileUnlessStatus,
} from "../lib/state.mjs";
import { createJobRecord } from "../lib/tracked-jobs.mjs";
import { readStoredJob } from "../lib/job-control.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

function isTerminalJob(job) {
  return TERMINAL_JOB_STATUSES.has(job?.status);
}

function startTimeCaptureState(startTime) {
  return startTime ? "captured" : "unavailable";
}

function startTimeCaptureError(label, startTime) {
  if (startTime) {
    return null;
  }
  return `could not capture process start-time for ${label}; PID-only liveness fallback is active`;
}

function readPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  return positionals.join(" ").trim();
}

export async function handle(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "job-id"],
    booleanOptions: ["json", "background"],
  });
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const budgetUsd = config.rescueBudgetUsd ?? 20;

  const prompt = readPrompt(cwd, options, positionals);
  if (!prompt && !options["job-id"]) {
    throw new Error("task: provide a prompt, --prompt-file, or piped stdin.");
  }

  // Background dispatch — same pattern as review handlers.
  if (options.background && !options["job-id"]) {
    const jobId = generateJobId("task");
    const initialRecord = createJobRecord({
      id: jobId,
      kind: "task",
      kindLabel: "rescue",
      title: "Claude Task",
      workspaceRoot,
      jobClass: "task",
      summary: prompt.slice(0, 96),
      write: true,
    });
    initialRecord.status = "queued";
    initialRecord.phase = "queued";
    writeJobFile(workspaceRoot, jobId, { ...initialRecord, request: { argv, prompt, cwd } });
    upsertJob(workspaceRoot, initialRecord);

    const scriptPath = path.join(ROOT, "scripts/claude-companion.mjs");
    const child = spawn(
      process.execPath,
      [scriptPath, "task", ...argv.filter((a) => a !== "--background"), "--job-id", jobId],
      { detached: true, stdio: "ignore", env: process.env }
    );
    child.unref();

    // Persist live PID/PGID so /claude-adv:cancel <job-id> can kill it.
    const childPgid = (() => {
      try {
        return process.getpgid?.(child.pid) ?? child.pid;
      } catch {
        return child.pid;
      }
    })();
    // Capture before advertising the worker as running. If ps is unavailable,
    // the job records the degraded PID-only liveness fallback explicitly.
    const startTimeLabel = "background task worker";
    const startTime = await captureProcessStartTime(child.pid, {
      label: startTimeLabel,
    });
    const startedAt = new Date().toISOString();
    const runningRecord = {
      ...initialRecord,
      status: "running",
      phase: "running",
      pid: child.pid,
      pgid: childPgid,
      startTime,
      startTimeCapture: startTimeCaptureState(startTime),
      startTimeCaptureError: startTimeCaptureError(startTimeLabel, startTime),
      startedAt,
      request: { argv, prompt, cwd },
    };
    const storedRunningJob = writeJobFileUnlessStatus(
      workspaceRoot,
      jobId,
      runningRecord,
      TERMINAL_JOB_STATUSES
    );
    if (!isTerminalJob(storedRunningJob)) {
      upsertJobUnlessStatus(
        workspaceRoot,
        {
          id: jobId,
          status: "running",
          phase: "running",
          pid: child.pid,
          pgid: childPgid,
          startTime,
          startTimeCapture: startTimeCaptureState(startTime),
          startTimeCaptureError: startTimeCaptureError(startTimeLabel, startTime),
          startedAt,
        },
        TERMINAL_JOB_STATUSES
      );
    } else {
      upsertJob(workspaceRoot, {
        id: jobId,
        status: storedRunningJob.status,
        phase: storedRunningJob.phase,
      });
    }

    const out = { jobId, status: "queued", title: "Claude Task" };
    if (options.json) {
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    } else {
      process.stdout.write(
        `Claude Task started in the background as ${jobId}. Check /claude-adv:status ${jobId} for progress.\n`
      );
    }
    return;
  }

  const sessionId = randomUUID();
  const { useBare } = detectReviewerAuthClass();
  const argvOut = buildRescueArgs({
    model: options.model,
    effort: options.effort,
    budgetUsd,
    sessionId,
    useBare,
  });

  // Rescue subprocess emits freeform prose, not schema JSON. Opt out of the
  // parse+validate pipeline so result.ok tracks exit code only.
  //
  // Rescue MUST run in the workspace: it edits files and runs verifiers there.
  // spawnAndCollect's temp-cwd redirect exists for the read-only reviewer (which
  // gets its diff via stdin and never touches the filesystem); for rescue it
  // would strand a write-capable subprocess in an empty /tmp dir on the
  // subscription auth path. Pass the resolved workspace cwd and opt out of the
  // redirect explicitly.
  const result = await spawnAndCollect(argvOut, prompt, {
    parseAsJson: false,
    cwd,
    controlCwd: false,
  });

  const payload = {
    sessionId,
    ok: result.ok,
    exitCode: result.exitCode,
    costUsd: result.costUsd,
    rawOutput: result.events
      .filter((e) => e.type === "assistant")
      .flatMap((e) =>
        (e.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text)
      )
      .join(""),
    error: result.error,
    stderr: result.stderr,
  };

  // When invoked as task-worker (--job-id present), persist instead of print.
  if (options["job-id"]) {
    const existing = readStoredJob(workspaceRoot, options["job-id"]);
    if (existing) {
      writeJobFile(workspaceRoot, options["job-id"], {
        ...existing,
        status: result.ok ? "completed" : "failed",
        phase: result.ok ? "completed" : "failed",
        completedAt: new Date().toISOString(),
        rawPayload: payload,
      });
      upsertJob(workspaceRoot, {
        id: options["job-id"],
        status: result.ok ? "completed" : "failed",
        phase: result.ok ? "completed" : "failed",
        completedAt: new Date().toISOString(),
      });
    }
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    process.stdout.write(payload.rawOutput + "\n");
    if (typeof payload.costUsd === "number") {
      process.stdout.write(`\nCost: $${payload.costUsd.toFixed(4)}\n`);
    }
  }
  if (!result.ok) process.exitCode = 1;
}
