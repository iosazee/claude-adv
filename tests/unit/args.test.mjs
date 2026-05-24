import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  argvEnablesBackground,
  normalizeArgv,
  parseArgs,
  splitRawArgumentString,
} from "../../scripts/lib/args.mjs";

test("args.parseArgs separates known booleans, values, and positionals", () => {
  const result = parseArgs(["--wait", "--base", "main", "focus", "text"], {
    valueOptions: ["base"],
    booleanOptions: ["wait", "background"],
  });
  assert.equal(result.options.wait, true);
  assert.equal(result.options.background, undefined);
  assert.equal(result.options.base, "main");
  assert.deepEqual(result.positionals, ["focus", "text"]);
});

test("args.parseArgs boolean: bare flag is on", () => {
  const r = parseArgs(["--background"], { booleanOptions: ["background"] });
  assert.equal(r.options.background, true);
  assert.deepEqual(r.positionals, []);
});

test("args.parseArgs boolean: --flag=true inline value", () => {
  const r = parseArgs(["--background=true"], { booleanOptions: ["background"] });
  assert.equal(r.options.background, true);
  assert.deepEqual(r.positionals, []);
});

test("args.parseArgs boolean: --flag=false inline value disables", () => {
  const r = parseArgs(["--background=false"], { booleanOptions: ["background"] });
  assert.equal(r.options.background, false);
  assert.deepEqual(r.positionals, []);
});

test("args.parseArgs boolean: --flag false consumes the next token", () => {
  // Prior to this change `false` would leak into positionals while
  // background stayed true. Now it's an explicit off signal.
  const r = parseArgs(["--background", "false"], { booleanOptions: ["background"] });
  assert.equal(r.options.background, false);
  assert.deepEqual(r.positionals, []);
});

test("args.parseArgs boolean: --flag true consumes the next token", () => {
  const r = parseArgs(["--background", "true"], { booleanOptions: ["background"] });
  assert.equal(r.options.background, true);
  assert.deepEqual(r.positionals, []);
});

test("args.parseArgs boolean: --flag followed by anything else stays bare-on", () => {
  // "main" is not the literal "true"/"false", so it's a normal positional.
  const r = parseArgs(["--background", "main"], { booleanOptions: ["background"] });
  assert.equal(r.options.background, true);
  assert.deepEqual(r.positionals, ["main"]);
});

test("args.parseArgs boolean: -- passthrough hides the flag", () => {
  // `-- --background` makes --background a positional, not a flag.
  const r = parseArgs(["--", "--background"], { booleanOptions: ["background"] });
  assert.equal(r.options.background, undefined);
  assert.deepEqual(r.positionals, ["--background"]);
});

test("args.parseArgs boolean: short form -b also consumes literal true/false", () => {
  // Mirror behavior across short flags so the contract is uniform.
  const r1 = parseArgs(["-b", "false"], { booleanOptions: ["b"] });
  assert.equal(r1.options.b, false);
  const r2 = parseArgs(["-b", "true"], { booleanOptions: ["b"] });
  assert.equal(r2.options.b, true);
  const r3 = parseArgs(["-b"], { booleanOptions: ["b"] });
  assert.equal(r3.options.b, true);
});

test("args.splitRawArgumentString handles quoted segments", () => {
  const parts = splitRawArgumentString(`--scope working-tree "focus with spaces"`);
  assert.deepEqual(parts, ["--scope", "working-tree", "focus with spaces"]);
});

test("args.normalizeArgv splits packed slash-command arguments", () => {
  assert.deepEqual(normalizeArgv(["--base main --wait"]), ["--base", "main", "--wait"]);
  assert.deepEqual(normalizeArgv(["--json", "--set-budget-usd 3"]), [
    "--json",
    "--set-budget-usd",
    "3",
  ]);
});

// Regression: a positional argv element (e.g. a rescue prompt passed as one
// shell-quoted arg) must NOT be whitespace-split. Slash-command packing only
// ever produces FLAG-LEADING packed tokens; a token that starts with anything
// other than `-` is positional content and may legitimately contain
// whitespace AND flag-shaped substrings ("--background", "--base") without
// those being parsed as flags by the dispatcher.
test("args.normalizeArgv leaves positional whitespace content intact", () => {
  // Prompt containing the literal token `--background` as English text.
  const promptWithFlagWord = "fix the bug where --background returns are slower than expected";
  assert.deepEqual(normalizeArgv([promptWithFlagWord]), [promptWithFlagWord]);

  // Long multi-sentence prompt with multiple flag-shaped substrings.
  const longPrompt = "Investigate why --base main --wait sometimes hangs; check the worker.";
  assert.deepEqual(normalizeArgv([longPrompt]), [longPrompt]);

  // Direct-CLI invocation with a positional arg that has internal whitespace.
  assert.deepEqual(normalizeArgv(["--wait", "--json", "fix the bug in foo.js"]), [
    "--wait",
    "--json",
    "fix the bug in foo.js",
  ]);
});

test("args.argvEnablesBackground is not fooled by --background as positional text", () => {
  // The codex wrapper's background guard previously fired on prompts that
  // mentioned --background as English text because normalizeArgv split every
  // whitespace-containing element. After the fix, only flag-leading tokens
  // get split.
  assert.equal(argvEnablesBackground(["fix the bug where --background hangs"]), false);
  assert.equal(
    argvEnablesBackground(["--wait", "--json", "explain --background semantics"]),
    false
  );
  // True positive still works.
  assert.equal(argvEnablesBackground(["--background", "explain --background semantics"]), true);
  // Slash-command packed --background still detected.
  assert.equal(argvEnablesBackground(["--background --wait"]), true);
});

test("args.argvEnablesBackground mirrors parser background semantics", () => {
  assert.equal(argvEnablesBackground(["--background"]), true);
  assert.equal(argvEnablesBackground(["--background=true"]), true);
  assert.equal(argvEnablesBackground(["--background=false"]), false);
  assert.equal(argvEnablesBackground(["--background", "false"]), false);
  assert.equal(argvEnablesBackground(["--background", "true"]), true);
  assert.equal(argvEnablesBackground(["--", "--background"]), false);
  assert.equal(argvEnablesBackground(["--background", "main"]), true);
});

test("args background matrix locks approved boolean compatibility semantics", () => {
  const cases = [
    {
      argv: ["--background"],
      background: true,
      positionals: [],
      enablesBackground: true,
    },
    {
      argv: ["--background=false"],
      background: false,
      positionals: [],
      enablesBackground: false,
    },
    {
      argv: ["--background=true"],
      background: true,
      positionals: [],
      enablesBackground: true,
    },
    {
      argv: ["--background=1"],
      background: true,
      positionals: [],
      enablesBackground: true,
    },
    {
      argv: ["--background=FALSE"],
      background: true,
      positionals: [],
      enablesBackground: true,
    },
    {
      argv: ["--background", "false"],
      background: false,
      positionals: [],
      enablesBackground: false,
    },
    {
      argv: ["--background", "true"],
      background: true,
      positionals: [],
      enablesBackground: true,
    },
    {
      argv: ["--background", "main"],
      background: true,
      positionals: ["main"],
      enablesBackground: true,
    },
    {
      argv: ["--", "--background"],
      background: undefined,
      positionals: ["--background"],
      enablesBackground: false,
    },
  ];

  for (const { argv, background, positionals, enablesBackground } of cases) {
    const parsed = parseArgs(argv, { booleanOptions: ["background"] });
    assert.equal(parsed.options.background, background, JSON.stringify(argv));
    assert.deepEqual(parsed.positionals, positionals, JSON.stringify(argv));
    assert.equal(argvEnablesBackground(argv), enablesBackground, JSON.stringify(argv));
  }
});
