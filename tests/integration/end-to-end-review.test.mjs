// tests/integration/end-to-end-review.test.mjs.skip
//
// Run manually before each release with:
//   cp end-to-end-review.test.mjs.skip end-to-end-review.test.mjs
//   node --test tests/integration/end-to-end-review.test.mjs
//
// Requires authenticated `claude` CLI and a real network connection.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.RUN_INTEGRATION_TESTS !== "true") {
  test("skipping integration tests (set RUN_INTEGRATION_TESTS=true to run)", {
    skip: true,
  }, () => {});
} else {
  const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
  const COMPANION = path.join(ROOT, "scripts/claude-companion.mjs");

  test("adversarial-review runs against real claude and returns valid JSON", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-e2e-"));
    execSync("git init -q", { cwd: repo });
    execSync("git config user.email t@t && git config user.name t", {
      cwd: repo,
      shell: "/bin/bash",
    });
    // Commit a clean version, then dirty the working tree with a buggy version
    // so the working-tree diff has actual content for the model to review.
    writeFileSync(path.join(repo, "calc.js"), "function add(a, b) { return a + b }\n");
    execSync("git add . && git commit -q -m initial", { cwd: repo, shell: "/bin/bash" });
    writeFileSync(path.join(repo, "calc.js"), "function add(a, b) { return a - b }\n");

    const r = spawnSync(
      process.execPath,
      [
        COMPANION,
        "adversarial-review",
        "--wait",
        "--json",
        "--cwd",
        repo,
        "--scope",
        "working-tree",
        "--model",
        "claude-haiku-4-5",
        "the add() function looks buggy",
      ],
      { encoding: "utf8", timeout: 120000 }
    );

    assert.equal(r.status, 0, `companion exited ${r.status}; stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(
      ["approve", "needs-attention"].includes(parsed.review_output.verdict),
      `verdict was ${JSON.stringify(parsed.review_output)}`
    );
    assert.ok(typeof parsed.claude.costUsd === "number");
  });
}
