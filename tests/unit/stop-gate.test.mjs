// tests/unit/stop-gate.test.mjs
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const HOOK = path.join(ROOT, "scripts/stop-review-gate-hook.mjs");
const MOCK = path.join(ROOT, "tests/fixtures/mock-claude.sh");

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "claude-adv-stop-gate-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@t && git config user.name t", { cwd: dir, shell: "/bin/bash" });
  writeFileSync(join(dir, "f.txt"), "v1\n");
  execSync("git add . && git commit -q -m initial", { cwd: dir, shell: "/bin/bash" });
  return dir;
}

function runHook({ cwd, mockScript, sessionId = "test-sess", home }) {
  const mockBin = mkdtempSync(join(tmpdir(), "claude-adv-bin-"));
  execSync(`ln -sf '${MOCK}' '${mockBin}/claude'`);
  const env = {
    ...process.env,
    PATH: `${mockBin}:${process.env.PATH}`,
    MOCK_CLAUDE_SCRIPT: mockScript,
    HOME: home,
    CLAUDE_SESSION_ID: sessionId,
  };
  return spawnSync(process.execPath, [HOOK], { cwd, env, encoding: "utf8" });
}

test("stop-gate: review IPC timeout is generous, not the old 60s default", () => {
  // A 60s review IPC timeout fired mid-review on real Opus reviews, abandoning
  // the worker's still-running review and double-spending on a fresh-subprocess
  // fallback. The review request must now use a wall-clock bound well above any
  // budget-bounded review (REVIEW_IPC_TIMEOUT_MS). Guard against regressing to
  // the old inline `{ timeoutMs: 60000 }` on the review call.
  const src = readFileSync(HOOK, "utf8");
  const constMatch = src.match(/const REVIEW_IPC_TIMEOUT_MS\s*=\s*(\d+)\s*;/);
  assert.ok(constMatch, "expected a named REVIEW_IPC_TIMEOUT_MS constant");
  const timeoutMs = parseInt(constMatch[1], 10);
  assert.ok(
    timeoutMs >= 5 * 60 * 1000,
    `review IPC timeout should comfortably exceed a long review (>=5min); got ${timeoutMs}ms`
  );
  // The review request must use the constant, not a hardcoded 60000.
  assert.match(
    src,
    /type:\s*"review"[\s\S]*?\{\s*timeoutMs:\s*REVIEW_IPC_TIMEOUT_MS\s*\}/,
    "the review request must pass REVIEW_IPC_TIMEOUT_MS"
  );
  assert.doesNotMatch(
    src,
    /timeoutMs:\s*60000/,
    "the old 60000 review timeout must no longer appear in the hook"
  );
});

test("stop-gate: feature off → exit 0 immediately", () => {
  const repo = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "claude-adv-home-"));
  // No config written → stopReviewGate defaults to false.
  const r = runHook({ cwd: repo, mockScript: '{"events":[],"exitCode":0}', home });
  assert.equal(r.status, 0);
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("stop-gate: approve verdict → exit 0", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "f.txt"), "v2\n");
  const home = mkdtempSync(join(tmpdir(), "claude-adv-home-"));
  // Use companion's setup to enable the review-gate config under
  // $HOME/.claude/state/claude-adv/... for the test repo.
  execSync(`node "${path.join(ROOT, "scripts/claude-companion.mjs")}" setup --enable-review-gate`, {
    cwd: repo,
    env: { ...process.env, HOME: home },
  });

  const r = runHook({
    cwd: repo,
    mockScript: JSON.stringify({
      events: [
        { type: "system", subtype: "init", session_id: "mock" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  verdict: "approve",
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
    }),
    home,
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("stop-gate: needs-attention verdict → exit 2 with stderr", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "f.txt"), "BAD\n");
  const home = mkdtempSync(join(tmpdir(), "claude-adv-home-"));
  execSync(`node "${path.join(ROOT, "scripts/claude-companion.mjs")}" setup --enable-review-gate`, {
    cwd: repo,
    env: { ...process.env, HOME: home },
  });

  const r = runHook({
    cwd: repo,
    mockScript: JSON.stringify({
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
                  verdict: "needs-attention",
                  summary: "this should block",
                  findings: [
                    {
                      severity: "high",
                      title: "SQL injection",
                      body: "...",
                      file: "f.txt",
                      line_start: 1,
                      line_end: 1,
                      confidence: 0.95,
                      recommendation: "parameterize the query",
                    },
                  ],
                  next_steps: [],
                }),
              },
            ],
          },
        },
        { type: "result", subtype: "success" },
      ],
      exitCode: 0,
    }),
    home,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs-attention/);
  assert.match(r.stderr, /SQL injection/);
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("stop-gate: schema-invalid response → fail open (exit 0)", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "f.txt"), "v3\n");
  const home = mkdtempSync(join(tmpdir(), "claude-adv-home-"));
  execSync(`node "${path.join(ROOT, "scripts/claude-companion.mjs")}" setup --enable-review-gate`, {
    cwd: repo,
    env: { ...process.env, HOME: home },
  });
  const r = runHook({
    cwd: repo,
    mockScript: JSON.stringify({
      events: [
        { type: "system", subtype: "init" },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "not json at all" }] },
        },
        { type: "result", subtype: "success" },
      ],
      exitCode: 0,
    }),
    home,
  });
  assert.equal(r.status, 0);
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});
