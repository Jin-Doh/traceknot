import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderQaBoardHtml, type QaBoardView } from "../system/presentation/qa-board";

const output = resolve(process.argv[2] ?? "preview");
await mkdir(output, { recursive: true });

const base: QaBoardView = {
  runId: "pr65-pr66-final",
  requestId: "complete-canonical-runtime",
  rootIdentity: "Jin-Doh/traceknot",
  snapshotId: "8cc4bf55c69910c3fc792068037abf08b1328823",
  revision: 2,
  sourceState: "TERMINAL",
  sourceUpdatedAt: "2026-08-20T03:15:00Z",
  changeSummary: "Complete the canonical Skill runtime cutover and organize PRs 65 and 66",
  assurance: {
    context: "release",
    requiredIndependence: "separate-verification-context",
    releaseStatus: "satisfied",
  },
  verdict: "PASS",
  authoritative: false,
  rationale: "Five mandatory obligations passed on the final stacked snapshot with local direct-path evidence and separate verification; no unresolved review thread or material residual risk remains.",
  counts: { mandatory: 5, passed: 5, failed: 0, blocked: 0, incomplete: 0 },
  findings: [
    {
      obligationId: "OBL-001",
      mandatory: true,
      status: "PASS",
      expectedResults: ["The installed canonical Skill payload passes its runtime self-check."],
      summary: "Skills CLI smoke and runtime self-check passed with four required Board schemas and five host capability manifests.",
      producer: { kind: "ci", identity: "PR 65 required checks", independence: "separate-verification-context" },
      evaluation: { status: "ACCEPTED", rejectionReasons: [] },
      screenshots: [],
      artifacts: [],
    },
    {
      obligationId: "OBL-002",
      mandatory: true,
      status: "PASS",
      expectedResults: ["Board publication uses one session-scoped contract without a portable fallback namespace."],
      summary: "The duplicate renderer reference and Portable Board field set were removed; Board contract and canonical gate tests passed.",
      producer: { kind: "ci", identity: "PR 65 correctness", independence: "separate-verification-context" },
      evaluation: { status: "ACCEPTED", rejectionReasons: [] },
      screenshots: [],
      artifacts: [],
    },
    {
      obligationId: "OBL-003",
      mandatory: true,
      status: "PASS",
      expectedResults: ["The optional prefix launcher never creates or retargets a Skills CLI registration."],
      summary: "Installer, updater, rollback, recovery, and uninstall smoke scenarios preserved external registrations and removed only legacy prefix-owned symlinks.",
      producer: { kind: "ci", identity: "PR 65 correctness", independence: "separate-verification-context" },
      evaluation: { status: "ACCEPTED", rejectionReasons: [] },
      screenshots: [],
      artifacts: [],
    },
    {
      obligationId: "OBL-004",
      mandatory: true,
      status: "PASS",
      expectedResults: ["Tight retention cutover and cross-run terminal selection preserve the correct Board revisions."],
      summary: "Original quota reproduction no longer fails publication and maintenance regression modules passed.",
      producer: { kind: "ci", identity: "PR 65 correctness", independence: "separate-verification-context" },
      evaluation: { status: "ACCEPTED", rejectionReasons: [] },
      screenshots: [],
      artifacts: [],
    },
    {
      obligationId: "OBL-005",
      mandatory: true,
      status: "PASS",
      expectedResults: ["The stacked PR chain is source-first, documentation-only on top, review-complete, clean, and green."],
      summary: "PR 65 and PR 66 are ready for review, mergeable CLEAN, zero unresolved threads, and all required checks succeeded on final heads.",
      producer: { kind: "ci", identity: "PR 65 and PR 66 required checks", independence: "separate-verification-context" },
      evaluation: { status: "ACCEPTED", rejectionReasons: [] },
      screenshots: [],
      artifacts: [],
    },
  ],
  coverage: {
    basis: { total: 6, covered: 6, uncoveredIds: [] },
    risks: { total: 3, covered: 3, uncoveredIds: [] },
    conditions: { total: 5, covered: 5, uncoveredIds: [] },
    mandatoryObligations: { total: 5, covered: 5, uncoveredIds: [] },
  },
  openDefectIds: [],
  acceptedRiskIds: [],
  residualRisks: [],
};

const mixed: QaBoardView = {
  ...base,
  runId: "qa-board-mixed-status",
  revision: 3,
  verdict: "BLOCKED",
  assurance: { ...base.assurance, releaseStatus: "insufficient" },
  rationale: "One deterministic verification passed, one browser obligation is blocked, and one evidence set is incomplete.",
  counts: { mandatory: 3, passed: 1, failed: 0, blocked: 1, incomplete: 1 },
  findings: [
    base.findings[0]!,
    {
      ...base.findings[1]!,
      obligationId: "OBL-BROWSER",
      status: "BLOCKED",
      summary: "Browser execution was unavailable in the selected harness, so the responsive layout could not be independently observed.",
      expectedResults: ["Capture the whole page and focused report cards at desktop and mobile widths."],
      evaluation: { status: "REJECTED", rejectionReasons: ["INDEPENDENCE_NOT_MET"] },
    },
    {
      ...base.findings[2]!,
      obligationId: "OBL-EVIDENCE",
      status: "INCOMPLETE",
      summary: "The command completed but one declared screenshot artifact was not persisted.",
      expectedResults: ["Every declared screenshot digest resolves to immutable local evidence."],
      evaluation: { status: "INDETERMINATE", rejectionReasons: ["MISSING_ARTIFACT"] },
    },
  ],
  coverage: {
    basis: { total: 6, covered: 5, uncoveredIds: ["basis:mobile"] },
    risks: { total: 3, covered: 2, uncoveredIds: ["risk:responsive"] },
    conditions: { total: 5, covered: 3, uncoveredIds: ["condition:mobile", "condition:evidence"] },
    mandatoryObligations: { total: 3, covered: 1, uncoveredIds: ["OBL-BROWSER", "OBL-EVIDENCE"] },
  },
  openDefectIds: [],
  acceptedRiskIds: [],
  residualRisks: ["Responsive behavior was not independently observed."],
};

await writeFile(resolve(output, "qa-board-pass-en.html"), renderQaBoardHtml(base, "en", { showProjectSupport: true }));
await writeFile(resolve(output, "qa-board-pass-ko.html"), renderQaBoardHtml(base, "ko", { showProjectSupport: true }));
await writeFile(resolve(output, "qa-board-mixed-en.html"), renderQaBoardHtml(mixed, "en"));
console.log(`Wrote QA Board previews to ${output}`);
