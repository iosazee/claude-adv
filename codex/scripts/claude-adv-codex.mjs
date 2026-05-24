#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  argvEnablesBackground,
  normalizeArgv,
  parseArgs,
  parseJobReferenceArgs,
} from "../../scripts/lib/args.mjs";
import { buildAdapterEnv, detectCodexCiMode } from "./lib/codex-env.mjs";
import { touchPluginInstallRegistry } from "./lib/codex-registry.mjs";

const WINDOWS_UNSUPPORTED =
  "claude-adv-codex: Windows is not supported (process-group signaling is required for safe inner-claude cleanup). Use WSL2.";
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const ESCALATE_AFTER_MS = 5000;
const EXIT_AFTER_KILL_MS = 1000;
const GROUP_POLL_MS = 50;
const CI_PREFLIGHT_TIMEOUT_MS = 10000;
const CI_PREFLIGHT_KILL_WAIT_MS = 1000;
const CI_PREFLIGHT_SUBCOMMANDS = new Set(["review", "adversarial-review", "task"]);
const CI_EXPLICIT_JOB_SUBCOMMANDS = new Set(["status", "result", "cancel"]);
const CI_ALLOWED_READINESS_REASONS = new Set([
  "claude-missing",
  "auth-missing",
  "auth-invalid",
  "auth-unknown",
]);
const WAIT_HINT_SUBCOMMANDS = new Set(["review", "adversarial-review", "task"]);
const NO_BACKGROUND_SUBCOMMANDS = new Set(["setup", "status", "result", "cancel"]);

function resolveRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function ensureSubcommandFirst(argv) {
  if (!argv[0] || argv[0].startsWith("-")) {
    throw new Error("claude-adv-codex: expected a subcommand as the first argument");
  }
}

function backgroundRejectionMessage(subcommand) {
  if (WAIT_HINT_SUBCOMMANDS.has(subcommand)) {
    return `Codex: --background is not supported for ${subcommand}; rerun with --wait`;
  }
  if (NO_BACKGROUND_SUBCOMMANDS.has(subcommand)) {
    return `Codex: --background is not a supported flag for ${subcommand}; rerun without it`;
  }
  return `Codex: --background is not supported for ${subcommand}`;
}

function maybeRejectBackground(argv) {
  if (!argvEnablesBackground(argv.slice(1))) return false;
  process.stderr.write(`${backgroundRejectionMessage(argv[0])}\n`);
  process.exitCode = 1;
  return true;
}

function hasExplicitJobReference(argv) {
  const [subcommand, ...rest] = argv;
  const normalized = normalizeArgv(rest);
  if (subcommand === "status") {
    const { positionals } = parseArgs(normalized, {
      valueOptions: ["cwd"],
      booleanOptions: ["json", "all"],
    });
    return Boolean(positionals[0]);
  }

  const { positionals } = parseJobReferenceArgs(normalized);
  return Boolean(positionals[0]);
}

function maybeRejectCiDefaultJobLookup(argv) {
  const subcommand = argv[0];
  if (!CI_EXPLICIT_JOB_SUBCOMMANDS.has(subcommand) || hasExplicitJobReference(argv)) {
    return false;
  }

  process.stderr.write(
    `claude-adv-codex: ci-mode-requires-explicit-job-id (subcommand=${subcommand})\n`
  );
  process.exitCode = 1;
  return true;
}

function failCiPrecondition(reason) {
  process.stderr.write(`claude-adv-codex: ci-precondition-failed (reason=${reason})\n`);
  process.exitCode = 78;
}

function touchRegistryOnce(registryState, { validatedCodexHome, repoRoot, argv }) {
  if (registryState.touched) return;
  registryState.touched = true;
  try {
    const result = touchPluginInstallRegistry({ validatedCodexHome, repoRoot, argv });
    if (result.warning) {
      process.stderr.write(`${result.warning}\n`);
    }
    if (result.updated && process.env.MOCK_REGISTRY_WRITE_COUNTER) {
      fs.appendFileSync(process.env.MOCK_REGISTRY_WRITE_COUNTER, "1\n");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`claude-adv-codex: warning: plugin-installs update failed: ${message}\n`);
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function signalChildGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function clearStateTimers(childState) {
  for (const key of ["escalationTimer", "forceExitTimer", "groupPollTimer"]) {
    if (childState[key]) {
      clearTimeout(childState[key]);
      childState[key] = null;
    }
  }
}

function finish(childState, code) {
  if (childState.finished) return;
  childState.finished = true;
  clearStateTimers(childState);
  process.exit(code);
}

function startEscalation(childState) {
  if (childState.escalationTimer || childState.killed) return;
  childState.escalationTimer = setTimeout(() => {
    childState.escalationTimer = null;
    childState.killed = true;
    const child = childState.child;
    if (child?.pid) {
      signalChildGroup(child, "SIGKILL");
    }
    childState.forceExitTimer = setTimeout(() => {
      finish(childState, 137);
    }, EXIT_AFTER_KILL_MS);
  }, ESCALATE_AFTER_MS);
}

function finishWhenGroupExits(childState) {
  if (childState.finished || childState.killed) return;
  const child = childState.child;
  if (!child?.pid || !processGroupExists(child.pid)) {
    finish(childState, signalExitCode(childState.signal));
    return;
  }

  childState.groupPollTimer = setTimeout(() => {
    childState.groupPollTimer = null;
    finishWhenGroupExits(childState);
  }, GROUP_POLL_MS);
}

function handleForwardedSignal(signal, childState) {
  if (childState.finished || childState.closing) return;
  childState.closing = true;
  childState.signal = signal;

  const child = childState.child;
  if (!child?.pid) {
    finish(childState, signalExitCode(signal));
    return;
  }

  if (!childState.childSpawned) {
    try {
      process.kill(child.pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        finish(childState, signalExitCode(signal));
        return;
      }
      throw error;
    }
  }

  if (!signalChildGroup(child, signal)) {
    finish(childState, signalExitCode(signal));
    return;
  }
  startEscalation(childState);
}

function registerSignalHandlers(childState) {
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => {
      handleForwardedSignal(signal, childState);
    });
  }
}

function handleChildClose(childState, code, signal) {
  if (!childState.closing) {
    finish(childState, code ?? signalExitCode(signal));
    return;
  }

  if (childState.killed) {
    finish(childState, 137);
    return;
  }

  finishWhenGroupExits(childState);
}

function attachChildToSignalState(childState, child) {
  childState.child = child;
  childState.childSpawned = false;
  child.on("spawn", () => {
    childState.childSpawned = true;
    childState.child = child;
  });
}

function clearChildFromSignalState(childState, child) {
  if (childState.child !== child || childState.closing) return;
  childState.child = null;
  childState.childSpawned = false;
}

function classifySetupPreflight(result) {
  if (result.timedOut) return "setup-timeout";
  if (result.error || result.code !== 0 || result.signal) return "setup-malformed";

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return "setup-malformed";
  }

  if (parsed?.ready === true) return null;
  if (parsed?.ready !== false) return "setup-malformed";
  const reason = parsed.readinessReason;
  if (CI_ALLOWED_READINESS_REASONS.has(reason)) return reason;
  return "setup-malformed";
}

async function runCiSetupPreflight({ companion, env, cwd, childState }) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [companion, "setup", "--json"], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    attachChildToSignalState(childState, child);

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeoutTimer = null;
    let killWaitTimer = null;

    function settle(result) {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killWaitTimer) clearTimeout(killWaitTimer);
      clearChildFromSignalState(childState, child);
      resolve({ stdout, stderr, ...result });
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (childState.closing) return;
      settle({ code: -1, signal: null, error });
    });

    child.on("close", (code, signal) => {
      if (childState.closing) {
        handleChildClose(childState, code, signal);
        return;
      }
      settle({ code, signal, timedOut });
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalChildGroup(child, "SIGKILL");
      killWaitTimer = setTimeout(() => {
        settle({ code: null, signal: "SIGKILL", timedOut: true });
      }, CI_PREFLIGHT_KILL_WAIT_MS);
    }, CI_PREFLIGHT_TIMEOUT_MS);
  });
}

function addCrossSessionWarningEnv(argv, env) {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "result" && subcommand !== "cancel") {
    delete env.CLAUDE_ADV_WARN_CROSS_SESSION;
    return;
  }

  const { positionals } = parseJobReferenceArgs(normalizeArgv(rest));
  if (positionals[0] && env.CLAUDE_ADV_SESSION_ID) {
    env.CLAUDE_ADV_WARN_CROSS_SESSION = env.CLAUDE_ADV_SESSION_ID;
    return;
  }

  delete env.CLAUDE_ADV_WARN_CROSS_SESSION;
}

async function main() {
  if (process.platform === "win32") {
    process.stderr.write(`${WINDOWS_UNSUPPORTED}\n`);
    process.exitCode = 1;
    return;
  }

  const childState = {
    child: null,
    childSpawned: false,
    closing: false,
    signal: null,
    killed: false,
    finished: false,
    escalationTimer: null,
    forceExitTimer: null,
    groupPollTimer: null,
  };
  registerSignalHandlers(childState);
  const registryState = { touched: false };

  const argv = process.argv.slice(2);
  ensureSubcommandFirst(argv);
  if (maybeRejectBackground(argv)) return;

  const repoRoot = resolveRepoRoot();
  let adapter;
  try {
    adapter = buildAdapterEnv({ repoRoot });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  for (const warning of adapter.warnings) {
    process.stderr.write(`${warning}\n`);
  }

  const companion = path.join(repoRoot, "scripts/claude-companion.mjs");
  if (detectCodexCiMode(process.env)) {
    if (maybeRejectCiDefaultJobLookup(argv)) return;
    if (CI_PREFLIGHT_SUBCOMMANDS.has(argv[0])) {
      const preflight = await runCiSetupPreflight({
        companion,
        env: adapter.env,
        cwd: process.cwd(),
        childState,
      });
      const reason = classifySetupPreflight(preflight);
      if (reason) {
        failCiPrecondition(reason);
        return;
      }
    }
  }

  addCrossSessionWarningEnv(argv, adapter.env);

  const child = spawn(process.execPath, [companion, ...argv], {
    cwd: process.cwd(),
    env: adapter.env,
    detached: true,
    stdio: "inherit",
  });
  attachChildToSignalState(childState, child);

  child.on("error", (error) => {
    if (childState.closing) return;
    process.stderr.write(`${error.message}\n`);
    finish(childState, 1);
  });

  child.on("close", (code, signal) => {
    if (!childState.closing && code === 0 && signal == null) {
      touchRegistryOnce(registryState, {
        validatedCodexHome: adapter.codexHome,
        repoRoot,
        argv,
      });
    }
    handleChildClose(childState, code, signal);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
