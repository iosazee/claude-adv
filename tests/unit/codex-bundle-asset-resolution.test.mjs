import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as acorn from "acorn";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = path.join(ROOT, "plugins/claude-adv");
const HANDLERS = path.join(BUNDLE, "scripts/companion-handlers");
const SCRIPTS = path.join(BUNDLE, "scripts");
const CLAUDE_CLI = path.join(BUNDLE, "scripts/lib/claude-cli.mjs");
const SYNC_SCRIPT = path.join(ROOT, "scripts/release/sync-codex-bundle.mjs");

function parse(file) {
  return acorn.parse(readFileSync(file, "utf8"), {
    ecmaVersion: "latest",
    locations: true,
    sourceType: "module",
  });
}

function* walk(node) {
  if (!node || typeof node.type !== "string") return;
  yield node;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) yield* walk(child);
    } else if (value && typeof value.type === "string") {
      yield* walk(value);
    }
  }
}

function findAllJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...findAllJsFiles(full));
    else if (full.endsWith(".mjs")) out.push(full);
  }
  return out;
}

function isIdentifier(node, name) {
  return node?.type === "Identifier" && node.name === name;
}

function isStringLiteral(node) {
  return node?.type === "Literal" && typeof node.value === "string";
}

function propertyName(property) {
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal") return property.key.value;
  return null;
}

function pathJoinAsset(node) {
  if (node.type !== "CallExpression") return null;
  const callee = node.callee;
  if (
    callee.type !== "MemberExpression" ||
    !isIdentifier(callee.object, "path") ||
    !isIdentifier(callee.property, "join")
  ) {
    return null;
  }
  const dirIndex = node.arguments.findIndex(
    (arg) => isStringLiteral(arg) && (arg.value === "prompts" || arg.value === "schemas")
  );
  if (dirIndex === -1) return null;
  return { dirArg: node.arguments[dirIndex], leaf: node.arguments[dirIndex + 1] };
}

function allowedPromptFileSink(file, leaf) {
  const basenamePromptFile =
    leaf?.type === "CallExpression" &&
    leaf.callee.type === "MemberExpression" &&
    isIdentifier(leaf.callee.object, "path") &&
    isIdentifier(leaf.callee.property, "basename") &&
    isIdentifier(leaf.arguments[0], "promptFile");
  if (basenamePromptFile && file.endsWith("_shared-review.mjs")) return true;

  const promptTemplateName =
    leaf?.type === "TemplateLiteral" &&
    leaf.expressions.length === 1 &&
    isIdentifier(leaf.expressions[0], "name");
  return promptTemplateName && file.endsWith(path.join("scripts", "lib", "prompts.mjs"));
}

function discoverRequiredAssets() {
  const required = new Set();

  for (const name of readdirSync(HANDLERS)) {
    if (!name.endsWith(".mjs") || name.startsWith("_")) continue;
    const file = path.join(HANDLERS, name);
    for (const node of walk(parse(file))) {
      if (node.type !== "CallExpression" || !isIdentifier(node.callee, "runReview")) continue;
      assert.ok(node.arguments.length >= 2, `${file}:${node.loc.start.line}: runReview needs args`);
      const opts = node.arguments[1];
      assert.equal(
        opts.type,
        "ObjectExpression",
        `${file}:${node.loc.start.line}: runReview second arg must be an object literal`
      );
      const prop = opts.properties.find(
        (item) => item.type === "Property" && propertyName(item) === "promptFile"
      );
      if (!prop) continue;
      assert.ok(
        isStringLiteral(prop.value),
        `${file}:${prop.loc.start.line}: runReview promptFile is not a string literal`
      );
      required.add(`prompts/${prop.value.value}`);
    }
  }

  for (const file of findAllJsFiles(SCRIPTS)) {
    for (const node of walk(parse(file))) {
      const asset = pathJoinAsset(node);
      if (!asset) continue;
      if (isStringLiteral(asset.leaf)) {
        required.add(`${asset.dirArg.value}/${asset.leaf.value}`);
        continue;
      }
      if (allowedPromptFileSink(file, asset.leaf)) continue;
      assert.fail(
        `${file}:${asset.leaf?.loc?.start?.line ?? node.loc.start.line}: bundle asset path leaf is not a string literal`
      );
    }
  }

  for (const node of parse(CLAUDE_CLI).body) {
    if (node.type !== "VariableDeclaration") continue;
    for (const declaration of node.declarations) {
      if (
        !isIdentifier(declaration.id, "RESCUE_PROMPT_PATH") &&
        !isIdentifier(declaration.id, "SCHEMA_PATH")
      ) {
        continue;
      }
      const literal = declaration.init?.arguments?.find((arg) => isStringLiteral(arg));
      assert.ok(literal, `${declaration.id.name}: no string literal asset path`);
      required.add(literal.value);
    }
  }

  return required;
}

test("bundle JS exposes only statically discoverable prompt/schema assets", () => {
  for (const rel of discoverRequiredAssets()) {
    assert.ok(existsSync(path.join(BUNDLE, rel)), `bundle missing required asset: ${rel}`);
  }
});

test("sync script ASSETS manifest covers discovered prompt/schema assets", () => {
  const required = discoverRequiredAssets();
  const src = readFileSync(SYNC_SCRIPT, "utf8");
  const match = src.match(/const ASSETS = \[([\s\S]*?)\];/);
  assert.ok(match, "could not locate ASSETS in sync-codex-bundle.mjs");
  const declared = new Set([...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]));
  for (const rel of required) {
    assert.ok(declared.has(rel), `sync ASSETS manifest is missing required asset: ${rel}`);
  }
});
