// Generated from scripts/lib/process.mjs by scripts/release/sync-codex-bundle.mjs. Do not edit.
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

// Read the OS-level start identifier for a PID. Used together with
// process.kill(pid, 0) to detect PID reuse: a PID that exists but with a
// different start-time than what we recorded at spawn is a different process.
// macOS: ps -o lstart=. Linux: ps emits the same lstart format. Returns null
// when the PID is gone (ps exits non-zero) or on platforms without ps.
let isPsAvailable = true;

export function getProcessStartTime(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (process.platform === "win32") return null;
  if (!isPsAvailable) return null;
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (r.error) {
    if (r.error.code === "ENOENT") {
      isPsAvailable = false;
    }
    return null;
  }
  if (r.status !== 0) {
    if (r.status === 127) {
      isPsAvailable = false;
    }
    return null;
  }
  const out = r.stdout.trim();
  return out.length > 0 ? out : null;
}

// Memoized accessor for *this* process's start-time. State-write callers
// (lock-file payload) need the value on every save; PIDs cannot be reused
// while we are alive, so the result is constant for the lifetime of the
// process. Cache it after the first lookup to avoid paying the spawnSync
// cost on every state mutation. `null` (ps unavailable) is cached too so we
// don't retry a known-failing probe.
let ownProcessStartTimeCached;
let ownProcessStartTimeCachedFor = -1;
export function getOwnProcessStartTime() {
  if (ownProcessStartTimeCachedFor === process.pid) {
    return ownProcessStartTimeCached;
  }
  ownProcessStartTimeCached = getProcessStartTime(process.pid);
  ownProcessStartTimeCachedFor = process.pid;
  return ownProcessStartTimeCached;
}

function getProcessStartTimeAsync(pid, options = {}) {
  if (!Number.isFinite(pid) || pid <= 0) return Promise.resolve(null);
  if (process.platform === "win32") return Promise.resolve(null);
  if (!isPsAvailable) return Promise.resolve(null);

  const timeoutMs = nonNegativeNumberOption(options.timeoutMs, 150);

  return new Promise((resolve) => {
    const child = spawn("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      if (err && err.code === "ENOENT") {
        isPsAvailable = false;
      }
      resolve(null);
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      if (status !== 0) {
        if (status === 127) {
          isPsAvailable = false;
        }
        resolve(null);
        return;
      }
      const out = stdout.trim();
      resolve(out.length > 0 ? out : null);
    });
  });
}

function positiveIntegerOption(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function nonNegativeNumberOption(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, parsed);
}

export async function captureProcessStartTime(pid, options = {}) {
  // Defaults are deliberately tight: enqueueBackgroundReview and the
  // task-enqueue handler await this call between spawn and returning
  // {jobId, status:queued}, so the worst-case latency must stay well under
  // a second. One attempt with a ~150ms ps timeout caps the fast-return
  // path at ~150ms even when ps is misbehaving; the PID-only liveness
  // fallback in reapDeadJobs still works when startTime ends up null.
  const attempts = positiveIntegerOption(options.attempts ?? 1, 1);
  const delayMs = nonNegativeNumberOption(options.delayMs ?? 25, 25);
  const timeoutMs = nonNegativeNumberOption(options.timeoutMs ?? 150, 150);
  const label = options.label ?? "worker process";
  const getProcessStartTimeImpl = options.getProcessStartTimeImpl ?? getProcessStartTimeAsync;
  const warn =
    options.warn ??
    ((message) => {
      process.stderr.write(`${message}\n`);
    });

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startTime = await getProcessStartTimeImpl(pid, { timeoutMs });
    if (startTime) {
      return startTime;
    }
    if (attempt < attempts) {
      await delay(delayMs);
    }
  }

  warn(
    `claude-adv-runtime: warning: could not capture process start-time for ${label} ` +
      `(pid=${pid}); PID-only liveness fallback is active`
  );
  return null;
}

// True iff a process with `pid` is currently alive AND (when expectedStartTime
// is provided) its OS-level start-time matches. Channel 1 is process.kill(pid,
// 0) — sends no signal, just checks existence; throws ESRCH for dead PIDs.
// Channel 2 is the start-time match, which guards against PID reuse falsely
// reporting an unrelated newer process as our worker.
//
// When ps can't be consulted (returns null) we fall back to the kill-0 result
// alone — better than refusing to do liveness probing at all on a platform
// where ps is missing.
export function isProcessAlive(pid, expectedStartTime = null) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err && err.code === "ESRCH") return false;
    // EPERM: process exists but we lack permission. That still means alive.
    if (err && err.code === "EPERM") return true;
    return false;
  }
  if (expectedStartTime != null) {
    const current = getProcessStartTime(pid);
    if (current != null && current !== expectedStartTime) return false;
  }
  return true;
}

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" ? process.env.SHELL || true : false,
    windowsHide: true,
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env,
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
