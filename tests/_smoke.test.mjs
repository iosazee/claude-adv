import { test } from "node:test";
import { strict as assert } from "node:assert";

test("smoke: node native test runner works", () => {
  assert.equal(1 + 1, 2);
});
