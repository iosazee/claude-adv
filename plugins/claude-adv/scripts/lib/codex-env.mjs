import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DESKTOP_ORIGIN = "Codex Desktop";

export function validateThreadId(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (raw.startsWith("codex:")) {
    return { ok: false, reason: "already-prefixed" };
  }
  if (!THREAD_ID_RE.test(raw)) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, value: raw };
}

export function roundedBootEpochSeconds(nowMs = Date.now(), uptimeSeconds = os.uptime()) {
  return Math.round(Math.floor(nowMs / 1000 - uptimeSeconds) / 60) * 60;
}

export function bootFingerprint(nowMs = Date.now(), uptimeSeconds = os.uptime()) {
  const epochSeconds = roundedBootEpochSeconds(nowMs, uptimeSeconds);
  return crypto.createHash("sha256").update(String(epochSeconds)).digest("hex").slice(0, 8);
}

export function parseCodexCi(value) {
  if (value == null) {
    return false;
  }
  return ["1", "true", "yes"].includes(String(value).trim().toLowerCase());
}

export function detectCodexCiMode(env = process.env) {
  return parseCodexCi(env.CODEX_CI) && env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE !== DESKTOP_ORIGIN;
}

function getCurrentUid(fsImpl) {
  if (typeof fsImpl.getuid === "function") {
    return fsImpl.getuid();
  }
  if (typeof process.getuid === "function") {
    return process.getuid();
  }
  return null;
}

function realpath(fsImpl, value) {
  const realpathFn = fsImpl.realpathSync?.native ?? fsImpl.realpathSync;
  if (typeof realpathFn !== "function") {
    throw new Error("realpath unavailable");
  }
  return realpathFn(value);
}

function validateCodexHomeCandidate(value, fsImpl) {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, reason: "empty" };
  }

  let resolved;
  try {
    resolved = realpath(fsImpl, value);
  } catch {
    return { ok: false, reason: "realpath-failed" };
  }

  let stat;
  try {
    stat = fsImpl.statSync(resolved);
  } catch {
    return { ok: false, reason: "stat-failed" };
  }

  if (typeof stat.isDirectory === "function" && !stat.isDirectory()) {
    return { ok: false, reason: "not-directory" };
  }

  const uid = getCurrentUid(fsImpl);
  if (uid != null && stat.uid != null && stat.uid !== uid) {
    return { ok: false, reason: "uid-mismatch" };
  }

  return { ok: true, value: resolved };
}

function formatStateDirFailure(env) {
  return `claude-adv-codex: no usable state directory (CODEX_HOME=${env.CODEX_HOME ?? ""} HOME=${
    env.HOME ?? ""
  })`;
}

export function resolveValidatedCodexHome(env = process.env, fsImpl = fs) {
  const warnings = [];
  const fallback = env.HOME ? path.join(env.HOME, ".codex") : "";
  const primary = validateCodexHomeCandidate(env.CODEX_HOME, fsImpl);

  if (primary.ok) {
    return { codexHome: primary.value, warnings };
  }

  warnings.push(
    `claude-adv-codex: warning: CODEX_HOME ignored (reason=${primary.reason}); falling back to ${fallback}`
  );

  const fallbackResult = validateCodexHomeCandidate(fallback, fsImpl);
  if (fallbackResult.ok) {
    return { codexHome: fallbackResult.value, warnings };
  }

  throw new Error(formatStateDirFailure(env));
}

export function buildAdapterEnv({
  env = process.env,
  repoRoot,
  nowMs = Date.now(),
  uptimeSeconds = os.uptime(),
  fsImpl = fs,
} = {}) {
  if (!repoRoot) {
    throw new Error("buildAdapterEnv: repoRoot is required");
  }

  const { codexHome, warnings } = resolveValidatedCodexHome(env, fsImpl);
  const nextEnv = { ...env };
  nextEnv.CLAUDE_PLUGIN_ROOT = repoRoot;
  nextEnv.CLAUDE_PLUGIN_DATA = path.join(codexHome, "state", "claude-adv");
  delete nextEnv.CODEX_PLUGIN_DATA;
  delete nextEnv.CLAUDE_ADV_SESSION_ID;
  delete nextEnv.CLAUDE_ADV_WARN_CROSS_SESSION;
  delete nextEnv.CLAUDE_SESSION_ID;

  const thread = validateThreadId(env.CODEX_THREAD_ID);
  if (thread.ok) {
    nextEnv.CLAUDE_ADV_SESSION_ID = `codex:${thread.value}@${bootFingerprint(
      nowMs,
      uptimeSeconds
    )}`;
  } else if (env.CODEX_THREAD_ID) {
    warnings.push(
      `claude-adv-codex: warning: CODEX_THREAD_ID ignored (reason=${thread.reason})`
    );
  }

  return { env: nextEnv, codexHome, warnings };
}
