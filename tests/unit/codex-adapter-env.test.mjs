import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  bootFingerprint,
  buildAdapterEnv,
  detectCodexCiMode,
  parseCodexCi,
  resolveValidatedCodexHome,
  roundedBootEpochSeconds,
  validateThreadId,
} from "../../plugins/claude-adv/scripts/lib/codex-env.mjs";

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-home-"));
  mkdirSync(path.join(home, ".codex"));
  return home;
}

test("codex env validates thread ids", () => {
  assert.deepEqual(validateThreadId("abc_123.X-y"), { ok: true, value: "abc_123.X-y" });

  for (const raw of [
    "",
    " ",
    ".leading",
    "abc\ndef",
    "abc\u0000def",
    "a".repeat(129),
    "codex:already",
    "../escape",
  ]) {
    assert.equal(validateThreadId(raw).ok, false, JSON.stringify(raw));
  }
});

test("codex env parses CI truth values and excludes Desktop origin", () => {
  for (const value of ["1", "true", "yes", "TRUE", "YES"]) {
    assert.equal(parseCodexCi(value), true, value);
    assert.equal(detectCodexCiMode({ CODEX_CI: value }), true, value);
  }
  for (const value of ["", "0", "false", "no", undefined]) {
    assert.equal(parseCodexCi(value), false, String(value));
    assert.equal(detectCodexCiMode({ CODEX_CI: value }), false, String(value));
  }

  assert.equal(
    detectCodexCiMode({
      CODEX_CI: "1",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
    }),
    false
  );
});

test("codex env boot fingerprint is deterministic across small slew", () => {
  const nowMs = 2_000_000;
  const uptimeSeconds = 1000;

  assert.equal(roundedBootEpochSeconds(nowMs, uptimeSeconds), 1020);
  assert.match(bootFingerprint(nowMs, uptimeSeconds), /^[0-9a-f]{8}$/);
  assert.equal(
    bootFingerprint(nowMs, uptimeSeconds),
    bootFingerprint(nowMs + 5_000, uptimeSeconds)
  );
  assert.notEqual(
    bootFingerprint(nowMs, uptimeSeconds),
    bootFingerprint(nowMs + 90_000, uptimeSeconds)
  );
});

test("codex env falls back from empty or invalid CODEX_HOME to validated HOME", () => {
  const home = makeHome();
  const fallback = realpathSync(path.join(home, ".codex"));

  assert.equal(resolveValidatedCodexHome({ CODEX_HOME: "", HOME: home }).codexHome, fallback);
  assert.equal(
    resolveValidatedCodexHome({ CODEX_HOME: path.join(home, "missing"), HOME: home }).codexHome,
    fallback
  );
});

test("codex env rejects symlink and uid-mismatch CODEX_HOME values", () => {
  const home = makeHome();
  const fallback = realpathSync(path.join(home, ".codex"));
  const evilLink = path.join(home, "evil-codex-home");
  symlinkSync("/etc", evilLink);

  const symlinkResult = resolveValidatedCodexHome({ CODEX_HOME: evilLink, HOME: home });
  assert.equal(symlinkResult.codexHome, fallback);
  assert.match(symlinkResult.warnings.join("\n"), /CODEX_HOME ignored/);

  const currentUid = typeof process.getuid === "function" ? process.getuid() : 0;
  const fsImpl = {
    realpathSync: (value) => value,
    statSync: (value) => ({
      uid: value === "/codex-home" ? currentUid + 1 : currentUid,
      isDirectory: () => true,
    }),
  };

  const uidResult = resolveValidatedCodexHome(
    { CODEX_HOME: "/codex-home", HOME: "/home/user" },
    fsImpl
  );
  assert.equal(uidResult.codexHome, "/home/user/.codex");
  assert.match(uidResult.warnings.join("\n"), /reason=uid-mismatch/);
});

test("codex env fails closed when no usable state directory exists", () => {
  const fsImpl = {
    realpathSync() {
      throw new Error("missing");
    },
    statSync() {
      throw new Error("missing");
    },
  };

  assert.throws(
    () => resolveValidatedCodexHome({ CODEX_HOME: "/bad", HOME: "/no-home" }, fsImpl),
    /claude-adv-codex: no usable state directory \(CODEX_HOME=\/bad HOME=\/no-home\)/
  );
});

test("codex env builds isolated adapter env with validated session id", () => {
  const home = makeHome();
  const repoRoot = "/repo/root";
  const result = buildAdapterEnv({
    repoRoot,
    nowMs: 2_000_000,
    uptimeSeconds: 1000,
    env: {
      HOME: home,
      CODEX_THREAD_ID: "abc_123.X-y",
      CLAUDE_PLUGIN_DATA: "/stale/claude",
      CODEX_PLUGIN_DATA: "/ignored/codex",
      CLAUDE_ADV_SESSION_ID: "stale-session",
      CLAUDE_ADV_WARN_CROSS_SESSION: "stale-warning",
      CLAUDE_SESSION_ID: "claude-session",
    },
  });

  assert.equal(result.codexHome, realpathSync(path.join(home, ".codex")));
  assert.equal(result.env.CLAUDE_PLUGIN_ROOT, repoRoot);
  assert.equal(result.env.CLAUDE_PLUGIN_DATA, path.join(result.codexHome, "state", "claude-adv"));
  assert.match(result.env.CLAUDE_ADV_SESSION_ID, /^codex:abc_123\.X-y@[0-9a-f]{8}$/);
  assert.equal(result.env.CLAUDE_ADV_WARN_CROSS_SESSION, undefined);
  assert.equal(result.env.CLAUDE_SESSION_ID, undefined);
});

test("codex env removes inherited session vars when thread id is missing or invalid", () => {
  for (const CODEX_THREAD_ID of [undefined, "", ".bad"]) {
    const home = makeHome();
    const result = buildAdapterEnv({
      repoRoot: "/repo/root",
      env: {
        HOME: home,
        CODEX_THREAD_ID,
        CLAUDE_ADV_SESSION_ID: "stale-session",
        CLAUDE_ADV_WARN_CROSS_SESSION: "stale-warning",
      },
    });

    assert.equal(result.env.CLAUDE_ADV_SESSION_ID, undefined, String(CODEX_THREAD_ID));
    assert.equal(result.env.CLAUDE_ADV_WARN_CROSS_SESSION, undefined, String(CODEX_THREAD_ID));
  }
});
