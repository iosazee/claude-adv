// Generated from scripts/lib/claude-cli.mjs by scripts/release/sync-codex-bundle.mjs. Do not edit.
// scripts/lib/claude-cli.mjs
//
// Wraps the `claude` CLI as a subprocess. Two builder contracts:
//   - buildReviewerArgs(opts) — read-only, schema-constrained, isolated reviewer
//   - buildRescueArgs(opts)   — write-capable rescue subprocess with locked invariants
//
// Plus a spawnAndCollect(argv, stdinText, opts) helper that runs claude
// and parses stream-json events into a structured result.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync as fsExistsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const DEFAULT_MODEL = "claude-opus-4-7";
const SCHEMA_PATH = path.join(ROOT, "schemas/review-output.schema.json");
const RESCUE_PROMPT_PATH = path.join(ROOT, "prompts/rescue.md");

function readSchemaJson() {
  return readFileSync(SCHEMA_PATH, "utf8");
}

// Locked invariants for the reviewer-class builder. Callers cannot override.
// `--bare` is no longer in this set — see `useBare` below. Every other safety
// invariant remains locked regardless of which auth path is taken.
const REVIEWER_LOCKED = {
  tools: "",
  permissionMode: "default",
  sessionPersistence: false,
  settingSources: "",
  schemaFile: SCHEMA_PATH,
};

// Rescue is a deliberately-invoked write-capable subprocess. It already has
// unrestricted file-edit access in the workspace, and the whole value
// proposition is that it can finish work the delegating Claude couldn't.
// bypassPermissions lets it run shell commands (npm test, npx biome check,
// node --test, git diff) so it can verify its own edits before returning;
// acceptEdits gated those behind permission prompts that no human can answer
// in this non-interactive context, which turned the prompt's "Run tests
// after edits" directive into a dead letter. Trust boundary: when useBare is
// true, --bare strips plugins/hooks/settings/keychain in a single flag; when
// false (subscription auth), --no-session-persistence still ensures no
// carryover, --setting-sources "" still ensures project settings can't
// influence, the system prompt is still locked. The marginal threat over
// acceptEdits is shell execution, but a malicious file-edit can already
// corrupt the workspace, so this is a marginal not categorical increase.
const RESCUE_LOCKED = {
  permissionMode: "bypassPermissions",
  sessionPersistence: false,
  settingSources: "",
  systemPromptFile: RESCUE_PROMPT_PATH,
};

export function buildReviewerArgs(opts = {}) {
  // Reject locked-invariant overrides at the API surface. `useBare` is NOT
  // in this list — it's a required, deliberate parameter (see below).
  const forbidden = [
    "tools",
    "permissionMode",
    "sessionPersistence",
    "settingSources",
    "schemaFile",
  ];
  for (const key of forbidden) {
    if (key in opts) {
      throw new Error(`buildReviewerArgs: caller cannot override locked invariant '${key}'`);
    }
  }

  if (!opts.promptFile) {
    throw new Error("buildReviewerArgs: promptFile is required");
  }
  if (typeof opts.budgetUsd !== "number" || opts.budgetUsd <= 0) {
    throw new Error("buildReviewerArgs: budgetUsd must be a positive number");
  }
  if (!opts.sessionId) {
    throw new Error("buildReviewerArgs: sessionId is required");
  }
  // `useBare` MUST be set explicitly by every caller so that the auth-class
  // decision is visible at the call site rather than hiding behind a default.
  // true → emit --bare (strongest isolation; requires API-key auth — env
  //        ANTHROPIC_API_KEY or apiKeyHelper from user settings).
  // false → omit --bare (uses OAuth/keychain via the CLI's own auth path;
  //         caller MUST also spawn the subprocess from a controlled cwd to
  //         suppress project CLAUDE.md auto-discovery — spawnAndCollect does
  //         that automatically based on whether --bare is in the argv).
  if (typeof opts.useBare !== "boolean") {
    throw new Error(
      "buildReviewerArgs: useBare must be set explicitly (true for API-key auth, false for OAuth/subscription auth)"
    );
  }

  const argv = [];
  if (opts.useBare) argv.push("--bare");
  argv.push(
    "--print",
    "--verbose",
    "--model",
    opts.model ?? DEFAULT_MODEL,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--json-schema",
    readSchemaJson(),
    "--system-prompt-file",
    opts.promptFile,
    "--tools",
    REVIEWER_LOCKED.tools,
    "--permission-mode",
    REVIEWER_LOCKED.permissionMode,
    "--no-session-persistence",
    "--setting-sources",
    REVIEWER_LOCKED.settingSources,
    "--max-budget-usd",
    String(opts.budgetUsd),
    "--session-id",
    opts.sessionId
  );
  return argv;
}

export function buildRescueArgs(opts = {}) {
  const forbidden = ["permissionMode", "sessionPersistence", "settingSources", "systemPromptFile"];
  for (const key of forbidden) {
    if (key in opts) {
      throw new Error(`buildRescueArgs: caller cannot override locked invariant '${key}'`);
    }
  }

  if (typeof opts.budgetUsd !== "number" || opts.budgetUsd <= 0) {
    throw new Error("buildRescueArgs: budgetUsd must be a positive number");
  }
  if (!opts.sessionId) {
    throw new Error("buildRescueArgs: sessionId is required");
  }
  // Same useBare contract as buildReviewerArgs — see that function for the
  // rationale. Rescue uses cwd=project (it edits files) regardless of
  // useBare; the auth-class distinction is purely about whether the inner
  // claude needs --bare's API-key-only auth path or can use OAuth natively.
  if (typeof opts.useBare !== "boolean") {
    throw new Error(
      "buildRescueArgs: useBare must be set explicitly (true for API-key auth, false for OAuth/subscription auth)"
    );
  }

  const argv = [];
  if (opts.useBare) argv.push("--bare");
  argv.push(
    "--print",
    "--verbose",
    "--model",
    opts.model ?? DEFAULT_MODEL,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--effort",
    opts.effort ?? "high",
    "--system-prompt-file",
    RESCUE_LOCKED.systemPromptFile,
    "--permission-mode",
    RESCUE_LOCKED.permissionMode,
    "--no-session-persistence",
    "--setting-sources",
    RESCUE_LOCKED.settingSources,
    "--max-budget-usd",
    String(opts.budgetUsd),
    "--session-id",
    opts.sessionId
  );
  return argv;
}

/**
 * Spawn a `claude` subprocess with the given argv, write `stdinText` to its
 * stdin, collect stream-json events from stdout, return a structured result.
 *
 * @param {string[]} argv - Output of buildReviewerArgs or buildRescueArgs.
 * @param {string} stdinText - The prompt body to write to stdin.
 * @param {object} opts
 * @param {string} [opts.claudeBin="claude"] - Override the binary (used in tests).
 * @param {object} [opts.env] - Extra env vars to pass to the subprocess.
 * @param {boolean} [opts.parseAsJson=true] - When true (default), expect the
 *   final assistant message to be schema-conformant JSON; fence-strip, parse,
 *   normalize, and hard-validate against the review-output shape. When false
 *   (rescue-class callers), skip parsing and validation: `ok` is `exitCode===0`,
 *   `review` is null, and `error` is `null` on clean exit. Caller reads
 *   freeform text from `events`.
 * @param {function} [opts.onEvent] - Called for each stream-json event.
 * @param {function} [opts.onSpawn] - Called once with the child process handle
 *   immediately after spawn, BEFORE the subprocess produces output. Used by
 *   the worker to register an in-flight handle for interrupt requests.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   exitCode: number,
 *   review: object | null,       // Parsed structured-output JSON, if any.
 *   events: object[],            // All stream-json events seen.
 *   costUsd: number | null,
 *   error: string | null,
 *   stderr: string,
 * }>}
 */
export async function spawnAndCollect(argv, stdinText, opts = {}) {
  const claudeBin = opts.claudeBin ?? "claude";
  const parseAsJson = opts.parseAsJson !== false;
  const env = { ...process.env, ...(opts.env ?? {}) };

  // Auth-class plumbing. When the argv includes --bare we're on the API-key
  // path, which requires ANTHROPIC_API_KEY to be set in env (claude --bare
  // rejects OAuth/keychain). Inject via the waterfall if the caller didn't
  // pre-set it. When --bare is absent we're on the subscription path; the
  // inner claude reads its own keychain natively and no injection is needed.
  const useBare = argv.includes("--bare");
  let credentialSource = useBare ? "env" : "oauth-native";
  if (useBare && !("ANTHROPIC_API_KEY" in (opts.env ?? {}))) {
    const credential = resolveAnthropicCredential({ env });
    if (credential.value) {
      env.ANTHROPIC_API_KEY = credential.value;
      credentialSource = credential.source;
    }
  }

  // Subscription path: spawn from a fresh temp cwd to suppress project
  // CLAUDE.md auto-discovery. --bare already strips CLAUDE.md auto-load so
  // the API-key path doesn't need this. Reviewer doesn't read project files
  // anyway — the diff comes in via stdin — so cwd doesn't affect function.
  let spawnCwd = opts.cwd ?? process.cwd();
  let cwdToCleanup = null;
  if (!useBare && opts.controlCwd !== false) {
    cwdToCleanup = mkdtempSync(path.join(tmpdir(), "claude-adv-reviewer-cwd-"));
    spawnCwd = cwdToCleanup;
  }

  const onEvent = opts.onEvent ?? (() => {});
  const onSpawn = opts.onSpawn ?? (() => {});

  return await new Promise((rawResolve) => {
    // Wrap resolve so we always clean up the controlled temp cwd, regardless
    // of which exit path the child takes.
    const resolve = (result) => {
      if (cwdToCleanup) {
        try {
          rmSync(cwdToCleanup, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
        cwdToCleanup = null;
      }
      rawResolve(result);
    };

    const child = spawn(claudeBin, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: spawnCwd,
    });

    // Expose the handle to the caller IMMEDIATELY so worker.interrupt can
    // SIGTERM this exact subprocess if the user cancels mid-review.
    try {
      onSpawn(child);
    } catch {
      /* caller bug — swallow */
    }

    // If the binary is missing or unspawnable (ENOENT/EACCES), Node fires an
    // 'error' event on the child. Without a listener that bubbles up as an
    // unhandled exception. Resolve cleanly with ok:false instead.
    let spawnFailed = false;
    child.on("error", (err) => {
      spawnFailed = true;
      resolve({
        ok: false,
        exitCode: -1,
        review: null,
        events: [],
        costUsd: null,
        error: `spawn failed: ${err.message}`,
        stderr: "",
      });
    });

    // If the child exits before we finish flushing the prompt (auth failure,
    // crash, OOM, or a large prompt racing a fast termination), the stdin
    // pipe closes and async writes emit EPIPE on the stdin stream. Without
    // an error listener, Node escalates that to an uncaught exception and
    // kills the supervisor. Swallow it — the 'close' event still fires and
    // resolves the promise with the real exitCode/stderr, which is the
    // authoritative signal of what went wrong.
    child.stdin.on("error", () => {
      /* see comment above */
    });

    if (stdinText) {
      try {
        child.stdin.write(stdinText);
      } catch {
        /* spawn already failed */
      }
    }
    try {
      child.stdin.end();
    } catch {
      /* spawn already failed */
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    const events = [];

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          events.push(ev);
          onEvent(ev);
        } catch {
          // Skip non-JSON line (likely warnings or partial chunks).
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk;
    });

    child.on("close", (exitCode) => {
      // If 'error' already resolved (spawn failed), don't double-resolve.
      if (spawnFailed) return;
      // Flush any trailing event without newline.
      if (stdoutBuf.trim()) {
        try {
          events.push(JSON.parse(stdoutBuf.trim()));
        } catch {
          /* ignore */
        }
      }

      // Auth-failure classification: if exit is non-zero AND stderr matches
      // a known auth-rejection pattern, swap the bare error for an
      // actionable message that names the working remedies.
      const authFailureKind = exitCode === 0 ? null : classifyAuthFailure(stderrBuf);
      const authFailureError = authFailureKind
        ? buildAuthFailureMessage(authFailureKind, credentialSource)
        : null;

      // Free-form (rescue-class) callers skip the schema-conformant JSON
      // parse + validate pipeline. They read text out of events themselves.
      if (!parseAsJson) {
        return resolve({
          ok: exitCode === 0,
          exitCode,
          review: null,
          events,
          costUsd: extractCost(events),
          error: authFailureError ?? (exitCode === 0 ? null : `claude exited ${exitCode}`),
          stderr: stderrBuf,
        });
      }

      const finalAssistant = [...events]
        .reverse()
        .find((e) => e.type === "assistant" && e.message?.content);

      if (!finalAssistant) {
        return resolve({
          ok: false,
          exitCode,
          review: null,
          events,
          costUsd: extractCost(events),
          error: authFailureError ?? "no final assistant message in stream",
          stderr: stderrBuf,
        });
      }

      const rawText = (finalAssistant.message.content ?? [])
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      // claude wraps structured output in ```json ... ``` fences; strip them.
      const text = stripMarkdownFences(rawText);

      let parsed = null;
      let parseError = null;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        parseError = err.message;
        // Grounded reviews where the model inspects files tend to emit valid
        // JSON followed by a short prose commentary. Try to recover the first
        // balanced top-level object before treating this as a hard failure.
        const extracted = extractFirstJsonObject(text);
        if (extracted !== null) {
          try {
            parsed = JSON.parse(extracted);
            parseError = null;
          } catch {
            /* extraction failed to produce parseable JSON — fall through */
          }
        }
      }
      if (parseError !== null) {
        return resolve({
          ok: false,
          exitCode,
          review: null,
          events,
          costUsd: extractCost(events),
          error: `failed to parse final assistant text as JSON: ${parseError}`,
          stderr: stderrBuf,
        });
      }

      // --json-schema doesn't enforce output. Normalize known
      // synonyms, then hard-validate the review-output shape. Failures surface
      // as ok:false with a schema-violation error.
      const { review, error: schemaError } = validateAndNormalizeReview(parsed);
      if (schemaError) {
        return resolve({
          ok: false,
          exitCode,
          review: null,
          events,
          costUsd: extractCost(events),
          error: `schema-violation: ${schemaError}`,
          stderr: stderrBuf,
        });
      }

      resolve({
        ok: exitCode === 0,
        exitCode,
        review,
        events,
        costUsd: extractCost(events),
        error: exitCode === 0 ? null : `claude exited ${exitCode}`,
        stderr: stderrBuf,
      });
    });
  });
}

// Normalize known model deviations from review-output.schema.json, then hard-
// validate the result. Returns {review, error}. `error` is null on success.
export function validateAndNormalizeReview(parsed) {
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { review: null, error: "parsed value is not a JSON object" };
  }
  const out = { ...parsed };

  // Synonym renames (only when target key is missing).
  if (out.verdict === undefined && typeof out.status === "string") {
    out.verdict = out.status;
    delete out.status;
  }
  if (out.summary === undefined && typeof out.description === "string") {
    out.summary = out.description;
    delete out.description;
  }
  if (out.findings === undefined) out.findings = [];
  if (out.next_steps === undefined) out.next_steps = [];

  // Verdict enum coercion: one of [approve, approve-with-notes, needs-attention].
  if (typeof out.verdict === "string") {
    const v = out.verdict.toLowerCase().replace(/_/g, "-");
    if (v === "approve" || v === "approved") {
      out.verdict = "approve";
    } else if (v === "approve-with-notes" || v === "approvewithnotes" || v === "approve-notes") {
      out.verdict = "approve-with-notes";
    } else if (v === "needs-attention" || v === "needsattention") {
      out.verdict = "needs-attention";
    } else {
      // Anything else (e.g. "CRITICAL_BUG", "reject") routes to needs-attention
      // — model said something, but it's not a clean approve.
      out.verdict = "needs-attention";
    }
  }

  // Hard validation.
  if (!["approve", "approve-with-notes", "needs-attention"].includes(out.verdict)) {
    return {
      review: null,
      error: `verdict missing or not in [approve, approve-with-notes, needs-attention] (got: ${JSON.stringify(out.verdict)})`,
    };
  }
  if (typeof out.summary !== "string" || out.summary.length === 0) {
    return { review: null, error: "summary missing or empty" };
  }
  if (!Array.isArray(out.findings)) {
    return { review: null, error: "findings is not an array" };
  }
  if (!Array.isArray(out.next_steps)) {
    return { review: null, error: "next_steps is not an array" };
  }

  // Per-finding validation against review-output.schema.json. The CLI's
  // --json-schema flag is non-enforcing, so without this a malformed finding
  // (e.g. missing `confidence`) would slip through and crash the renderer.
  for (let i = 0; i < out.findings.length; i++) {
    const findingError = validateFinding(out.findings[i], i);
    if (findingError) return { review: null, error: findingError };
    // Compute stable fingerprint client-side if the model didn't supply one.
    // Even if the model did supply one, we recompute and overwrite — the
    // canonical identity must match across iterations and models cannot be
    // trusted to produce stable hashes.
    out.findings[i].fingerprint = computeFindingFingerprint(out.findings[i]);
  }
  for (let i = 0; i < out.next_steps.length; i++) {
    if (typeof out.next_steps[i] !== "string" || out.next_steps[i].length === 0) {
      return { review: null, error: `next_steps[${i}] is not a non-empty string` };
    }
  }

  // Verdict consistency: approve-with-notes is only valid when every finding
  // is severity ≤ medium AND confidence ≤ 0.7. If the model picked
  // approve-with-notes alongside a critical/high finding or a high-confidence
  // one, auto-demote to needs-attention. This stops the model from softening
  // a real concern by under-grading the verdict.
  if (out.verdict === "approve-with-notes") {
    const hasMaterial = out.findings.some(
      (f) =>
        f.severity === "critical" ||
        f.severity === "high" ||
        (typeof f.confidence === "number" && f.confidence > 0.7)
    );
    if (hasMaterial) {
      out.verdict = "needs-attention";
      out._verdictDemoted =
        "approve-with-notes promoted to needs-attention: at least one finding is critical/high severity or confidence > 0.7";
    }
  }

  // Convergence helper: if the model picked needs-attention but every finding
  // is in fact ≤ medium AND ≤ 0.7 confidence, demote to approve-with-notes
  // so the iterate-to-approve loop has a fixed point at this calibration.
  // Empty findings always remain "approve" (or whatever the model picked).
  if (out.verdict === "needs-attention" && out.findings.length > 0) {
    const allMinor = out.findings.every(
      (f) =>
        (f.severity === "medium" || f.severity === "low") &&
        typeof f.confidence === "number" &&
        f.confidence <= 0.7
    );
    if (allMinor) {
      out.verdict = "approve-with-notes";
      out._verdictDemoted =
        "needs-attention demoted to approve-with-notes: all findings are ≤ medium severity AND confidence ≤ 0.7";
    }
  }

  return { review: out, error: null };
}

// Stable identity for a finding across review iterations. Two findings with
// the same file + line_start + normalized title hash to the same value, so
// the loop driver can detect "this concern keeps coming back" even when
// wording shifts. The hash also lets the next iteration's prompt cite a
// specific prior finding without depending on title-string matching.
export function computeFindingFingerprint(finding) {
  const file = String(finding.file ?? "").trim();
  const lineStart = Number.isInteger(finding.line_start) ? finding.line_start : 0;
  const titleNorm = String(finding.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  const canonical = `${file}:${lineStart}:${titleNorm}`;
  return createHash("sha1").update(canonical, "utf8").digest("hex").slice(0, 16);
}

const FINDING_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

function validateFinding(finding, index) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    return `findings[${index}] is not an object`;
  }
  if (!FINDING_SEVERITIES.has(finding.severity)) {
    return `findings[${index}].severity must be one of critical|high|medium|low (got: ${JSON.stringify(finding.severity)})`;
  }
  for (const key of ["title", "body", "file"]) {
    if (typeof finding[key] !== "string" || finding[key].length === 0) {
      return `findings[${index}].${key} missing or empty`;
    }
  }
  for (const key of ["line_start", "line_end"]) {
    if (!Number.isInteger(finding[key]) || finding[key] < 1) {
      return `findings[${index}].${key} must be an integer >= 1 (got: ${JSON.stringify(finding[key])})`;
    }
  }
  if (typeof finding.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1) {
    return `findings[${index}].confidence must be a number in [0, 1] (got: ${JSON.stringify(finding.confidence)})`;
  }
  if (typeof finding.recommendation !== "string") {
    return `findings[${index}].recommendation must be a string`;
  }
  return null;
}

function extractCost(events) {
  const result = events.find((e) => e.type === "result" && e.total_cost_usd != null);
  return result ? result.total_cost_usd : null;
}

// Strip a leading ```json (or ```) fence and trailing ``` if present.
// Idempotent on un-fenced input.
export function stripMarkdownFences(text) {
  if (typeof text !== "string") return text;
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : trimmed;
}

// Extract the substring of the first balanced top-level JSON object from
// `text`, respecting string literals and escapes. Returns null when no such
// object exists. Used as a fallback when strict JSON.parse rejects output
// that mixes a valid object with surrounding prose (a common live failure
// mode of grounded reviews — model emits `{...}\n\nHere are my notes: ...`).
//
// Brace counting only — no schema knowledge. The caller still parses and
// schema-validates the result; if extraction produces something parseable
// but not schema-conformant, the normal validateAndNormalizeReview path
// surfaces a schema-violation and the retry layer takes over.
export function extractFirstJsonObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

// Resolve an API-key credential for the --bare reviewer subprocess. Used
// only on the API-key auth path; the subscription/OAuth path doesn't need
// any injection (claude reads its own keychain when --bare is omitted).
//
// Waterfall:
//   1. env.ANTHROPIC_API_KEY — caller already exported one; trust it.
//   2. apiKeyHelper from ~/.claude/settings.local.json (then settings.json) —
//      claude-adv runs the helper itself and uses stdout. The locked
//      `--setting-sources ""` inside the inner claude still applies; we're
//      not relaxing isolation, we're just executing a USER-level command the
//      user already configured for this exact purpose.
//
// Threat surface: project-level .claude/settings.json (in the workspace) is
// NEVER consulted — that file can be planted by an attacker. Only user-level
// settings under ~/.claude/ are honored.
//
// Returns { source, value }. The matching `source` is what
// detectReviewerAuthClass uses to classify the auth path. `null` source
// means no API key is configured; the caller should choose useBare=false
// and let the CLI handle OAuth/keychain natively.
//
// Exported for unit testing; spawnAndCollect / detectReviewerAuthClass are
// the production callers.
export function resolveAnthropicCredential({
  env = process.env,
  homeDir = homedir(),
  fsImpl = { readFileSync, existsSync: fsExistsSync },
  execFileImpl = execFileSync,
} = {}) {
  if (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0) {
    return { source: "env", value: env.ANTHROPIC_API_KEY };
  }

  // settings.local.json takes precedence over settings.json (matches Claude
  // Code's own precedence for user-level settings).
  for (const settingsName of ["settings.local.json", "settings.json"]) {
    const settingsPath = path.join(homeDir, ".claude", settingsName);
    const helper = readApiKeyHelperFromSettings(settingsPath, fsImpl, homeDir);
    if (!helper) continue;
    const value = runApiKeyHelper(helper, execFileImpl);
    if (value) return { source: "apiKeyHelper", value };
  }

  return { source: null, value: null };
}

// Classify the auth path for the reviewer subprocess.
//   "api-key"      — env.ANTHROPIC_API_KEY set OR apiKeyHelper resolves to
//                    a non-empty value. Use --bare for strongest isolation.
//   "subscription" — neither. Use non-bare path so the inner claude can
//                    read its own keychain/OAuth credentials. Spawn from a
//                    controlled cwd to suppress project CLAUDE.md auto-load.
//
// `credential` is the same shape returned by resolveAnthropicCredential, so
// callers that need the actual API-key value to inject can read it from
// here without resolving twice.
export function detectReviewerAuthClass(deps = {}) {
  const credential = resolveAnthropicCredential(deps);
  if (credential.source === "env" || credential.source === "apiKeyHelper") {
    return { authClass: "api-key", useBare: true, credential };
  }
  return { authClass: "subscription", useBare: false, credential };
}

export function assertUserSettingsPath(settingsPath, homeDir) {
  const resolvedHome = path.resolve(homeDir);
  const resolvedSettings = path.resolve(settingsPath);
  const relative = path.relative(resolvedHome, resolvedSettings);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `apiKeyHelper settings path must live under the configured home directory: ${settingsPath}`
    );
  }
}

function readApiKeyHelperFromSettings(settingsPath, fsImpl, homeDir) {
  assertUserSettingsPath(settingsPath, homeDir);
  try {
    const blob = fsImpl.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(blob);
    const helper = parsed?.apiKeyHelper;
    return typeof helper === "string" && helper.length > 0 ? helper : null;
  } catch {
    return null;
  }
}

function runApiKeyHelper(command, execFileImpl) {
  // Settings format is a shell command (Claude Code's own apiKeyHelper docs
  // describe it as such). Run via /bin/sh -c so users can use the same
  // helper script they configure for plain `claude`. 5s timeout — long
  // enough for vault calls, short enough to not hang reviews.
  try {
    const out = execFileImpl("/bin/sh", ["-c", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// Classify Claude CLI stderr output that indicates an auth failure. The
// runtime uses this to swap the bare "claude exited 1" / "Invalid API key"
// error for an actionable message naming the working remedies.
export function classifyAuthFailure(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return null;
  if (/invalid api key|fix external api key/i.test(stderr)) return "invalid-key";
  if (/not logged in|please run \/login/i.test(stderr)) return "not-logged-in";
  return null;
}

export function buildAuthFailureMessage(kind, credentialSource = null) {
  const intro =
    kind === "invalid-key"
      ? "claude --bare auth failed with `Invalid API key`."
      : kind === "not-logged-in"
        ? "claude --bare auth failed with `Not logged in`."
        : "claude --bare auth failed.";
  const sourceNote =
    credentialSource === "oauth-keychain"
      ? " The OAuth keychain token was auto-injected as ANTHROPIC_API_KEY but the CLI rejected it — this is the documented failure mode for subscription auth (claude.ai) on newer CLI versions."
      : "";
  return [
    `${intro}${sourceNote}`,
    "Either:",
    "  1. Export `ANTHROPIC_API_KEY` pointing to a real `sk-ant-…` key, or",
    '  2. Configure `apiKeyHelper` in `~/.claude/settings.json` to a script that prints one (claude-adv runs the helper itself; the locked --setting-sources "" still applies inside the inner claude).',
    "See `docs/HOW-TO.md` §12 troubleshooting for details.",
  ].join("\n");
}

/**
 * Returns a description of the Claude-CLI runtime mode for /claude-adv:setup.
 * For Claude CLI we always use the direct one-shot subprocess model; no
 * persistent app-server exists. The "mode" string mirrors what codex's
 * equivalent function returned, to keep render.mjs untouched.
 */
export function getSessionRuntimeStatus(_env, _workspaceRoot) {
  return {
    mode: "direct",
    label: "direct claude subprocess",
    detail: "Each review or task spawns a fresh `claude` subprocess.",
    endpoint: null,
  };
}
