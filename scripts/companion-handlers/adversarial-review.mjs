import { runReview } from "./_shared-review.mjs";
export async function handle(argv) {
  await runReview(argv, {
    promptFile: "adversarial-review.md",
    reviewName: "Adversarial Review",
  });
}
