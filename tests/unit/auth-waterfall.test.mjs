// Auth-waterfall: resolving a credential for the --bare review subprocess.
//
// Background: claude --bare strips keychain reads, so we have to inject
// ANTHROPIC_API_KEY into the subprocess env. The waterfall is:
//   1. env.ANTHROPIC_API_KEY (caller already exported one — wins)
//   2. apiKeyHelper from ~/.claude/settings.local.json (then settings.json) —
//      run it ourselves and use stdout
//   3. null source, which means the caller should take the supported
//      subscription/OAuth path by omitting --bare and letting claude read its
//      own credential store.
//
// Threat surface note: only user-level ~/.claude/settings.json and
// settings.local.json are consulted — NOT the project's .claude/settings.json,
// since that file can be planted by an attacker controlling the workspace.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resolveAnthropicCredential,
  assertUserSettingsPath,
  classifyAuthFailure,
  detectReviewerAuthClass,
} from "../../scripts/lib/claude-cli.mjs";

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), "claude-adv-auth-home-"));
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  return home;
}

function writeSettings(home, name, body) {
  writeFileSync(path.join(home, ".claude", name), JSON.stringify(body), "utf8");
}

function writeHelperScript(dir, name, stdout) {
  const scriptPath = path.join(dir, name);
  writeFileSync(scriptPath, `#!/bin/sh\nprintf '%s' '${stdout}'\n`, "utf8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

test("resolveAnthropicCredential: env.ANTHROPIC_API_KEY wins over everything else", () => {
  const home = makeHome();
  writeSettings(home, "settings.json", { apiKeyHelper: "echo helper-key" });
  const result = resolveAnthropicCredential({
    homeDir: home,
    env: { ANTHROPIC_API_KEY: "sk-ant-from-env" },
  });
  assert.equal(result.source, "env");
  assert.equal(result.value, "sk-ant-from-env");
});

test("resolveAnthropicCredential: empty env.ANTHROPIC_API_KEY is treated as unset", () => {
  // Tests deliberately set ANTHROPIC_API_KEY="" to simulate logged-out state.
  // Empty string must not short-circuit the waterfall.
  const home = makeHome();
  const result = resolveAnthropicCredential({
    homeDir: home,
    env: { ANTHROPIC_API_KEY: "" },
  });
  assert.notEqual(result.source, "env");
});

test("resolveAnthropicCredential: apiKeyHelper from settings.json is honored", () => {
  const home = makeHome();
  const helperDir = mkdtempSync(path.join(tmpdir(), "claude-adv-helper-"));
  const helper = writeHelperScript(helperDir, "key.sh", "sk-ant-helper-output");
  writeSettings(home, "settings.json", { apiKeyHelper: helper });
  const result = resolveAnthropicCredential({ homeDir: home, env: {} });
  assert.equal(result.source, "apiKeyHelper");
  assert.equal(result.value, "sk-ant-helper-output");
});

test("resolveAnthropicCredential: apiKeyHelper from settings.local.json takes precedence over settings.json", () => {
  const home = makeHome();
  const helperDir = mkdtempSync(path.join(tmpdir(), "claude-adv-helper-"));
  const mainHelper = writeHelperScript(helperDir, "main.sh", "main-key");
  const localHelper = writeHelperScript(helperDir, "local.sh", "local-key");
  writeSettings(home, "settings.json", { apiKeyHelper: mainHelper });
  writeSettings(home, "settings.local.json", { apiKeyHelper: localHelper });
  const result = resolveAnthropicCredential({ homeDir: home, env: {} });
  assert.equal(result.source, "apiKeyHelper");
  assert.equal(result.value, "local-key");
});

test("resolveAnthropicCredential: failing apiKeyHelper falls through to null (subscription class)", () => {
  const home = makeHome();
  writeSettings(home, "settings.json", { apiKeyHelper: "/nonexistent/helper.sh" });
  const result = resolveAnthropicCredential({ homeDir: home, env: {} });
  assert.equal(result.source, null);
  assert.equal(result.value, null);
});

test("resolveAnthropicCredential: helper that outputs nothing is treated as failure", () => {
  const home = makeHome();
  const helperDir = mkdtempSync(path.join(tmpdir(), "claude-adv-helper-"));
  const helper = writeHelperScript(helperDir, "empty.sh", "");
  writeSettings(home, "settings.json", { apiKeyHelper: helper });
  const result = resolveAnthropicCredential({ homeDir: home, env: {} });
  assert.equal(result.source, null);
});

test("resolveAnthropicCredential: returns null when no source is usable (→ subscription class)", () => {
  const home = makeHome();
  const result = resolveAnthropicCredential({ homeDir: home, env: {} });
  assert.equal(result.source, null);
  assert.equal(result.value, null);
});

test("resolveAnthropicCredential: project .claude/settings.json is NOT consulted (security boundary)", () => {
  // The function takes a homeDir; it must not auto-walk to cwd to find a
  // project-level settings.json. That file can be planted by an attacker.
  const home = makeHome();
  const projectDir = mkdtempSync(path.join(tmpdir(), "claude-adv-project-"));
  mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
  writeFileSync(
    path.join(projectDir, ".claude", "settings.json"),
    JSON.stringify({ apiKeyHelper: "echo hostile-key" }),
    "utf8"
  );
  const result = resolveAnthropicCredential({
    homeDir: home,
    env: {},
    cwd: projectDir,
  });
  assert.equal(result.source, null, "project settings must be ignored even when passed as cwd");
});

test("assertUserSettingsPath rejects paths outside the configured home directory", () => {
  const home = makeHome();
  const projectDir = mkdtempSync(path.join(tmpdir(), "claude-adv-project-"));
  const projectSettings = path.join(projectDir, ".claude", "settings.json");
  assert.throws(
    () => assertUserSettingsPath(projectSettings, home),
    /must live under the configured home directory/
  );
  assert.doesNotThrow(() =>
    assertUserSettingsPath(path.join(home, ".claude", "settings.json"), home)
  );
});

// detectReviewerAuthClass — decides which auth path the reviewer takes.
test("detectReviewerAuthClass: env.ANTHROPIC_API_KEY → api-key class, useBare=true", () => {
  const home = makeHome();
  const result = detectReviewerAuthClass({
    homeDir: home,
    env: { ANTHROPIC_API_KEY: "sk-ant-real" },
  });
  assert.equal(result.authClass, "api-key");
  assert.equal(result.useBare, true);
  assert.equal(result.credential.source, "env");
  assert.equal(result.credential.value, "sk-ant-real");
});

test("detectReviewerAuthClass: apiKeyHelper resolves → api-key class, useBare=true", () => {
  const home = makeHome();
  const helperDir = mkdtempSync(path.join(tmpdir(), "claude-adv-helper-"));
  const helper = writeHelperScript(helperDir, "h.sh", "sk-ant-from-helper");
  writeSettings(home, "settings.json", { apiKeyHelper: helper });
  const result = detectReviewerAuthClass({ homeDir: home, env: {} });
  assert.equal(result.authClass, "api-key");
  assert.equal(result.useBare, true);
  assert.equal(result.credential.source, "apiKeyHelper");
});

test("detectReviewerAuthClass: no env, no helper → subscription class, useBare=false", () => {
  const home = makeHome();
  const result = detectReviewerAuthClass({ homeDir: home, env: {} });
  assert.equal(result.authClass, "subscription");
  assert.equal(result.useBare, false);
  assert.equal(result.credential.source, null);
});

test("detectReviewerAuthClass: empty env.ANTHROPIC_API_KEY does NOT trip api-key class", () => {
  // Empty string is the test convention for "logged out". Must classify as
  // subscription so the non-bare path is taken.
  const home = makeHome();
  const result = detectReviewerAuthClass({ homeDir: home, env: { ANTHROPIC_API_KEY: "" } });
  assert.equal(result.authClass, "subscription");
  assert.equal(result.useBare, false);
});

// classifyAuthFailure groups Claude CLI auth rejection messages so the runtime
// can show one actionable error instead of "claude exited 1" + opaque stderr.
test("classifyAuthFailure: Invalid API key → invalid-key", () => {
  assert.equal(classifyAuthFailure("Invalid API key · Fix external API key"), "invalid-key");
  assert.equal(classifyAuthFailure("error: Invalid API key"), "invalid-key");
});

test("classifyAuthFailure: Not logged in → not-logged-in", () => {
  assert.equal(classifyAuthFailure("Not logged in · Please run /login"), "not-logged-in");
});

test("classifyAuthFailure: Fix external API key → invalid-key", () => {
  assert.equal(classifyAuthFailure("Fix external API key"), "invalid-key");
});

test("classifyAuthFailure: ordinary spawn error → null", () => {
  assert.equal(classifyAuthFailure("git: command not found"), null);
  assert.equal(classifyAuthFailure(""), null);
  assert.equal(classifyAuthFailure(null), null);
});
