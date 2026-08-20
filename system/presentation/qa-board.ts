import { createHash } from "node:crypto";
import TRACEKNOT_MARK_SVG from "../../assets/traceknot-mark.svg" with { type: "text" };
import { resolveObligationOutcome, type Artifact, type EvidenceEvaluation, type Observation, type Producer, type QaVerdict } from "../core/qa-core";
import type {
  AssuranceContext,
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
export type QaBoardRenderOptions = Readonly<{ showProjectSupport?: boolean }>;

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

export type QaBoardAssurance = Readonly<{
  context: AssuranceContext;
  requiredIndependence: "separate-verification-context" | "independent-producer";
  releaseStatus: "not-evaluated" | "satisfied" | "insufficient";
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
  assurance: QaBoardAssurance;
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
  assurance: QaBoardAssurance;
  verdict: QaVerdict;
  counts: VerdictDocument["obligationSummary"];
  generatedBy: Readonly<{
    invocationId: string;
    sessionHost: string;
    sessionRef: string;
  }>;
  sessionKey?: string;
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
  const evidence = evidenceFor(obligationId, documents);
  if (!evidence) return "INCOMPLETE";
  const plan = documents.plan;
  const execution = documents.execution;
  const evidenceDocument = documents.evidence;
  const obligation = plan?.obligations.find(item => item.id === obligationId);
  const claim = execution?.claims.find(item => item.obligationId === obligationId);
  const evaluation = claim === undefined ? undefined : evidenceDocument?.evaluations.find(item => item.claimId === claim.claimId);
  if (plan && execution && evidenceDocument && obligation && claim && evaluation) {
    const observationIds = new Set(claim.observationIds);
    const criterionId = `criterion:${obligation.id}`;
    const outcome = resolveObligationOutcome({
      requestId: plan.requestId,
      snapshotId: plan.snapshotId,
      obligation: { id: obligation.id, mandatory: obligation.mandatory, criterionIds: [criterionId], requiredIndependence: obligation.independence },
      criteria: [{ schemaVersion: "success-criterion/v1", criterionId, kind: "structured-assertion", expected: { assertions: [{ field: "execution.exitStatus", operator: "equals", value: "passed" }] }, requiredScope: { kind: "repository-canonical", selectors: [plan.requestId] }, requiredIndependence: obligation.independence, requiredArtifacts: ["verification-result"] }],
      claims: [claim],
      evaluations: [evaluation],
      observations: execution.observations.filter(item => observationIds.has(item.observationId) && item.execution.exitStatus !== "cancelled"),
    }).outcome;
    return outcome === "PASSED" ? "PASS" : outcome === "FAILED" ? "FAIL" : outcome === "BLOCKED" ? "BLOCKED" : "INCOMPLETE";
  }
  return evidenceFor(obligationId, documents)?.result.verdict ?? "INCOMPLETE";
}
function assuranceFor(source: BoardSource, plan: PlanDocument | undefined): QaBoardAssurance {
  const context = source.documents.request?.assuranceContext ?? "release";
  const requiredIndependence = plan?.obligations.some(item => item.independence === "independent-producer")
    ? "independent-producer" as const
    : "separate-verification-context" as const;
  const releaseStatus = context === "release"
    ? source.verdict.qaVerdict === "PASS" || source.verdict.qaVerdict === "PASS_WITH_ACCEPTED_RISK" ? "satisfied" as const : "insufficient" as const
    : "not-evaluated" as const;
  return { context, requiredIndependence, releaseStatus };
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
    assurance: assuranceFor(source, plan),
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
    assurance: input.view.assurance,
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
    assurance: "Assurance",
    assuranceContext: "Context",
    requiredIndependence: "Required independence",
    releaseStatus: "Release status",
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
    projectSupportTitle: "Project support",
    projectSupportDescription: "If Traceknot was useful, consider starring it on GitHub.",
    projectSupportAction: "Star on GitHub",
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
    assurance: "보증 수준",
    assuranceContext: "검증 맥락",
    requiredIndependence: "필요한 독립성",
    releaseStatus: "릴리스 상태",
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
    projectSupportTitle: "프로젝트 응원하기",
    projectSupportDescription: "Traceknot이 도움이 되었다면 GitHub Star로 응원해 주세요.",
    projectSupportAction: "GitHub에서 Star",
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
    assurance: "保证级别",
    assuranceContext: "验证上下文",
    requiredIndependence: "所需独立性",
    releaseStatus: "发布状态",
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
    projectSupportTitle: "支持项目",
    projectSupportDescription: "如果 Traceknot 对你有帮助，可以考虑在 GitHub 上加星。",
    projectSupportAction: "在 GitHub 上加星",
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
  const preview = finding.summary.length <= 180 ? finding.summary : `${finding.summary.slice(0, 177).trimEnd()}…`;
  const open = finding.status === "PASS" ? "" : " open";
  return `<details class="finding status-${finding.status.toLowerCase()}"${open}>
<summary class="finding-header"><span class="status-icon">${statusIcon(finding.status)}</span><span class="finding-title"><span class="finding-badges"><span class="status">${copy.status[finding.status]}</span><span class="requirement">${finding.mandatory ? copy.required : copy.optional}</span></span><span class="finding-id">${escapeHtml(finding.obligationId)}</span><span class="finding-peek">${escapeHtml(preview)}</span></span><span class="disclosure" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="m5 7.5 5 5 5-5"/></svg></span></summary>
<div class="finding-body"><p class="finding-summary">${escapeHtml(finding.summary)}</p><h4>${copy.expected}</h4>${expected}${rejected}${producer}${images}</div>
</details>`;
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
    return { label: coverageLabel(name, locale), covered: value.covered, total: value.total };
  });
  const evidenceTotal = distributionTotal;
  const flowStages = [
    ...coverageStages,
    { label: coverageLabel("mandatoryObligations", locale), covered: view.counts.passed, total: view.counts.mandatory },
    { label: copy.evidence, covered: view.counts.passed, total: evidenceTotal },
  ];
  const flowNodes = flowStages.map((stage, index) => {
    const percent = visualPercent(stage.covered, stage.total);
    const tone = visualTone(stage.covered, stage.total);
    const value = percent === undefined ? copy.notApplicable : `${stage.covered} / ${stage.total} · ${percent}%`;
    return `<div class="flow-step tone-${tone}" role="listitem"><span class="flow-node" aria-hidden="true">${index + 1}</span><span class="flow-step-copy"><strong>${escapeHtml(stage.label)}</strong><span>${escapeHtml(value)}</span></span></div>`;
  }).join("");
  const verdictStatus: BoardFindingStatus = view.verdict === "PASS_WITH_ACCEPTED_RISK" ? "PASS" : view.verdict;
  const verdictTone = verdictStatus === "PASS" ? "complete" : verdictStatus === "INCOMPLETE" ? "partial" : "empty";
  const verdictLabel = copy.status[verdictStatus];
  return `<div class="visualization-grid">
<section class="viz-card health-card" aria-labelledby="health-heading"><div class="viz-heading"><div><h2 id="health-heading">${copy.health}</h2><p>${copy.healthDescription}</p></div><span class="viz-kicker">${escapeHtml(view.verdict)}</span></div><div class="health-layout"><div class="health-ring tone-${healthPercent === undefined ? "na" : healthPercent === 100 ? "complete" : "partial"}" style="--health:${healthPercent ?? 0}%" role="img" aria-label="${escapeHtml(`${copy.health}: ${healthPercent === undefined ? copy.notApplicable : `${healthPercent}%`}`)}"><strong>${healthPercent === undefined ? "—" : `${healthPercent}%`}</strong><span>${healthPassed} / ${healthTotal}</span></div><div class="distribution" aria-label="${escapeHtml(copy.distribution)}"><h3>${copy.distribution}</h3><div class="distribution-bar" role="img" aria-label="${escapeHtml(distribution.map(item => `${copy.status[item.key]} ${item.value}`).join(", "))}">${distributionBar}</div><div class="distribution-legend">${distributionLegend}</div></div></div></section>
<section class="viz-card flow-card" aria-labelledby="flow-heading"><div class="viz-heading"><div><h2 id="flow-heading">${copy.flow}</h2><p>${copy.flowDescription}</p></div><span class="viz-kicker">${escapeHtml(verdictLabel)}</span></div><div class="flow" role="list" aria-label="${escapeHtml(copy.flowDescription)}">${flowNodes}<div class="flow-step tone-${verdictTone} flow-verdict" role="listitem"><span class="flow-node" aria-hidden="true">${statusIcon(verdictStatus)}</span><span class="flow-step-copy"><strong>${escapeHtml(verdictLabel)}</strong><span>${escapeHtml(view.verdict)}</span></span></div></div></section>
</div>`;
}

const BOARD_STYLES = `
:root{
  color-scheme:light dark;
  font-family:"SF Pro Text","Segoe UI","Noto Sans KR","Noto Sans SC",system-ui,-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased;
  --canvas:#f4f7fb;
  --surface:#ffffff;
  --surface-2:#f7f9fc;
  --surface-3:#edf2f7;
  --text:#172033;
  --muted:#5b687b;
  --faint:#7b8798;
  --line:#d7e0ea;
  --line-strong:#bcc8d6;
  --primary:#2f61d5;
  --primary-soft:#eaf0ff;
  --pass:#087a46;
  --pass-soft:#e6f7ee;
  --fail:#b42318;
  --fail-soft:#fff0ee;
  --blocked:#9a4d00;
  --blocked-soft:#fff3e2;
  --incomplete:#596579;
  --incomplete-soft:#eef1f5;
  --shadow:0 1px 2px rgba(16,24,40,.05),0 16px 42px rgba(28,39,60,.08);
  background:var(--canvas);
  color:var(--text);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:radial-gradient(circle at 50% -12rem,#dfe9ff 0,transparent 40rem),var(--canvas);color:var(--text)}
a{color:inherit}
code{font-family:ui-monospace,"SFMono-Regular",Consolas,monospace}
svg{display:block}
button,a,summary{touch-action:manipulation}
.skip-link{position:fixed;left:18px;top:12px;z-index:1000;padding:10px 14px;border-radius:10px;background:var(--text);color:var(--surface);font-weight:750;text-decoration:none;transform:translateY(-160%)}
.skip-link:focus{transform:translateY(0)}
.shell{width:min(1240px,100%);margin:auto;padding:0 28px 72px}
.topbar{min-height:72px;display:flex;align-items:center;justify-content:space-between;gap:24px}
.brand{display:flex;align-items:center;gap:11px;font-weight:780;letter-spacing:-.025em}
.brand-mark{width:32px;height:32px;display:block;flex:0 0 auto;overflow:hidden;border-radius:9px;box-shadow:0 5px 16px rgba(23,32,51,.18)}
.brand-mark svg{width:100%;height:100%}
.language-switcher{display:flex;align-items:center;gap:3px;padding:4px;border:1px solid var(--line);border-radius:12px;background:var(--surface);box-shadow:0 2px 8px rgba(16,24,40,.06)}
.language-switcher>span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.language-switcher a{min-height:38px;display:flex;align-items:center;flex:0 0 auto;padding:0 12px;border-radius:8px;color:var(--muted);font-size:.8rem;font-weight:700;text-decoration:none;white-space:nowrap;transition:background-color 160ms,color 160ms,transform 160ms}
.language-switcher a:hover{color:var(--text);background:var(--surface-2)}
.language-switcher a:active{transform:scale(.97)}
.language-switcher a[aria-current=page]{color:var(--primary);background:var(--primary-soft)}
.summary-card,.panel,.technical-trace,.attention-banner{border:1px solid var(--line);background:var(--surface);box-shadow:var(--shadow)}
.summary-card{--state:var(--primary);overflow:hidden;border-top:4px solid var(--state);border-radius:22px}
.summary-pass{--state:var(--pass)}
.summary-risk,.summary-blocked{--state:var(--blocked)}
.summary-fail{--state:var(--fail)}
.summary-incomplete{--state:var(--incomplete)}
.summary-main{display:grid;grid-template-columns:minmax(0,1fr) 176px;gap:34px;padding:34px 38px 30px}
.eyebrow{margin:0 0 10px;color:var(--primary);font-size:.75rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
.summary-card h1{max-width:860px;margin:0;font-size:clamp(1.85rem,3.2vw,2.8rem);line-height:1.08;letter-spacing:-.04em;overflow-wrap:anywhere;text-wrap:balance}
.outcome-title{margin:15px 0 0;font-size:1.08rem;font-weight:760}
.rationale{max-width:78ch;margin:8px 0 0;color:var(--muted);font-size:.94rem;line-height:1.65;text-wrap:pretty}
.rationale strong{color:var(--text)}
.verdict{align-self:start;display:grid;justify-items:center;min-width:160px;padding:18px 16px;border-radius:17px;text-align:center}
.verdict-icon{width:32px;height:32px;display:grid;place-items:center;margin-bottom:8px;border:2px solid currentColor;border-radius:50%}
.verdict-icon svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.verdict strong{font-size:1.06rem;letter-spacing:.04em}
.verdict span{margin-top:5px;font-size:.76rem;font-weight:650}
.verdict-pass{color:var(--pass);background:var(--pass-soft)}
.verdict-risk,.verdict-blocked{color:var(--blocked);background:var(--blocked-soft)}
.verdict-fail{color:var(--fail);background:var(--fail-soft)}
.verdict-incomplete{color:var(--incomplete);background:var(--incomplete-soft)}
.summary-meta{display:flex;flex-wrap:wrap;gap:9px;margin-top:19px;color:var(--muted);font-size:.78rem}
.summary-meta span{display:flex;align-items:center;gap:6px;min-width:0;padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--surface-2)}
.summary-meta strong{color:var(--text);font-weight:720}
.summary-meta code,.summary-meta time{overflow-wrap:anywhere}
.visualization-grid{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.35fr);gap:14px;padding:22px 30px;background:var(--surface-2);border-top:1px solid var(--line)}
.viz-card{min-width:0;padding:19px;border:1px solid var(--line);border-radius:16px;background:var(--surface);box-shadow:0 1px 2px rgba(16,24,40,.04)}
.viz-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
.viz-heading h2{margin:0;font-size:.98rem;letter-spacing:-.015em}
.viz-heading p{max-width:48ch;margin:5px 0 0;color:var(--muted);font-size:.78rem;line-height:1.5}
.viz-kicker{flex:0 0 auto;padding:5px 8px;border-radius:7px;background:var(--surface-3);color:var(--muted);font-family:ui-monospace,monospace;font-size:.64rem;font-weight:800}
.health-layout{display:grid;grid-template-columns:116px minmax(0,1fr);align-items:center;gap:20px;margin-top:20px}
.health-ring{--health:0%;position:relative;width:108px;height:108px;display:grid;place-content:center;text-align:center;border-radius:50%;background:conic-gradient(var(--pass) 0 var(--health),var(--surface-3) var(--health) 100%)}
.health-ring::after{content:"";position:absolute;inset:10px;border-radius:50%;background:var(--surface)}
.health-ring strong,.health-ring span{position:relative;z-index:1}
.health-ring strong{font-size:1.4rem;line-height:1}
.health-ring span{margin-top:5px;color:var(--muted);font-size:.72rem;font-variant-numeric:tabular-nums}
.health-ring.tone-na{background:var(--surface-3)}
.distribution h3{margin:0 0 9px;color:var(--muted);font-size:.69rem;letter-spacing:.06em;text-transform:uppercase}
.distribution-bar{display:flex;min-height:13px;overflow:hidden;border-radius:999px;background:var(--surface-3)}
.distribution-segment{min-width:3px}
.segment-pass{background:var(--pass)}
.segment-fail{background:var(--fail)}
.segment-blocked{background:var(--blocked)}
.segment-incomplete{background:var(--incomplete)}
.distribution-empty{width:100%;padding:3px 8px;color:var(--muted);font-size:.67rem;text-align:center}
.distribution-legend{display:flex;flex-wrap:wrap;gap:8px 12px;margin-top:11px;color:var(--muted);font-size:.69rem}
.distribution-key{display:flex;align-items:center;gap:4px}
.distribution-key i{width:7px;height:7px;border-radius:50%;background:currentColor}
.distribution-key strong{color:var(--text);font-variant-numeric:tabular-nums}
.distribution-key.status-pass{color:var(--pass)}
.distribution-key.status-fail{color:var(--fail)}
.distribution-key.status-blocked{color:var(--blocked)}
.distribution-key.status-incomplete{color:var(--incomplete)}
.flow{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-top:23px;overflow:visible}
.flow-step{position:relative;min-width:0;display:grid;justify-items:center;align-content:start;gap:8px;text-align:center}
.flow-step:not(:last-child)::after{content:"";position:absolute;top:13px;left:calc(50% + 18px);width:calc(100% - 24px);height:2px;background:var(--line)}
.flow-node{position:relative;z-index:1;width:28px;height:28px;display:grid;place-items:center;border:2px solid currentColor;border-radius:50%;background:var(--surface);font-size:.68rem;font-weight:850}
.flow-node svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.flow-step-copy{min-width:0;display:grid;gap:3px}
.flow-step-copy strong{font-size:.7rem;line-height:1.25;overflow-wrap:anywhere}
.flow-step-copy span{color:var(--muted);font-size:.63rem;line-height:1.3;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.tone-complete{color:var(--pass)}
.tone-partial{color:var(--blocked)}
.tone-empty{color:var(--fail)}
.tone-na{color:var(--muted)}
.summary-footer{border-top:1px solid var(--line);background:var(--surface)}
.assurance-strip{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:13px 28px}
.assurance-strip>strong{margin-right:2px;font-size:.76rem}
.assurance-strip span{display:flex;gap:5px;padding:5px 8px;border-radius:7px;background:var(--surface-2);color:var(--muted);font-family:ui-monospace,monospace;font-size:.68rem}
.assurance-strip b{color:var(--text);font-family:inherit}
.counts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin:0;border-top:1px solid var(--line);background:var(--surface-2)}
.count{min-width:0;padding:17px 21px;border-right:1px solid var(--line)}
.count:last-child{border-right:0}
.count dt{color:var(--muted);font-size:.74rem;font-weight:700}
.count dd{margin:5px 0 0;font-size:1.45rem;font-weight:800;font-variant-numeric:tabular-nums}
.count-pass dd{color:var(--pass)}
.count-fail dd{color:var(--fail)}
.count-blocked dd{color:var(--blocked)}
.count-incomplete dd{color:var(--incomplete)}
.jump-nav{position:sticky;top:10px;z-index:20;display:flex;gap:3px;width:max-content;max-width:100%;margin:16px auto 0;padding:5px;border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--surface) 91%,transparent);box-shadow:0 8px 24px rgba(28,39,60,.1);backdrop-filter:blur(14px)}
.jump-nav a{min-height:39px;display:flex;align-items:center;padding:0 14px;border-radius:9px;color:var(--muted);font-size:.8rem;font-weight:720;text-decoration:none;white-space:nowrap}
.jump-nav a:hover{color:var(--primary);background:var(--primary-soft)}
.panel{margin-top:20px;padding:28px 30px;border-radius:20px;scroll-margin-top:76px}
.section-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:20px}
.section-header h2{margin:0;font-size:1.22rem;letter-spacing:-.025em;text-wrap:balance}
.section-header p{max-width:680px;margin:5px 0 0;color:var(--muted);font-size:.88rem;line-height:1.55;text-wrap:pretty}
.section-count{flex:0 0 auto;min-width:34px;height:28px;display:grid;place-items:center;padding:0 9px;border-radius:999px;background:var(--surface-3);font-size:.76rem;font-weight:800;font-variant-numeric:tabular-nums}
.attention-banner{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:14px;margin-top:20px;padding:17px 20px;border-radius:16px;scroll-margin-top:76px}
.attention-banner .status-icon{color:var(--pass);background:var(--pass-soft)}
.attention-banner h2{margin:0;font-size:.96rem}
.attention-banner p{margin:3px 0 0;color:var(--muted);font-size:.8rem}
.attention-panel{border-top:3px solid var(--blocked)}
.empty-state{display:flex;align-items:center;justify-content:center;gap:12px;min-height:86px;padding:18px;border:1px dashed var(--line-strong);border-radius:13px;background:var(--surface-2);color:var(--muted);text-align:left}
.empty-state strong{color:var(--text)}
.empty-state p{margin:3px 0 0;font-size:.78rem}
.findings{display:grid;gap:11px}
.finding{--finding-state:var(--incomplete);overflow:hidden;border:1px solid var(--line);border-left:4px solid var(--finding-state);border-radius:15px;background:var(--surface);box-shadow:0 1px 2px rgba(16,24,40,.04)}
.finding.status-pass{--finding-state:var(--pass)}
.finding.status-fail{--finding-state:var(--fail)}
.finding.status-blocked{--finding-state:var(--blocked)}
.finding.status-incomplete{--finding-state:var(--incomplete)}
.finding>summary{list-style:none}
.finding>summary::-webkit-details-marker{display:none}
.finding-header{display:grid;grid-template-columns:36px minmax(0,1fr) 28px;align-items:center;gap:12px;min-height:78px;padding:13px 16px;cursor:pointer;user-select:none}
.finding-header:hover{background:var(--surface-2)}
.finding-header:focus-visible{outline:3px solid var(--primary);outline-offset:-3px}
.status-icon{width:30px;height:30px;display:grid;place-items:center;border-radius:9px;background:var(--surface-3);color:var(--finding-state)}
.status-icon svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.finding-title{min-width:0;display:grid;gap:5px}
.finding-badges{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:.63rem;font-weight:820;letter-spacing:.055em;text-transform:uppercase}
.finding-badges .status{color:var(--finding-state)}
.finding-id{font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;font-size:.8rem;font-weight:800;overflow-wrap:anywhere}
.finding-peek{color:var(--muted);font-size:.8rem;line-height:1.45;overflow-wrap:anywhere}
.finding[open] .finding-peek{display:none}
.disclosure{width:26px;height:26px;display:grid;place-items:center;color:var(--muted);transition:transform 160ms}
.disclosure svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.finding[open] .disclosure{transform:rotate(180deg)}
.finding-body{padding:18px 20px 20px;border-top:1px solid var(--line);background:var(--surface-2)}
.finding-summary{margin:0;color:var(--text);font-size:.9rem;line-height:1.6}
.finding-body h4{margin:18px 0 8px;color:var(--muted);font-size:.69rem;letter-spacing:.07em;text-transform:uppercase}
.expected-list{margin:0;padding-left:20px;color:var(--muted);font-size:.84rem;line-height:1.55}
.expected-list li+li{margin-top:5px}
.rejected{margin:16px 0 0;padding:12px;border-radius:10px;background:var(--fail-soft);color:var(--fail);font-size:.82rem;line-height:1.5}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:16px 0 0;color:var(--muted);font-size:.72rem}
.meta code{overflow-wrap:anywhere}
.previews{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:18px}
.previews figure{margin:0;padding:10px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
.previews img{display:block;width:100%;height:auto;border-radius:8px}
.previews figcaption{margin-top:7px;color:var(--muted);font-family:ui-monospace,monospace;font-size:.68rem}
.coverage-table{width:100%;border-collapse:collapse}
.coverage-table th,.coverage-table td{padding:16px 10px;border-top:1px solid var(--line);text-align:left;vertical-align:top}
.coverage-table thead th{padding-top:0;border-top:0;color:var(--muted);font-size:.7rem;letter-spacing:.055em;text-transform:uppercase}
.coverage-table tbody th{width:42%;font-size:.82rem}
.coverage-table progress{display:block;width:min(330px,100%);height:9px;margin-top:10px;accent-color:var(--primary)}
.coverage-table progress::-webkit-progress-bar{background:var(--surface-3);border-radius:999px}
.coverage-table progress::-webkit-progress-value{background:var(--primary);border-radius:999px}
.coverage-table td{font-size:.82rem}
.coverage-table td strong{font-variant-numeric:tabular-nums}
.percentage{margin-left:8px;color:var(--muted);font-size:.74rem}
.coverage-table tbody td:last-child{color:var(--muted);overflow-wrap:anywhere}
.coverage-na progress{opacity:.35}
.coverage-na .percentage{font-style:italic}
.technical-trace{margin-top:20px;border-radius:16px;scroll-margin-top:76px}
.technical-trace summary{display:flex;align-items:center;justify-content:space-between;min-height:52px;padding:0 18px;cursor:pointer;font-size:.86rem;font-weight:760;list-style:none}
.technical-trace summary::-webkit-details-marker{display:none}
.technical-trace summary::after{content:"+";color:var(--muted);font-size:1.2rem}
.technical-trace[open] summary::after{content:"−"}
.technical-trace summary:focus-visible{outline:3px solid var(--primary);outline-offset:-3px}
.technical-trace-content{padding:0 18px 18px;border-top:1px solid var(--line)}
.technical-trace-content>p{color:var(--muted);font-size:.8rem;line-height:1.5}
.technical-trace dl{display:grid;grid-template-columns:180px minmax(0,1fr);gap:10px 16px;margin:16px 0 0}
.technical-trace dt{color:var(--muted);font-size:.75rem;font-weight:700}
.technical-trace dd{min-width:0;margin:0;font-family:ui-monospace,monospace;font-size:.75rem;overflow-wrap:anywhere}
.notice{max-width:880px;margin:22px auto 0;padding:13px 16px;border-radius:11px;background:var(--surface-3);color:var(--muted);font-size:.74rem;line-height:1.5;text-align:center}
.project-support{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:18px 0 0;padding:16px 18px;border:1px solid var(--line);border-radius:13px;background:var(--surface)}
.project-support h2{margin:0;font-size:.86rem}
.project-support p{margin:4px 0 0;color:var(--muted);font-size:.78rem}
.project-support a{flex:0 0 auto;padding:8px 11px;border:1px solid var(--line);border-radius:8px;color:var(--primary);font-size:.76rem;font-weight:750;text-decoration:none}
.project-support a:hover{text-decoration:underline}
:focus-visible{outline:3px solid var(--primary);outline-offset:3px}
@media(prefers-color-scheme:dark){
  :root{
    --canvas:#0c121a;
    --surface:#161e29;
    --surface-2:#111822;
    --surface-3:#222c3a;
    --text:#eef3f9;
    --muted:#a8b4c4;
    --faint:#8794a6;
    --line:#334052;
    --line-strong:#526176;
    --primary:#88adff;
    --primary-soft:#1d3158;
    --pass:#55d995;
    --pass-soft:#123a2a;
    --fail:#ff8a80;
    --fail-soft:#49201f;
    --blocked:#ffbd6a;
    --blocked-soft:#493018;
    --incomplete:#c1c9d5;
    --incomplete-soft:#303947;
    --shadow:0 1px 2px rgba(0,0,0,.25),0 18px 44px rgba(0,0,0,.28);
  }
  body{background:radial-gradient(circle at 50% -12rem,#182b50 0,transparent 40rem),var(--canvas)}
  .language-switcher,.jump-nav{box-shadow:0 8px 28px rgba(0,0,0,.22)}
}
@media(max-width:900px){
  .summary-main{grid-template-columns:1fr;gap:20px;padding:30px}
  .verdict{justify-self:start;grid-template-columns:auto auto;align-items:center;justify-items:start;gap:0 10px;min-width:0;padding:12px 15px;text-align:left}
  .verdict-icon{grid-row:1/3;margin:0}
  .verdict span{margin:0}
  .visualization-grid{grid-template-columns:1fr;padding:18px 22px}
  .flow{grid-template-columns:1fr;gap:0;margin-top:18px}
  .flow-step{grid-template-columns:32px minmax(0,1fr);justify-items:start;align-items:center;gap:10px;padding:6px 0;text-align:left}
  .flow-step:not(:last-child)::after{top:34px;left:13px;width:2px;height:18px}
  .flow-step-copy{gap:2px}
  .counts{grid-template-columns:repeat(3,minmax(0,1fr))}
  .count:nth-child(3){border-right:0}
  .count:nth-child(n+4){border-top:1px solid var(--line)}
}
@media(max-width:640px){
  .shell{padding:0 16px 52px}
  .topbar{min-height:62px;align-items:flex-start;padding-top:13px}
  .brand{font-size:.86rem}
  .language-switcher{max-width:58vw;overflow-x:auto}
  .language-switcher a{min-height:34px;padding:0 9px;font-size:.72rem}
  .summary-main{padding:25px 22px 22px}
  .summary-card h1{font-size:1.72rem}
  .visualization-grid{padding:15px}
  .health-layout{grid-template-columns:94px minmax(0,1fr);gap:14px}
  .health-ring{width:88px;height:88px}
  .health-ring::after{inset:8px}
  .assurance-strip{padding:12px 16px}
  .counts{grid-template-columns:repeat(2,minmax(0,1fr))}
  .count{padding:14px 16px}
  .count:nth-child(2n){border-right:0}
  .count:nth-child(n+3){border-top:1px solid var(--line)}
  .count:first-child{grid-column:1/-1;border-right:0}
  .jump-nav{width:100%;justify-content:flex-start;overflow-x:auto;margin-top:12px}
  .jump-nav a{min-height:36px;padding:0 11px;font-size:.75rem}
  .panel{padding:22px 18px}
  .section-header{margin-bottom:16px}
  .attention-banner{grid-template-columns:auto minmax(0,1fr);padding:15px 16px}
  .attention-banner .section-count{display:none}
  .finding-header{grid-template-columns:34px minmax(0,1fr) 24px;padding:12px}
  .finding-body{padding:16px}
  .coverage-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .coverage-table,.coverage-table tbody,.coverage-table tr,.coverage-table th,.coverage-table td{display:block;width:100%}
  .coverage-table tr{padding:14px 0;border-top:1px solid var(--line)}
  .coverage-table tbody tr:first-child{border-top:0}
  .coverage-table th,.coverage-table td{padding:4px 0;border:0}
  .coverage-table tbody td::before{content:attr(data-label);display:block;margin-bottom:3px;color:var(--muted);font-size:.67rem;font-weight:750;letter-spacing:.05em;text-transform:uppercase}
  .technical-trace dl{grid-template-columns:1fr;gap:4px}
  .technical-trace dd+dt{margin-top:8px}
  .project-support{align-items:flex-start;flex-direction:column}
}
@media(prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  *,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}
}
@media(prefers-contrast:more){
  :root{--line:var(--line-strong)}
  .summary-card,.panel,.technical-trace,.attention-banner,.finding{box-shadow:none}
}
@media(forced-colors:active){
  .summary-card,.panel,.technical-trace,.attention-banner,.finding,.language-switcher,.jump-nav{border:1px solid CanvasText}
  .summary-card{border-top-width:4px}
  .status-icon,.verdict-icon,.flow-node{forced-color-adjust:none}
}
`;

export function renderQaBoardHtml(view: QaBoardView, locale: QaBoardLocale = "en", options: QaBoardRenderOptions = {}): string {
  const copy = BOARD_COPY[locale];
  const projectSupportHtml = options.showProjectSupport
    ? `<aside class="project-support" aria-labelledby="project-support-title"><div><h2 id="project-support-title">${copy.projectSupportTitle}</h2><p>${copy.projectSupportDescription}</p></div><a href="https://github.com/Jin-Doh/traceknot" target="_blank" rel="noopener noreferrer">${copy.projectSupportAction}</a></aside>`
    : "";
  const attention = view.findings.filter(item => item.status !== "PASS");
  const coverageRows = COVERAGE_KEYS.map(name => {
    const value = view.coverage[name];
    const percent = visualPercent(value.covered, value.total);
    const label = coverageLabel(name, locale);
    const percentageLabel = percent === undefined ? copy.notApplicable : `${percent}%`;
    return `<tr class="${percent === undefined ? "coverage-na" : ""}"><th scope="row"><span>${escapeHtml(label)}</span><progress max="100" value="${percent ?? 0}" aria-label="${escapeHtml(label)}: ${escapeHtml(percentageLabel)}"></progress></th><td data-label="${copy.covered}"><strong>${value.covered} / ${value.total}</strong><span class="percentage">${escapeHtml(percentageLabel)}</span></td><td data-label="${copy.uncoveredIds}">${escapeHtml(value.uncoveredIds.join(", ") || "—")}</td></tr>`;
  }).join("");
  const allFindings = view.findings.map(item => findingHtml(item, locale)).join("") || `<div class="empty-state"><strong>${copy.noChecks}</strong></div>`;
  const attentionSection = attention.length === 0
    ? `<section class="attention-banner status-pass" id="attention" aria-labelledby="attention-title"><span class="status-icon">${statusIcon("PASS")}</span><div><h2 id="attention-title">${copy.noAttention}</h2><p>${copy.noAttentionDescription}</p></div><span class="section-count">0</span></section>`
    : `<section class="panel attention-panel" id="attention"><div class="section-header"><div><h2>${copy.attention}</h2><p>${copy.attentionDescription}</p></div><span class="section-count">${attention.length}</span></div><div class="findings">${attention.map(item => findingHtml(item, locale)).join("")}</div></section>`;
  const labels: Readonly<Record<QaBoardLocale, string>> = { en: "English", ko: "한국어", "zh-CN": "简体中文" };
  const languageLinks = QA_BOARD_LOCALES.map(item => `<a href="index.${item}.html" lang="${item}" hreflang="${item}"${item === locale ? ' aria-current="page"' : ""}>${labels[item]}</a>`).join("");
  const alternateLinks = QA_BOARD_LOCALES.map(item => `<link rel="alternate" hreflang="${item}" href="index.${item}.html">`).join("\n");
  const verdictTone = view.verdict === "PASS" ? "pass" : view.verdict === "PASS_WITH_ACCEPTED_RISK" ? "risk" : view.verdict.toLowerCase();
  const verdictStatus: BoardFindingStatus = view.verdict === "PASS_WITH_ACCEPTED_RISK" ? "PASS" : view.verdict;
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
${alternateLinks}
<title>${copy.documentTitle} · ${escapeHtml(view.runId)}</title>
<style>${BOARD_STYLES}</style>
</head>
<body>
<a class="skip-link" href="#main">${copy.overview}</a>
<div class="shell">
<header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">${TRACEKNOT_MARK_SVG}</span><span>${copy.documentTitle}</span></div><nav class="language-switcher" aria-label="${copy.language}"><span>${copy.language}</span>${languageLinks}</nav></header>
<main id="main">
<section class="summary-card summary-${verdictTone}" id="overview" aria-labelledby="report-title">
<div class="summary-main"><div><p class="eyebrow">${copy.reportLabel} · ${copy.revision} ${view.revision}</p><h1 id="report-title">${escapeHtml(view.changeSummary)}</h1><p class="outcome-title">${copy.outcomes[view.verdict]}</p><p class="rationale"><strong>${copy.verdictRationale}:</strong> ${escapeHtml(view.rationale)}</p><div class="summary-meta"><span><strong>${copy.run}</strong> ${escapeHtml(view.runId)}</span><span><strong>${copy.snapshot}</strong> <code title="${escapeHtml(view.snapshotId)}">${escapeHtml(short(view.snapshotId))}</code></span><span><strong>${copy.updated}</strong> <time datetime="${escapeHtml(view.sourceUpdatedAt)}">${escapeHtml(view.sourceUpdatedAt)}</time></span></div></div><div class="verdict verdict-${verdictTone}" role="status"><span class="verdict-icon">${statusIcon(verdictStatus)}</span><strong>${escapeHtml(view.verdict)}</strong><span>${copy.status[verdictStatus]}</span></div></div>
${visualizationHtml(view, locale)}
<div class="summary-footer"><section class="assurance-strip" aria-label="${copy.assurance}"><strong>${copy.assurance}</strong><span><b>${copy.assuranceContext}</b>${escapeHtml(view.assurance.context)}</span><span><b>${copy.requiredIndependence}</b>${escapeHtml(view.assurance.requiredIndependence)}</span><span><b>${copy.releaseStatus}</b>${escapeHtml(view.assurance.releaseStatus)}</span></section><dl class="counts"><div class="count"><dt>${copy.mandatory}</dt><dd>${view.counts.mandatory}</dd></div><div class="count count-pass"><dt>${copy.passed}</dt><dd>${view.counts.passed}</dd></div><div class="count count-fail"><dt>${copy.failed}</dt><dd>${view.counts.failed}</dd></div><div class="count count-blocked"><dt>${copy.blocked}</dt><dd>${view.counts.blocked}</dd></div><div class="count count-incomplete"><dt>${copy.incomplete}</dt><dd>${view.counts.incomplete}</dd></div></dl></div>
</section>
<nav class="jump-nav" aria-label="${copy.jumpNavigation}"><a href="#overview">${copy.overview}</a><a href="#attention">${copy.attention}</a><a href="#checks">${copy.checks}</a><a href="#coverage">${copy.coverage}</a></nav>
${attentionSection}
<section class="panel" id="checks"><div class="section-header"><div><h2>${copy.checks}</h2><p>${copy.checksDescription}</p></div><span class="section-count">${view.findings.length}</span></div><div class="findings">${allFindings}</div></section>
<section class="panel" id="coverage"><div class="section-header"><div><h2>${copy.coverage}</h2><p>${copy.coverageDescription}</p></div></div><table class="coverage-table"><thead><tr><th scope="col">${copy.area}</th><th scope="col">${copy.covered}</th><th scope="col">${copy.uncoveredIds}</th></tr></thead><tbody>${coverageRows}</tbody></table></section>
<details class="technical-trace" id="trace"><summary>${copy.technicalTrace}</summary><div class="technical-trace-content"><p>${copy.technicalTraceDescription}</p><dl><dt>${copy.request}</dt><dd>${escapeHtml(view.requestId)}</dd><dt>${copy.repositoryIdentity}</dt><dd>${escapeHtml(view.rootIdentity)}</dd><dt>${copy.snapshot}</dt><dd>${escapeHtml(view.snapshotId)}</dd><dt>${copy.runState}</dt><dd>${escapeHtml(view.sourceState)}</dd><dt>${copy.openDefects}</dt><dd>${escapeHtml(view.openDefectIds.join(", ") || copy.none)}</dd><dt>${copy.acceptedRisks}</dt><dd>${escapeHtml(view.acceptedRiskIds.join(", ") || copy.none)}</dd></dl></div></details>
<p class="notice">${copy.readOnlyNotice}</p>
${projectSupportHtml}
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
