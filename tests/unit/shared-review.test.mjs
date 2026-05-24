import { test } from "node:test";
import { strict as assert } from "node:assert";

import { buildRepairPrompt } from "../../scripts/companion-handlers/_shared-review.mjs";

test("buildRepairPrompt lists every accepted verdict, including approve-with-notes", () => {
  const prompt = buildRepairPrompt(
    "original prompt",
    '{"verdict":"approve_with_notes"}',
    "bad enum"
  );
  assert.match(prompt, /`approve`/);
  assert.match(prompt, /`approve-with-notes`/);
  assert.match(prompt, /`needs-attention`/);
});
