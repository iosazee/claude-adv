// Generated from scripts/lib/workspace.mjs by scripts/release/sync-codex-bundle.mjs. Do not edit.
import { ensureGitRepository } from "./git.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}
