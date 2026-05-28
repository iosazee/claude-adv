// Generated from scripts/lib/state.mjs by scripts/release/sync-codex-bundle.mjs. Do not edit.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getOwnProcessStartTime, isProcessAlive } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "claude-adv");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const FILE_LOCK_STALE_MS = 30_000;
const FILE_LOCK_TIMEOUT_MS = FILE_LOCK_STALE_MS + 5_000;
const FILE_LOCK_RETRY_MS = 5;
const SLEEP_BUFFER = new SharedArrayBuffer(4);
const SLEEP_ARRAY = new Int32Array(SLEEP_BUFFER);

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false,
    },
    jobs: [],
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {}),
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
    )
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function sleepSync(ms) {
  Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

function writeJsonFileAtomic(filePath, payload) {
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, filePath);
}

function warnReleaseError(action, lockFile, error) {
  // Best-effort logging; an EPIPE on stderr must not propagate and mask the
  // original error from the protected work.
  try {
    process.stderr.write(
      `claude-adv-runtime: warning: ${action} ${lockFile} failed: ${error?.message ?? error}\n`
    );
  } catch {
    // Intentionally swallowed.
  }
}

function removeStaleLock(lockFile, nowMs) {
  let stat;
  try {
    stat = fs.statSync(lockFile);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    throw error;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (Number.isFinite(payload?.pid) && payload.pid > 0) {
      // When the lock recorded the OS-level start identifier, pass it through
      // so isProcessAlive() can distinguish "same pid, same process" from
      // "same pid, recycled by an unrelated process". Older payloads without
      // startTime fall through to PID-only liveness — backward-compatible.
      const expectedStartTime =
        typeof payload.startTime === "string" && payload.startTime.length > 0
          ? payload.startTime
          : null;
      if (!isProcessAlive(payload.pid, expectedStartTime)) {
        fs.unlinkSync(lockFile);
        return true;
      }
      return false;
    }
  } catch {
    // Fall back to mtime for empty, partial, or corrupt lock files.
  }
  if (nowMs - stat.mtimeMs < FILE_LOCK_STALE_MS) {
    return false;
  }
  try {
    fs.unlinkSync(lockFile);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return true;
}

function acquireFileLock(filePath) {
  const lockFile = `${filePath}.lock`;
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;

  while (true) {
    let fd = null;
    try {
      fd = fs.openSync(lockFile, "wx");
      try {
        // Record startTime alongside the pid so a stale lock left behind by a
        // crashed process whose pid was later recycled is correctly detected
        // as reclaimable (isProcessAlive(pid, startTime) returns false on a
        // start-time mismatch). getOwnProcessStartTime() is memoized — the
        // OS-level value is constant for the lifetime of this process — so
        // every save after the first pays no ps cost. May still be null on
        // platforms without ps; in that case we degrade to PID-only liveness.
        fs.writeFileSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            startTime: getOwnProcessStartTime(),
            createdAt: new Date().toISOString(),
          }),
          "utf8"
        );
      } catch (error) {
        try {
          fs.closeSync(fd);
        } catch {
          // Best-effort cleanup before surfacing the lock write failure.
        }
        try {
          fs.unlinkSync(lockFile);
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") {
            throw unlinkError;
          }
        }
        throw error;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Release runs inside a `finally` block. If the protected work threw
        // and close/unlink also throw, propagating the release error would
        // mask the real failure (JS finally semantics replace the original
        // exception with whatever finally throws). Log non-trivial release
        // errors to stderr but never throw — the original exception from the
        // protected work must survive.
        try {
          fs.closeSync(fd);
        } catch (error) {
          if (error?.code !== "EBADF") {
            warnReleaseError("closing lock fd", lockFile, error);
          }
        }
        try {
          fs.unlinkSync(lockFile);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            warnReleaseError("unlinking lock file", lockFile, error);
          }
        }
      };
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Best-effort cleanup before retrying or surfacing the original error.
        }
      }
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const nowMs = Date.now();
      if (removeStaleLock(lockFile, nowMs)) {
        continue;
      }
      if (nowMs >= deadline) {
        throw new Error(`timed out acquiring lock for ${filePath}`);
      }
      sleepSync(FILE_LOCK_RETRY_MS);
    }
  }
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {}),
    },
    jobs: nextJobs,
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeJsonFileAtomic(resolveStateFile(cwd), nextState);
  return nextState;
}

export function saveState(cwd, state) {
  ensureStateDir(cwd);
  const release = acquireFileLock(resolveStateFile(cwd));
  try {
    return saveStateUnlocked(cwd, state);
  } finally {
    release();
  }
}

export function updateState(cwd, mutate) {
  ensureStateDir(cwd);
  const release = acquireFileLock(resolveStateFile(cwd));
  try {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  } finally {
    release();
  }
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch,
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp,
    };
  });
}

export function upsertJobUnlessStatus(cwd, jobPatch, skipStatuses) {
  const skip = new Set(skipStatuses ?? []);
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex !== -1 && skip.has(state.jobs[existingIndex].status)) {
      return;
    }
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch,
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp,
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value,
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  const release = acquireFileLock(jobFile);
  try {
    writeJsonFileAtomic(jobFile, payload);
  } finally {
    release();
  }
  return jobFile;
}

export function writeJobFileUnlessStatus(cwd, jobId, payload, skipStatuses) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  const release = acquireFileLock(jobFile);
  try {
    if (fs.existsSync(jobFile)) {
      const existing = readJobFile(jobFile);
      if (new Set(skipStatuses ?? []).has(existing.status)) {
        return existing;
      }
      const next = {
        ...existing,
        ...payload,
      };
      writeJsonFileAtomic(jobFile, next);
      return next;
    }
    writeJsonFileAtomic(jobFile, payload);
    return payload;
  } finally {
    release();
  }
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function patchJobFile(cwd, jobId, patch, options = {}) {
  const jobFile = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  const release = acquireFileLock(jobFile);
  try {
    if (!fs.existsSync(jobFile)) {
      return null;
    }
    const skipStatuses = new Set(options.skipStatuses ?? []);
    const existing = readJobFile(jobFile);
    if (skipStatuses.has(existing.status)) {
      return existing;
    }
    const next = {
      ...existing,
      ...patch,
    };
    writeJsonFileAtomic(jobFile, next);
    return next;
  } finally {
    release();
  }
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
