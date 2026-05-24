// Job-liveness reaper tests. A background-spawned task-worker subprocess
// that dies abnormally (SIGKILL, OOM, parent killed mid-status-check) leaves
// the on-disk job record stuck at status="running" forever. Reading the
// status snapshot should detect dead PIDs and rewrite their records to
// status="failed" so /claude-adv:status doesn't lie.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

import {
  captureProcessStartTime,
  getProcessStartTime,
  isProcessAlive,
} from "../../scripts/lib/process.mjs";
import { reapDeadJobs } from "../../scripts/lib/job-control.mjs";
import { writeJobFile, upsertJob, listJobs } from "../../scripts/lib/state.mjs";

function makeWorkspace(tag, t) {
  const repo = mkdtempSync(path.join(tmpdir(), `claude-adv-liveness-${tag}-`));
  const pluginData = mkdtempSync(path.join(tmpdir(), `claude-adv-liveness-pd-${tag}-`));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(pluginData, { recursive: true, force: true });
  });
  return { repo, pluginData };
}

function waitForClose(child) {
  return new Promise((resolve) => {
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function exitedChildWithRecordedStartTime() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
    stdio: "ignore",
  });
  const closePromise = waitForClose(child);
  let startTime = null;
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      startTime = getProcessStartTime(child.pid);
      if (startTime) break;
      await delay(25);
    }
    if (!startTime) {
      child.kill("SIGKILL");
      await closePromise;
      return null;
    }
    return { pid: child.pid, startTime, closePromise, child };
  } catch (error) {
    child.kill("SIGKILL");
    await closePromise;
    throw error;
  }
}

async function exitedPidWithRecordedStartTime(t) {
  const childInfo = await exitedChildWithRecordedStartTime();
  if (!childInfo) {
    t.skip("ps start-time probe unavailable");
    return null;
  }
  childInfo.child.kill("SIGTERM");
  await childInfo.closePromise;
  return { pid: childInfo.pid, startTime: childInfo.startTime };
}

// State helpers resolve CLAUDE_PLUGIN_DATA from process.env, so env-mutating
// liveness tests must remain serial within this file.
function withPluginData(pluginData, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

test("isProcessAlive returns true for the current node process", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("isProcessAlive returns false for an exited process with its recorded start-time", async (t) => {
  const exited = await exitedPidWithRecordedStartTime(t);
  if (!exited) return;

  assert.equal(isProcessAlive(exited.pid, exited.startTime), false);
});

test("isProcessAlive returns false when expected start-time mismatches (PID reuse)", () => {
  // Current PID is alive, but we lie about the start-time. The function
  // should treat this as dead so the reaper doesn't falsely keep a job
  // alive after a PID reuse.
  assert.equal(isProcessAlive(process.pid, "Mon Jan  1 00:00:00 1970"), false);
});

test("isProcessAlive returns true when expected start-time matches current", () => {
  const current = getProcessStartTime(process.pid);
  if (!current) {
    // No ps available (unlikely on macOS/Linux test runners). Skip rather
    // than false-fail.
    return;
  }
  assert.equal(isProcessAlive(process.pid, current), true);
});

test("captureProcessStartTime retries before returning a start-time", async () => {
  let calls = 0;
  const warnings = [];
  const startTimePromise = captureProcessStartTime(123, {
    attempts: 3,
    delayMs: 0,
    label: "test-worker",
    getProcessStartTimeImpl: () => {
      calls += 1;
      return calls === 3 ? "Mon May 14 12:00:00 2026" : null;
    },
    warn: (message) => warnings.push(message),
  });
  assert.equal(typeof startTimePromise.then, "function");
  const startTime = await startTimePromise;

  assert.equal(startTime, "Mon May 14 12:00:00 2026");
  assert.equal(calls, 3);
  assert.deepEqual(warnings, []);
});

test("captureProcessStartTime warns when start-time remains unavailable", async () => {
  let calls = 0;
  const warnings = [];
  const startTime = await captureProcessStartTime(456, {
    attempts: 2,
    delayMs: 0,
    label: "test-worker",
    getProcessStartTimeImpl: () => {
      calls += 1;
      return null;
    },
    warn: (message) => warnings.push(message),
  });

  assert.equal(startTime, null);
  assert.equal(calls, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /test-worker/);
  assert.match(warnings[0], /pid=456/);
  assert.match(warnings[0], /PID-only liveness/);
});

test("captureProcessStartTime falls back to default attempts for non-finite options", async () => {
  // The fast-return enqueue path awaits this call between spawn and
  // returning {jobId, status:queued}. The default is therefore one attempt
  // — accept a null start-time rather than block callers for seconds while
  // ps misbehaves. The PID-only liveness fallback still works when the
  // capture comes back null.
  let calls = 0;
  const warnings = [];
  const startTime = await captureProcessStartTime(789, {
    attempts: Number.NaN,
    delayMs: 0,
    label: "test-worker",
    getProcessStartTimeImpl: () => {
      calls += 1;
      return null;
    },
    warn: (message) => warnings.push(message),
  });

  assert.equal(startTime, null);
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /test-worker/);
});

test("reapDeadJobs rewrites running jobs with dead PIDs to status=failed", async (t) => {
  const exited = await exitedPidWithRecordedStartTime(t);
  if (!exited) return;

  const { repo, pluginData } = makeWorkspace("reap", t);
  withPluginData(pluginData, () => {
    const jobId = "review-deadpid-1";
    const jobRecord = {
      id: jobId,
      kind: "adversarial-review",
      kindLabel: "adversarial-review",
      title: "Claude Adversarial Review",
      workspaceRoot: repo,
      jobClass: "review",
      summary: "test",
      status: "running",
      phase: "running",
      pid: exited.pid,
      startTime: exited.startTime,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    writeJobFile(repo, jobId, jobRecord);
    upsertJob(repo, jobRecord);

    const reaped = reapDeadJobs(repo, [jobRecord]);
    assert.equal(reaped.length, 1, "the dead-PID job should be reaped");
    assert.equal(reaped[0].id, jobId);
    assert.equal(reaped[0].status, "failed");

    // State should reflect the change.
    const after = listJobs(repo).find((j) => j.id === jobId);
    assert.equal(after.status, "failed");
    assert.equal(after.phase, "failed");
    assert.ok(typeof after.errorMessage === "string" && after.errorMessage.length > 0);
  });
});

test("reapDeadJobs rewrites reused PIDs when the recorded start-time mismatches", (t) => {
  const { repo, pluginData } = makeWorkspace("reused-pid", t);
  withPluginData(pluginData, () => {
    const jobId = "review-reusedpid-1";
    const jobRecord = {
      id: jobId,
      kind: "adversarial-review",
      title: "Claude Adversarial Review",
      workspaceRoot: repo,
      jobClass: "review",
      summary: "test",
      status: "running",
      phase: "running",
      pid: process.pid,
      startTime: "Mon Jan  1 00:00:00 1970",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    writeJobFile(repo, jobId, jobRecord);
    upsertJob(repo, jobRecord);

    const reaped = reapDeadJobs(repo, [jobRecord]);
    assert.equal(reaped.length, 1, "stale start-time must be treated as dead despite live PID");
    assert.equal(reaped[0].status, "failed");

    const after = listJobs(repo).find((j) => j.id === jobId);
    assert.equal(after.status, "failed");
    assert.equal(after.pid, null);
  });
});

test("reapDeadJobs leaves alive jobs untouched", (t) => {
  const { repo, pluginData } = makeWorkspace("alive", t);
  withPluginData(pluginData, () => {
    const jobId = "review-alive-1";
    const aliveStartTime = getProcessStartTime(process.pid);
    const jobRecord = {
      id: jobId,
      kind: "adversarial-review",
      title: "x",
      workspaceRoot: repo,
      jobClass: "review",
      summary: "test",
      status: "running",
      phase: "running",
      pid: process.pid,
      startTime: aliveStartTime,
      startedAt: new Date().toISOString(),
    };
    writeJobFile(repo, jobId, jobRecord);
    upsertJob(repo, jobRecord);

    const reaped = reapDeadJobs(repo, [jobRecord]);
    assert.equal(reaped.length, 0, "live job should not be reaped");

    const after = listJobs(repo).find((j) => j.id === jobId);
    assert.equal(after.status, "running");
  });
});

test("reapDeadJobs ignores jobs in terminal states", (t) => {
  const { repo, pluginData } = makeWorkspace("terminal", t);
  withPluginData(pluginData, () => {
    const jobRecord = {
      id: "review-already-done",
      kind: "review",
      title: "x",
      workspaceRoot: repo,
      jobClass: "review",
      summary: "test",
      status: "completed",
      pid: process.pid,
      startTime: "Mon Jan  1 00:00:00 1970",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    writeJobFile(repo, jobRecord.id, jobRecord);
    upsertJob(repo, jobRecord);

    const reaped = reapDeadJobs(repo, [jobRecord]);
    assert.equal(reaped.length, 0, "completed job must not be re-reaped");

    const after = listJobs(repo).find((j) => j.id === jobRecord.id);
    assert.equal(after.status, "completed");
  });
});
