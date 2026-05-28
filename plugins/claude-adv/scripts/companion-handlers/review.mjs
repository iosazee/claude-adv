// Generated from scripts/companion-handlers/review.mjs by scripts/release/sync-codex-bundle.mjs. Do not edit.
import { runReview } from "./_shared-review.mjs";
export async function handle(argv) {
  await runReview(argv, {
    promptFile: "review.md",
    reviewName: "Review",
  });
}
