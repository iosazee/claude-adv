import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  spawnAndCollect,
  stripMarkdownFences,
  validateAndNormalizeReview,
  computeFindingFingerprint,
} from "../../scripts/lib/claude-cli.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const MOCK = path.join(ROOT, "tests/fixtures/mock-claude.sh");

function buildScript({ verdict = "approve", summary = "ok", exitCode = 0, extraEvents = [] } = {}) {
  return JSON.stringify({
    events: [
      { type: "system", subtype: "init", session_id: "test-sid" },
      ...extraEvents,
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({ verdict, summary, findings: [], next_steps: [] }),
            },
          ],
        },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.01 },
    ],
    exitCode,
  });
}

test("spawnAndCollect parses stream-json events and extracts final structured output", async () => {
  const result = await spawnAndCollect([], "review this diff", {
    claudeBin: MOCK,
    env: { MOCK_CLAUDE_SCRIPT: buildScript({ verdict: "approve" }) },
  });

  assert.equal(result.ok, true);
  assert.equal(result.review.verdict, "approve");
  assert.equal(result.review.summary, "ok");
  assert.equal(result.exitCode, 0);
  assert.ok(typeof result.costUsd === "number");
});

test("spawnAndCollect surfaces a non-zero exit code", async () => {
  const result = await spawnAndCollect([], "x", {
    claudeBin: MOCK,
    env: { MOCK_CLAUDE_SCRIPT: buildScript({ exitCode: 2 }) },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.ok, false);
});

test("spawnAndCollect handles missing final-message gracefully", async () => {
  const result = await spawnAndCollect([], "x", {
    claudeBin: MOCK,
    env: {
      MOCK_CLAUDE_SCRIPT: JSON.stringify({
        events: [{ type: "system", subtype: "init" }],
        exitCode: 0,
      }),
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /no final assistant message/i);
});

test("spawnAndCollect handles malformed final-message JSON", async () => {
  const result = await spawnAndCollect([], "x", {
    claudeBin: MOCK,
    env: {
      MOCK_CLAUDE_SCRIPT: JSON.stringify({
        events: [
          { type: "system", subtype: "init" },
          {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "not json at all" }] },
          },
        ],
        exitCode: 0,
      }),
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /parse|JSON/i);
});

test("spawnAndCollect strips markdown ```json fences before JSON.parse", async () => {
  // The model wraps the JSON in fences in real claude stream-json output.
  // The mock emits the same pattern; spawnAndCollect must strip them.
  const fenced =
    "```json\n" +
    JSON.stringify({ verdict: "approve", summary: "fenced", findings: [], next_steps: [] }) +
    "\n```";
  const script = JSON.stringify({
    events: [
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: fenced }] },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.005 },
    ],
    exitCode: 0,
  });
  const result = await spawnAndCollect([], "x", {
    claudeBin: MOCK,
    env: { MOCK_CLAUDE_SCRIPT: script, ANTHROPIC_API_KEY: "" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.review.verdict, "approve");
  assert.equal(result.review.summary, "fenced");
});

test("stripMarkdownFences handles plain text and fenced variants", () => {
  assert.equal(stripMarkdownFences("plain text"), "plain text");
  assert.equal(stripMarkdownFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripMarkdownFences('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripMarkdownFences('  ```json\n  {"a":1}\n```  '), '{"a":1}');
  assert.equal(stripMarkdownFences(""), "");
});

test("validateAndNormalizeReview accepts a well-formed object", () => {
  const { review, error } = validateAndNormalizeReview({
    verdict: "approve",
    summary: "ok",
    findings: [],
    next_steps: [],
  });
  assert.equal(error, null);
  assert.equal(review.verdict, "approve");
});

test("validateAndNormalizeReview renames status→verdict and description→summary", () => {
  const { review, error } = validateAndNormalizeReview({
    status: "approve",
    description: "looks fine",
  });
  assert.equal(error, null);
  assert.equal(review.verdict, "approve");
  assert.equal(review.summary, "looks fine");
  assert.ok(!("status" in review));
  assert.ok(!("description" in review));
  assert.deepEqual(review.findings, []);
  assert.deepEqual(review.next_steps, []);
});

test("validateAndNormalizeReview fills missing findings and next_steps with []", () => {
  const { review, error } = validateAndNormalizeReview({
    verdict: "needs-attention",
    summary: "issues",
  });
  assert.equal(error, null);
  assert.deepEqual(review.findings, []);
  assert.deepEqual(review.next_steps, []);
});

test("validateAndNormalizeReview coerces non-enum verdict to needs-attention", () => {
  const { review, error } = validateAndNormalizeReview({
    verdict: "CRITICAL_BUG",
    summary: "x",
  });
  assert.equal(error, null);
  assert.equal(review.verdict, "needs-attention");
});

test("validateAndNormalizeReview normalizes verdict case + underscored variant", () => {
  assert.equal(
    validateAndNormalizeReview({ verdict: "APPROVED", summary: "x" }).review.verdict,
    "approve"
  );
  assert.equal(
    validateAndNormalizeReview({ verdict: "needs_attention", summary: "x" }).review.verdict,
    "needs-attention"
  );
});

test("validateAndNormalizeReview rejects missing summary", () => {
  const { review, error } = validateAndNormalizeReview({ verdict: "approve" });
  assert.equal(review, null);
  assert.match(error, /summary/);
});

test("validateAndNormalizeReview rejects non-object input", () => {
  assert.match(validateAndNormalizeReview(null).error, /not a JSON object/);
  assert.match(validateAndNormalizeReview([]).error, /not a JSON object/);
  assert.match(validateAndNormalizeReview("approve").error, /not a JSON object/);
});

function wellFormedFinding(overrides = {}) {
  return {
    severity: "high",
    title: "t",
    body: "b",
    file: "f.ts",
    line_start: 1,
    line_end: 1,
    confidence: 0.9,
    recommendation: "fix",
    ...overrides,
  };
}

test("validateAndNormalizeReview accepts a fully-structured finding", () => {
  const { review, error } = validateAndNormalizeReview({
    verdict: "needs-attention",
    summary: "x",
    findings: [wellFormedFinding()],
    next_steps: ["do the thing"],
  });
  assert.equal(error, null);
  assert.equal(review.findings.length, 1);
  assert.equal(review.findings[0].severity, "high");
});

test("validateAndNormalizeReview rejects a finding with bad severity", () => {
  const { error } = validateAndNormalizeReview({
    verdict: "needs-attention",
    summary: "x",
    findings: [wellFormedFinding({ severity: "blocker" })],
    next_steps: [],
  });
  assert.match(error, /findings\[0\]\.severity/);
});

test("validateAndNormalizeReview rejects a finding missing confidence", () => {
  const { confidence: _drop, ...rest } = wellFormedFinding();
  const { error } = validateAndNormalizeReview({
    verdict: "needs-attention",
    summary: "x",
    findings: [rest],
    next_steps: [],
  });
  assert.match(error, /findings\[0\]\.confidence/);
});

test("validateAndNormalizeReview rejects a finding with non-integer line_start", () => {
  const { error } = validateAndNormalizeReview({
    verdict: "needs-attention",
    summary: "x",
    findings: [wellFormedFinding({ line_start: "ten" })],
    next_steps: [],
  });
  assert.match(error, /findings\[0\]\.line_start/);
});

test("validateAndNormalizeReview rejects confidence outside [0, 1]", () => {
  const { error } = validateAndNormalizeReview({
    verdict: "needs-attention",
    summary: "x",
    findings: [wellFormedFinding({ confidence: 1.5 })],
    next_steps: [],
  });
  assert.match(error, /confidence must be a number in \[0, 1\]/);
});

test("validateAndNormalizeReview rejects empty string in next_steps", () => {
  const { error } = validateAndNormalizeReview({
    verdict: "approve",
    summary: "ok",
    findings: [],
    next_steps: ["", "fine"],
  });
  assert.match(error, /next_steps\[0\] is not a non-empty string/);
});

test("validateAndNormalizeReview rejects findings/next_steps not being arrays", () => {
  assert.match(
    validateAndNormalizeReview({ verdict: "approve", summary: "x", findings: "nope" }).error,
    /findings is not an array/
  );
  assert.match(
    validateAndNormalizeReview({ verdict: "approve", summary: "x", next_steps: {} }).error,
    /next_steps is not an array/
  );
});

test("computeFindingFingerprint produces a 16-hex stable identity per file+line+normalized-title", () => {
  // Same file + same line + same title (post-normalization) → same hash.
  const a = computeFindingFingerprint({ file: "x.ts", line_start: 10, title: "Off-by-one error" });
  const b = computeFindingFingerprint({ file: "x.ts", line_start: 10, title: "Off-by-one error" });
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{16}$/);
  // Title normalization (case + punctuation + whitespace) is idempotent.
  const c = computeFindingFingerprint({
    file: "x.ts",
    line_start: 10,
    title: "  off by ONE   error!!  ",
  });
  assert.equal(a, c);
  // Different file → different hash.
  const d = computeFindingFingerprint({ file: "y.ts", line_start: 10, title: "Off-by-one error" });
  assert.notEqual(a, d);
  // Different line → different hash (line_start is part of identity).
  const e = computeFindingFingerprint({ file: "x.ts", line_start: 11, title: "Off-by-one error" });
  assert.notEqual(a, e);
});

test("validateAndNormalizeReview computes fingerprint client-side and overwrites any model-supplied one", () => {
  const { review, error } = validateAndNormalizeReview({
    verdict: "needs-attention",
    summary: "x",
    findings: [
      {
        severity: "high",
        title: "off by one",
        body: "b",
        file: "f.ts",
        line_start: 1,
        line_end: 1,
        confidence: 0.9,
        recommendation: "fix",
        fingerprint: "MODEL_INVENTED_ID",
      },
    ],
    next_steps: [],
  });
  assert.equal(error, null);
  assert.match(review.findings[0].fingerprint, /^[a-f0-9]{16}$/);
  assert.notEqual(review.findings[0].fingerprint, "MODEL_INVENTED_ID");
});

test("validateAndNormalizeReview accepts approve-with-notes verdict", () => {
  const { review, error } = validateAndNormalizeReview({
    verdict: "approve-with-notes",
    summary: "minor notes only",
    findings: [
      {
        severity: "medium",
        title: "t",
        body: "b",
        file: "f.ts",
        line_start: 1,
        line_end: 1,
        confidence: 0.5,
        recommendation: "fix",
      },
    ],
    next_steps: [],
  });
  assert.equal(error, null);
  assert.equal(review.verdict, "approve-with-notes");
});

test("validateAndNormalizeReview promotes approve-with-notes to needs-attention on high-severity finding", () => {
  // Model picked approve-with-notes but findings include a high-severity item.
  // Auto-promote to needs-attention so the model can't soften a real concern.
  const { review, error } = validateAndNormalizeReview({
    verdict: "approve-with-notes",
    summary: "x",
    findings: [
      {
        severity: "high",
        title: "real concern",
        body: "b",
        file: "f.ts",
        line_start: 1,
        line_end: 1,
        confidence: 0.9,
        recommendation: "fix",
      },
    ],
    next_steps: [],
  });
  assert.equal(error, null);
  assert.equal(review.verdict, "needs-attention");
  assert.match(review._verdictDemoted, /promoted to needs-attention/);
});

test("validateAndNormalizeReview promotes approve-with-notes on high-confidence finding", () => {
  const { review, error } = validateAndNormalizeReview({
    verdict: "approve-with-notes",
    summary: "x",
    findings: [
      {
        severity: "medium",
        title: "t",
        body: "b",
        file: "f.ts",
        line_start: 1,
        line_end: 1,
        confidence: 0.85, // > 0.7
        recommendation: "fix",
      },
    ],
    next_steps: [],
  });
  assert.equal(error, null);
  assert.equal(review.verdict, "needs-attention");
});

test("validateAndNormalizeReview demotes needs-attention to approve-with-notes when all findings are minor", () => {
  // Convergence helper: model picked needs-attention but every finding is
  // medium/low AND confidence ≤ 0.7. The iteration loop needs a fixed point,
  // so we demote.
  const { review, error } = validateAndNormalizeReview({
    verdict: "needs-attention",
    summary: "x",
    findings: [
      {
        severity: "medium",
        title: "t1",
        body: "b",
        file: "f.ts",
        line_start: 1,
        line_end: 1,
        confidence: 0.55,
        recommendation: "fix",
      },
      {
        severity: "low",
        title: "t2",
        body: "b",
        file: "f.ts",
        line_start: 2,
        line_end: 2,
        confidence: 0.65,
        recommendation: "fix",
      },
    ],
    next_steps: [],
  });
  assert.equal(error, null);
  assert.equal(review.verdict, "approve-with-notes");
  assert.match(review._verdictDemoted, /demoted to approve-with-notes/);
});

test("validateAndNormalizeReview leaves empty-findings approve untouched", () => {
  const { review, error } = validateAndNormalizeReview({
    verdict: "approve",
    summary: "all clear",
    findings: [],
    next_steps: [],
  });
  assert.equal(error, null);
  assert.equal(review.verdict, "approve");
  assert.equal(review._verdictDemoted, undefined);
});

test("validateAndNormalizeReview maps approve_with_notes underscore form to canonical kebab", () => {
  const { review, error } = validateAndNormalizeReview({
    verdict: "approve_with_notes",
    summary: "x",
    findings: [],
    next_steps: [],
  });
  assert.equal(error, null);
  assert.equal(review.verdict, "approve-with-notes");
});

test("spawnAndCollect surfaces schema-violation as ok:false", async () => {
  // Mock emits a final assistant message whose JSON is missing required fields.
  const script = JSON.stringify({
    events: [
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: '{"verdict":"approve"}' }] },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.001 },
    ],
    exitCode: 0,
  });
  const result = await spawnAndCollect([], "x", {
    claudeBin: MOCK,
    env: { MOCK_CLAUDE_SCRIPT: script, ANTHROPIC_API_KEY: "" },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /schema-violation/);
});

test("spawnAndCollect with parseAsJson:false skips parse and sets ok from exit code", async () => {
  const script = JSON.stringify({
    events: [
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Task complete: freeform prose, not JSON." }],
        },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.005 },
    ],
    exitCode: 0,
  });
  const result = await spawnAndCollect([], "x", {
    claudeBin: MOCK,
    parseAsJson: false,
    env: { MOCK_CLAUDE_SCRIPT: script, ANTHROPIC_API_KEY: "" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.review, null);
  assert.equal(result.error, null);
  assert.equal(result.exitCode, 0);
  // Caller reads freeform text from events themselves
  const text = result.events
    .filter((e) => e.type === "assistant")
    .flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text))
    .join("");
  assert.ok(text.includes("Task complete"));
});

test("spawnAndCollect with parseAsJson:false surfaces non-zero exit cleanly", async () => {
  const result = await spawnAndCollect([], "x", {
    claudeBin: MOCK,
    parseAsJson: false,
    env: { MOCK_CLAUDE_SCRIPT: JSON.stringify({ events: [], exitCode: 5 }), ANTHROPIC_API_KEY: "" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 5);
  assert.match(result.error, /exited 5/);
});

test("spawnAndCollect resolves ok:false when the binary is missing (ENOENT)", async () => {
  // Pointing at a path that does not exist must NOT raise an unhandled
  // 'error' event; the helper has to surface a clean failure.
  const result = await spawnAndCollect([], "x", {
    claudeBin: "/no/such/binary/anywhere-xyz",
    env: { ANTHROPIC_API_KEY: "" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.review, null);
  assert.match(result.error, /spawn failed/);
});

test("spawnAndCollect normalizes status→verdict end-to-end via mock", async () => {
  const script = JSON.stringify({
    events: [
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "approve",
                summary: "ok",
                findings: [],
                next_steps: [],
              }),
            },
          ],
        },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.001 },
    ],
    exitCode: 0,
  });
  const result = await spawnAndCollect([], "x", {
    claudeBin: MOCK,
    env: { MOCK_CLAUDE_SCRIPT: script, ANTHROPIC_API_KEY: "" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.review.verdict, "approve");
  assert.ok(!("status" in result.review));
});

// Live failure mode observed 2026-05-14: grounded reviews where the model
// inspects actual files tend to emit valid JSON followed by a short prose
// commentary (e.g. "Here are my detailed observations: ..."). Strict
// JSON.parse rejected this entirely; the runtime now extracts the first
// balanced top-level object so the trailing prose doesn't poison the verdict.
test("spawnAndCollect tolerates valid JSON followed by trailing prose", async () => {
  const reviewJson = JSON.stringify({
    verdict: "approve",
    summary: "all good",
    findings: [],
    next_steps: [],
  });
  const trailing =
    "\n\nHere are my detailed observations: I inspected all 4 files and they look clean.";
  const script = JSON.stringify({
    events: [
      { type: "system", subtype: "init", session_id: "trail-1" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: reviewJson + trailing }],
        },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.01 },
    ],
    exitCode: 0,
  });
  const result = await spawnAndCollect([], "x", {
    claudeBin: MOCK,
    env: { MOCK_CLAUDE_SCRIPT: script, ANTHROPIC_API_KEY: "" },
  });
  assert.equal(result.ok, true, `expected ok:true, got error=${result.error}`);
  assert.equal(result.review.verdict, "approve");
  assert.equal(result.review.summary, "all good");
});

// Counterpart: when the model emits purely conversational text with NO
// extractable JSON object, surface a parse-failure error so the caller
// (_shared-review) can trigger the schema-repair retry path.
test("spawnAndCollect returns parse-failure for non-JSON conversational text", async () => {
  const script = JSON.stringify({
    events: [
      { type: "system", subtype: "init", session_id: "prose-1" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I'll inspect these files and report back. Looking at the diff first...",
            },
          ],
        },
      },
      { type: "result", subtype: "success", total_cost_usd: 0.01 },
    ],
    exitCode: 0,
  });
  const result = await spawnAndCollect([], "x", {
    claudeBin: MOCK,
    env: { MOCK_CLAUDE_SCRIPT: script, ANTHROPIC_API_KEY: "" },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /failed to parse/);
});
