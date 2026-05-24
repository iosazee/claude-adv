import { strict as assert } from "node:assert";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseJobReferenceArgs } from "../../scripts/lib/args.mjs";
import { upsertJob, writeJobFile } from "../../scripts/lib/state.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const COMPANION = path.join(ROOT, "scripts/claude-companion.mjs");
const EXPECTED_SESSION = "codex:thread-A@aaaaaaaa";
const TARGET_SESSION = "codex:thread-B@bbbbbbbb";

function withPluginData(pluginData, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

function makeRepoWithFinishedJobs() {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-cross-session-repo-"));
  const pluginData = mkdtempSync(path.join(tmpdir(), "claude-adv-cross-session-state-"));
  execSync("git init -q", { cwd: repo });

  withPluginData(pluginData, () => {
    for (const job of [
      { id: "job-A", sessionId: EXPECTED_SESSION, rawOutput: "same-session output" },
      { id: "job-B", sessionId: TARGET_SESSION, rawOutput: "cross-session output" },
    ]) {
      upsertJob(repo, {
        id: job.id,
        status: "completed",
        phase: "completed",
        kind: "task",
        jobClass: "task",
        title: job.id,
        sessionId: job.sessionId,
      });
      writeJobFile(repo, job.id, { result: { rawOutput: job.rawOutput } });
    }
  });

  return { repo, pluginData };
}

function makeRepoWithActiveJobs() {
  const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-cross-session-active-repo-"));
  const pluginData = mkdtempSync(path.join(tmpdir(), "claude-adv-cross-session-active-state-"));
  execSync("git init -q", { cwd: repo });

  withPluginData(pluginData, () => {
    for (const job of [
      { id: "job-A-active", sessionId: EXPECTED_SESSION },
      { id: "job-B-resolved", sessionId: TARGET_SESSION },
    ]) {
      upsertJob(repo, {
        id: job.id,
        status: "running",
        phase: "running",
        kind: "task",
        jobClass: "task",
        title: job.id,
        sessionId: job.sessionId,
        pid: null,
      });
      writeJobFile(repo, job.id, { startedAt: new Date().toISOString() });
    }
  });

  return { repo, pluginData };
}

function runResult({ repo, pluginData, jobId, warnSession }) {
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginData,
  };
  if (warnSession) {
    env.CLAUDE_ADV_WARN_CROSS_SESSION = warnSession;
  } else {
    delete env.CLAUDE_ADV_WARN_CROSS_SESSION;
  }

  return spawnSync(process.execPath, [COMPANION, "result", jobId, "--json", "--cwd", repo], {
    encoding: "utf8",
    env,
  });
}

function runCancel({ repo, pluginData, jobReference, warnSession }) {
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginData,
  };
  if (warnSession) {
    env.CLAUDE_ADV_WARN_CROSS_SESSION = warnSession;
  } else {
    delete env.CLAUDE_ADV_WARN_CROSS_SESSION;
  }

  return spawnSync(process.execPath, [COMPANION, "cancel", jobReference, "--json", "--cwd", repo], {
    encoding: "utf8",
    env,
  });
}

test("parseJobReferenceArgs keeps the explicit job id positional", () => {
  const parsed = parseJobReferenceArgs(["job-123", "--json", "--cwd", "/tmp/x"]);
  assert.equal(parsed.positionals[0], "job-123");
  assert.equal(parsed.options.json, true);
  assert.equal(parsed.options.cwd, "/tmp/x");
});

test("result warns when explicit job resolves outside the expected session", () => {
  const { repo, pluginData } = makeRepoWithFinishedJobs();

  const result = runResult({
    repo,
    pluginData,
    jobId: "job-B",
    warnSession: EXPECTED_SESSION,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    new RegExp(
      `claude-adv-runtime: warning: cross-session result ` +
        `\\(expected=${EXPECTED_SESSION} target=${TARGET_SESSION} job=job-B\\)`
    )
  );
  assert.equal(JSON.parse(result.stdout).job.id, "job-B");
});

test("result emits no warning for same-session explicit job", () => {
  const { repo, pluginData } = makeRepoWithFinishedJobs();

  const result = runResult({
    repo,
    pluginData,
    jobId: "job-A",
    warnSession: EXPECTED_SESSION,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /cross-session result/);
  assert.equal(JSON.parse(result.stdout).job.id, "job-A");
});

test("result emits no warning when cross-session warning env is absent", () => {
  const { repo, pluginData } = makeRepoWithFinishedJobs();

  const result = runResult({
    repo,
    pluginData,
    jobId: "job-B",
    warnSession: null,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /cross-session result/);
  assert.equal(JSON.parse(result.stdout).job.id, "job-B");
});

test("cancel warns with resolved job id when explicit prefix targets another session", () => {
  const { repo, pluginData } = makeRepoWithActiveJobs();

  const result = runCancel({
    repo,
    pluginData,
    jobReference: "job-B",
    warnSession: EXPECTED_SESSION,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    new RegExp(
      `claude-adv-runtime: warning: cross-session cancel ` +
        `\\(expected=${EXPECTED_SESSION} target=${TARGET_SESSION} job=job-B-resolved\\)`
    )
  );
  assert.equal(JSON.parse(result.stdout).jobId, "job-B-resolved");
});
