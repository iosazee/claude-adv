#!/usr/bin/env node
// Backwards-compatibility shim for the relocated Codex adapter.
// Removed in the release after next.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.stderr.write(
  "claude-adv: codex/scripts/claude-adv-codex.mjs is deprecated; " +
    "use plugins/claude-adv/scripts/claude-adv-codex.mjs (see CHANGELOG). " +
    "This shim will be removed in the release after next.\n"
);

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../../plugins/claude-adv/scripts/claude-adv-codex.mjs");

// Node's import() takes a URL specifier; pathToFileURL preserves paths
// containing URL-significant characters such as "#" and "?".
await import(pathToFileURL(target).href);
