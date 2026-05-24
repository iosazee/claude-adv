import { test } from "node:test";
import { strict as assert } from "node:assert";
import { extractThinkingBlocks, renderStoredJobResult } from "../../scripts/lib/render.mjs";

test("render.extractThinkingBlocks pulls thinking text out of assistant events", () => {
  const events = [
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "first thought" },
          { type: "text", text: "..." },
        ],
      },
    },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "second thought" }] } },
    { type: "result", subtype: "success" },
  ];
  assert.deepEqual(extractThinkingBlocks(events), ["first thought", "second thought"]);
});

test("render.extractThinkingBlocks returns empty array on empty/missing input", () => {
  assert.deepEqual(extractThinkingBlocks(), []);
  assert.deepEqual(extractThinkingBlocks([]), []);
  assert.deepEqual(extractThinkingBlocks([{ type: "result" }]), []);
});

test("renderStoredJobResult reads rawOutput from rawPayload (task background path)", () => {
  // task.mjs persists the rescue payload under `rawPayload`. The renderer must
  // surface that text instead of falling through to "No captured result".
  const job = { id: "task-001", title: "Claude Task", status: "completed" };
  const storedJob = {
    rawPayload: {
      rawOutput: "edited foo.js\npatched bar.ts",
      costUsd: 0.0234,
      ok: true,
    },
  };
  const out = renderStoredJobResult(job, storedJob);
  assert.match(out, /edited foo\.js/);
  assert.match(out, /patched bar\.ts/);
  assert.match(out, /Cost: \$0\.0234/);
  assert.doesNotMatch(out, /No captured result payload was stored/);
});

test("renderStoredJobResult still honours legacy storedJob.result.rawOutput", () => {
  const job = { id: "task-002", status: "completed" };
  const storedJob = { result: { rawOutput: "legacy output" } };
  const out = renderStoredJobResult(job, storedJob);
  assert.match(out, /legacy output/);
});

test("renderStoredJobResult surfaces raw output on schema-violation failure", () => {
  // When the inner reviewer returns malformed JSON and the retry also fails,
  // _shared-review.mjs persists the model's raw text under rawPayload.claude.
  // /result must render it as a fenced text block so the user can salvage
  // the content, instead of falling through to "No captured result payload".
  const job = { id: "rev-fail-001", title: "Claude Adversarial Review", status: "failed" };
  const storedJob = {
    rawPayload: {
      target: { label: "working tree vs HEAD" },
      claude: {
        ok: false,
        error: "schema-violation: findings[0].severity missing or not in enum",
        retryAttempted: true,
        costUsd: 0.0019,
        rawOutput:
          '{"verdict":"needs-attention","summary":"x","findings":[{"title":"y"}],"next_steps":[]}',
      },
    },
  };
  const out = renderStoredJobResult(job, storedJob);
  assert.match(out, /# Claude Adversarial Review/);
  assert.match(out, /Review failed: schema-violation/);
  assert.match(out, /A single schema-repair retry was attempted and also failed/);
  assert.match(out, /```text/);
  assert.match(out, /"findings":\[\{"title":"y"\}\]/);
  assert.match(out, /Cost: \$0\.0019/);
  assert.doesNotMatch(out, /No captured result payload was stored/);
});

test("renderStoredJobResult renders background review_output as structured markdown", () => {
  // _shared-review.mjs persists review_output alongside rawPayload for
  // background reviews. Without a dedicated render branch, /result <id>
  // fell through to "No captured result payload was stored."
  const job = { id: "rev-001", title: "Claude Adversarial Review", status: "completed" };
  const storedJob = {
    review_output: {
      verdict: "needs-attention",
      summary: "missing error handling around the retry loop",
      findings: [
        {
          severity: "high",
          title: "unbounded retry on 5xx",
          body: "the loop has no max-attempts; a flapping upstream produces infinite retries",
          file: "src/retry.ts",
          line_start: 10,
          line_end: 18,
          confidence: 0.9,
          recommendation: "add max-attempts and exponential backoff",
        },
      ],
      next_steps: ["cap retries at 5", "log the final-failure path"],
    },
    rawPayload: {
      target: { label: "working tree vs HEAD" },
      claude: { costUsd: 0.0123 },
    },
  };
  const out = renderStoredJobResult(job, storedJob);
  assert.match(out, /# Claude Adversarial Review/);
  assert.match(out, /Target: working tree vs HEAD/);
  assert.match(out, /Verdict: needs-attention/);
  assert.match(out, /missing error handling/);
  assert.match(out, /unbounded retry on 5xx/);
  assert.match(out, /src\/retry\.ts:10-18/);
  assert.match(out, /cap retries at 5/);
  assert.match(out, /Cost: \$0\.0123/);
  assert.doesNotMatch(out, /No captured result payload was stored/);
});
