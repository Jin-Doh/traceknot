/// <reference types="bun" />

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderQaBoardHtml, type QaBoardView } from "../system/presentation/qa-board";

const output = resolve(process.argv[2] ?? "preview");
const snapshotId = process.argv[3] ?? process.env.GITHUB_SHA;
if (snapshotId === undefined || !/^[0-9a-f]{40,64}$/.test(snapshotId)) {
  throw new Error("usage: render-qa-board-visual-fixtures.ts OUTPUT SNAPSHOT_SHA");
}
await mkdir(output, { recursive: true });

const pass: QaBoardView = {
  runId: "qa-board-visual-pass",
  requestId: "qa-board-visual-contract",
  rootIdentity: "Jin-Doh/traceknot",
  snapshotId,
  revision: 1,
  sourceState: "TERMINAL",
  sourceUpdatedAt: "2026-08-20T00:00:00Z",
  changeSummary: "Verify the canonical QA Board visual contract",
  assurance: {
    context: "release",
    requiredIndependence: "independent-producer",
    releaseStatus: "satisfied",
  },
  verdict: "PASS",
  authoritative: false,
  rationale: "This synthetic visual fixture exercises representative accepted evidence, coverage, localization, responsive layout, and technical trace content.",
  counts: { mandatory: 5, passed: 5, failed: 0, blocked: 0, incomplete: 0 },
  findings: [
    {
      obligationId: "OBL-VISUAL-DESKTOP",
      mandatory: true,
      status: "PASS",
      expectedResults: ["Desktop sections remain visually distinct and preserve readable card hierarchy."],
      summary: "Desktop summary, flow, findings, coverage, and trace regions rendered without overlap.",
      producer: { kind: "ci", identity: "QA Board visual workflow", independence: "independent-producer" },
      evaluation: { status: "ACCEPTED", rejectionReasons: [] },
      screenshots: [],
      artifacts: [],
    },
    {
      obligationId: "OBL-VISUAL-MOBILE",
      mandatory: true,
      status: "PASS",
      expectedResults: ["The Board reflows at 320 and 390 CSS pixels without page-level horizontal overflow."],
      summary: "Navigation, verification flow, findings, and coverage rows use their documented mobile layouts.",
      producer: { kind: "ci", identity: "QA Board visual workflow", independence: "independent-producer" },
      evaluation: { status: "ACCEPTED", rejectionReasons: [] },
      screenshots: [],
      artifacts: [],
    },
    {
      obligationId: "OBL-VISUAL-LOCALE",
      mandatory: true,
      status: "PASS",
      expectedResults: ["English, Korean, and Simplified Chinese labels render with legible glyphs."],
      summary: "Localized labels and long technical content remain visible in light and dark color schemes.",
      producer: { kind: "ci", identity: "QA Board visual workflow", independence: "independent-producer" },
      evaluation: { status: "ACCEPTED", rejectionReasons: [] },
      screenshots: [],
      artifacts: [],
    },
    {
      obligationId: "OBL-VISUAL-LOGO",
      mandatory: true,
      status: "PASS",
      expectedResults: ["The header embeds the official Traceknot mark."],
      summary: "The Board embeds the repository-owned SVG mark rather than a text placeholder.",
      producer: { kind: "ci", identity: "QA Board visual workflow", independence: "independent-producer" },
      evaluation: { status: "ACCEPTED", rejectionReasons: [] },
      screenshots: [],
      artifacts: [],
    },
    {
      obligationId: "OBL-VISUAL-ACCESSIBILITY",
      mandatory: true,
      status: "PASS",
      expectedResults: ["Reduced-motion, forced-color, keyboard, and disclosure affordances remain available."],
      summary: "Static visual composition does not replace the renderer's deterministic accessibility contracts.",
      producer: { kind: "ci", identity: "QA Board visual workflow", independence: "independent-producer" },
      evaluation: { status: "ACCEPTED", rejectionReasons: [] },
      screenshots: [],
      artifacts: [],
    },
  ],
  coverage: {
    basis: { total: 7, covered: 7, uncoveredIds: [] },
    risks: { total: 5, covered: 5, uncoveredIds: [] },
    conditions: { total: 7, covered: 7, uncoveredIds: [] },
    mandatoryObligations: { total: 5, covered: 5, uncoveredIds: [] },
  },
  openDefectIds: [],
  acceptedRiskIds: [],
  residualRisks: [],
};

const mixed: QaBoardView = {
  ...pass,
  runId: "qa-board-visual-mixed",
  revision: 2,
  verdict: "BLOCKED",
  assurance: { ...pass.assurance, releaseStatus: "insufficient" },
  rationale: "One deterministic verification passed, one browser obligation is blocked, and one evidence set is incomplete.",
  counts: { mandatory: 3, passed: 1, failed: 0, blocked: 1, incomplete: 1 },
  findings: [
    pass.findings[0]!,
    {
      ...pass.findings[1]!,
      obligationId: "OBL-BROWSER",
      status: "BLOCKED",
      summary: "Browser execution was unavailable, so responsive layout was not independently observed.",
      expectedResults: ["Capture the whole page and focused report cards at desktop and mobile widths."],
      evaluation: { status: "REJECTED", rejectionReasons: ["INDEPENDENCE_NOT_MET"] },
    },
    {
      ...pass.findings[2]!,
      obligationId: "OBL-EVIDENCE",
      status: "INCOMPLETE",
      summary: "The command completed but one declared screenshot artifact was not persisted.",
      expectedResults: ["Every declared screenshot digest resolves to immutable evidence."],
      evaluation: { status: "REJECTED", rejectionReasons: ["MISSING_ARTIFACT"] },
    },
  ],
  coverage: {
    basis: { total: 7, covered: 5, uncoveredIds: ["basis:mobile", "basis:localization"] },
    risks: { total: 5, covered: 3, uncoveredIds: ["risk:responsive", "risk:evidence"] },
    conditions: { total: 7, covered: 4, uncoveredIds: ["condition:mobile", "condition:evidence", "condition:locale"] },
    mandatoryObligations: { total: 3, covered: 1, uncoveredIds: ["OBL-BROWSER", "OBL-EVIDENCE"] },
  },
  residualRisks: ["Responsive behavior was not independently observed."],
};

await Promise.all([
  writeFile(resolve(output, "qa-board-pass-en.html"), renderQaBoardHtml(pass, "en", { showProjectSupport: true })),
  writeFile(resolve(output, "qa-board-pass-ko.html"), renderQaBoardHtml(pass, "ko", { showProjectSupport: true })),
  writeFile(resolve(output, "qa-board-pass-zh-CN.html"), renderQaBoardHtml(pass, "zh-CN", { showProjectSupport: true })),
  writeFile(resolve(output, "qa-board-mixed-en.html"), renderQaBoardHtml(mixed, "en")),
]);
console.log(`Wrote snapshot-bound QA Board visual fixtures to ${output}`);
