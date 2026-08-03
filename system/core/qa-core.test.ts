import { describe, expect, test } from "bun:test";
import {
  evaluateEvidence,
  resolveObligationOutcome,
  resolveQaVerdict,
  type DefectSummary,
  type EvidenceClaim,
  type EvidenceEvaluation,
  type EvidenceRejectionReason,
  type IndependenceLevel,
  type Observation,
  type SuccessCriterion,
  type VerdictInput,
  type VerificationObligation,
} from "./qa-core";

const REQUEST_ID = "request-1";
const SNAPSHOT_ID = "snapshot-1";
const EVALUATED_AT = "2026-07-22T00:00:00.000Z";
const LOG_DIGEST = "a".repeat(64);

type EntryOptions = {
  obligationId?: string;
  criterionId?: string;
  observationId?: string;
  claimId?: string;
  snapshotId?: string;
  observationSnapshotId?: string;
  exitStatus?: Observation["execution"]["exitStatus"];
  independence?: IndependenceLevel;
  artifacts?: Observation["artifacts"];
  evaluation?: "accepted" | "rejected" | "none";
  checks?: Partial<EvidenceEvaluation["checks"]>;
  rejectionReasons?: EvidenceRejectionReason[];
};

type Entry = {
  obligation: VerificationObligation;
  criterion: SuccessCriterion;
  observation: Observation;
  claim: EvidenceClaim;
  evaluation?: EvidenceEvaluation;
};

const allChecks = (overrides: Partial<EvidenceEvaluation["checks"]> = {}): EvidenceEvaluation["checks"] => ({
  snapshotBound: true,
  fresh: true,
  scopeComplete: true,
  producerAllowed: true,
  independenceSatisfied: true,
  expectedResultDemonstrated: true,
  integrityVerified: true,
  ...overrides,
});

const makeEntry = (options: EntryOptions = {}): Entry => {
  const obligationId = options.obligationId ?? "obligation-1";
  const criterionId = options.criterionId ?? "criterion-1";
  const observationId = options.observationId ?? "observation-1";
  const claimId = options.claimId ?? "claim-1";
  const snapshotId = options.snapshotId ?? SNAPSHOT_ID;
  const observationSnapshotId = options.observationSnapshotId ?? snapshotId;
  const evaluationKind = options.evaluation ?? "accepted";
  const evaluationReasons = options.rejectionReasons ?? [];

  const criterion: SuccessCriterion = {
    schemaVersion: "success-criterion/v1",
    criterionId,
    kind: "structured-assertion",
    expected: {
      assertions: [{ field: "execution.exitStatus", operator: "equals", value: "passed" }],
    },
    requiredScope: { kind: "repository-canonical", selectors: ["system/core/qa-core.test.ts"] },
    requiredIndependence: "independent-producer",
    requiredArtifacts: ["log"],
  };
  const obligation: VerificationObligation = {
    id: obligationId,
    mandatory: true,
    criterionIds: [criterionId],
    requiredIndependence: "independent-producer",
  };
  const observation: Observation = {
    schemaVersion: "observation/v1",
    observationId,
    requestId: REQUEST_ID,
    snapshotId: observationSnapshotId,
    producer: {
      kind: "ci",
      identity: "traceknot-ci",
      independence: options.independence ?? "independent-producer",
    },
    execution: {
      kind: "command",
      identity: "bun test system/core/qa-core.test.ts",
      startedAt: "2026-07-22T00:00:00.000Z",
      finishedAt: "2026-07-22T00:00:01.000Z",
      exitStatus: options.exitStatus ?? "passed",
      exitCode: options.exitStatus === "failed" ? 1 : 0,
    },
    artifacts: options.artifacts ?? [{ type: "log", digest: LOG_DIGEST, path: "artifacts/qa-core.log" }],
  };
  const claim: EvidenceClaim = {
    schemaVersion: "evidence-claim/v1",
    claimId,
    requestId: REQUEST_ID,
    snapshotId,
    obligationId,
    criterionId,
    observationIds: [observationId],
    claim: "The required canonical QA assertion passed.",
  };
  const evaluation =
    evaluationKind === "none"
      ? undefined
      : ({
          schemaVersion: "evidence-evaluation/v1",
          evaluationId: `evaluation-${claimId}`,
          requestId: REQUEST_ID,
          snapshotId,
          claimId,
          status: evaluationKind === "accepted" ? "ACCEPTED" : "REJECTED",
          checks: allChecks(options.checks),
          rejectionReasons: evaluationReasons,
          evaluatedAt: EVALUATED_AT,
        } satisfies EvidenceEvaluation);

  return { obligation, criterion, observation, claim, evaluation };
};

const graph = (...entries: Entry[]): VerdictInput => ({
  requestId: REQUEST_ID,
  snapshotId: SNAPSHOT_ID,
  evaluatedAt: EVALUATED_AT,
  obligations: entries.map(entry => entry.obligation),
  criteria: entries.map(entry => entry.criterion),
  observations: entries.map(entry => entry.observation),
  claims: entries.map(entry => entry.claim),
  evaluations: entries.flatMap(entry => (entry.evaluation ? [entry.evaluation] : [])),
  defects: [],
  coverage: {
    basisIds: ["basis-1"],
    coveredBasisIds: ["basis-1"],
    riskIds: ["risk-1"],
    coveredRiskIds: ["risk-1"],
    conditionIds: ["condition-1"],
    coveredConditionIds: ["condition-1"],
  },
});

const evaluate = (entry: Entry) =>
  evaluateEvidence({
    requestId: REQUEST_ID,
    snapshotId: SNAPSHOT_ID,
    obligation: entry.obligation,
    criterion: entry.criterion,
    claim: entry.claim,
    evaluation: entry.evaluation!,
    observations: [entry.observation],
  });

const outcome = (entry: Entry) =>
  resolveObligationOutcome({
    requestId: REQUEST_ID,
    snapshotId: SNAPSHOT_ID,
    obligation: entry.obligation,
    criteria: [entry.criterion],
    claims: [entry.claim],
    evaluations: entry.evaluation ? [entry.evaluation] : [],
    observations: [entry.observation],
  });

describe("evaluateEvidence", () => {
  test("accepts only a complete, linked graph", () => {
    const entry = makeEntry();

    expect(evaluate(entry)).toEqual({ accepted: true, rejectionReasons: [] });
    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "ACCEPTED", outcome: "PASSED" });
  });
  test("rejects an ACCEPTED evaluation for a different claim", () => {
    const entry = makeEntry();
    const mismatchedEvaluation: EvidenceEvaluation = { ...entry.evaluation!, claimId: "claim-2" };

    expect(
      evaluateEvidence({
        requestId: REQUEST_ID,
        snapshotId: SNAPSHOT_ID,
        obligation: entry.obligation,
        criterion: entry.criterion,
        claim: entry.claim,
        evaluation: mismatchedEvaluation,
        observations: [entry.observation],
      }),
    ).toEqual({ accepted: false, rejectionReasons: ["INSUFFICIENT_SCOPE"] });
  });

  test("rejects a natural-language claim without an accepted evaluation", () => {
    const entry = makeEntry({ evaluation: "none" });
    const result = resolveQaVerdict(graph(entry));

    expect(result.qaVerdict).toBe("INCOMPLETE");
    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "NONE", outcome: "INCOMPLETE" });
  });

  test("rejects exit zero when a required artifact is absent", () => {
    const entry = makeEntry({ artifacts: [] });
    const result = evaluate(entry);

    expect(result).toEqual({ accepted: false, rejectionReasons: ["MISSING_ARTIFACT"] });
    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "REJECTED", outcome: "INCOMPLETE" });
    expect(resolveQaVerdict(graph(entry)).qaVerdict).toBe("INCOMPLETE");
  });

  test("rejects an evaluation with incomplete scope", () => {
    const entry = makeEntry({
      evaluation: "rejected",
      checks: { scopeComplete: false },
      rejectionReasons: ["INSUFFICIENT_SCOPE"],
    });

    expect(evaluate(entry)).toEqual({ accepted: false, rejectionReasons: ["INSUFFICIENT_SCOPE"] });
    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "REJECTED", outcome: "INCOMPLETE" });
  });

  test("rejects evidence from another snapshot instead of trusting ACCEPTED", () => {
    const entry = makeEntry({ observationSnapshotId: "snapshot-2" });

    expect(evaluate(entry)).toEqual({ accepted: false, rejectionReasons: ["SNAPSHOT_MISMATCH"] });
    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "REJECTED", outcome: "INCOMPLETE" });
    expect(resolveQaVerdict(graph(entry)).qaVerdict).toBe("INCOMPLETE");
  });

  test("retains a failed execution as FAIL when the expected result is rejected", () => {
    const entry = makeEntry({
      exitStatus: "failed",
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });

    expect(evaluate(entry)).toEqual({ accepted: false, rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"] });
    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "REJECTED", outcome: "FAILED" });
    expect(resolveQaVerdict(graph(entry)).qaVerdict).toBe("FAIL");
  });

  test("blocks an execution that could not run", () => {
    const entry = makeEntry({
      exitStatus: "blocked",
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });

    expect(outcome(entry)).toEqual({ execution: "NOT_EXECUTABLE", evidence: "REJECTED", outcome: "BLOCKED" });
    expect(resolveQaVerdict(graph(entry)).qaVerdict).toBe("BLOCKED");
  });

  test("blocks evidence below the obligation independence requirement", () => {
    const entry = makeEntry({
      independence: "self-check",
      evaluation: "rejected",
      checks: { independenceSatisfied: false },
      rejectionReasons: ["INDEPENDENCE_NOT_MET"],
    });

    expect(evaluate(entry)).toEqual({ accepted: false, rejectionReasons: ["INDEPENDENCE_NOT_MET"] });
    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "REJECTED", outcome: "BLOCKED" });
    expect(resolveQaVerdict(graph(entry)).qaVerdict).toBe("BLOCKED");
  });

  test.each(["cancelled", "timed-out"] as const)("marks %s observations incomplete", exitStatus => {
    const entry = makeEntry({
      exitStatus,
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });

    expect(outcome(entry)).toEqual({ execution: "NOT_EXECUTABLE", evidence: "REJECTED", outcome: "INCOMPLETE" });
    expect(resolveQaVerdict(graph(entry)).qaVerdict).toBe("INCOMPLETE");
  });
});

describe("resolveQaVerdict", () => {
  test("returns qa-verdict/v1 with authoritative false for a complete accepted graph", () => {
    const result = resolveQaVerdict(graph(makeEntry()));

    expect(result.schemaVersion).toBe("qa-verdict/v1");
    expect(result.authoritative).toBe(false);
    expect(result.qaVerdict).toBe("PASS");
    expect(result.obligationSummary).toMatchObject({ mandatory: 1, passed: 1, failed: 0, blocked: 0, incomplete: 0 });
  });

  test("applies FAIL, BLOCKED, INCOMPLETE, accepted-risk, then PASS precedence", () => {
    const failed = makeEntry({
      obligationId: "obligation-fail",
      criterionId: "criterion-fail",
      observationId: "observation-fail",
      claimId: "claim-fail",
      exitStatus: "failed",
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });
    const blocked = makeEntry({
      obligationId: "obligation-blocked",
      criterionId: "criterion-blocked",
      observationId: "observation-blocked",
      claimId: "claim-blocked",
      exitStatus: "blocked",
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });
    const incomplete = makeEntry({
      obligationId: "obligation-incomplete",
      criterionId: "criterion-incomplete",
      observationId: "observation-incomplete",
      claimId: "claim-incomplete",
      evaluation: "none",
    });

    const all = resolveQaVerdict(graph(failed, blocked, incomplete));
    expect(all.qaVerdict).toBe("FAIL");

    const withoutFail = resolveQaVerdict(graph(blocked, incomplete));
    expect(withoutFail.qaVerdict).toBe("BLOCKED");

    const withoutBlock = resolveQaVerdict(graph(incomplete));
    expect(withoutBlock.qaVerdict).toBe("INCOMPLETE");

    const acceptedRisk: DefectSummary = {
      id: "defect-accepted-risk",
      material: true,
      disposition: "ACCEPTED_RISK",
      acceptanceExpiresAt: "2026-08-01T00:00:00.000Z",
    };
    const passing = graph(makeEntry());
    passing.defects = [acceptedRisk];
    expect(resolveQaVerdict(passing).qaVerdict).toBe("PASS_WITH_ACCEPTED_RISK");

    passing.defects = [];
    expect(resolveQaVerdict(passing).qaVerdict).toBe("PASS");
  });

  test("allows accepted material risk only after every mandatory criterion passes", () => {
    const input = graph(makeEntry({ evaluation: "none" }));
    input.defects = [
      {
        id: "defect-accepted-risk",
        material: true,
        disposition: "ACCEPTED_RISK",
        acceptanceExpiresAt: "2026-08-01T00:00:00.000Z",
      },
    ];

    expect(resolveQaVerdict(input).qaVerdict).toBe("INCOMPLETE");
  });

  test("rejects duplicate IDs and unknown graph references as invalid input", () => {
    const entry = makeEntry();
    const duplicateClaim = { ...entry.claim, claimId: entry.claim.claimId };
    expect(() => resolveQaVerdict({ ...graph(entry), claims: [entry.claim, duplicateClaim] })).toThrow(/duplicate/i);

    const unknownCriterion = {
      ...entry.claim,
      claimId: "claim-unknown-criterion",
      criterionId: "criterion-unknown",
    };
    expect(() => resolveQaVerdict({ ...graph(entry), claims: [unknownCriterion] })).toThrow(/unknown.*criterion|criterion.*unknown/i);
  });
});
