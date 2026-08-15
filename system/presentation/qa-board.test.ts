import { describe, expect, test } from "bun:test";
import type { EvidenceEvaluation, Observation } from "../core/qa-core";
import type { BoardSource } from "./qa-board";
import { buildQaBoardView, renderQaBoardHtml, sessionReference, sha256 } from "./qa-board";

const SNAPSHOT = "snapshot-1";
const REQUEST = "request-1";
const OBSERVATION_ID = "observation:checkout";
const CLAIM_ID = "claim:checkout";
const EVALUATION_ID = "evaluation:checkout";
const SCREENSHOT = "a".repeat(64);

function source(overrides: Partial<BoardSource> = {}): BoardSource {
  const observation: Observation = {
    schemaVersion: "observation/v1",
    observationId: OBSERVATION_ID,
    requestId: REQUEST,
    snapshotId: SNAPSHOT,
    producer: { kind: "ci", identity: "fixture-ci", independence: "independent-producer" },
    execution: { kind: "browser", identity: "fixture-browser", startedAt: "2026-08-15T00:00:00Z", finishedAt: "2026-08-15T00:00:01Z", exitStatus: "passed" },
    artifacts: [{ type: "screenshot", digest: SCREENSHOT, path: "/tmp/checkout.png" }],
  };
  const evaluation: EvidenceEvaluation = {
    schemaVersion: "evidence-evaluation/v1",
    evaluationId: EVALUATION_ID,
    requestId: REQUEST,
    snapshotId: SNAPSHOT,
    claimId: CLAIM_ID,
    status: "ACCEPTED",
    checks: { snapshotBound: true, fresh: true, scopeComplete: true, producerAllowed: true, independenceSatisfied: true, artifactRequirementsSatisfied: true, expectedResultDemonstrated: true, expectedResultViolated: false, integrityVerified: true },
    rejectionReasons: [],
    evaluatedAt: "2026-08-15T00:00:02Z",
  };
  const base: BoardSource = {
    run: { schemaVersion: "verification-run/v1", runId: "run-1", requestId: REQUEST, rootIdentity: "root-1", snapshotId: SNAPSHOT, state: "TERMINAL", observationIds: [OBSERVATION_ID], claimIds: [CLAIM_ID], evaluationIds: [EVALUATION_ID], revision: 9, createdAt: "2026-08-15T00:00:00Z", updatedAt: "2026-08-15T00:00:03Z" },
    verdict: { schemaVersion: "qa-verdict/v1", requestId: REQUEST, snapshotId: SNAPSHOT, qaVerdict: "PASS", authoritative: false, obligationSummary: { mandatory: 1, passed: 1, failed: 0, blocked: 0, incomplete: 0 }, coverage: { basis: { total: 1, covered: 1, uncoveredIds: [] }, risks: { total: 1, covered: 1, uncoveredIds: [] }, conditions: { total: 1, covered: 1, uncoveredIds: [] }, mandatoryObligations: { total: 1, covered: 1, uncoveredIds: [] } }, openDefectIds: [], acceptedRiskIds: [], residualRisks: [], rationale: "All mandatory obligations passed." },
    documents: {
      request: { schemaVersion: "verification-request/v1", requestId: REQUEST, project: { rootIdentity: "root-1", snapshotId: SNAPSHOT }, change: { summary: "Checkout responsive update", paths: ["src/checkout.tsx"] }, testBasis: [{ id: "basis:checkout", kind: "acceptance-criterion", origin: "explicit", text: "Submit remains visible." }] },
      plan: { schemaVersion: "verification-plan/v1", requestId: REQUEST, snapshotId: SNAPSHOT, risks: [], conditions: [{ id: "condition:checkout", basisIds: ["basis:checkout"], riskIds: [], techniques: ["browser"], expectedResult: "Submit remains visible." }], obligations: [{ id: "obligation:checkout", conditionIds: ["condition:checkout"], evidenceType: "browser-result", mandatory: true, independence: "independent-producer", entryCriteria: [], completionCriteria: [] }] },
      execution: { schemaVersion: "verification-execution/v1", requestId: REQUEST, snapshotId: SNAPSHOT, observations: [observation], claims: [{ schemaVersion: "evidence-claim/v1", claimId: CLAIM_ID, requestId: REQUEST, snapshotId: SNAPSHOT, obligationId: "obligation:checkout", criterionId: "criterion:obligation:checkout", observationIds: [OBSERVATION_ID], claim: "Submit remained visible." }], evidence: [{ schemaVersion: "verification-evidence/v1", evidenceId: "evidence:checkout", requestId: REQUEST, snapshotId: SNAPSHOT, obligationId: "obligation:checkout", producer: observation.producer, execution: observation.execution, result: { verdict: "PASS", summary: "Submit remained visible.", passed: 1, artifacts: [SCREENSHOT] }, observedAt: "2026-08-15T00:00:01Z" }], authorities: [], usageOutbox: [] },
      evidence: { schemaVersion: "verification-evidence-evaluation/v1", requestId: REQUEST, snapshotId: SNAPSHOT, freshnessEvaluatedAt: "2026-08-15T00:00:02Z", freshnessAuthority: { schemaVersion: "verification-freshness-authority/v1", authorityId: "freshness:fixture", issuer: "fixture", binding: { schemaVersion: "verification-freshness-binding/v1", requestId: REQUEST, snapshotId: SNAPSHOT, planDigest: "b".repeat(64), executionDigest: "c".repeat(64), freshnessEvaluatedAt: "2026-08-15T00:00:02Z", evaluationIds: [EVALUATION_ID], evaluationsDigest: "d".repeat(64), acceptedClaimIds: [CLAIM_ID], coverage: { basisIds: ["basis:checkout"], coveredBasisIds: ["basis:checkout"], riskIds: [], coveredRiskIds: [], conditionIds: ["condition:checkout"], coveredConditionIds: ["condition:checkout"] } } }, evaluations: [evaluation], acceptedClaimIds: [CLAIM_ID], coverage: { basisIds: ["basis:checkout"], coveredBasisIds: ["basis:checkout"], riskIds: [], coveredRiskIds: [], conditionIds: ["condition:checkout"], coveredConditionIds: ["condition:checkout"] } },
    },
  };
  return { ...base, ...overrides, documents: { ...base.documents, ...(overrides.documents ?? {}) } };
}

describe("QA Board projection", () => {
  test("uses persisted verdict counts and creates screenshot references", () => {
    const view = buildQaBoardView(source());
    expect(view.changeSummary).toBe("Checkout responsive update");
    expect(view.counts).toEqual({ mandatory: 1, passed: 1, failed: 0, blocked: 0, incomplete: 0 });
    expect(view.findings[0]).toMatchObject({ obligationId: "obligation:checkout", status: "PASS", expectedResults: ["Submit remains visible."] });
    expect(view.findings[0]?.screenshots).toEqual([{ digest: SCREENSHOT, observationId: OBSERVATION_ID }]);
  });

  test("sorts failures before blocked, incomplete, and pass", () => {
    const initial = source();
    const plan = initial.documents.plan!;
    const extraPlan = { ...plan, conditions: [...plan.conditions, { id: "condition:fail", basisIds: [], riskIds: [], techniques: [], expectedResult: "Failure is reported." }], obligations: [...plan.obligations, { ...plan.obligations[0]!, id: "obligation:fail", conditionIds: ["condition:fail"] }, { ...plan.obligations[0]!, id: "obligation:blocked", conditionIds: [], independence: "separate-verification-context" as const }] };
    const extraEvidence = [...initial.documents.execution!.evidence, { ...initial.documents.execution!.evidence[0]!, evidenceId: "evidence:fail", obligationId: "obligation:fail", result: { verdict: "FAIL" as const, summary: "Failure observed." } }, { ...initial.documents.execution!.evidence[0]!, evidenceId: "evidence:blocked", obligationId: "obligation:blocked", result: { verdict: "BLOCKED" as const, summary: "Browser unavailable." } }];
    const view = buildQaBoardView({ ...initial, documents: { ...initial.documents, plan: extraPlan, execution: { ...initial.documents.execution!, evidence: extraEvidence } } });
    expect(view.findings.map(item => item.obligationId)).toEqual(["obligation:fail", "obligation:blocked", "obligation:checkout"]);
  });

  test("escapes hostile content and emits a static local-only document", () => {
    const hostile = source({ documents: { ...source().documents, request: { ...source().documents.request!, change: { ...source().documents.request!.change, summary: "<script>alert('x')</script>" } } } });
    const html = renderQaBoardHtml(buildQaBoardView(hostile));
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).toContain("read-only projection");
  });

  test("is deterministic for the same source", () => {
    const first = renderQaBoardHtml(buildQaBoardView(source()));
    const second = renderQaBoardHtml(buildQaBoardView(source()));
    expect(first).toBe(second);
  });

  test("does not invent a pass when evidence is absent", () => {
    const initial = source();
    const documents = { ...initial.documents, execution: { ...initial.documents.execution!, evidence: [] } };
    const view = buildQaBoardView({ ...initial, documents });
    expect(view.findings[0]?.status).toBe("INCOMPLETE");
    expect(view.findings[0]?.summary).toBe("Verification evidence is unavailable.");
  });
});

describe("QA Board identity helpers", () => {
  test("hashes an optional session without persisting the raw value", () => {
    expect(sessionReference("omp", "session-1")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sessionReference("omp", undefined)).toBe("UNAVAILABLE");
    expect(sha256("session-1")).toMatch(/^[0-9a-f]{64}$/);
  });
});
