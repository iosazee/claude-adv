// tests/integration/claude-cli.real.test.mjs.skip
//
// Run manually before each release with:
//   cp claude-cli.real.test.mjs.skip claude-cli.real.test.mjs
//   node --test tests/integration/claude-cli.real.test.mjs
//   rm tests/integration/claude-cli.real.test.mjs
//
// Requires authenticated `claude` CLI.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildReviewerArgs, spawnAndCollect } from "../../scripts/lib/claude-cli.mjs";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

if (process.env.RUN_INTEGRATION_TESTS !== "true") {
  test("skipping integration tests (set RUN_INTEGRATION_TESTS=true to run)", {
    skip: true,
  }, () => {});
} else {
  test("real claude + buildReviewerArgs returns a schema-valid review", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "claude-adv-real-"));
    const promptFile = join(tempDir, "prompt.md");
    writeFileSync(promptFile, `You are reviewing a code diff. Return strict JSON only.`);

    try {
      const argv = buildReviewerArgs({
        promptFile,
        budgetUsd: 0.5,
        sessionId: randomUUID(),
        model: "claude-haiku-4-5", // cheap model for smoke
      });

      const result = await spawnAndCollect(
        argv,
        `Diff:\n\`\`\`\nfunction add(a,b) { return a+b }\n\`\`\`\n\nReview this.`
      );

      assert.equal(result.ok, true, `failed: ${result.error ?? ""}`);
      assert.ok(["approve", "needs-attention"].includes(result.review.verdict));
      assert.ok(result.review.summary);
      assert.ok(Array.isArray(result.review.findings));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
}
