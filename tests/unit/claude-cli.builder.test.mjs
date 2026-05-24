// tests/unit/claude-cli.builder.test.mjs
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { buildReviewerArgs, buildRescueArgs } from "../../scripts/lib/claude-cli.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");

test("buildReviewerArgs produces exact golden argv for adversarial review (useBare:true)", () => {
  const argv = buildReviewerArgs({
    promptFile: path.join(ROOT, "prompts/adversarial-review.md"),
    budgetUsd: 5,
    sessionId: "00000000-0000-4000-8000-000000000001",
    useBare: true,
  });

  // --json-schema receives the verbatim contents of the schema file, not a path
  // (the CLI silently hangs on a path arg). Test derives the expected value by
  // reading the same file the builder reads.
  const expectedSchema = readFileSync(path.join(ROOT, "schemas/review-output.schema.json"), "utf8");

  assert.deepEqual(argv, [
    "--bare",
    "--print",
    "--verbose",
    "--model",
    "claude-opus-4-7",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--json-schema",
    expectedSchema,
    "--system-prompt-file",
    path.join(ROOT, "prompts/adversarial-review.md"),
    "--tools",
    "",
    "--permission-mode",
    "default",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--max-budget-usd",
    "5",
    "--session-id",
    "00000000-0000-4000-8000-000000000001",
  ]);
});

test("buildReviewerArgs throws when caller tries to override tools", () => {
  assert.throws(
    () =>
      buildReviewerArgs({
        promptFile: "/p",
        budgetUsd: 5,
        sessionId: "s",
        useBare: true,
        tools: "Edit",
      }),
    /tools/
  );
});

test("buildReviewerArgs throws when caller tries to override permissionMode", () => {
  assert.throws(
    () =>
      buildReviewerArgs({
        promptFile: "/p",
        budgetUsd: 5,
        sessionId: "s",
        useBare: true,
        permissionMode: "bypassPermissions",
      }),
    /permissionMode/
  );
});

test("buildReviewerArgs throws when caller tries to enable sessionPersistence", () => {
  assert.throws(
    () =>
      buildReviewerArgs({
        promptFile: "/p",
        budgetUsd: 5,
        sessionId: "s",
        useBare: true,
        sessionPersistence: true,
      }),
    /sessionPersistence/
  );
});

test("buildReviewerArgs throws when caller tries to set settingSources", () => {
  assert.throws(
    () =>
      buildReviewerArgs({
        promptFile: "/p",
        budgetUsd: 5,
        sessionId: "s",
        useBare: true,
        settingSources: "user,project",
      }),
    /settingSources/
  );
});

test("buildReviewerArgs throws when caller tries to point at a different schemaFile", () => {
  assert.throws(
    () =>
      buildReviewerArgs({
        promptFile: "/p",
        budgetUsd: 5,
        sessionId: "s",
        useBare: true,
        schemaFile: "/some/other/schema.json",
      }),
    /schemaFile/
  );
});

test("buildReviewerArgs throws when useBare is not an explicit boolean", () => {
  // useBare must be set explicitly — no default — so each call site has to
  // visibly choose the auth path.
  assert.throws(
    () => buildReviewerArgs({ promptFile: "/p", budgetUsd: 5, sessionId: "s" }),
    /useBare/,
    "missing useBare must throw"
  );
  assert.throws(
    () => buildReviewerArgs({ promptFile: "/p", budgetUsd: 5, sessionId: "s", useBare: "true" }),
    /useBare/,
    "non-boolean useBare must throw"
  );
});

test("buildReviewerArgs throws when required opts are missing", () => {
  assert.throws(() => buildReviewerArgs({}), /promptFile/);
  assert.throws(() => buildReviewerArgs({ promptFile: "/p" }), /budgetUsd/);
  assert.throws(() => buildReviewerArgs({ promptFile: "/p", budgetUsd: 5 }), /sessionId/);
});

test("buildReviewerArgs accepts a custom model", () => {
  const argv = buildReviewerArgs({
    promptFile: "/p",
    budgetUsd: 5,
    sessionId: "s",
    useBare: true,
    model: "claude-haiku-4-5",
  });
  const idx = argv.indexOf("--model");
  assert.equal(argv[idx + 1], "claude-haiku-4-5");
});

test("buildReviewerArgs produces exactly one --max-budget-usd flag", () => {
  const argv = buildReviewerArgs({
    promptFile: "/p",
    budgetUsd: 5,
    sessionId: "s",
    useBare: true,
  });
  const occurrences = argv.filter((a) => a === "--max-budget-usd").length;
  assert.equal(occurrences, 1);
});

test("buildReviewerArgs argv MUST NOT contain rejected stream-json worker flags", () => {
  // These flags belonged to a
  // rejected long-lived-worker draft; their presence in any reviewer call
  // site would reintroduce the prompt-injection-persistence vulnerability.
  const argv = buildReviewerArgs({
    promptFile: "/p",
    budgetUsd: 5,
    sessionId: "s",
    useBare: true,
  });
  assert.ok(
    !argv.includes("--input-format"),
    "argv must not contain --input-format (rejected worker-mode flag)"
  );
  assert.ok(
    !argv.includes("--replay-user-messages"),
    "argv must not contain --replay-user-messages (rejected worker-mode flag)"
  );
});

test("buildRescueArgs produces exact golden argv (useBare:true)", () => {
  const argv = buildRescueArgs({
    model: "claude-opus-4-7",
    budgetUsd: 20,
    sessionId: "00000000-0000-4000-8000-000000000002",
    effort: "high",
    useBare: true,
  });

  assert.deepEqual(argv, [
    "--bare",
    "--print",
    "--verbose",
    "--model",
    "claude-opus-4-7",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--effort",
    "high",
    "--system-prompt-file",
    path.join(ROOT, "prompts/rescue.md"),
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--max-budget-usd",
    "20",
    "--session-id",
    "00000000-0000-4000-8000-000000000002",
  ]);
});

test("buildRescueArgs throws on permissionMode override", () => {
  assert.throws(
    () =>
      buildRescueArgs({
        budgetUsd: 20,
        sessionId: "s",
        useBare: true,
        permissionMode: "bypassPermissions",
      }),
    /permissionMode/
  );
});

test("buildRescueArgs throws when useBare is not an explicit boolean", () => {
  assert.throws(() => buildRescueArgs({ budgetUsd: 20, sessionId: "s" }), /useBare/);
  assert.throws(
    () => buildRescueArgs({ budgetUsd: 20, sessionId: "s", useBare: "yes" }),
    /useBare/
  );
});

test("buildRescueArgs throws on settingSources override", () => {
  assert.throws(
    () =>
      buildRescueArgs({
        budgetUsd: 20,
        sessionId: "s",
        useBare: true,
        settingSources: "user,project",
      }),
    /settingSources/
  );
});

test("buildRescueArgs throws on systemPromptFile override", () => {
  assert.throws(
    () =>
      buildRescueArgs({
        budgetUsd: 20,
        sessionId: "s",
        useBare: true,
        systemPromptFile: "/other.md",
      }),
    /systemPromptFile/
  );
});

test("buildRescueArgs throws on sessionPersistence:true", () => {
  assert.throws(
    () =>
      buildRescueArgs({
        budgetUsd: 20,
        sessionId: "s",
        useBare: true,
        sessionPersistence: true,
      }),
    /sessionPersistence/
  );
});

test("buildRescueArgs argv MUST NOT contain reviewer-only flags", () => {
  const argv = buildRescueArgs({ budgetUsd: 20, sessionId: "s", useBare: true });
  assert.ok(!argv.includes("--tools"), "argv must not contain --tools");
  assert.ok(!argv.includes("--json-schema"), "argv must not contain --json-schema");
});

test("buildRescueArgs produces exactly one --max-budget-usd flag", () => {
  const argv = buildRescueArgs({ budgetUsd: 20, sessionId: "s", useBare: true });
  const occurrences = argv.filter((a) => a === "--max-budget-usd").length;
  assert.equal(occurrences, 1);
});

// Subscription-auth path: --bare is omitted but every other safety invariant
// remains locked. Tests assert both the omission and that nothing else drifted.
test("buildReviewerArgs golden argv with useBare:false (subscription auth path)", () => {
  const argv = buildReviewerArgs({
    promptFile: path.join(ROOT, "prompts/adversarial-review.md"),
    budgetUsd: 5,
    sessionId: "00000000-0000-4000-8000-000000000001",
    useBare: false,
  });
  const expectedSchema = readFileSync(path.join(ROOT, "schemas/review-output.schema.json"), "utf8");
  assert.deepEqual(argv, [
    "--print",
    "--verbose",
    "--model",
    "claude-opus-4-7",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--json-schema",
    expectedSchema,
    "--system-prompt-file",
    path.join(ROOT, "prompts/adversarial-review.md"),
    "--tools",
    "",
    "--permission-mode",
    "default",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--max-budget-usd",
    "5",
    "--session-id",
    "00000000-0000-4000-8000-000000000001",
  ]);
  // Sanity: locked invariants survive even though --bare is omitted.
  assert.ok(!argv.includes("--bare"), "useBare:false must omit --bare");
  assert.ok(argv.includes("--tools"), '--tools "" must still be present');
  assert.ok(argv.includes("--no-session-persistence"));
  assert.ok(argv.includes("--setting-sources"));
});

test("buildRescueArgs golden argv with useBare:false (subscription auth path)", () => {
  const argv = buildRescueArgs({
    model: "claude-opus-4-7",
    budgetUsd: 20,
    sessionId: "00000000-0000-4000-8000-000000000002",
    effort: "high",
    useBare: false,
  });
  assert.deepEqual(argv, [
    "--print",
    "--verbose",
    "--model",
    "claude-opus-4-7",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--effort",
    "high",
    "--system-prompt-file",
    path.join(ROOT, "prompts/rescue.md"),
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--max-budget-usd",
    "20",
    "--session-id",
    "00000000-0000-4000-8000-000000000002",
  ]);
  assert.ok(!argv.includes("--bare"), "useBare:false must omit --bare");
  assert.ok(argv.includes("--no-session-persistence"));
});
