// scripts/companion-handlers/setup.mjs
import path from "node:path";
import { spawnSync } from "node:child_process";

import { parseArgs } from "../lib/args.mjs";
import { binaryAvailable } from "../lib/process.mjs";
import { getConfig, setConfig } from "../lib/state.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { getSessionRuntimeStatus } from "../lib/claude-cli.mjs";

function classifyAuthFailureKind(detail) {
  const text = String(detail ?? "");
  if (/invalid|expired|unauthorized|forbidden|\b401\b|\b403\b/i.test(text)) {
    return "invalid";
  }
  if (/not logged in|not authenticated|login required|unauthenticated|missing/i.test(text)) {
    return "missing";
  }
  return "unknown";
}

function getClaudeAuthStatus(cwd) {
  // `claude auth status --json` is the documented probe.
  const r = spawnSync("claude", ["auth", "status", "--json"], {
    cwd,
    encoding: "utf8",
    timeout: 10000,
  });
  if (r.error) {
    return {
      available: false,
      loggedIn: false,
      detail: r.error.message,
      failureKind: "probe-error",
    };
  }
  if (r.status !== 0) {
    const detail = r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`;
    return {
      available: true,
      loggedIn: false,
      detail,
      failureKind: classifyAuthFailureKind(detail),
    };
  }
  try {
    const j = JSON.parse(r.stdout);
    const loggedIn = Boolean(j.logged_in ?? j.loggedIn);
    const detail = j.detail ?? null;
    return {
      available: true,
      loggedIn,
      authMethod: j.auth_method ?? j.authMethod ?? null,
      detail,
      failureKind: loggedIn ? null : classifyAuthFailureKind(detail ?? "not logged in"),
    };
  } catch (err) {
    return {
      available: true,
      loggedIn: false,
      detail: `parse error: ${err.message}`,
      failureKind: "parse-error",
    };
  }
}

function classifyReadinessReason({ nodeStatus, claudeStatus, auth }) {
  if (!nodeStatus.available) return "node-missing";
  if (!claudeStatus.available) return "claude-missing";
  if (auth.loggedIn) return null;
  if (auth.failureKind === "invalid") {
    return "auth-invalid";
  }
  if (auth.failureKind === "missing") {
    return "auth-missing";
  }
  if (
    auth.failureKind === "unknown" ||
    auth.failureKind === "parse-error" ||
    auth.failureKind === "probe-error"
  ) {
    return "auth-unknown";
  }
  return "auth-unknown";
}

export async function handle(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: [
      "cwd",
      "set-budget-usd",
      "set-rescue-budget-usd",
      "set-worker-budget-multiplier",
    ],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });
  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose --enable-review-gate OR --disable-review-gate, not both.");
  }
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const actionsTaken = [];
  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled stop-time review gate for ${workspaceRoot}.`);
  }
  if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled stop-time review gate for ${workspaceRoot}.`);
  }
  if (options["set-budget-usd"]) {
    const n = Number(options["set-budget-usd"]);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("--set-budget-usd must be a positive number.");
    }
    setConfig(workspaceRoot, "maxBudgetUsd", n);
    actionsTaken.push(`Set per-review budget cap to $${n}.`);
  }
  if (options["set-rescue-budget-usd"]) {
    const n = Number(options["set-rescue-budget-usd"]);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("--set-rescue-budget-usd must be a positive number.");
    }
    setConfig(workspaceRoot, "rescueBudgetUsd", n);
    actionsTaken.push(`Set per-rescue budget cap to $${n}.`);
  }
  if (options["set-worker-budget-multiplier"]) {
    const n = Number(options["set-worker-budget-multiplier"]);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("--set-worker-budget-multiplier must be a positive number.");
    }
    setConfig(workspaceRoot, "workerBudgetMultiplier", n);
    actionsTaken.push(`Set worker session budget multiplier to ${n}× per-review.`);
  }

  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const claudeStatus = binaryAvailable("claude", ["--version"], { cwd });
  const auth = getClaudeAuthStatus(cwd);
  const config = getConfig(workspaceRoot);
  const sessionRuntime = getSessionRuntimeStatus(process.env, workspaceRoot);
  const readinessReason = classifyReadinessReason({ nodeStatus, claudeStatus, auth });

  const nextSteps = [];
  if (!claudeStatus.available) {
    nextSteps.push("Install Claude CLI: `npm install -g @anthropic-ai/claude-code`.");
  }
  if (claudeStatus.available && !auth.loggedIn) {
    nextSteps.push("Run `!claude /login` to authenticate.");
  }
  // Subscription auth (claude.ai) is a first-class supported path as of
  // 2026-05-16: claude-adv detects the auth class and runs the reviewer
  // WITHOUT `--bare` so the CLI can read its own OAuth/keychain. Strongest
  // isolation (`--bare`) is automatically used when an API key is configured
  // (env or apiKeyHelper). Don't push any warning here — both paths just work.
  if (!config.stopReviewGate) {
    nextSteps.push(
      "Optional: `/claude-adv:setup --enable-review-gate` to require review before stop."
    );
  }

  const report = {
    ready: nodeStatus.available && claudeStatus.available && auth.loggedIn,
    readinessReason,
    node: nodeStatus,
    claude: claudeStatus,
    auth,
    sessionRuntime,
    config: {
      stopReviewGate: Boolean(config.stopReviewGate),
      maxBudgetUsd: config.maxBudgetUsd ?? 5,
      rescueBudgetUsd: config.rescueBudgetUsd ?? 20,
      workerBudgetMultiplier: config.workerBudgetMultiplier ?? 10,
    },
    actionsTaken,
    nextSteps,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    renderTextReport(report);
  }
}

function renderTextReport(r) {
  process.stdout.write(`claude-adv setup\n`);
  process.stdout.write(`  ready: ${r.ready ? "yes" : "no"}\n`);
  process.stdout.write(`  node: ${r.node.detail ?? "?"}\n`);
  process.stdout.write(`  claude: ${r.claude.detail ?? "?"}\n`);
  process.stdout.write(`  auth: ${r.auth.loggedIn ? "logged in" : "not authenticated"}`);
  if (r.auth.authMethod) process.stdout.write(` (${r.auth.authMethod})`);
  process.stdout.write("\n");
  process.stdout.write(`  config.stopReviewGate: ${r.config.stopReviewGate}\n`);
  process.stdout.write(`  config.maxBudgetUsd: $${r.config.maxBudgetUsd}\n`);
  process.stdout.write(`  config.rescueBudgetUsd: $${r.config.rescueBudgetUsd}\n`);
  process.stdout.write(`  config.workerBudgetMultiplier: ${r.config.workerBudgetMultiplier}×\n`);
  for (const action of r.actionsTaken) {
    process.stdout.write(`  ✓ ${action}\n`);
  }
  for (const step of r.nextSteps) {
    process.stdout.write(`  → ${step}\n`);
  }
}
