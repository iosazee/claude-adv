import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const COMMANDS_DIR = path.join(ROOT, "commands");

// Every slash-command that shells out to claude-companion.mjs MUST pass the
// user arguments as a double-quoted "$ARGUMENTS". Double quotes are the only
// form that is safe in BOTH bash and zsh: they suppress filename globbing
// (zsh aborts an unquoted command whose glob — e.g. parens in focus text —
// matches nothing, under the default NOMATCH) AND word-splitting (zsh does
// not split unquoted scalars, bash does). A bare $ARGUMENTS in an invocation
// line is a cross-shell footgun, so fail loudly if one is ever introduced.
function commandFiles() {
  return readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(COMMANDS_DIR, f));
}

test("commands: every companion invocation that passes $ARGUMENTS double-quotes it", () => {
  let invocationLinesChecked = 0;
  for (const file of commandFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // Only consider lines that BOTH invoke the companion AND reference the
      // raw arguments — prose/display mentions of $ARGUMENTS are exempt.
      if (!line.includes("claude-companion.mjs")) return;
      if (!line.includes("ARGUMENTS")) return;
      invocationLinesChecked++;
      assert.ok(
        line.includes('"$ARGUMENTS"'),
        `${path.basename(file)}:${i + 1} invokes the companion with an unquoted $ARGUMENTS — ` +
          `use "$ARGUMENTS" (double-quoted) so it is glob- and word-split-safe in bash and zsh:\n  ${line.trim()}`
      );
    });
  }
  // Guard the guard: if this drops to zero, the heuristic stopped matching
  // real invocations (e.g. the file layout changed) and the test is vacuous.
  assert.ok(
    invocationLinesChecked >= 5,
    `expected to check several companion invocation lines, only saw ${invocationLinesChecked}`
  );
});
