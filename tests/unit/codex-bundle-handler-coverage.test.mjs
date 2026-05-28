import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMPANION = path.join(ROOT, "scripts/claude-companion.mjs");
const BUNDLE_HANDLERS = path.join(ROOT, "plugins/claude-adv/scripts/companion-handlers");

function discoverSubcommands() {
  const src = readFileSync(COMPANION, "utf8");
  const match = src.match(/const SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, "could not locate SUBCOMMANDS in claude-companion.mjs");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

test("every SUBCOMMANDS handler exists in the bundle", () => {
  for (const subcommand of discoverSubcommands()) {
    const expected = path.join(BUNDLE_HANDLERS, `${subcommand}.mjs`);
    assert.ok(existsSync(expected), `bundle missing handler for ${subcommand}: ${expected}`);
  }
});
