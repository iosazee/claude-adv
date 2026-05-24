import { runReview } from "./_shared-review.mjs";
export async function handle(argv) {
  await runReview(argv, {
    promptFile: "review.md",
    reviewName: "Review",
  });
}
