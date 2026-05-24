import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateJobId,
  getConfig,
  listJobs,
  patchJobFile,
  readJobFile,
  resolveJobFile,
  setConfig,
  upsertJob,
  upsertJobUnlessStatus,
  writeJobFile,
  writeJobFileUnlessStatus,
} from "../../scripts/lib/state.mjs";

let workspaceRoot;

test("state: getConfig returns defaults for unknown workspace", () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "claude-adv-state-"));
  const c = getConfig(workspaceRoot);
  assert.equal(typeof c, "object");
});

test("state: setConfig + getConfig roundtrip", () => {
  setConfig(workspaceRoot, "stopReviewGate", true);
  const c = getConfig(workspaceRoot);
  assert.equal(c.stopReviewGate, true);
});

test("state: generateJobId returns a unique-looking id", () => {
  const a = generateJobId("review");
  const b = generateJobId("review");
  assert.match(a, /^review-/);
  assert.notEqual(a, b);
});

test("state: upsertJob and listJobs roundtrip", () => {
  upsertJob(workspaceRoot, { id: "review-1", status: "queued", title: "t" });
  const jobs = listJobs(workspaceRoot);
  assert.ok(jobs.find((j) => j.id === "review-1"));
});

test("state: patchJobFile can skip terminal status records", () => {
  writeJobFile(workspaceRoot, "review-terminal", {
    id: "review-terminal",
    status: "completed",
    phase: "completed",
    rawPayload: { ok: true },
  });

  const patched = patchJobFile(
    workspaceRoot,
    "review-terminal",
    { status: "running", phase: "running", startTime: "stale" },
    { skipStatuses: ["completed", "failed", "cancelled"] }
  );

  const stored = readJobFile(resolveJobFile(workspaceRoot, "review-terminal"));
  assert.equal(patched.status, "completed");
  assert.equal(stored.status, "completed");
  assert.equal(stored.phase, "completed");
  assert.equal(stored.rawPayload.ok, true);
  assert.equal(Object.hasOwn(stored, "startTime"), false);
});

test("state: skip-aware job file and index writes preserve terminal status", () => {
  writeJobFile(workspaceRoot, "review-skip-running", {
    id: "review-skip-running",
    status: "completed",
    phase: "completed",
  });
  upsertJob(workspaceRoot, {
    id: "review-skip-running",
    status: "completed",
    phase: "completed",
  });

  const storedResult = writeJobFileUnlessStatus(
    workspaceRoot,
    "review-skip-running",
    { id: "review-skip-running", status: "running", phase: "running" },
    ["completed", "failed", "cancelled"]
  );
  upsertJobUnlessStatus(
    workspaceRoot,
    { id: "review-skip-running", status: "running", phase: "running" },
    ["completed", "failed", "cancelled"]
  );

  const stored = readJobFile(resolveJobFile(workspaceRoot, "review-skip-running"));
  const indexed = listJobs(workspaceRoot).find((job) => job.id === "review-skip-running");
  assert.equal(storedResult.status, "completed");
  assert.equal(stored.status, "completed");
  assert.equal(indexed.status, "completed");
});

test("state: job file locks are reclaimed when the recorded PID is dead", () => {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  const jobFile = resolveJobFile(workspaceRoot, "review-dead-lock");
  writeFileSync(
    `${jobFile}.lock`,
    JSON.stringify({ pid: child.pid, createdAt: new Date().toISOString() }),
    "utf8"
  );

  const storedResult = writeJobFileUnlessStatus(
    workspaceRoot,
    "review-dead-lock",
    { id: "review-dead-lock", status: "running" },
    ["completed", "failed", "cancelled"]
  );

  assert.equal(storedResult.status, "running");
  assert.equal(readJobFile(jobFile).status, "running");
});

test("state: job file locks are reclaimed when a recycled PID has a mismatched start-time", () => {
  // Lock payload claims our (very-much-alive) PID but with a fabricated
  // start-time. Before the PID-reuse fix this looked "live" via plain
  // process.kill(pid, 0) and the saver would block 35s before timing out.
  // The fix routes startTime through isProcessAlive(), which detects the
  // start-time mismatch as "dead" so the stale lock is reclaimed promptly.
  const jobFile = resolveJobFile(workspaceRoot, "review-reused-pid-lock");
  writeFileSync(
    `${jobFile}.lock`,
    JSON.stringify({
      pid: process.pid,
      startTime: "Mon Jan  1 00:00:00 1970",
      createdAt: new Date().toISOString(),
    }),
    "utf8"
  );

  const started = Date.now();
  const storedResult = writeJobFileUnlessStatus(
    workspaceRoot,
    "review-reused-pid-lock",
    { id: "review-reused-pid-lock", status: "running" },
    ["completed", "failed", "cancelled"]
  );
  const elapsedMs = Date.now() - started;

  assert.equal(storedResult.status, "running");
  assert.equal(readJobFile(jobFile).status, "running");
  // Reclamation must be quick; bail-out time before the fix was ~35s.
  assert.ok(elapsedMs < 5000, `expected fast reclamation, took ${elapsedMs}ms`);
});

// Cleanup
test("state: cleanup", () => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});
