import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const EMPTY_LOCK_RETRY_MS = [10, 30, 100];
const LIVE_LOCK_RETRY_MS = [10, 20, 40, 80, 160];
const FOREIGN_HOST_LOCK_STALE_MS = 24 * 60 * 60 * 1000;

export function registryPathForCodexHome(validatedCodexHome) {
  return path.join(validatedCodexHome, "state", "claude-adv", "plugin-installs.json");
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function realpath(fsImpl, value) {
  const realpathFn = fsImpl.realpathSync?.native ?? fsImpl.realpathSync;
  return realpathFn(value);
}

function writerPath(fsImpl) {
  try {
    return realpath(fsImpl, process.argv[1] || process.execPath);
  } catch {
    return process.argv[1] || process.execPath;
  }
}

function writeLockPayload(fsImpl, lockPath, osImpl) {
  const fd = fsImpl.openSync(lockPath, "wx", 0o600);
  let closed = false;
  try {
    const payload = JSON.stringify({
      pid: process.pid,
      writerPath: writerPath(fsImpl),
      hostname: osImpl.hostname(),
    });
    fsImpl.writeSync(fd, payload);
    fsImpl.fsyncSync?.(fd);
    fsImpl.closeSync(fd);
    closed = true;
  } catch (error) {
    if (!closed) {
      try {
        fsImpl.closeSync(fd);
      } catch {
        /* ignore close failure during cleanup */
      }
    }
    try {
      fsImpl.unlinkSync(lockPath);
    } catch {
      /* ignore cleanup race */
    }
    throw error;
  }
}

function unlinkIfExists(fsImpl, file) {
  try {
    fsImpl.unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function lockMtimeAgeMs(fsImpl, lockPath, now) {
  try {
    const stat = fsImpl.statSync(lockPath);
    const mtimeMs =
      typeof stat.mtimeMs === "number"
        ? stat.mtimeMs
        : stat.mtime instanceof Date
          ? stat.mtime.getTime()
          : Number.NaN;
    if (!Number.isFinite(mtimeMs)) return null;
    return Math.max(0, now.getTime() - mtimeMs);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function quarantineForeignLock(fsImpl, lockPath, now) {
  const quarantinePath = `${lockPath}.foreign-stale-${now.getTime()}`;
  try {
    fsImpl.renameSync(lockPath, quarantinePath);
    return quarantinePath;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameLock(left, right) {
  return (
    left.pid === right.pid &&
    left.hostname === right.hostname &&
    left.writerPath === right.writerPath
  );
}

function confirmForeignLockStale({ fsImpl, lockPath, expectedLock, now }) {
  const current = readLockFile(fsImpl, lockPath);
  if (current.action === "retry") return { action: "retry" };
  if (!sameLock(expectedLock, current.lock)) return { action: "retry" };

  const ageMs = lockMtimeAgeMs(fsImpl, lockPath, now);
  if (ageMs == null) return { action: "retry" };
  if (ageMs < FOREIGN_HOST_LOCK_STALE_MS) return { action: "fresh" };
  return { action: "stale", ageMs };
}

function readLockFile(fsImpl, lockPath) {
  for (let attempt = 0; attempt <= EMPTY_LOCK_RETRY_MS.length; attempt += 1) {
    let raw;
    try {
      raw = fsImpl.readFileSync(lockPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { action: "retry" };
      throw error;
    }

    if (String(raw).trim().length < 2) {
      if (attempt < EMPTY_LOCK_RETRY_MS.length) {
        sleepMs(EMPTY_LOCK_RETRY_MS[attempt]);
        continue;
      }
      unlinkIfExists(fsImpl, lockPath);
      return { action: "retry" };
    }

    try {
      const parsed = JSON.parse(raw);
      if (
        !Number.isInteger(parsed.pid) ||
        typeof parsed.writerPath !== "string" ||
        typeof parsed.hostname !== "string"
      ) {
        unlinkIfExists(fsImpl, lockPath);
        return { action: "retry" };
      }
      return { action: "inspect", lock: parsed };
    } catch {
      unlinkIfExists(fsImpl, lockPath);
      return { action: "retry" };
    }
  }

  unlinkIfExists(fsImpl, lockPath);
  return { action: "retry" };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function commandForPid(pid) {
  if (process.platform === "linux") {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      return null;
    }
  }

  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function pidLooksLikeWriter(pid, lockWriterPath) {
  const command = commandForPid(pid);
  if (command == null) return true;
  return command.includes(path.basename(lockWriterPath));
}

function acquireLock({ lockPath, fsImpl, osImpl, now }) {
  let liveAttempts = 0;
  let recoveredWarning = null;
  while (true) {
    try {
      writeLockPayload(fsImpl, lockPath, osImpl);
      return { locked: true, warning: recoveredWarning };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const current = readLockFile(fsImpl, lockPath);
    if (current.action === "retry") continue;

    const lock = current.lock;
    if (lock.hostname !== osImpl.hostname()) {
      const ageMs = lockMtimeAgeMs(fsImpl, lockPath, now);
      if (ageMs != null && ageMs >= FOREIGN_HOST_LOCK_STALE_MS) {
        const confirmed = confirmForeignLockStale({
          fsImpl,
          lockPath,
          expectedLock: lock,
          now,
        });
        if (confirmed.action === "retry") continue;
        if (confirmed.action === "fresh") {
          return {
            locked: false,
            warning:
              `claude-adv-codex: warning: plugin-installs lock held by ` +
              `foreign host=${lock.hostname} pid=${lock.pid}; skipping registry update ` +
              `(lock=${lockPath}; remove ${lockPath} if stale)`,
          };
        }
        const quarantinePath = quarantineForeignLock(fsImpl, lockPath, now);
        if (quarantinePath) {
          recoveredWarning =
            `claude-adv-codex: warning: reclaimed stale plugin-installs lock from ` +
            `foreign host=${lock.hostname} pid=${lock.pid} ageMs=${Math.floor(
              confirmed.ageMs
            )} ` +
            `quarantined=${quarantinePath}`;
        }
        continue;
      }
      return {
        locked: false,
        warning:
          `claude-adv-codex: warning: plugin-installs lock held by ` +
          `foreign host=${lock.hostname} pid=${lock.pid}; skipping registry update ` +
          `(lock=${lockPath}; remove ${lockPath} if stale)`,
      };
    }

    if (!pidAlive(lock.pid) || !pidLooksLikeWriter(lock.pid, lock.writerPath)) {
      unlinkIfExists(fsImpl, lockPath);
      continue;
    }

    if (liveAttempts >= LIVE_LOCK_RETRY_MS.length) {
      return {
        locked: false,
        warning: `claude-adv-codex: warning: plugin-installs lock contention (writer-pid=${lock.pid}); skipping registry update`,
      };
    }
    sleepMs(LIVE_LOCK_RETRY_MS[liveAttempts]);
    liveAttempts += 1;
  }
}

function pluginRootValid(fsImpl, root) {
  let canonical;
  try {
    canonical = realpath(fsImpl, root);
    const rootStat = fsImpl.statSync(canonical);
    if (typeof rootStat.isDirectory === "function" && !rootStat.isDirectory()) {
      return null;
    }
    try {
      fsImpl.statSync(path.join(canonical, ".codex-plugin", "plugin.json"));
    } catch {
      // Fall back to the Claude manifest: the plugin root is shared between
      // both hosts, so either manifest confirms a valid install root.
      fsImpl.statSync(path.join(canonical, ".claude-plugin", "plugin.json"));
    }
  } catch {
    return null;
  }
  return canonical;
}

function emptyRegistry() {
  return { installs: [] };
}

function readRegistryLocked({ registryPath, fsImpl, now }) {
  try {
    const raw = fsImpl.readFileSync(registryPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      installs: Array.isArray(parsed.installs) ? parsed.installs : [],
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyRegistry();

    const quarantinePath = `${registryPath}.bad-${now.getTime()}`;
    try {
      fsImpl.renameSync(registryPath, quarantinePath);
    } catch {
      /* if quarantine races away, still rebuild cleanly */
    }
    return emptyRegistry();
  }
}

function writeRegistryAtomic({ registryPath, registry, fsImpl }) {
  const tmpPath = `${registryPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const fd = fsImpl.openSync(tmpPath, "w", 0o600);
  let closed = false;
  try {
    fsImpl.writeSync(fd, `${JSON.stringify(registry, null, 2)}\n`);
    fsImpl.fsyncSync?.(fd);
    fsImpl.closeSync(fd);
    closed = true;
    fsImpl.renameSync(tmpPath, registryPath);
  } finally {
    if (!closed) {
      try {
        fsImpl.closeSync(fd);
      } catch {
        /* ignore close failure during cleanup */
      }
    }
    try {
      fsImpl.unlinkSync(tmpPath);
    } catch {
      /* ignore absent temp file */
    }
  }
}

export function touchPluginInstallRegistry({
  validatedCodexHome,
  repoRoot,
  argv: _argv = [],
  now = new Date(),
  fsImpl = fs,
  osImpl = os,
} = {}) {
  if (!validatedCodexHome) {
    throw new Error("touchPluginInstallRegistry: validatedCodexHome is required");
  }
  if (!repoRoot) {
    throw new Error("touchPluginInstallRegistry: repoRoot is required");
  }

  const registryPath = registryPathForCodexHome(validatedCodexHome);
  const registryDir = path.dirname(registryPath);
  const lockPath = `${registryPath}.lock`;
  fsImpl.mkdirSync(registryDir, { recursive: true });

  const lock = acquireLock({ lockPath, fsImpl, osImpl, now });
  if (!lock.locked) {
    return { updated: false, warning: lock.warning };
  }

  try {
    const canonicalRoot = pluginRootValid(fsImpl, repoRoot);
    if (!canonicalRoot) {
      return {
        updated: false,
        warning: `claude-adv-codex: warning: plugin install root is invalid (${repoRoot}); skipping registry update`,
      };
    }

    const existing = readRegistryLocked({ registryPath, fsImpl, now });
    const byRoot = new Map();
    for (const entry of existing.installs) {
      if (!entry || typeof entry.root !== "string") continue;
      const canonical = pluginRootValid(fsImpl, entry.root);
      if (!canonical) continue;
      byRoot.set(canonical, {
        root: canonical,
        lastSeenAt:
          typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : new Date(0).toISOString(),
      });
    }

    byRoot.set(canonicalRoot, {
      root: canonicalRoot,
      lastSeenAt: now.toISOString(),
    });

    const next = {
      installs: [...byRoot.values()].sort((a, b) => a.root.localeCompare(b.root)),
    };
    writeRegistryAtomic({ registryPath, registry: next, fsImpl });
    return lock.warning ? { updated: true, warning: lock.warning } : { updated: true };
  } finally {
    unlinkIfExists(fsImpl, lockPath);
  }
}
