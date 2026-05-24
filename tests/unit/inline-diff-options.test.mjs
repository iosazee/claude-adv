import { test } from "node:test";
import { strict as assert } from "node:assert";

import { parseInlineDiffOptions } from "../../scripts/companion-handlers/_shared-review.mjs";

test("parseInlineDiffOptions: returns empty object when neither flag is set", () => {
  assert.deepEqual(parseInlineDiffOptions({}), {});
});

test("parseInlineDiffOptions: parses --max-inline-bytes into maxInlineDiffBytes", () => {
  const result = parseInlineDiffOptions({ "max-inline-bytes": "1048576" });
  assert.deepEqual(result, { maxInlineDiffBytes: 1048576 });
});

test("parseInlineDiffOptions: parses --max-inline-file-bytes into maxInlineFileDiffBytes", () => {
  const result = parseInlineDiffOptions({ "max-inline-file-bytes": "131072" });
  assert.deepEqual(result, { maxInlineFileDiffBytes: 131072 });
});

test("parseInlineDiffOptions: parses both flags together", () => {
  const result = parseInlineDiffOptions({
    "max-inline-bytes": "2097152",
    "max-inline-file-bytes": "262144",
  });
  assert.deepEqual(result, {
    maxInlineDiffBytes: 2097152,
    maxInlineFileDiffBytes: 262144,
  });
});

test("parseInlineDiffOptions: floors fractional values rather than rejecting them", () => {
  // The CLI receives strings; users may pass an expression result like "512.7"
  // through shell arithmetic. Coerce-and-floor mirrors how budget caps behave.
  const result = parseInlineDiffOptions({ "max-inline-bytes": "512.7" });
  assert.deepEqual(result, { maxInlineDiffBytes: 512 });
});

test("parseInlineDiffOptions: rejects non-numeric --max-inline-bytes", () => {
  assert.throws(
    () => parseInlineDiffOptions({ "max-inline-bytes": "huge" }),
    /--max-inline-bytes must be a positive number/
  );
});

test("parseInlineDiffOptions: rejects zero --max-inline-bytes", () => {
  // Zero would make every diff self-collect; reject so the failure is loud
  // rather than producing a paper-approve safeguard verdict on every review.
  assert.throws(
    () => parseInlineDiffOptions({ "max-inline-bytes": "0" }),
    /--max-inline-bytes must be a positive number/
  );
});

test("parseInlineDiffOptions: rejects negative --max-inline-bytes", () => {
  assert.throws(
    () => parseInlineDiffOptions({ "max-inline-bytes": "-1" }),
    /--max-inline-bytes must be a positive number/
  );
});

test("parseInlineDiffOptions: rejects non-numeric --max-inline-file-bytes", () => {
  assert.throws(
    () => parseInlineDiffOptions({ "max-inline-file-bytes": "lots" }),
    /--max-inline-file-bytes must be a positive number/
  );
});

test("parseInlineDiffOptions: rejects zero --max-inline-file-bytes", () => {
  assert.throws(
    () => parseInlineDiffOptions({ "max-inline-file-bytes": "0" }),
    /--max-inline-file-bytes must be a positive number/
  );
});

test("parseInlineDiffOptions: an invalid total cap throws even when file cap is valid", () => {
  // Validation should fail on the first bad value rather than partially
  // accepting a half-configured pair (which would silently apply only one).
  assert.throws(
    () =>
      parseInlineDiffOptions({
        "max-inline-bytes": "bad",
        "max-inline-file-bytes": "65536",
      }),
    /--max-inline-bytes must be a positive number/
  );
});
