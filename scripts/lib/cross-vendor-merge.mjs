// Cross-vendor review merger.
//
// Reduces two vendor review outputs (claude-adv + codex-plugin-cc, both
// conforming to review-output.schema.json) to a single annotated structure
// that surfaces:
//   - agreements: same fingerprint raised by both (file + line + normalized
//     title collide)
//   - site_overlaps: same file, line within ±3, different framing (probably
//     the same underlying issue described differently by the two vendors)
//   - claude_unique / codex_unique: findings only one vendor raised
//
// This is the cross-vendor blind-spot probe: the unique buckets are the
// signal — if either bucket is non-trivial across multiple diffs, the
// committee architecture earns its complexity. If both buckets are
// consistently empty, the two vendors agree on basically everything and
// the cross-vendor work is over-engineered for what it buys.
//
// No voting, no debate, no defensive-floor logic. The merger reports what
// both vendors saw. Interpretation is left to the human running the
// experiment.

import { computeFindingFingerprint } from "./claude-cli.mjs";

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const SITE_OVERLAP_LINE_TOLERANCE = 3;

function stricterSeverity(a, b) {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function averageConfidence(a, b) {
  const ca = typeof a === "number" ? a : 0;
  const cb = typeof b === "number" ? b : 0;
  return Math.round(((ca + cb) / 2) * 1000) / 1000;
}

function consensusVerdict(claudeVerdict, codexVerdict) {
  if (claudeVerdict === "needs-attention" || codexVerdict === "needs-attention") {
    return "needs-attention";
  }
  if (claudeVerdict === "approve-with-notes" || codexVerdict === "approve-with-notes") {
    return "approve-with-notes";
  }
  return "approve";
}

function attachFingerprints(findings) {
  return (findings ?? []).map((f) => ({ ...f, fingerprint: computeFindingFingerprint(f) }));
}

// Pair claude-unique-and-codex-unique findings into site_overlap when they
// share file and line within tolerance. Greedy one-to-one: each finding can
// participate in at most one overlap pair.
function pairSiteOverlaps(claudeUnmatched, codexUnmatched) {
  const overlaps = [];
  const usedCodex = new Set();

  for (const c of claudeUnmatched) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < codexUnmatched.length; i++) {
      if (usedCodex.has(i)) continue;
      const k = codexUnmatched[i];
      if (k.file !== c.file) continue;
      const dist = Math.abs(k.line_start - c.line_start);
      if (dist <= SITE_OVERLAP_LINE_TOLERANCE && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx !== -1) {
      usedCodex.add(bestIdx);
      const k = codexUnmatched[bestIdx];
      overlaps.push({
        file: c.file,
        claude_view: { ...c, raised_by: ["claude"] },
        codex_view: { ...k, raised_by: ["codex"] },
        line_delta: Math.abs(k.line_start - c.line_start),
        merged_severity: stricterSeverity(c.severity, k.severity),
        merged_confidence: averageConfidence(c.confidence, k.confidence),
      });
    }
  }

  const claudeStillUnique = claudeUnmatched.filter(
    (_, i) => !overlaps.find((o) => o.claude_view.fingerprint === claudeUnmatched[i].fingerprint)
  );
  const codexStillUnique = codexUnmatched.filter((_, i) => !usedCodex.has(i));

  return { overlaps, claudeStillUnique, codexStillUnique };
}

export function mergeCrossVendor(claudeOutput, codexOutput) {
  const claudeFindings = attachFingerprints(claudeOutput?.findings);
  const codexFindings = attachFingerprints(codexOutput?.findings);

  // Fingerprint-keyed lookup for exact agreements.
  const codexByFingerprint = new Map(codexFindings.map((f) => [f.fingerprint, f]));
  const agreements = [];
  const claudeUnmatched = [];

  for (const c of claudeFindings) {
    const k = codexByFingerprint.get(c.fingerprint);
    if (k) {
      agreements.push({
        fingerprint: c.fingerprint,
        file: c.file,
        line_start: c.line_start,
        line_end: c.line_end,
        title: c.title,
        claude_view: { ...c, raised_by: ["claude"] },
        codex_view: { ...k, raised_by: ["codex"] },
        raised_by: ["claude", "codex"],
        merged_severity: stricterSeverity(c.severity, k.severity),
        merged_confidence: averageConfidence(c.confidence, k.confidence),
      });
      codexByFingerprint.delete(c.fingerprint);
    } else {
      claudeUnmatched.push(c);
    }
  }
  const codexUnmatched = [...codexByFingerprint.values()];

  // Among unmatched, look for site overlap (same file, close lines).
  const { overlaps, claudeStillUnique, codexStillUnique } = pairSiteOverlaps(
    claudeUnmatched,
    codexUnmatched
  );

  return {
    vendors: ["claude", "codex"],
    claude_verdict: claudeOutput?.verdict ?? null,
    codex_verdict: codexOutput?.verdict ?? null,
    consensus_verdict: consensusVerdict(claudeOutput?.verdict, codexOutput?.verdict),
    agreement_count: agreements.length,
    site_overlap_count: overlaps.length,
    claude_unique_count: claudeStillUnique.length,
    codex_unique_count: codexStillUnique.length,
    agreements,
    site_overlaps: overlaps,
    claude_unique: claudeStillUnique.map((f) => ({ ...f, raised_by: ["claude"] })),
    codex_unique: codexStillUnique.map((f) => ({ ...f, raised_by: ["codex"] })),
  };
}
