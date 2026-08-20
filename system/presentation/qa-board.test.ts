import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { EvidenceEvaluation, Observation } from "../core/qa-core";
import type { BoardSource } from "./qa-board";
import { buildQaBoardView, renderQaBoardHtml, resolveQaBoardLocale, sessionReference, sha256 } from "./qa-board";
import { detectQaBoardLocale, parseMacPreferredLanguages } from "./qa-board-locale";

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
    artifacts: [{ type: "screenshot", digest: SCREENSHOT, path: "/tmp/checkout.png" }, { type: "verification-result", digest: "b".repeat(64) }],
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
    expect(view.assurance).toEqual({ context: "release", requiredIndependence: "independent-producer", releaseStatus: "satisfied" });
  });
  test("resolves each evaluated finding without leaking sibling claims", () => {
    const initial = source();
    const plan = initial.documents.plan!;
    const execution = initial.documents.execution!;
    const evidence = initial.documents.evidence!;
    const siblingObservation = { ...execution.observations[0]!, observationId: "observation:sibling" };
    const siblingClaim = { ...execution.claims[0]!, claimId: "claim:sibling", obligationId: "obligation:sibling", criterionId: "criterion:obligation:sibling", observationIds: [siblingObservation.observationId] };
    const siblingEvaluation = { ...evidence.evaluations[0]!, evaluationId: "evaluation:sibling", claimId: siblingClaim.claimId, status: "REJECTED" as const, checks: { ...evidence.evaluations[0]!.checks, independenceSatisfied: false }, rejectionReasons: ["INDEPENDENCE_NOT_MET" as const] };
    const siblingCondition = { ...plan.conditions[0]!, id: "condition:sibling", expectedResult: "Sibling check passes." };
    const siblingObligation = { ...plan.obligations[0]!, id: "obligation:sibling", conditionIds: [siblingCondition.id] };
    const siblingEvidence = { ...execution.evidence[0]!, evidenceId: "evidence:sibling", obligationId: siblingObligation.id };
    const view = buildQaBoardView({
      ...initial,
      documents: {
        ...initial.documents,
        plan: { ...plan, conditions: [...plan.conditions, siblingCondition], obligations: [...plan.obligations, siblingObligation] },
        execution: { ...execution, observations: [...execution.observations, siblingObservation], claims: [...execution.claims, siblingClaim], evidence: [...execution.evidence, siblingEvidence] },
        evidence: { ...evidence, evaluations: [...evidence.evaluations, siblingEvaluation] },
      },
    });
    expect(view.findings.map(finding => [finding.obligationId, finding.status])).toEqual([
      ["obligation:sibling", "BLOCKED"],
      ["obligation:checkout", "PASS"],
    ]);
  });

  test("uses evaluated evidence status instead of raw executor verdict", () => {
    const initial = source();
    const evidence = initial.documents.evidence!;
    const evaluation = evidence.evaluations[0]!;
    const rejected = { ...evaluation, status: "REJECTED" as const, checks: { ...evaluation.checks, independenceSatisfied: false }, rejectionReasons: ["INDEPENDENCE_NOT_MET" as const] };
    const view = buildQaBoardView({
      ...initial,
      verdict: { ...initial.verdict, qaVerdict: "BLOCKED", obligationSummary: { mandatory: 1, passed: 0, failed: 0, blocked: 1, incomplete: 0 } },
      documents: { ...initial.documents, evidence: { ...evidence, evaluations: [rejected] } },
    });
    expect(view.findings[0]).toMatchObject({ status: "BLOCKED", evaluation: { status: "REJECTED", rejectionReasons: ["INDEPENDENCE_NOT_MET"] } });
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
    expect(html).not.toContain('src="http://');
    expect(html).not.toContain('href="http://');
    expect(html).not.toContain("https://");
    expect(html).toContain("read-only projection");
  });
  test("keeps optional project support outside verification output", () => {
    const view = buildQaBoardView(source());
    const withoutSupport = renderQaBoardHtml(view);
    const withSupport = renderQaBoardHtml(view, "en", { showProjectSupport: true });
    expect(withoutSupport).not.toContain("Project support");
    expect(withSupport).toContain("Project support");
    expect(withSupport).toContain('href="https://github.com/Jin-Doh/traceknot" target="_blank" rel="noopener noreferrer"');
    expect(withSupport).toContain("Star on GitHub");
    expect(withSupport).not.toContain("CONSIDER");
    expect(withSupport.match(/Project support/g)).toHaveLength(1);
  });

  test("is deterministic for the same source", () => {
    const first = renderQaBoardHtml(buildQaBoardView(source()));
    const second = renderQaBoardHtml(buildQaBoardView(source()));
    expect(first).toBe(second);
  });

  test("renders complete English, Korean, and Simplified Chinese views", () => {
    const view = buildQaBoardView(source());
    const english = renderQaBoardHtml(view, "en");
    const korean = renderQaBoardHtml(view, "ko");
    const chinese = renderQaBoardHtml(view, "zh-CN");
    expect(english).toContain('<html lang="en">');
    expect(english).toContain("All required checks passed");
    expect(korean).toContain('<html lang="ko">');
    expect(korean).toContain("필수 검증을 모두 통과했습니다");
    expect(korean).toContain("확인이 필요한 항목이 없습니다.");
    expect(chinese).toContain('<html lang="zh-CN">');
    expect(chinese).toContain("所有必需检查均已通过");
    expect(chinese).toContain("没有需要关注的检查项。");
    for (const html of [english, korean, chinese]) {
      expect(html).toContain('href="index.en.html"');
      expect(html).toContain('href="index.ko.html"');
      expect(html).toContain('href="index.zh-CN.html"');
    }
  });

  test("renders evidence-backed health, distribution, and flow visualizations", () => {
    const html = renderQaBoardHtml(buildQaBoardView(source()));
    expect(html).toContain('class="health-ring tone-complete"');
    expect(html).toContain('style="--health:100%"');
    expect(html).toContain('class="distribution-segment segment-pass"');
    expect(html).toContain('class="flow" role="list"');
    expect(html).toContain('<details class="finding status-pass">');
    expect(html).toContain(".finding[open] .disclosure");
  });

  test("keeps the verification flow fully visible and responsive", () => {
    const html = renderQaBoardHtml(buildQaBoardView(source()));
    expect(html).toContain("grid-template-columns:repeat(6,minmax(0,1fr))");
    expect(html).toContain(".flow-step:not(:last-child)::after");
    expect(html).toContain("@media(max-width:900px)");
  });

  test("keeps verification flow order independent of coverage object insertion order", () => {
    const initial = source();
    const coverage = initial.verdict.coverage;
    const permutedCoverage = {
      mandatoryObligations: coverage.mandatoryObligations,
      conditions: coverage.conditions,
      risks: coverage.risks,
      basis: coverage.basis,
    };
    const html = renderQaBoardHtml(buildQaBoardView({
      ...initial,
      verdict: { ...initial.verdict, coverage: permutedCoverage },
    }));
    const flow = html.slice(html.indexOf('<div class="flow"'));
    const labels = ["Test basis", "Risks", "Conditions", "Mandatory checks", "Accepted evidence"];
    const positions = labels.map(label => flow.indexOf(`<strong>${label}</strong>`));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  test("labels zero-total coverage as not applicable without invalid percentages", () => {
    const initial = source();
    const html = renderQaBoardHtml(buildQaBoardView({
      ...initial,
      verdict: {
        ...initial.verdict,
        obligationSummary: { mandatory: 0, passed: 0, failed: 0, blocked: 0, incomplete: 0 },
        coverage: {
          basis: { total: 0, covered: 0, uncoveredIds: [] },
          risks: { total: 0, covered: 0, uncoveredIds: [] },
          conditions: { total: 0, covered: 0, uncoveredIds: [] },
          mandatoryObligations: { total: 0, covered: 0, uncoveredIds: [] },
        },
      },
    }));
    expect(html).toContain("Not applicable");
    expect(html).toContain('style="--health:0%"');
    expect(html).not.toContain("NaN");
  });

  test("resolves locale preferences in order with a stable English fallback", () => {
    expect(resolveQaBoardLocale("ko_KR.UTF-8", "en-US")).toBe("ko");
    expect(resolveQaBoardLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(resolveQaBoardLocale("fr-FR", "en_GB")).toBe("en");
    expect(resolveQaBoardLocale(undefined, "fr-FR")).toBe("en");
  });

  test("selects the default locale from explicit and platform preferences", () => {
    expect(detectQaBoardLocale({
      env: { LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" },
      platform: "darwin",
      preferredLanguages: ["ko-KR", "en-US"],
      runtimeLocale: "ko-KR",
    })).toBe("en");
    expect(detectQaBoardLocale({
      env: { LANG: "en_US.UTF-8" },
      platform: "darwin",
      preferredLanguages: ["ko-KR", "en-US"],
      runtimeLocale: "en-US",
    })).toBe("ko");
    expect(detectQaBoardLocale({
      env: { LANGUAGE: "zh_CN:en_US", LANG: "en_US.UTF-8" },
      platform: "linux",
      preferredLanguages: [],
      runtimeLocale: "en-US",
    })).toBe("zh-CN");
    expect(detectQaBoardLocale({
      env: { LANG: "C.UTF-8" },
      platform: "linux",
      preferredLanguages: [],
      runtimeLocale: "ko-KR",
    })).toBe("ko");
  });

  test("parses macOS AppleLanguages output without shell evaluation", () => {
    expect(parseMacPreferredLanguages('(\n    "ko-KR",\n    "en-KR"\n)')).toEqual(["ko-KR", "en-KR"]);
    expect(parseMacPreferredLanguages("ko_KR")).toEqual(["ko_KR"]);
  });

  test("uses native disclosure for detail while keeping failures open", () => {
    const passView = buildQaBoardView(source());
    const passHtml = renderQaBoardHtml(passView);
    expect(passHtml).toContain('<details class="finding status-pass">');
    expect(passHtml).not.toContain('<details class="finding status-pass" open>');
    const blockedHtml = renderQaBoardHtml({
      ...passView,
      verdict: "BLOCKED",
      counts: { mandatory: 1, passed: 0, failed: 0, blocked: 1, incomplete: 0 },
      findings: [{ ...passView.findings[0]!, status: "BLOCKED" as const }],
    });
    expect(blockedHtml).toContain('<details class="finding status-blocked" open>');
    expect(blockedHtml).not.toContain("<script");
  });

  test("embeds the official Traceknot mark without altering its SVG", () => {
    const html = renderQaBoardHtml(buildQaBoardView(source()));
    const officialLogo = readFileSync(new URL("../../assets/traceknot-mark.svg", import.meta.url), "utf8");
    expect(html).toContain(officialLogo);
    expect(html).not.toContain(">TK</span>");
  });

  test("publishes keyboard, contrast, and reduced-motion affordances", () => {
    const html = renderQaBoardHtml(buildQaBoardView(source()));
    expect(html).toContain('class="skip-link"');
    expect(html).toContain(".finding-header:focus-visible");
    expect(html).toContain("@media(prefers-reduced-motion:reduce)");
    expect(html).toContain("@media(forced-colors:active)");
  });
  test("emits mobile-safe wrapping and labeled coverage rows", () => {
    const initial = source();
    const html = renderQaBoardHtml(buildQaBoardView({
      ...initial,
      run: { ...initial.run, rootIdentity: `/private/tmp/${"long-repository-path-".repeat(12)}` },
    }));
    expect(html).toContain(".technical-trace dd");
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain(".coverage-table tbody td::before");
    expect(html).toContain('data-label="Covered"');
    expect(html).toContain('data-label="Uncovered IDs"');
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
