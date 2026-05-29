#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as acorn from "acorn";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_SCRIPTS = path.join(ROOT, "scripts");
const BUNDLE = path.join(ROOT, "plugins/claude-adv");
const BUNDLE_SCRIPTS = path.join(BUNDLE, "scripts");
const CHECK_MODE = process.argv.includes("--check");

// package.json is the single source of truth for the release version. These
// plugin manifests must mirror it; codex-manifest.test.mjs asserts the Codex
// manifest matches, and the Claude marketplace surfaces the Claude manifest
// version. Keeping them in lockstep here means a `npm version`-style bump can
// never silently drift the bundle out of sync again.
const VERSION_MANIFESTS = [
  ".claude-plugin/plugin.json",
  "plugins/claude-adv/.codex-plugin/plugin.json",
];

const ASSETS = [
  "prompts/adversarial-review.md",
  "prompts/review.md",
  "prompts/rescue.md",
  "schemas/review-output.schema.json",
];

const GENERATED_MARKER_RE =
  /^\/\/ Generated from scripts\/.+ by scripts\/release\/sync-codex-bundle\.mjs\. Do not edit\.$/m;

function parseModule(file) {
  return acorn.parse(readFileSync(file, "utf8"), {
    ecmaVersion: "latest",
    sourceType: "module",
  });
}

function discoverSubcommands() {
  const file = path.join(SOURCE_SCRIPTS, "claude-companion.mjs");
  const source = readFileSync(file, "utf8");
  const match = source.match(/const SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\);/);
  if (!match) {
    throw new Error("Could not locate SUBCOMMANDS in scripts/claude-companion.mjs");
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  if (existsSync(resolved) && statSync(resolved).isFile()) return resolved;
  if (existsSync(`${resolved}.mjs`)) return `${resolved}.mjs`;
  return resolved;
}

function jsClosure(entryPaths) {
  const visited = new Set();
  const queue = entryPaths.map((entry) => path.resolve(entry));
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    if (!file.startsWith(`${SOURCE_SCRIPTS}${path.sep}`)) continue;
    if (!existsSync(file)) {
      throw new Error(`Missing sync source: ${path.relative(ROOT, file)}`);
    }
    visited.add(file);

    for (const node of parseModule(file).body) {
      if (node.type !== "ImportDeclaration") continue;
      const specifier = node.source?.value;
      if (typeof specifier !== "string") continue;
      const resolved = resolveImport(file, specifier);
      if (resolved) queue.push(resolved);
    }
  }
  return [...visited].sort();
}

function markerLine(relativeFromScripts) {
  return `// Generated from scripts/${relativeFromScripts} by scripts/release/sync-codex-bundle.mjs. Do not edit.\n`;
}

function generatedJsBody(srcAbs) {
  const body = readFileSync(srcAbs, "utf8");
  const rel = path.relative(SOURCE_SCRIPTS, srcAbs);
  const marker = markerLine(rel);
  if (!body.startsWith("#!")) return marker + body;

  const firstNewline = body.indexOf("\n");
  if (firstNewline === -1) return `${body}\n${marker}`;
  return body.slice(0, firstNewline + 1) + marker + body.slice(firstNewline + 1);
}

function expectedBody(srcAbs) {
  if (path.extname(srcAbs) === ".mjs") return generatedJsBody(srcAbs);
  return readFileSync(srcAbs, "utf8");
}

function diffText(label, expected, actual) {
  const tmp = mkdtempSync(path.join(tmpdir(), "codex-bundle-diff-"));
  try {
    const expectedPath = path.join(tmp, "expected");
    const actualPath = path.join(tmp, "actual");
    writeFileSync(expectedPath, expected);
    writeFileSync(actualPath, actual);
    const result = spawnSync("diff", ["-u", actualPath, expectedPath], { encoding: "utf8" });
    if (result.stdout) {
      return result.stdout
        .replaceAll(actualPath, `${label} (actual)`)
        .replaceAll(expectedPath, `${label} (expected)`);
    }
    return `--- ${label} (actual)\n+++ ${label} (expected)\n`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const plannedWrites = new Map();

function planCopy(srcAbs, dstAbs) {
  const rel = path.relative(ROOT, dstAbs);
  if (!existsSync(srcAbs)) throw new Error(`Missing sync source: ${path.relative(ROOT, srcAbs)}`);
  plannedWrites.set(dstAbs, { rel, body: expectedBody(srcAbs) });
}

// Rewrite only the top-level "version" string, preserving the manifest's
// hand-authored formatting (inline arrays, key order). A full JSON re-serialize
// would expand inline arrays and churn the diff, so we target the field itself.
function planManifestVersion(manifestRel, version) {
  const manifestAbs = path.join(ROOT, manifestRel);
  if (!existsSync(manifestAbs)) {
    throw new Error(`Missing version manifest: ${manifestRel}`);
  }
  const body = readFileSync(manifestAbs, "utf8");
  const versionRe = /("version"\s*:\s*")([^"]*)(")/;
  if (!versionRe.test(body)) {
    throw new Error(`Could not locate a "version" field in ${manifestRel}`);
  }
  const expected = body.replace(versionRe, `$1${version}$3`);
  plannedWrites.set(manifestAbs, { rel: manifestRel, body: expected });
}

function* walkFiles(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

function generatedBundleFiles() {
  return [...walkFiles(BUNDLE_SCRIPTS)].filter((file) => {
    if (!file.endsWith(".mjs")) return false;
    return GENERATED_MARKER_RE.test(readFileSync(file, "utf8"));
  });
}

function applyPlan() {
  let drift = false;
  for (const [dstAbs, { rel, body }] of plannedWrites) {
    const actual = existsSync(dstAbs) ? readFileSync(dstAbs, "utf8") : null;
    if (CHECK_MODE) {
      if (actual !== body) {
        drift = true;
        process.stderr.write(`DRIFT: ${rel}\n`);
        process.stderr.write(diffText(rel, body, actual ?? ""));
      }
      continue;
    }
    mkdirSync(path.dirname(dstAbs), { recursive: true });
    writeFileSync(dstAbs, body);
  }

  for (const file of generatedBundleFiles()) {
    if (plannedWrites.has(file)) continue;
    const rel = path.relative(ROOT, file);
    if (CHECK_MODE) {
      drift = true;
      process.stderr.write(`DRIFT: stale generated file ${rel}\n`);
      continue;
    }
    rmSync(file);
  }

  if (drift) process.exitCode = 1;
}

const subcommands = discoverSubcommands();
const entries = [
  path.join(SOURCE_SCRIPTS, "claude-companion.mjs"),
  ...subcommands.map((subcommand) =>
    path.join(SOURCE_SCRIPTS, "companion-handlers", `${subcommand}.mjs`)
  ),
];
const jsFiles = jsClosure(entries);

for (const src of jsFiles) {
  const rel = path.relative(SOURCE_SCRIPTS, src);
  planCopy(src, path.join(BUNDLE_SCRIPTS, rel));
}

for (const asset of ASSETS) {
  planCopy(path.join(ROOT, asset), path.join(BUNDLE, asset));
}

const packageVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
if (typeof packageVersion !== "string" || packageVersion.length === 0) {
  throw new Error("package.json is missing a usable version string");
}
for (const manifestRel of VERSION_MANIFESTS) {
  planManifestVersion(manifestRel, packageVersion);
}

applyPlan();

for (const subcommand of subcommands) {
  const expected = path.join(BUNDLE_SCRIPTS, "companion-handlers", `${subcommand}.mjs`);
  assert.ok(
    existsSync(expected),
    `post-sync invariant failed: missing ${path.relative(ROOT, expected)} for subcommand "${subcommand}"`
  );
}

if (!CHECK_MODE) {
  process.stdout.write(
    `Synced ${jsFiles.length} JS files + ${ASSETS.length} assets to plugins/claude-adv/, ` +
      `${VERSION_MANIFESTS.length} manifests pinned to ${packageVersion}\n`
  );
}
