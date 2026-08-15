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
export const QA_BOARD_LOCALES = ["en", "ko", "zh-CN"] as const;
export type QaBoardLocale = typeof QA_BOARD_LOCALES[number];

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
  role: "entrypoint" | "localized-view" | "screenshot-preview";
  sha256: string;
  bytes: number;
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

const BOARD_COPY = {
  en: {
    documentTitle: "Traceknot QA Board",
    reportLabel: "Verification report",
    revision: "Revision",
    language: "Language",
    jumpNavigation: "Report sections",
    overview: "Overview",
    attention: "Needs attention",
    attentionDescription: "Review checks that did not pass before making a delivery decision.",
    noAttention: "No checks need attention.",
    noAttentionDescription: "Every persisted verification check passed.",
    checks: "Verification checks",
    checksDescription: "Evidence-backed results, ordered by the checks that need review first.",
    noChecks: "No verification obligations were persisted.",
    coverage: "Coverage",
    coverageDescription: "How much of each required verification area is backed by accepted evidence.",
    area: "Area",
    covered: "Covered",
    uncoveredIds: "Uncovered IDs",
    technicalTrace: "Technical trace",
    technicalTraceDescription: "Identifiers and source state for audit and troubleshooting.",
    request: "Request",
    repositoryIdentity: "Repository identity",
    snapshot: "Snapshot",
    runState: "Run state",
    openDefects: "Open defects",
    acceptedRisks: "Accepted risks",
    none: "None",
    run: "Run",
    updated: "Updated",
    verdictRationale: "Verdict rationale",
    mandatory: "Mandatory",
    passed: "Passed",
    failed: "Failed",
    blocked: "Blocked",
    incomplete: "Incomplete",
    expected: "Expected result",
    noExpected: "No expected result was persisted.",
    evidenceRejected: "Evidence rejected",
    producer: "Producer",
    required: "Required",
    optional: "Optional",
    screenshotAlt: "Screenshot evidence for",
    readOnlyNotice: "This Board is a read-only projection of persisted Traceknot records. It does not modify evidence, verdicts, approvals, or harness completion. QA PASS does not mean every harness task or delivery action is complete.",
    status: { PASS: "Passed", FAIL: "Failed", BLOCKED: "Blocked", INCOMPLETE: "Incomplete" },
    outcomes: {
      PASS: "All required checks passed",
      PASS_WITH_ACCEPTED_RISK: "Passed with accepted risk",
      FAIL: "Verification found blocking failures",
      BLOCKED: "Verification could not complete",
      INCOMPLETE: "Verification evidence is incomplete",
    },
    coverageAreas: { basis: "Test basis", risks: "Risks", conditions: "Conditions", mandatoryObligations: "Mandatory checks" },
    health: "Verification health",
    healthDescription: "Mandatory checks passed out of all required checks.",
    distribution: "Status distribution",
    flow: "Verification flow",
    flowDescription: "Aggregate coverage path from test basis to the final verdict.",
    evidence: "Accepted evidence",
    notApplicable: "Not applicable",
    uncovered: "Uncovered",
  },
  ko: {
    documentTitle: "Traceknot QA 보드",
    reportLabel: "검증 보고서",
    revision: "리비전",
    language: "언어",
    jumpNavigation: "보고서 섹션",
    overview: "요약",
    attention: "확인이 필요합니다",
    attentionDescription: "배포를 결정하기 전에 통과하지 못한 검증 항목을 확인하세요.",
    noAttention: "확인이 필요한 항목이 없습니다.",
    noAttentionDescription: "저장된 모든 검증 항목을 통과했습니다.",
    checks: "검증 항목",
    checksDescription: "확인이 필요한 항목을 먼저 보여주는 증거 기반 검증 결과입니다.",
    noChecks: "저장된 검증 의무가 없습니다.",
    coverage: "검증 범위",
    coverageDescription: "필수 검증 영역 중 승인된 증거로 확인된 범위입니다.",
    area: "영역",
    covered: "검증됨",
    uncoveredIds: "미검증 ID",
    technicalTrace: "기술 추적 정보",
    technicalTraceDescription: "감사와 문제 해결에 사용하는 식별자 및 원본 상태입니다.",
    request: "요청",
    repositoryIdentity: "저장소 식별자",
    snapshot: "스냅샷",
    runState: "실행 상태",
    openDefects: "열린 결함",
    acceptedRisks: "수용된 위험",
    none: "없음",
    run: "실행",
    updated: "업데이트",
    verdictRationale: "판정 근거",
    mandatory: "필수",
    passed: "통과",
    failed: "실패",
    blocked: "차단",
    incomplete: "불완전",
    expected: "기대 결과",
    noExpected: "저장된 기대 결과가 없습니다.",
    evidenceRejected: "증거가 거부되었습니다",
    producer: "생성자",
    required: "필수",
    optional: "선택",
    screenshotAlt: "스크린샷 증거",
    readOnlyNotice: "이 보드는 저장된 Traceknot 기록을 읽기 전용으로 보여줍니다. 증거, 판정, 승인 또는 하네스 완료 상태를 변경하지 않습니다. QA 통과는 모든 하네스 작업이나 배포 절차가 완료되었다는 의미가 아닙니다.",
    status: { PASS: "통과", FAIL: "실패", BLOCKED: "차단", INCOMPLETE: "불완전" },
    outcomes: {
      PASS: "필수 검증을 모두 통과했습니다",
      PASS_WITH_ACCEPTED_RISK: "위험을 수용하고 통과했습니다",
      FAIL: "배포를 막는 검증 실패가 있습니다",
      BLOCKED: "검증을 완료할 수 없습니다",
      INCOMPLETE: "검증 증거가 충분하지 않습니다",
    },
    coverageAreas: { basis: "테스트 기준", risks: "위험", conditions: "조건", mandatoryObligations: "필수 검증" },
    health: "검증 상태",
    healthDescription: "전체 필수 검증 중 통과한 항목입니다.",
    distribution: "상태 분포",
    flow: "검증 흐름",
    flowDescription: "테스트 기준에서 최종 판정까지의 집계 흐름입니다.",
    evidence: "승인된 증거",
    notApplicable: "해당 없음",
    uncovered: "미검증",
  },
  "zh-CN": {
    documentTitle: "Traceknot QA 看板",
    reportLabel: "验证报告",
    revision: "修订",
    language: "语言",
    jumpNavigation: "报告章节",
    overview: "概览",
    attention: "需要关注",
    attentionDescription: "在做出交付决定前，请检查未通过的验证项。",
    noAttention: "没有需要关注的检查项。",
    noAttentionDescription: "所有已保存的验证检查均已通过。",
    checks: "验证检查",
    checksDescription: "基于证据的验证结果，需要关注的检查项优先显示。",
    noChecks: "没有已保存的验证义务。",
    coverage: "覆盖率",
    coverageDescription: "必需验证领域中已由接受证据覆盖的范围。",
    area: "领域",
    covered: "已覆盖",
    uncoveredIds: "未覆盖 ID",
    technicalTrace: "技术追踪",
    technicalTraceDescription: "用于审计和故障排查的标识符与源状态。",
    request: "请求",
    repositoryIdentity: "仓库标识",
    snapshot: "快照",
    runState: "运行状态",
    openDefects: "未解决缺陷",
    acceptedRisks: "已接受风险",
    none: "无",
    run: "运行",
    updated: "更新时间",
    verdictRationale: "判定依据",
    mandatory: "必需",
    passed: "通过",
    failed: "失败",
    blocked: "阻塞",
    incomplete: "不完整",
    expected: "预期结果",
    noExpected: "没有已保存的预期结果。",
    evidenceRejected: "证据已被拒绝",
    producer: "生成者",
    required: "必需",
    optional: "可选",
    screenshotAlt: "截图证据",
    readOnlyNotice: "此看板是已保存 Traceknot 记录的只读视图。它不会修改证据、判定、批准或执行框架的完成状态。QA 通过并不表示所有执行框架任务或交付操作均已完成。",
    status: { PASS: "通过", FAIL: "失败", BLOCKED: "阻塞", INCOMPLETE: "不完整" },
    outcomes: {
      PASS: "所有必需检查均已通过",
      PASS_WITH_ACCEPTED_RISK: "接受风险后通过",
      FAIL: "验证发现阻止交付的失败",
      BLOCKED: "验证无法完成",
      INCOMPLETE: "验证证据不完整",
    },
    coverageAreas: { basis: "测试依据", risks: "风险", conditions: "条件", mandatoryObligations: "必需检查" },
    health: "验证健康度",
    healthDescription: "所有必需检查中已通过的数量。",
    distribution: "状态分布",
    flow: "验证流程",
    flowDescription: "从测试依据到最终判定的汇总路径。",
    evidence: "已接受证据",
    notApplicable: "不适用",
    uncovered: "未覆盖",
  },
} as const;

export function resolveQaBoardLocale(...preferences: readonly (string | undefined)[]): QaBoardLocale {
  for (const preference of preferences) {
    const normalized = preference?.trim().toLowerCase().replaceAll("_", "-").split(".")[0]!.split("@")[0];
    if (!normalized) continue;
    if (normalized === "ko" || normalized.startsWith("ko-")) return "ko";
    if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
  }
  return "en";
}

function statusIcon(status: BoardFindingStatus): string {
  if (status === "PASS") return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.3 10.2 3 3.1 6.5-7"/></svg>';
  if (status === "FAIL") return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8"/></svg>';
  if (status === "BLOCKED") return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 5v6m0 3v.1"/></svg>';
  return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 5v5m0 4v.1"/></svg>';
}

function findingHtml(finding: BoardFinding, locale: QaBoardLocale): string {
  const copy = BOARD_COPY[locale];
  const expected = finding.expectedResults.length === 0
    ? `<p class="muted">${copy.noExpected}</p>`
    : `<ul class="expected-list">${finding.expectedResults.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  const images = finding.screenshots.length === 0
    ? ""
    : `<div class="previews">${finding.screenshots.map(item => `<figure><img src="evidence/${item.digest}.png" alt="${copy.screenshotAlt}: ${escapeHtml(finding.obligationId)}"><figcaption>${escapeHtml(short(item.digest))}</figcaption></figure>`).join("")}</div>`;
  const rejected = finding.evaluation?.status === "REJECTED"
    ? `<p class="rejected"><strong>${copy.evidenceRejected}:</strong> ${escapeHtml(finding.evaluation.rejectionReasons.join(", "))}</p>`
    : "";
  const producer = finding.producer
    ? `<p class="meta producer"><span>${copy.producer}</span><code>${escapeHtml(finding.producer.identity)}</code><span aria-hidden="true">·</span><span>${escapeHtml(finding.producer.independence)}</span></p>`
    : "";
  return `<article class="finding status-${finding.status.toLowerCase()}">
<header class="finding-header"><span class="status-icon">${statusIcon(finding.status)}</span><div class="finding-title"><div class="finding-badges"><span class="status">${copy.status[finding.status]}</span><span class="requirement">${finding.mandatory ? copy.required : copy.optional}</span></div><h3>${escapeHtml(finding.obligationId)}</h3></div></header>
<div class="finding-body"><p class="finding-summary">${escapeHtml(finding.summary)}</p><h4>${copy.expected}</h4>${expected}${rejected}${producer}${images}</div>
</article>`;
}

function coverageLabel(name: string, locale: QaBoardLocale): string {
  const labels = BOARD_COPY[locale].coverageAreas;
  return name in labels ? labels[name as keyof typeof labels] : name;
}

type VisualTone = "complete" | "partial" | "empty" | "na";

function visualTone(covered: number, total: number): VisualTone {
  if (total === 0) return "na";
  if (covered === total) return "complete";
  return covered === 0 ? "empty" : "partial";
}

function visualPercent(covered: number, total: number): number | undefined {
  return total === 0 ? undefined : Math.round(covered / total * 100);
}

const FLOW_COVERAGE_KEYS = ["basis", "risks", "conditions"] as const;
const COVERAGE_KEYS = [...FLOW_COVERAGE_KEYS, "mandatoryObligations"] as const;

function visualizationHtml(view: QaBoardView, locale: QaBoardLocale): string {
  const copy = BOARD_COPY[locale];
  const healthTotal = view.counts.mandatory;
  const healthPassed = Math.min(view.counts.passed, healthTotal);
  const healthPercent = visualPercent(healthPassed, healthTotal);
  const distribution = [
    { key: "PASS" as const, value: view.counts.passed },
    { key: "FAIL" as const, value: view.counts.failed },
    { key: "BLOCKED" as const, value: view.counts.blocked },
    { key: "INCOMPLETE" as const, value: view.counts.incomplete },
  ];
  const distributionTotal = distribution.reduce((sum, item) => sum + item.value, 0);
  const distributionBar = distributionTotal === 0
    ? `<span class="distribution-empty">${escapeHtml(copy.none)}</span>`
    : distribution.filter(item => item.value > 0).map(item => `<span class="distribution-segment segment-${item.key.toLowerCase()}" style="width:${item.value / distributionTotal * 100}%" aria-hidden="true"></span>`).join("");
  const distributionLegend = distribution.map(item => `<span class="distribution-key status-${item.key.toLowerCase()}"><i aria-hidden="true"></i><strong>${item.value}</strong> ${escapeHtml(copy.status[item.key])}</span>`).join("");
  const coverageStages = FLOW_COVERAGE_KEYS.map(name => {
    const value = view.coverage[name];
    return {
      label: coverageLabel(name, locale),
      covered: value.covered,
      total: value.total,
    };
  });
  const evidenceTotal = distributionTotal;
  const evidencePassed = view.counts.passed;
  const flowStages = [
    ...coverageStages.slice(0, 3),
    { label: coverageLabel("mandatoryObligations", locale), covered: view.counts.passed, total: view.counts.mandatory },
    { label: copy.evidence, covered: evidencePassed, total: evidenceTotal },
  ];
  const flowNodes = flowStages.map((stage, index) => {
    const percent = visualPercent(stage.covered, stage.total);
    const tone = visualTone(stage.covered, stage.total);
    const value = percent === undefined ? copy.notApplicable : `${stage.covered} / ${stage.total}`;
    return `<div class="flow-step tone-${tone}"><span class="flow-node" aria-hidden="true">${index + 1}</span><div class="flow-step-copy"><strong>${escapeHtml(stage.label)}</strong><span>${escapeHtml(value)}${percent === undefined ? "" : ` · ${percent}%`}</span></div></div>`;
  }).join('<span class="flow-connector" aria-hidden="true"></span>');
  const verdictTone = view.verdict === "PASS" || view.verdict === "PASS_WITH_ACCEPTED_RISK" ? "complete" : view.verdict === "INCOMPLETE" ? "partial" : "empty";
  const verdictLabel = view.verdict === "PASS_WITH_ACCEPTED_RISK" ? copy.status.PASS : copy.status[view.verdict as BoardFindingStatus];
  return `<div class="visualization-grid">
<section class="viz-card health-card" aria-labelledby="health-heading"><div class="viz-heading"><div><h2 id="health-heading">${copy.health}</h2><p>${copy.healthDescription}</p></div><span class="viz-kicker">${escapeHtml(view.verdict)}</span></div><div class="health-layout"><div class="health-ring tone-${healthPercent === undefined ? "na" : healthPercent === 100 ? "complete" : "partial"}" style="--health:${healthPercent ?? 0}%"><strong>${healthPercent === undefined ? "—" : `${healthPercent}%`}</strong><span>${healthPassed} / ${healthTotal}</span></div><div class="distribution" aria-label="${escapeHtml(copy.distribution)}"><h3>${copy.distribution}</h3><div class="distribution-bar" role="img" aria-label="${escapeHtml(distribution.map(item => `${copy.status[item.key]} ${item.value}`).join(", "))}">${distributionBar}</div><div class="distribution-legend">${distributionLegend}</div></div></div></section>
<section class="viz-card flow-card" aria-labelledby="flow-heading"><div class="viz-heading"><div><h2 id="flow-heading">${copy.flow}</h2><p>${copy.flowDescription}</p></div><span class="viz-kicker">${escapeHtml(verdictLabel)}</span></div><div class="flow" role="img" aria-label="${escapeHtml(copy.flowDescription)}">${flowNodes}<span class="flow-connector" aria-hidden="true"></span><div class="flow-step tone-${verdictTone}"><span class="flow-node" aria-hidden="true">✓</span><div class="flow-step-copy"><strong>${escapeHtml(verdictLabel)}</strong><span>${escapeHtml(view.verdict)}</span></div></div></div></section>
</div>`;
}

export function renderQaBoardHtml(view: QaBoardView, locale: QaBoardLocale = "en"): string {
  const copy = BOARD_COPY[locale];
  const attention = view.findings.filter(item => item.status !== "PASS");
  const coverageRows = COVERAGE_KEYS.map(name => {
    const value = view.coverage[name];
    const percent = visualPercent(value.covered, value.total);
    const label = coverageLabel(name, locale);
    const percentageLabel = percent === undefined ? copy.notApplicable : `${percent}%`;
    return `<tr class="${percent === undefined ? "coverage-na" : ""}"><th scope="row"><span>${escapeHtml(label)}</span><progress max="100" value="${percent ?? 0}" aria-label="${escapeHtml(label)}: ${escapeHtml(percentageLabel)}"></progress></th><td data-label="${copy.covered}"><strong>${value.covered} / ${value.total}</strong><span class="percentage">${escapeHtml(percentageLabel)}</span></td><td data-label="${copy.uncoveredIds}">${escapeHtml(value.uncoveredIds.join(", ") || "—")}</td></tr>`;
  }).join("");
  const allFindings = view.findings.map(item => findingHtml(item, locale)).join("") || `<div class="empty-state"><strong>${copy.noChecks}</strong></div>`;
  const attentionHtml = attention.length === 0
    ? `<div class="empty-state success">${statusIcon("PASS")}<div><strong>${copy.noAttention}</strong><p>${copy.noAttentionDescription}</p></div></div>`
    : `<div class="findings">${attention.map(item => findingHtml(item, locale)).join("")}</div>`;
  const languageLinks = QA_BOARD_LOCALES.map(item => {
    const labels: Readonly<Record<QaBoardLocale, string>> = { en: "English", ko: "한국어", "zh-CN": "简体中文" };
    return `<a href="index.${item}.html" lang="${item}" hreflang="${item}"${item === locale ? ' aria-current="page"' : ""}>${labels[item]}</a>`;
  }).join("");
  const verdictTone = view.verdict === "PASS" ? "pass" : view.verdict === "PASS_WITH_ACCEPTED_RISK" ? "risk" : view.verdict.toLowerCase();
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${copy.documentTitle} · ${escapeHtml(view.runId)}</title>
<style>
.visualization-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:12px;padding:20px 28px;background:var(--surface-subtle);border-top:1px solid var(--line)}.viz-card{min-width:0;padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--surface);box-shadow:0 1px 2px rgba(16,24,40,.035)}.viz-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.viz-heading h2{margin:0;font-size:.94rem;letter-spacing:-.01em}.viz-heading p{max-width:44ch;margin:4px 0 0;color:var(--muted);font-size:.77rem;line-height:1.45}.viz-kicker{flex:0 0 auto;padding:5px 8px;border-radius:7px;background:var(--surface-strong);color:var(--muted);font-family:ui-monospace,monospace;font-size:.65rem;font-weight:750}.health-layout{display:grid;grid-template-columns:112px minmax(0,1fr);align-items:center;gap:18px;margin-top:18px}.health-ring{width:104px;height:104px;display:grid;place-content:center;text-align:center;border-radius:50%;background:conic-gradient(var(--pass) 0 var(--health),var(--surface-strong) var(--health) 100%);position:relative}.health-ring::after{content:"";position:absolute;inset:10px;border-radius:50%;background:var(--surface)}.health-ring strong,.health-ring span{position:relative;z-index:1}.health-ring strong{font-size:1.35rem;line-height:1}.health-ring span{margin-top:5px;color:var(--muted);font-size:.72rem;font-variant-numeric:tabular-nums}.health-ring.tone-na{background:var(--surface-strong)}.distribution h3{margin:0 0 9px;color:var(--muted);font-size:.7rem;letter-spacing:.05em;text-transform:uppercase}.distribution-bar{display:flex;min-height:13px;overflow:hidden;border-radius:999px;background:var(--surface-strong)}.distribution-segment{min-width:3px}.segment-pass{background:var(--pass)}.segment-fail{background:var(--fail)}.segment-blocked{background:var(--blocked)}.segment-incomplete{background:var(--incomplete)}.distribution-empty{width:100%;padding:3px 8px;color:var(--muted);font-size:.67rem;text-align:center}.distribution-legend{display:flex;flex-wrap:wrap;gap:7px 12px;margin-top:11px;color:var(--muted);font-size:.69rem}.distribution-key{display:flex;align-items:center;gap:4px}.distribution-key i{width:7px;height:7px;border-radius:50%;background:currentColor}.distribution-key strong{color:var(--text);font-variant-numeric:tabular-nums}.distribution-key.status-pass{color:var(--pass)}.distribution-key.status-fail{color:var(--fail)}.distribution-key.status-blocked{color:var(--blocked)}.distribution-key.status-incomplete{color:var(--incomplete)}.flow{display:flex;align-items:center;gap:8px;margin-top:22px;overflow-x:auto;padding:2px 0 5px}.flow-step{min-width:90px;display:flex;align-items:center;gap:8px}.flow-node{flex:0 0 auto;width:25px;height:25px;display:grid;place-items:center;border:2px solid currentColor;border-radius:50%;font-size:.68rem;font-weight:800}.flow-step-copy{min-width:0;display:grid;gap:2px}.flow-step-copy strong{font-size:.72rem;line-height:1.2;overflow-wrap:anywhere}.flow-step-copy span{color:var(--muted);font-size:.66rem;white-space:nowrap;font-variant-numeric:tabular-nums}.tone-complete{color:var(--pass)}.tone-partial{color:var(--blocked)}.tone-empty{color:var(--fail)}.tone-na{color:var(--muted)}.flow-connector{flex:1 1 18px;min-width:12px;height:2px;background:var(--line)}.findings{position:relative;padding-left:20px}.findings::before{content:"";position:absolute;left:5px;top:18px;bottom:18px;width:2px;background:var(--line)}.findings>.finding::before{content:"";position:absolute;left:-20px;top:23px;width:10px;height:10px;border:2px solid var(--surface);border-radius:50%;background:var(--muted);box-shadow:0 0 0 2px currentColor}.findings>.status-pass::before{background:var(--pass);color:var(--pass)}.findings>.status-fail::before{background:var(--fail);color:var(--fail)}.findings>.status-blocked::before{background:var(--blocked);color:var(--blocked)}.findings>.status-incomplete::before{background:var(--incomplete);color:var(--incomplete)}.coverage-table progress{width:min(280px,100%);height:10px;margin-top:10px}.coverage-table progress::-webkit-progress-bar{background:var(--surface-strong);border-radius:999px}.coverage-table progress::-webkit-progress-value{background:var(--primary);border-radius:999px}.coverage-na progress{opacity:.35}.coverage-na .percentage{font-style:italic}.coverage-table tbody td:last-child{color:var(--muted);font-size:.8rem}
:root{color-scheme:light dark;font-family:"SF Pro Text","Segoe UI","Noto Sans KR","Noto Sans SC",system-ui,-apple-system,sans-serif;background:#f6f8fb;color:#172033;-webkit-font-smoothing:antialiased;--surface:#fff;--surface-subtle:#f3f6fa;--surface-strong:#e9eef5;--text:#172033;--muted:#5f6b7a;--faint:#7b8798;--line:#dfe5ed;--primary:#215cca;--primary-soft:#e9f0ff;--pass:#08783f;--pass-soft:#e5f6ed;--fail:#b42318;--fail-soft:#fff0ee;--blocked:#9a4d00;--blocked-soft:#fff4e5;--incomplete:#596579;--incomplete-soft:#eef1f5;--shadow:0 1px 2px rgba(16,24,40,.04),0 10px 28px rgba(28,39,60,.06)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 50% -20%,#e8f0ff 0,transparent 38rem),var(--surface-subtle);color:var(--text)}a{color:inherit}button,a,summary{touch-action:manipulation}.shell{width:min(1180px,100%);margin:auto;padding:0 24px 64px}.topbar{min-height:72px;display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{display:flex;align-items:center;gap:10px;font-weight:760;letter-spacing:-.02em}.brand-mark{width:30px;height:30px;border-radius:10px;display:grid;place-items:center;background:var(--text);color:var(--surface);font-size:.78rem;box-shadow:0 4px 12px rgba(23,32,51,.18)}.language-switcher{display:flex;align-items:center;gap:4px;padding:4px;background:rgba(255,255,255,.72);border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 2px rgba(16,24,40,.04)}.language-switcher>span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.language-switcher a{min-height:40px;display:flex;align-items:center;padding:0 12px;border-radius:8px;color:var(--muted);font-size:.82rem;font-weight:650;text-decoration:none;transition-property:background-color,color,box-shadow,transform;transition-duration:180ms}.language-switcher a:hover{color:var(--text);background:var(--surface-subtle)}.language-switcher a:active{transform:scale(.96)}.language-switcher a[aria-current=page]{color:var(--primary);background:var(--surface);box-shadow:0 1px 3px rgba(16,24,40,.1)}.summary-card,.panel,.technical-trace{background:var(--surface);border:1px solid rgba(213,221,232,.9);border-radius:20px;box-shadow:var(--shadow)}.summary-card{overflow:hidden}.summary-main{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:32px;padding:34px 36px 30px}.eyebrow{margin:0 0 10px;color:var(--primary);font-size:.77rem;font-weight:760;letter-spacing:.09em;text-transform:uppercase}.summary-card h1{max-width:850px;margin:0;font-size:clamp(1.75rem,3vw,2.65rem);line-height:1.12;letter-spacing:-.035em;overflow-wrap:anywhere;text-wrap:balance}.outcome-title{margin:14px 0 0;font-size:1.03rem;font-weight:690}.rationale{max-width:76ch;margin:8px 0 0;color:var(--muted);line-height:1.65;text-wrap:pretty}.verdict{align-self:start;min-width:150px;padding:18px;border-radius:16px;background:var(--surface-subtle);text-align:center}.verdict strong{display:block;font-size:1.1rem;letter-spacing:.03em}.verdict span{display:block;margin-top:6px;color:var(--muted);font-size:.75rem}.verdict-pass{color:var(--pass);background:var(--pass-soft)}.verdict-risk,.verdict-blocked{color:var(--blocked);background:var(--blocked-soft)}.verdict-fail{color:var(--fail);background:var(--fail-soft)}.verdict-incomplete{color:var(--incomplete);background:var(--incomplete-soft)}.summary-meta{display:flex;gap:18px;flex-wrap:wrap;margin-top:18px;color:var(--muted);font-size:.82rem}.summary-meta span{display:flex;align-items:center;gap:6px}.summary-meta strong{color:var(--text);font-weight:670}.counts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin:0;border-top:1px solid var(--line);background:var(--surface-subtle)}.count{min-width:0;padding:18px 22px;border-right:1px solid var(--line)}.count:last-child{border-right:0}.count dt{color:var(--muted);font-size:.78rem;font-weight:650}.count dd{margin:5px 0 0;font-size:1.5rem;font-weight:760;font-variant-numeric:tabular-nums}.jump-nav{position:sticky;top:10px;z-index:10;display:flex;gap:4px;width:max-content;max-width:100%;margin:16px auto 0;padding:5px;border:1px solid rgba(213,221,232,.9);border-radius:14px;background:rgba(255,255,255,.88);box-shadow:0 8px 24px rgba(28,39,60,.09);backdrop-filter:blur(14px)}.jump-nav a{min-height:40px;display:flex;align-items:center;padding:0 14px;border-radius:9px;color:var(--muted);font-size:.84rem;font-weight:680;text-decoration:none;white-space:nowrap;transition-property:background-color,color,transform;transition-duration:180ms}.jump-nav a:hover{color:var(--primary);background:var(--primary-soft)}.jump-nav a:active{transform:scale(.96)}.panel{margin-top:20px;padding:28px 30px;scroll-margin-top:74px}.section-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:20px}.section-header h2{margin:0;font-size:1.25rem;letter-spacing:-.02em;text-wrap:balance}.section-header p{max-width:660px;margin:5px 0 0;color:var(--muted);font-size:.9rem;line-height:1.55;text-wrap:pretty}.section-count{flex:0 0 auto;min-width:34px;height:28px;display:grid;place-items:center;padding:0 9px;border-radius:999px;background:var(--surface-strong);font-size:.78rem;font-weight:750;font-variant-numeric:tabular-nums}.findings{display:grid;gap:12px}.finding{overflow:hidden;border:1px solid var(--line);border-radius:14px;background:var(--surface);box-shadow:0 1px 2px rgba(16,24,40,.035)}.finding-header{display:flex;align-items:flex-start;gap:12px;padding:16px 18px;background:var(--surface-subtle)}.status-icon{flex:0 0 auto;width:30px;height:30px;display:grid;place-items:center;border-radius:10px}.status-icon svg,.empty-state>svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2.1;stroke-linecap:round;stroke-linejoin:round}.status-pass .status-icon{color:var(--pass);background:var(--pass-soft)}.status-fail .status-icon{color:var(--fail);background:var(--fail-soft)}.status-blocked .status-icon{color:var(--blocked);background:var(--blocked-soft)}.status-incomplete .status-icon{color:var(--incomplete);background:var(--incomplete-soft)}.finding-title{min-width:0}.finding-badges{display:flex;align-items:center;gap:8px}.status,.requirement{font-size:.7rem;font-weight:760;letter-spacing:.045em;text-transform:uppercase}.requirement{padding-left:8px;border-left:1px solid var(--line);color:var(--muted)}.status-pass .status{color:var(--pass)}.status-fail .status{color:var(--fail)}.status-blocked .status{color:var(--blocked)}.status-incomplete .status{color:var(--incomplete)}.finding h3{margin:4px 0 0;font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;font-size:.86rem;font-weight:650;overflow-wrap:anywhere}.finding-body{padding:18px}.finding-summary{margin:0;line-height:1.6;text-wrap:pretty}.finding h4{margin:18px 0 7px;font-size:.77rem;letter-spacing:.045em;text-transform:uppercase}.expected-list{margin:0;padding-left:20px;color:var(--muted);line-height:1.6}.meta,.muted{color:var(--muted)}.producer{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:16px 0 0;font-size:.78rem}.producer code{max-width:100%;overflow-wrap:anywhere;color:var(--text)}.rejected{padding:12px 14px;border-radius:10px;background:var(--fail-soft);color:var(--fail);overflow-wrap:anywhere}.previews{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:16px}.previews figure{margin:0}.previews img{display:block;width:100%;height:auto;border-radius:10px;outline:1px solid rgba(0,0,0,.1)}.previews figcaption{margin-top:6px;color:var(--muted);font-family:ui-monospace,monospace;font-size:.75rem}.empty-state{min-height:96px;display:flex;align-items:center;justify-content:center;gap:13px;padding:20px;border:1px dashed var(--line);border-radius:14px;background:var(--surface-subtle);text-align:left}.empty-state>svg{flex:0 0 auto;width:30px;height:30px;padding:6px;border-radius:10px;color:var(--pass);background:var(--pass-soft)}.empty-state p{margin:4px 0 0;color:var(--muted);font-size:.88rem}.coverage-table{width:100%;border-collapse:separate;border-spacing:0}.coverage-table th,.coverage-table td{padding:15px 12px;text-align:left;border-top:1px solid var(--line);font-size:.88rem;overflow-wrap:anywhere}.coverage-table thead th{border-top:0;padding-top:0;color:var(--muted);font-size:.72rem;letter-spacing:.04em;text-transform:uppercase}.coverage-table tbody th{width:38%;font-weight:680}.coverage-table tbody th span{display:block}.coverage-table progress{display:block;width:min(220px,100%);height:5px;margin-top:8px;border:0;border-radius:999px;overflow:hidden;background:var(--surface-strong)}.coverage-table progress::-webkit-progress-bar{background:var(--surface-strong)}.coverage-table progress::-webkit-progress-value{background:var(--primary);border-radius:999px}.coverage-table td strong{font-variant-numeric:tabular-nums}.percentage{margin-left:8px;color:var(--muted);font-variant-numeric:tabular-nums}.technical-trace{margin-top:20px;overflow:hidden;scroll-margin-top:74px}.technical-trace summary{min-height:56px;display:flex;align-items:center;padding:0 24px;cursor:pointer;font-weight:720;list-style:none}.technical-trace summary::-webkit-details-marker{display:none}.technical-trace summary::after{content:"+";margin-left:auto;color:var(--muted);font-size:1.25rem}.technical-trace[open] summary::after{content:"−"}.technical-trace-content{padding:0 24px 24px;border-top:1px solid var(--line)}.technical-trace-content>p{margin:16px 0 0;color:var(--muted);font-size:.86rem}.technical-trace dl{margin:18px 0 0;display:grid;grid-template-columns:minmax(150px,.35fr) minmax(0,1fr);gap:10px 18px}.technical-trace dt{color:var(--muted);font-size:.82rem;font-weight:650}.technical-trace dd{min-width:0;margin:0;font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;font-size:.8rem;overflow-wrap:anywhere;word-break:break-word}.notice{max-width:900px;margin:24px auto 0;padding:14px 18px;border-radius:12px;background:var(--surface-strong);color:var(--muted);font-size:.78rem;line-height:1.55;text-align:center;text-wrap:pretty}a:focus-visible,summary:focus-visible{outline:3px solid rgba(33,92,202,.35);outline-offset:2px}@media(max-width:760px){.shell{padding:0 14px 40px}.topbar{min-height:64px;align-items:flex-start;padding:14px 0;flex-direction:column;gap:10px}.language-switcher{width:100%;display:grid;grid-template-columns:repeat(3,1fr)}.language-switcher a{justify-content:center;padding:0 6px}.summary-main{grid-template-columns:1fr;gap:18px;padding:24px 20px}.summary-card h1{font-size:1.72rem}.verdict{min-width:0;width:100%;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;text-align:left}.verdict span{margin:0}.summary-meta{gap:8px 14px}.counts{grid-template-columns:repeat(3,1fr)}.count{padding:14px 16px;border-bottom:1px solid var(--line)}.count:nth-child(3){border-right:0}.count:nth-child(4),.count:nth-child(5){border-bottom:0}.jump-nav{position:static;width:100%;overflow-x:auto;justify-content:flex-start}.jump-nav a{flex:1 0 auto;justify-content:center}.panel{padding:22px 18px}.section-header{margin-bottom:16px}.finding-header,.finding-body{padding:15px}.coverage-table{font-size:.84rem}.coverage-table thead{display:none}.coverage-table,.coverage-table tbody,.coverage-table tr,.coverage-table th,.coverage-table td{display:block}.coverage-table tr{padding:14px 0;border-top:1px solid var(--line)}.coverage-table tr:first-child{border-top:0}.coverage-table tbody th{width:auto;border:0;padding:0 0 10px}.coverage-table tbody td{border:0;padding:4px 0}.coverage-table tbody td::before{content:attr(data-label);display:inline-block;min-width:108px;color:var(--muted);font-weight:650}.technical-trace dl{grid-template-columns:1fr;gap:4px}.technical-trace dt{margin-top:10px}.technical-trace dd{margin:0}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.language-switcher a,.jump-nav a{transition-duration:0s}}@media(prefers-color-scheme:dark){:root{--surface:#171c25;--surface-subtle:#10141b;--surface-strong:#252c38;--text:#edf2f8;--muted:#a9b4c4;--faint:#8995a7;--line:#323b49;--primary:#8bb2ff;--primary-soft:#182b4f;--pass:#65d99b;--pass-soft:#123522;--fail:#ff9187;--fail-soft:#431b1c;--blocked:#ffbf69;--blocked-soft:#3d2a11;--incomplete:#bec8d8;--incomplete-soft:#2a303b;--shadow:0 1px 2px rgba(0,0,0,.22),0 16px 34px rgba(0,0,0,.18)}body{background:radial-gradient(circle at 50% -20%,#182b4f 0,transparent 38rem),var(--surface-subtle)}.language-switcher,.jump-nav{background:rgba(23,28,37,.88)}.brand-mark{background:var(--text);color:var(--surface)}.previews img{outline-color:rgba(255,255,255,.1)}}
@media(max-width:760px){.jump-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));overflow:visible}.jump-nav a{min-width:0;white-space:normal;text-align:center}}
@media(max-width:760px){.visualization-grid{grid-template-columns:1fr;padding:16px 18px}.health-layout{grid-template-columns:88px minmax(0,1fr);gap:13px}.health-ring{width:82px;height:82px}.health-ring::after{inset:8px}.health-ring strong{font-size:1.05rem}.flow{display:grid;grid-template-columns:28px minmax(0,1fr);gap:0 9px;overflow:visible}.flow-step{grid-column:1 / -1;min-width:0}.flow-connector{grid-column:1;width:2px;min-width:2px;height:18px;margin-left:12px}.findings{padding-left:16px}.findings::before{left:3px}.findings>.finding::before{left:-17px}}
</style>
</head>
<body>
<div class="shell">
<header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">TK</span><span>Traceknot QA Board</span></div><nav class="language-switcher" aria-label="${copy.language}"><span>${copy.language}</span>${languageLinks}</nav></header>
<main>
<section class="summary-card" id="overview" aria-labelledby="report-title">
<div class="summary-main"><div><p class="eyebrow">${copy.reportLabel} · ${copy.revision} ${view.revision}</p><h1 id="report-title">${escapeHtml(view.changeSummary)}</h1><p class="outcome-title">${copy.outcomes[view.verdict]}</p><p class="rationale"><strong>${copy.verdictRationale}:</strong> ${escapeHtml(view.rationale)}</p><div class="summary-meta"><span><strong>${copy.run}</strong> ${escapeHtml(view.runId)}</span><span><strong>${copy.snapshot}</strong> <code title="${escapeHtml(view.snapshotId)}">${escapeHtml(short(view.snapshotId))}</code></span><span><strong>${copy.updated}</strong> <time datetime="${escapeHtml(view.sourceUpdatedAt)}">${escapeHtml(view.sourceUpdatedAt)}</time></span></div></div><div class="verdict verdict-${verdictTone}"><strong>${escapeHtml(view.verdict)}</strong><span>${copy.status[view.verdict === "PASS_WITH_ACCEPTED_RISK" ? "PASS" : view.verdict]}</span></div></div>
${visualizationHtml(view, locale)}
<dl class="counts"><div class="count"><dt>${copy.mandatory}</dt><dd>${view.counts.mandatory}</dd></div><div class="count"><dt>${copy.passed}</dt><dd>${view.counts.passed}</dd></div><div class="count"><dt>${copy.failed}</dt><dd>${view.counts.failed}</dd></div><div class="count"><dt>${copy.blocked}</dt><dd>${view.counts.blocked}</dd></div><div class="count"><dt>${copy.incomplete}</dt><dd>${view.counts.incomplete}</dd></div></dl>
</section>
<nav class="jump-nav" aria-label="${copy.jumpNavigation}"><a href="#overview">${copy.overview}</a><a href="#attention">${copy.attention}</a><a href="#checks">${copy.checks}</a><a href="#coverage">${copy.coverage}</a></nav>
<section class="panel" id="attention"><div class="section-header"><div><h2>${copy.attention}</h2><p>${copy.attentionDescription}</p></div><span class="section-count">${attention.length}</span></div>${attentionHtml}</section>
<section class="panel" id="checks"><div class="section-header"><div><h2>${copy.checks}</h2><p>${copy.checksDescription}</p></div><span class="section-count">${view.findings.length}</span></div><div class="findings">${allFindings}</div></section>
<section class="panel" id="coverage"><div class="section-header"><div><h2>${copy.coverage}</h2><p>${copy.coverageDescription}</p></div></div><table class="coverage-table"><thead><tr><th scope="col">${copy.area}</th><th scope="col">${copy.covered}</th><th scope="col">${copy.uncoveredIds}</th></tr></thead><tbody>${coverageRows}</tbody></table></section>
<details class="technical-trace" id="trace"><summary>${copy.technicalTrace}</summary><div class="technical-trace-content"><p>${copy.technicalTraceDescription}</p><dl><dt>${copy.request}</dt><dd>${escapeHtml(view.requestId)}</dd><dt>${copy.repositoryIdentity}</dt><dd>${escapeHtml(view.rootIdentity)}</dd><dt>${copy.snapshot}</dt><dd>${escapeHtml(view.snapshotId)}</dd><dt>${copy.runState}</dt><dd>${escapeHtml(view.sourceState)}</dd><dt>${copy.openDefects}</dt><dd>${escapeHtml(view.openDefectIds.join(", ") || copy.none)}</dd><dt>${copy.acceptedRisks}</dt><dd>${escapeHtml(view.acceptedRiskIds.join(", ") || copy.none)}</dd></dl></div></details>
<p class="notice">${copy.readOnlyNotice}</p>
</main>
</div>
</body>
</html>\n`;
}

export function sessionReference(sessionHost: string, sessionId: string | undefined): string {
  return sessionId === undefined ? "UNAVAILABLE" : `sha256:${createHash("sha256").update(sessionHost).update("\0").update(sessionId).digest("hex")}`;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
