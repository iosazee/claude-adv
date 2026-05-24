// tests/integration/codex-real-claude-review.test.mjs.skip
//
// Run manually before release with:
//   cp tests/integration/codex-real-claude-review.test.mjs.skip tests/integration/codex-real-claude-review.test.mjs
//   node --test tests/integration/codex-real-claude-review.test.mjs
//   rm tests/integration/codex-real-claude-review.test.mjs
//
// Requires an authenticated real `claude` CLI and a network connection. This
// costs a small amount against the configured Claude account.
import { strict as assert } from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

if (process.env.RUN_INTEGRATION_TESTS !== "true") {
  test("skipping integration tests (set RUN_INTEGRATION_TESTS=true to run)", {
    skip: true,
  }, () => {});
} else {
  const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
  const ADAPTER = path.join(ROOT, "codex", "scripts", "claude-adv-codex.mjs");

  function makeRepo() {
    const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-real-repo-"));
    execSync("git init -q", { cwd: repo });
    execSync('git config user.email "real-codex@example.com" && git config user.name real-codex', {
      cwd: repo,
      shell: "/bin/bash",
    });
    writeFileSync(path.join(repo, "calc.js"), "export function add(a, b) { return a + b; }\n");
    execSync("git add . && git commit -q -m init", { cwd: repo, shell: "/bin/bash" });
    writeFileSync(path.join(repo, "calc.js"), "export function add(a, b) { return a - b; }\n");
    return repo;
  }

  function makeCodexHome() {
    return mkdtempSync(path.join(tmpdir(), "claude-adv-codex-real-home-"));
  }

  function runAdapter(args, options = {}) {
    return spawnSync(process.execPath, [ADAPTER, ...args], {
      cwd: options.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_CI: "0",
        CODEX_HOME: options.codexHome,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "",
        CODEX_THREAD_ID: "codex-real-claude-review",
      },
      timeout: 120_000,
    });
  }

  function parseJson(result) {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }

  test("codex adapter can run a real Claude adversarial review", () => {
    const repo = makeRepo();
    const codexHome = makeCodexHome();

    const setup = parseJson(
      runAdapter(["setup", "--set-budget-usd", "0.50", "--json"], { cwd: repo, codexHome })
    );
    assert.equal(setup.ready, true);
    assert.equal(setup.claude.available, true);
    assert.equal(setup.auth.loggedIn, true);
    assert.equal(setup.config.maxBudgetUsd, 0.5);

    const review = parseJson(
      runAdapter(
        [
          "adversarial-review",
          "--wait",
          "--json",
          "--scope",
          "working-tree",
          "--model",
          "claude-haiku-4-5",
        ],
        { cwd: repo, codexHome }
      )
    );

    assert.equal(review.review, "Adversarial Review");
    assert.ok(
      ["approve", "approve-with-notes", "needs-attention"].includes(review.review_output.verdict)
    );
    assert.equal(typeof review.review_output.summary, "string");
    assert.ok(Array.isArray(review.review_output.findings));
    if (typeof review.claude.costUsd === "number") {
      assert.ok(review.claude.costUsd <= 0.5);
    }
  });
}
