// Cross-vendor merge: fingerprint match + site overlap, vendor-attribution.
// The merge module reduces two vendor review outputs to a single annotated
// payload showing where the vendors agree, where they're talking about the
// same site but disagree on framing, and where each is alone.
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { mergeCrossVendor } from "../../scripts/lib/cross-vendor-merge.mjs";

function finding(overrides = {}) {
  return {
    severity: "medium",
    title: "default title",
    body: "default body",
    file: "src/foo.ts",
    line_start: 10,
    line_end: 10,
    confidence: 0.7,
    recommendation: "fix it",
    ...overrides,
  };
}

function vendorOutput({ verdict = "approve", findings = [] } = {}) {
  return { verdict, summary: "test", findings, next_steps: [] };
}

test("mergeCrossVendor: empty inputs produce empty agreement and no unique findings", () => {
  const merged = mergeCrossVendor(vendorOutput(), vendorOutput());
  assert.equal(merged.agreement_count, 0);
  assert.equal(merged.site_overlap_count, 0);
  assert.equal(merged.claude_unique_count, 0);
  assert.equal(merged.codex_unique_count, 0);
  assert.equal(merged.consensus_verdict, "approve");
});

test("mergeCrossVendor: identical fingerprints land in agreements", () => {
  const claudeF = finding({
    severity: "high",
    title: "Off-by-one in retry",
    file: "q.ts",
    line_start: 42,
  });
  const codexF = finding({
    severity: "high",
    title: "Off-by-one in retry",
    file: "q.ts",
    line_start: 42,
  });
  const merged = mergeCrossVendor(
    vendorOutput({ verdict: "needs-attention", findings: [claudeF] }),
    vendorOutput({ verdict: "needs-attention", findings: [codexF] })
  );
  assert.equal(merged.agreement_count, 1);
  assert.equal(merged.site_overlap_count, 0);
  assert.equal(merged.agreements[0].file, "q.ts");
  assert.equal(merged.agreements[0].line_start, 42);
  assert.ok(merged.agreements[0].claude_view);
  assert.ok(merged.agreements[0].codex_view);
});

test("mergeCrossVendor: agreement merged severity is the stricter of the two", () => {
  const claudeF = finding({
    severity: "medium",
    title: "Race condition",
    file: "q.ts",
    line_start: 7,
  });
  const codexF = finding({
    severity: "high",
    title: "Race condition",
    file: "q.ts",
    line_start: 7,
  });
  const merged = mergeCrossVendor(
    vendorOutput({ verdict: "approve-with-notes", findings: [claudeF] }),
    vendorOutput({ verdict: "needs-attention", findings: [codexF] })
  );
  assert.equal(merged.agreements[0].merged_severity, "high");
});

test("mergeCrossVendor: agreement merged_confidence is the average of the two", () => {
  const claudeF = finding({ confidence: 0.6, title: "Race", file: "q.ts", line_start: 7 });
  const codexF = finding({ confidence: 0.9, title: "Race", file: "q.ts", line_start: 7 });
  const merged = mergeCrossVendor(
    vendorOutput({ findings: [claudeF] }),
    vendorOutput({ findings: [codexF] })
  );
  assert.equal(merged.agreements[0].merged_confidence, 0.75);
});

test("mergeCrossVendor: same site (within ±3 lines) but different titles → site_overlap", () => {
  const claudeF = finding({ title: "Off-by-one in retry", file: "q.ts", line_start: 42 });
  const codexF = finding({ title: "Loop boundary error", file: "q.ts", line_start: 44 });
  const merged = mergeCrossVendor(
    vendorOutput({ findings: [claudeF] }),
    vendorOutput({ findings: [codexF] })
  );
  assert.equal(merged.agreement_count, 0);
  assert.equal(merged.site_overlap_count, 1);
  assert.equal(merged.site_overlaps[0].file, "q.ts");
  assert.equal(merged.site_overlaps[0].claude_view.title, "Off-by-one in retry");
  assert.equal(merged.site_overlaps[0].codex_view.title, "Loop boundary error");
});

test("mergeCrossVendor: site overlap requires same file, not just close lines", () => {
  const claudeF = finding({ title: "issue A", file: "a.ts", line_start: 10 });
  const codexF = finding({ title: "issue B", file: "b.ts", line_start: 10 });
  const merged = mergeCrossVendor(
    vendorOutput({ findings: [claudeF] }),
    vendorOutput({ findings: [codexF] })
  );
  assert.equal(merged.site_overlap_count, 0);
  assert.equal(merged.claude_unique_count, 1);
  assert.equal(merged.codex_unique_count, 1);
});

test("mergeCrossVendor: distance > 3 lines is treated as independent, not overlap", () => {
  const claudeF = finding({ title: "issue A", file: "q.ts", line_start: 10 });
  const codexF = finding({ title: "issue B", file: "q.ts", line_start: 20 });
  const merged = mergeCrossVendor(
    vendorOutput({ findings: [claudeF] }),
    vendorOutput({ findings: [codexF] })
  );
  assert.equal(merged.site_overlap_count, 0);
  assert.equal(merged.claude_unique_count, 1);
  assert.equal(merged.codex_unique_count, 1);
});

test("mergeCrossVendor: each finding consumes at most one match (site overlap is one-to-one)", () => {
  // Claude raises one issue at line 10. Codex raises two issues nearby
  // (line 11 and 12). Only ONE should pair off with the claude finding;
  // the other codex finding becomes codex_unique.
  const claudeF = finding({ title: "C-issue", file: "q.ts", line_start: 10 });
  const codexF1 = finding({ title: "K-issue-1", file: "q.ts", line_start: 11 });
  const codexF2 = finding({ title: "K-issue-2", file: "q.ts", line_start: 12 });
  const merged = mergeCrossVendor(
    vendorOutput({ findings: [claudeF] }),
    vendorOutput({ findings: [codexF1, codexF2] })
  );
  assert.equal(merged.site_overlap_count, 1);
  assert.equal(merged.codex_unique_count, 1);
});

test("mergeCrossVendor: vendor-unique findings carry forward intact", () => {
  const claudeOnly = finding({ title: "only-claude", file: "x.ts", line_start: 5 });
  const codexOnly = finding({ title: "only-codex", file: "y.ts", line_start: 9 });
  const merged = mergeCrossVendor(
    vendorOutput({ findings: [claudeOnly] }),
    vendorOutput({ findings: [codexOnly] })
  );
  assert.equal(merged.claude_unique_count, 1);
  assert.equal(merged.codex_unique_count, 1);
  assert.equal(merged.claude_unique[0].title, "only-claude");
  assert.equal(merged.codex_unique[0].title, "only-codex");
});

test("mergeCrossVendor: consensus verdict — both approve → approve", () => {
  const merged = mergeCrossVendor(
    vendorOutput({ verdict: "approve" }),
    vendorOutput({ verdict: "approve" })
  );
  assert.equal(merged.consensus_verdict, "approve");
});

test("mergeCrossVendor: consensus verdict — either needs-attention → needs-attention", () => {
  const merged = mergeCrossVendor(
    vendorOutput({ verdict: "approve" }),
    vendorOutput({ verdict: "needs-attention" })
  );
  assert.equal(merged.consensus_verdict, "needs-attention");
});

test("mergeCrossVendor: consensus verdict — approve + approve-with-notes → approve-with-notes", () => {
  const merged = mergeCrossVendor(
    vendorOutput({ verdict: "approve-with-notes" }),
    vendorOutput({ verdict: "approve" })
  );
  assert.equal(merged.consensus_verdict, "approve-with-notes");
});

test("mergeCrossVendor: vendor-attribution preserved on every output finding", () => {
  const claudeAgree = finding({ title: "Shared", file: "a.ts", line_start: 1 });
  const codexAgree = finding({ title: "Shared", file: "a.ts", line_start: 1 });
  const claudeOnly = finding({ title: "C-only", file: "b.ts", line_start: 1 });
  const codexOnly = finding({ title: "K-only", file: "c.ts", line_start: 1 });
  const merged = mergeCrossVendor(
    vendorOutput({ findings: [claudeAgree, claudeOnly] }),
    vendorOutput({ findings: [codexAgree, codexOnly] })
  );
  // Agreements list both vendors
  assert.deepEqual(merged.agreements[0].raised_by.sort(), ["claude", "codex"]);
  // Uniques carry sole-vendor tag
  assert.deepEqual(merged.claude_unique[0].raised_by, ["claude"]);
  assert.deepEqual(merged.codex_unique[0].raised_by, ["codex"]);
});

test("mergeCrossVendor: counts add up to total distinct findings", () => {
  const merged = mergeCrossVendor(
    vendorOutput({
      findings: [
        finding({ title: "shared", file: "a.ts", line_start: 1 }),
        finding({ title: "site-overlap-c", file: "b.ts", line_start: 5 }),
        finding({ title: "c-only", file: "c.ts", line_start: 1 }),
      ],
    }),
    vendorOutput({
      findings: [
        finding({ title: "shared", file: "a.ts", line_start: 1 }),
        finding({ title: "site-overlap-k", file: "b.ts", line_start: 7 }),
        finding({ title: "k-only", file: "d.ts", line_start: 1 }),
      ],
    })
  );
  assert.equal(merged.agreement_count, 1);
  assert.equal(merged.site_overlap_count, 1);
  assert.equal(merged.claude_unique_count, 1);
  assert.equal(merged.codex_unique_count, 1);
  // Sanity: total distinct concerns surfaced = 4
  assert.equal(
    merged.agreement_count +
      merged.site_overlap_count +
      merged.claude_unique_count +
      merged.codex_unique_count,
    4
  );
});
