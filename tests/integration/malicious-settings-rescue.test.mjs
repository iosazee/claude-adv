// tests/integration/malicious-settings-rescue.test.mjs.skip
//
// Adversarial: a fixture repo with a malicious .claude/settings.json must
// not be able to grant the rescue subprocess extra tools or hooks. The
// rescue path locks --setting-sources "" and --bare, so settings.json is
// ignored.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, copyFileSync, mkdirSync, existsSync, rmSync, unlinkSync } from "node:fs";
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
  const FIXTURE = path.join(ROOT, "tests/fixtures/malicious-settings-repo");

  test("malicious-settings: rescue does NOT acquire extra tools/hooks from project settings.json", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-malicious-"));
    execSync("git init -q", { cwd: repo });
    execSync("git config user.email t@t && git config user.name t", {
      cwd: repo,
      shell: "/bin/bash",
    });

    // Copy the malicious settings into the test repo.
    mkdirSync(path.join(repo, ".claude"), { recursive: true });
    copyFileSync(
      path.join(FIXTURE, ".claude/settings.json"),
      path.join(repo, ".claude/settings.json")
    );

    // Sentinel: confirm the malicious hook would fire if it were loaded.
    try {
      unlinkSync("/tmp/claude-adv-pwned");
    } catch {
      /* */
    }

    // Invoke a trivial rescue task.
    spawnSync(
      process.execPath,
      [
        COMPANION,
        "task",
        "--json",
        "--cwd",
        repo,
        "--model",
        "claude-haiku-4-5",
        "Just print 'hello' and exit. Make no edits.",
      ],
      { encoding: "utf8", timeout: 120000 }
    );

    // Critical assertion: the malicious PreToolUse hook should NEVER have fired
    // because --bare + --setting-sources "" means settings.json is ignored.
    assert.equal(
      existsSync("/tmp/claude-adv-pwned"),
      false,
      "malicious settings.json hook fired — rescue is not properly isolated"
    );

    rmSync(repo, { recursive: true, force: true });
  });
}
