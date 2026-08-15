import { createHash } from "node:crypto";
import type { Artifact, EvidenceEvaluation, Observation, Producer, QaVerdict } from "../core/qa-core";
import type {
  CanonicalRunState,
  PlanDocument,
  VerificationEvidence,
  VerificationRunDocuments,
  VerdictDocument,
} from "../runtime/verification-run";

export type BoardSource = Readonly<{
  run: CanonicalRunState;
  verdict: VerdictDocument;
  documents: VerificationRunDocuments;
}>;

export type BoardFindingStatus = "PASS" | "FAIL" | "BLOCKED" | "INCOMPLETE";

export type BoardFinding = Readonly<{
  obligationId: string;
  mandatory: boolean;
  status: BoardFindingStatus;
  expectedResults: readonly string[];
  summary: string;
  producer?: Producer;
  evaluation?: Pick<EvidenceEvaluation, "status" | "rejectionReasons">;
  screenshots: readonly Readonly<{ digest: string; observationId: string }>[];
  artifacts: readonly Artifact[];
}>;

export type QaBoardView = Readonly<{
  runId: string;
  requestId: string;
  rootIdentity: string;
  snapshotId: string;
  revision: number;
  sourceState: CanonicalRunState["state"];
  sourceUpdatedAt: string;
  changeSummary: string;
  verdict: QaVerdict;
  authoritative: false;
  rationale: string;
  counts: VerdictDocument["obligationSummary"];
  findings: readonly BoardFinding[];
  coverage: VerdictDocument["coverage"];
  openDefectIds: readonly string[];
  acceptedRiskIds: readonly string[];
  residualRisks: readonly string[];
}>;

export type QaBoardManifestFile = Readonly<{
  path: string;
  role: "entrypoint" | "screenshot-preview";
  sha256: string;
  artifactDigest?: string;
  observationId?: string;
}>;

export type QaBoardManifest = Readonly<{
  schemaVersion: "traceknot-qa-board/v1";
  runId: string;
  requestId: string;
  rootIdentity: string;
  snapshotId: string;
  sourceRevision: number;
  sourceState: CanonicalRunState["state"];
  sourceUpdatedAt: string;
  generatedAt: string;
  entrypoint: "index.html";
  authoritative: false;
  verdict: QaVerdict;
  counts: VerdictDocument["obligationSummary"];
  generatedBy: Readonly<{
    invocationId: string;
    sessionHost: string;
    sessionRef: string;
  }>;
  files: readonly QaBoardManifestFile[];
}>;

const STATUS_ORDER: Readonly<Record<BoardFindingStatus, number>> = {
  FAIL: 0,
  BLOCKED: 1,
  INCOMPLETE: 2,
  PASS: 3,
};

function evidenceFor(obligationId: string, documents: VerificationRunDocuments): VerificationEvidence | undefined {
  return documents.execution?.evidence.find(item => item.obligationId === obligationId);
}

function observationFor(obligationId: string, documents: VerificationRunDocuments): Observation | undefined {
  const claim = documents.execution?.claims.find(item => item.obligationId === obligationId);
  const ids = new Set(claim?.observationIds ?? []);
  return documents.execution?.observations.find(item => ids.has(item.observationId));
}

function evaluationFor(obligationId: string, documents: VerificationRunDocuments): EvidenceEvaluation | undefined {
  const claim = documents.execution?.claims.find(item => item.obligationId === obligationId);
  return claim === undefined ? undefined : documents.evidence?.evaluations.find(item => item.claimId === claim.claimId);
}

function expectedResults(obligationId: string, plan: PlanDocument | undefined): string[] {
  if (!plan) return [];
  const obligation = plan.obligations.find(item => item.id === obligationId);
  if (!obligation) return [];
  const ids = new Set(obligation.conditionIds);
  return plan.conditions.filter(condition => ids.has(condition.id)).map(condition => condition.expectedResult);
}

function statusFor(obligationId: string, documents: VerificationRunDocuments): BoardFindingStatus {
  return evidenceFor(obligationId, documents)?.result.verdict ?? "INCOMPLETE";
}

export function buildQaBoardView(source: BoardSource): QaBoardView {
  const plan = source.documents.plan;
  const obligations = plan?.obligations ?? [];
  const findings = obligations.map(obligation => {
    const evidence = evidenceFor(obligation.id, source.documents);
    const observation = observationFor(obligation.id, source.documents);
    const evaluation = evaluationFor(obligation.id, source.documents);
    const artifacts = observation?.artifacts ?? [];
    return {
      obligationId: obligation.id,
      mandatory: obligation.mandatory,
      status: statusFor(obligation.id, source.documents),
      expectedResults: expectedResults(obligation.id, plan),
      summary: evidence?.result.summary ?? "Verification evidence is unavailable.",
      ...(observation ? { producer: observation.producer } : {}),
      ...(evaluation ? { evaluation: { status: evaluation.status, rejectionReasons: evaluation.rejectionReasons } } : {}),
      screenshots: artifacts.filter(artifact => artifact.type === "screenshot").map(artifact => ({ digest: artifact.digest, observationId: observation!.observationId })),
      artifacts,
    } satisfies BoardFinding;
  }).sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status] || left.obligationId.localeCompare(right.obligationId));
  const request = source.documents.request;
  return {
    runId: source.run.runId,
    requestId: source.run.requestId,
    rootIdentity: source.run.rootIdentity,
    snapshotId: source.run.snapshotId,
    revision: source.run.revision,
    sourceState: source.run.state,
    sourceUpdatedAt: source.run.updatedAt,
    changeSummary: request?.change.summary ?? source.run.requestId,
    verdict: source.verdict.qaVerdict,
    authoritative: false,
    rationale: source.verdict.rationale,
    counts: source.verdict.obligationSummary,
    findings,
    coverage: source.verdict.coverage,
    openDefectIds: source.verdict.openDefectIds,
    acceptedRiskIds: source.verdict.acceptedRiskIds,
    residualRisks: source.verdict.residualRisks,
  };
}

export function buildQaBoardManifest(input: Readonly<{
  view: QaBoardView;
  generatedAt: string;
  invocationId: string;
  sessionHost: string;
  sessionRef: string;
  files: readonly QaBoardManifestFile[];
}>): QaBoardManifest {
  return {
    schemaVersion: "traceknot-qa-board/v1",
    runId: input.view.runId,
    requestId: input.view.requestId,
    rootIdentity: input.view.rootIdentity,
    snapshotId: input.view.snapshotId,
    sourceRevision: input.view.revision,
    sourceState: input.view.sourceState,
    sourceUpdatedAt: input.view.sourceUpdatedAt,
    generatedAt: input.generatedAt,
    entrypoint: "index.html",
    authoritative: false,
    verdict: input.view.verdict,
    counts: input.view.counts,
    generatedBy: {
      invocationId: input.invocationId,
      sessionHost: input.sessionHost,
      sessionRef: input.sessionRef,
    },
    files: input.files,
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function short(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 12)}…`;
}

function statusLabel(status: BoardFindingStatus): string {
  return status === "PASS" ? "Passed" : status === "FAIL" ? "Failed" : status === "BLOCKED" ? "Blocked" : "Incomplete";
}

function findingHtml(finding: BoardFinding): string {
  const expected = finding.expectedResults.length === 0 ? "<p class=\"muted\">No expected result was persisted.</p>" : `<ul>${finding.expectedResults.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  const images = finding.screenshots.length === 0 ? "" : `<div class=\"previews\">${finding.screenshots.map(item => `<figure><img src=\"evidence/${item.digest}.png\" alt=\"Screenshot evidence for ${escapeHtml(finding.obligationId)}\"><figcaption>${escapeHtml(short(item.digest))}</figcaption></figure>`).join("")}</div>`;
  const rejected = finding.evaluation?.status === "REJECTED" ? `<p class=\"rejected\">Evidence rejected: ${escapeHtml(finding.evaluation.rejectionReasons.join(", "))}</p>` : "";
  const producer = finding.producer ? `<p class=\"meta\">Producer: ${escapeHtml(finding.producer.identity)} · ${escapeHtml(finding.producer.independence)}</p>` : "";
  return `<article class=\"finding status-${finding.status.toLowerCase()}\"><header><span class=\"status\">${statusLabel(finding.status)}</span><h3>${escapeHtml(finding.obligationId)}</h3></header><p>${escapeHtml(finding.summary)}</p><h4>Expected</h4>${expected}${rejected}${producer}${images}</article>`;
}

export function renderQaBoardHtml(view: QaBoardView): string {
  const attention = view.findings.filter(item => item.status !== "PASS");
  const coverageRows = Object.entries(view.coverage).map(([name, value]) => `<tr><th scope="row">${escapeHtml(name)}</th><td data-label="Covered">${value.covered} / ${value.total}</td><td data-label="Uncovered IDs">${escapeHtml(value.uncoveredIds.join(", ") || "—")}</td></tr>`).join("");
  const allFindings = view.findings.map(findingHtml).join("") || "<p>No verification obligations were persisted.</p>";
  const attentionHtml = attention.length === 0 ? "<p>No mandatory issue requires attention.</p>" : attention.map(findingHtml).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Traceknot QA Board · ${escapeHtml(view.runId)}</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f5f7;color:#15171a;-webkit-font-smoothing:antialiased}*{box-sizing:border-box}body{margin:0}.page{width:min(1120px,100%);margin:auto;padding:32px 20px 56px}.hero,.panel,.finding{background:#fff;border:1px solid #d9dde3;border-radius:14px;box-shadow:0 1px 2px #0000000d}.hero{padding:28px}.eyebrow,.meta,.muted{color:#626a76}.eyebrow{font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}h1{overflow-wrap:anywhere;text-wrap:balance}.verdict{display:inline-block;margin:12px 0 6px;padding:7px 12px;border-radius:999px;background:#1f2937;color:#fff;font-weight:750}.counts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-top:20px}.count{padding:12px;border-radius:10px;background:#f4f5f7}.count strong{display:block;font-size:1.35rem;font-variant-numeric:tabular-nums}.panel{margin-top:18px;padding:22px}.finding{padding:18px;margin-top:12px;box-shadow:none;border-left-width:5px}.finding header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.finding h3{margin:0;font-size:1rem;overflow-wrap:anywhere}.finding p,.notice,.technical-trace dd{overflow-wrap:anywhere;word-break:break-word}.finding h4{margin-bottom:4px}.status{font-size:.76rem;font-weight:750;text-transform:uppercase}.status-fail{border-left-color:#b42318}.status-blocked{border-left-color:#b54708}.status-incomplete{border-left-color:#667085}.status-pass{border-left-color:#067647}.rejected{color:#b42318}.previews{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.previews figure{margin:0}.previews img{display:block;width:100%;height:auto;border:1px solid #d9dde3;border-radius:8px;outline:1px solid rgba(0,0,0,.1)}.previews figcaption{margin-top:5px;color:#626a76;font-size:.8rem}.coverage-table{width:100%;border-collapse:collapse}.coverage-table th,.coverage-table td{padding:9px;text-align:left;border-bottom:1px solid #e4e7ec;overflow-wrap:anywhere}.technical-trace{overflow:hidden}.technical-trace dl{margin:16px 0 0;display:grid;grid-template-columns:minmax(120px,.4fr) minmax(0,1fr);gap:8px 16px}.technical-trace dt{font-weight:750}.technical-trace dd{margin:0;min-width:0}details{margin-top:18px}summary{min-height:40px;display:flex;align-items:center;cursor:pointer}summary:focus-visible{outline:2px solid #4c9ffe;outline-offset:4px;border-radius:6px}.notice{border:1px solid #f0b429;border-radius:10px;padding:14px;color:#533f03}@media(max-width:700px){.page{padding:18px 12px 40px}.hero,.panel{padding:18px}.counts{grid-template-columns:repeat(2,minmax(0,1fr))}.coverage-table{font-size:.84rem}.coverage-table thead{display:none}.coverage-table,.coverage-table tbody,.coverage-table tr,.coverage-table th,.coverage-table td{display:block}.coverage-table tr{padding:10px 0;border-bottom:1px solid #e4e7ec}.coverage-table tr:last-child{border-bottom:0}.coverage-table tbody th{border:0;padding:0 0 4px}.coverage-table tbody td{border:0;padding:2px 0}.coverage-table tbody td::before{content:attr(data-label);display:inline-block;min-width:112px;font-weight:750}.technical-trace dl{grid-template-columns:1fr;gap:3px 0}.technical-trace dt{margin-top:10px}.technical-trace dd{margin:0}}@media(prefers-color-scheme:dark){:root{background:#111418;color:#f4f5f7}.hero,.panel,.finding{background:#191d23;border-color:#303640}.eyebrow,.meta,.muted,figcaption{color:#aab2bf}.count{background:#242a32}.coverage-table th,.coverage-table td{border-color:#303640}.coverage-table tr{border-color:#303640}.coverage-table tbody td::before{color:#aab2bf}.notice{background:#332b12;color:#ffe7a3;border-color:#806b23}.previews img{outline-color:rgba(255,255,255,.1)}}
</style>
</head>
<body><main class="page">
<section class="hero"><div class="eyebrow">Traceknot QA Board · revision ${view.revision}</div><h1>${escapeHtml(view.changeSummary)}</h1><div class="verdict">${escapeHtml(view.verdict)}</div><p>${escapeHtml(view.rationale)}</p><p class="meta">Run ${escapeHtml(view.runId)} · Snapshot ${escapeHtml(short(view.snapshotId))} · Updated ${escapeHtml(view.sourceUpdatedAt)}</p><div class="counts"><div class="count"><strong>${view.counts.mandatory}</strong>Mandatory</div><div class="count"><strong>${view.counts.passed}</strong>Passed</div><div class="count"><strong>${view.counts.failed}</strong>Failed</div><div class="count"><strong>${view.counts.blocked}</strong>Blocked</div><div class="count"><strong>${view.counts.incomplete}</strong>Incomplete</div></div></section>
<section class="panel"><h2>Needs attention</h2>${attentionHtml}</section>
<section class="panel"><h2>Verification checks</h2>${allFindings}</section>
<section class="panel"><h2>Coverage</h2><table class="coverage-table"><thead><tr><th scope="col">Area</th><th scope="col">Covered</th><th scope="col">Uncovered IDs</th></tr></thead><tbody>${coverageRows}</tbody></table></section>
<details class="panel technical-trace"><summary>Technical trace</summary><dl><dt>Request</dt><dd>${escapeHtml(view.requestId)}</dd><dt>Repository identity</dt><dd>${escapeHtml(view.rootIdentity)}</dd><dt>Snapshot</dt><dd>${escapeHtml(view.snapshotId)}</dd><dt>Run state</dt><dd>${escapeHtml(view.sourceState)}</dd><dt>Open defects</dt><dd>${escapeHtml(view.openDefectIds.join(", ") || "None")}</dd><dt>Accepted risks</dt><dd>${escapeHtml(view.acceptedRiskIds.join(", ") || "None")}</dd></dl></details>
<p class="notice">This Board is a read-only projection of persisted Traceknot records. It does not modify evidence, verdicts, approvals, or harness completion. QA PASS does not mean every harness task or delivery action is complete.</p>
</main></body></html>\n`;
}

export function sessionReference(sessionHost: string, sessionId: string | undefined): string {
  return sessionId === undefined ? "UNAVAILABLE" : `sha256:${createHash("sha256").update(sessionHost).update("\0").update(sessionId).digest("hex")}`;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
