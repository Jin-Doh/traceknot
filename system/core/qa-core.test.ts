import { describe, expect, test } from "bun:test";
import {
  evaluateEvidence,
  resolveObligationOutcome,
  resolveProofCarryingQaVerdict,
  resolveQaVerdict,
  type DefectSummary,
  type EvidenceClaim,
  type EvidenceEvaluation,
  type EvidenceRejectionReason,
  type IndependenceLevel,
  type Observation,
  type ProofCarryingObligation,
  type ProofCarryingVerdictInput,
  type SuccessCriterion,
  type TraceabilityLink,
  type VerdictInput,
  type VerificationObligation,
  type ObligationResult,
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
  producerKind?: Observation["producer"]["kind"];
  independence?: IndependenceLevel;
  mandatory?: boolean;
  artifacts?: Observation["artifacts"];
  actualValues?: Observation["actualValues"];
  evaluation?: "accepted" | "rejected" | "none";
  checks?: Partial<EvidenceEvaluation["checks"]>;
  rejectionReasons?: EvidenceRejectionReason[];
};

type Entry = {
  obligation: ProofCarryingObligation;
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
  artifactRequirementsSatisfied: true,
  expectedResultDemonstrated: true,
  expectedResultViolated: false,
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
  const obligation: ProofCarryingObligation = {
    id: obligationId,
    mandatory: options.mandatory ?? true,
    criterionIds: [criterionId],
    requiredIndependence: "independent-producer",
  };
  const observation: Observation = {
    schemaVersion: "observation/v1",
    observationId,
    requestId: REQUEST_ID,
    snapshotId: observationSnapshotId,
    producer: {
      kind: options.producerKind ?? "ci",
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
    actualValues: options.actualValues,
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

const graph = (...entries: Entry[]): ProofCarryingVerdictInput => ({
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
  traceability: entries.map(
    (entry): TraceabilityLink => ({
      schemaVersion: "traceability-link/v1",
      criterionId: entry.criterion.criterionId,
      conditionIds: ["condition-1"],
      basisIds: ["basis-1"],
      riskIds: ["risk-1"],
    }),
  ),
});

const legacyBase = (): VerdictInput => {
  const obligation: VerificationObligation = {
    id: "obligation-1",
    mandatory: true,
    conditionIds: ["condition-1"],
    requiredIndependence: "independent-producer",
  };
  const result: ObligationResult = {
    obligationId: obligation.id,
    snapshotId: SNAPSHOT_ID,
    status: "PASS",
    producerIndependence: "independent-producer",
    evidenceId: "evidence-1",
  };
  return {
    requestId: REQUEST_ID,
    snapshotId: SNAPSHOT_ID,
    evaluatedAt: EVALUATED_AT,
    obligations: [obligation],
    results: [result],
    defects: [],
    coverage: {
      basisIds: ["basis-1"],
      coveredBasisIds: ["basis-1"],
      riskIds: ["risk-1"],
      coveredRiskIds: ["risk-1"],
      conditionIds: ["condition-1"],
      coveredConditionIds: ["condition-1"],
    },
  };
};

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
  test("does not accept a failed observation without eligible negative evidence", () => {
    const entry = makeEntry({ exitStatus: "failed" });

    expect(evaluate(entry)).toEqual({ accepted: false, rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"] });
    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "REJECTED", outcome: "INCOMPLETE" });
    expect(resolveProofCarryingQaVerdict(graph(entry)).qaVerdict).toBe("INCOMPLETE");
  });
  test("accepts a matching structured actual value", () => {
    const entry = makeEntry({ actualValues: { testsPassed: 42 } });
    entry.criterion = {
      ...entry.criterion,
      expected: { assertions: [{ field: "testsPassed", operator: "equals", value: 42 }] },
    };

    expect(evaluate(entry)).toEqual({ accepted: true, rejectionReasons: [] });
  });
  test("rejects a missing structured actual value", () => {
    const entry = makeEntry();
    entry.criterion = {
      ...entry.criterion,
      expected: { assertions: [{ field: "testsPassed", operator: "equals", value: 42 }] },
    };

    expect(evaluate(entry)).toEqual({ accepted: false, rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"] });
  });
  test("rejects an unsupported structured actual value", () => {
    const entry = makeEntry({ actualValues: { otherField: 42 } });
    entry.criterion = {
      ...entry.criterion,
      expected: { assertions: [{ field: "testsPassed", operator: "equals", value: 42 }] },
    };

    expect(evaluate(entry)).toEqual({ accepted: false, rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"] });
  });
  test("rejects a mismatched structured actual value", () => {
    const entry = makeEntry({ actualValues: { testsPassed: 41 } });
    entry.criterion = {
      ...entry.criterion,
      expected: { assertions: [{ field: "testsPassed", operator: "equals", value: 42 }] },
    };

    expect(evaluate(entry)).toEqual({ accepted: false, rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"] });
  });
  test("looks up structured actual values by object field", () => {
    const entry = makeEntry({ actualValues: { testsPassed: 42 } });
    entry.criterion = {
      ...entry.criterion,
      expected: { assertions: [{ field: "testsPassed", operator: "equals", value: 42 }] },
    };

    expect(evaluate(entry)).toEqual({ accepted: true, rejectionReasons: [] });
  });
  test.each([
    { field: "toString", unrelatedValue: "nonempty-to-string" },
    { field: "constructor", unrelatedValue: "nonempty-constructor" },
  ] as const)("rejects inherited structured actual value for $field", ({ field, unrelatedValue }) => {
    const entry = makeEntry({ actualValues: { unrelated: unrelatedValue } });
    entry.criterion = {
      ...entry.criterion,
      expected: { assertions: [{ field, operator: "not-equals", value: "expected-value" }] },
    };

    expect(evaluate(entry)).toEqual({ accepted: false, rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"] });
    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "REJECTED", outcome: "INCOMPLETE" });
    expect(resolveProofCarryingQaVerdict(graph(entry)).qaVerdict).toBe("INCOMPLETE");
  });
  test("supports an explicit own null actual value", () => {
    const entry = makeEntry({ actualValues: { result: null } });
    entry.criterion = {
      ...entry.criterion,
      expected: { assertions: [{ field: "result", operator: "equals", value: null }] },
    };

    expect(evaluate(entry)).toEqual({ accepted: true, rejectionReasons: [] });
  });
  test("fails closed when rejection reasons do not match failed checks", () => {
    const entry = makeEntry({
      evaluation: "rejected",
      checks: { scopeComplete: false },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });

    expect(evaluate(entry)).toEqual({
      accepted: false,
      rejectionReasons: ["INSUFFICIENT_SCOPE", "INTEGRITY_FAILURE"],
    });
  });
  test("keeps missing-artifact checks and reasons consistent", () => {
    const entry = makeEntry({
      artifacts: [],
      evaluation: "rejected",
      checks: { artifactRequirementsSatisfied: false, expectedResultDemonstrated: false },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED", "MISSING_ARTIFACT"],
    });

    expect(evaluate(entry)).toEqual({
      accepted: false,
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED", "MISSING_ARTIFACT"],
    });
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
    const result = resolveProofCarryingQaVerdict(graph(entry));

    expect(result.qaVerdict).toBe("INCOMPLETE");
    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "NONE", outcome: "INCOMPLETE" });
  });

  test("rejects exit zero when a required artifact is absent", () => {
    const entry = makeEntry({ artifacts: [] });
    const result = evaluate(entry);

    expect(result).toEqual({ accepted: false, rejectionReasons: ["MISSING_ARTIFACT"] });
    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "REJECTED", outcome: "INCOMPLETE" });
    expect(resolveProofCarryingQaVerdict(graph(entry)).qaVerdict).toBe("INCOMPLETE");
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
    expect(outcome(entry)).toEqual({ execution: "PENDING", evidence: "REJECTED", outcome: "INCOMPLETE" });
    expect(resolveProofCarryingQaVerdict(graph(entry)).qaVerdict).toBe("INCOMPLETE");
  });

  test("does not turn an explicit violation into FAIL when evidence is stale", () => {
    const entry = makeEntry({
      observationSnapshotId: "snapshot-2",
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false, expectedResultViolated: true },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });

    expect(resolveProofCarryingQaVerdict(graph(entry)).qaVerdict).toBe("INCOMPLETE");
    expect(outcome(entry)).toEqual({ execution: "PENDING", evidence: "REJECTED", outcome: "INCOMPLETE" });
  });
  test("does not consume a violated evaluation when one linked observation is stale", () => {
    const target = makeEntry({
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false, expectedResultViolated: true },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });
    const stale = makeEntry({
      observationId: "observation-stale-mixed",
      claimId: "claim-stale-mixed",
      observationSnapshotId: "snapshot-2",
      evaluation: "none",
    });
    const input = graph(target);
    input.observations = [target.observation, stale.observation];
    input.claims = [
      {
        ...target.claim,
        observationIds: [target.observation.observationId, stale.observation.observationId],
      },
    ];
    input.evaluations = [target.evaluation!];

    const state = resolveObligationOutcome({
      requestId: REQUEST_ID,
      snapshotId: SNAPSHOT_ID,
      obligation: target.obligation,
      criteria: [target.criterion],
      claims: input.claims,
      evaluations: input.evaluations,
      observations: input.observations,
    });
    expect(state.execution).toBe("COMPLETED");
    expect(state.outcome).toBe("INCOMPLETE");
    expect(resolveProofCarryingQaVerdict(input).qaVerdict).toBe("INCOMPLETE");
  });
  test("does not let a stale blocked claim block the target execution", () => {
    const target = makeEntry();
    const stale = makeEntry({
      observationId: "observation-stale-blocked",
      claimId: "claim-stale-blocked",
      observationSnapshotId: "snapshot-2",
      exitStatus: "blocked",
      evaluation: "rejected",
      checks: { snapshotBound: false, expectedResultDemonstrated: false },
      rejectionReasons: ["SNAPSHOT_MISMATCH", "EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });
    const input = graph(target);
    input.observations = [target.observation, stale.observation];
    input.claims = [
      target.claim,
      {
        ...stale.claim,
        obligationId: target.obligation.id,
        criterionId: target.criterion.criterionId,
      },
    ];
    input.evaluations = [target.evaluation!, stale.evaluation!];

    const state = resolveObligationOutcome({
      requestId: REQUEST_ID,
      snapshotId: SNAPSHOT_ID,
      obligation: target.obligation,
      criteria: [target.criterion],
      claims: input.claims,
      evaluations: input.evaluations,
      observations: input.observations,
    });
    expect(state.execution).toBe("COMPLETED");
    expect(state.outcome).toBe("PASSED");
    expect(resolveProofCarryingQaVerdict(input).qaVerdict).toBe("PASS");
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
    expect(resolveProofCarryingQaVerdict(graph(entry)).qaVerdict).toBe("FAIL");
  });

  test("blocks an execution that could not run", () => {
    const entry = makeEntry({
      exitStatus: "blocked",
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });

    expect(outcome(entry)).toEqual({ execution: "NOT_EXECUTABLE", evidence: "REJECTED", outcome: "BLOCKED" });
    expect(resolveProofCarryingQaVerdict(graph(entry)).qaVerdict).toBe("BLOCKED");
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
    expect(resolveProofCarryingQaVerdict(graph(entry)).qaVerdict).toBe("BLOCKED");
  });
  test("rejects a self producer claiming external approval", () => {
    const entry = makeEntry({ producerKind: "self", independence: "external-approval" });

    expect(evaluate(entry)).toEqual({
      accepted: false,
      rejectionReasons: ["INDEPENDENCE_NOT_MET", "UNTRUSTED_PRODUCER"],
    });
    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "REJECTED", outcome: "BLOCKED" });
    expect(resolveProofCarryingQaVerdict(graph(entry)).qaVerdict).toBe("BLOCKED");
  });

  test("keeps a passed execution incomplete when expected result is unproven", () => {
    const entry = makeEntry({
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false, expectedResultViolated: false },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });

    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "REJECTED", outcome: "INCOMPLETE" });
    expect(resolveProofCarryingQaVerdict(graph(entry)).qaVerdict).toBe("INCOMPLETE");
  });

  test("fails a passed execution when the expected result is explicitly violated", () => {
    const entry = makeEntry({
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false, expectedResultViolated: true },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });

    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "REJECTED", outcome: "FAILED" });
    expect(resolveProofCarryingQaVerdict(graph(entry)).qaVerdict).toBe("FAIL");
  });
  test("fails on a contradictory supported assertion even without explicit violation", () => {
    const entry = makeEntry({
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false, expectedResultViolated: false },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });
    entry.criterion = {
      ...entry.criterion,
      expected: {
        assertions: [{ field: "execution.exitCode", operator: "equals", value: 1 }],
      },
    };

    expect(evaluate(entry)).toEqual({ accepted: false, rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"] });
    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "REJECTED", outcome: "FAILED" });
    expect(resolveProofCarryingQaVerdict(graph(entry)).qaVerdict).toBe("FAIL");
  });
  test("keeps a supported contradiction incomplete without an evaluation", () => {
    const entry = makeEntry({ evaluation: "none" });
    entry.criterion = {
      ...entry.criterion,
      expected: {
        assertions: [{ field: "execution.exitCode", operator: "equals", value: 1 }],
      },
    };

    expect(outcome(entry)).toEqual({ execution: "COMPLETED", evidence: "NONE", outcome: "INCOMPLETE" });
    expect(resolveProofCarryingQaVerdict(graph(entry)).qaVerdict).toBe("INCOMPLETE");
  });
  test("keeps stale target contradiction incomplete despite another accepting claim", () => {
    const failing = makeEntry({
      observationId: "observation-target-contradiction",
      claimId: "claim-target-contradiction",
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false, expectedResultViolated: false },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });
    failing.criterion = {
      ...failing.criterion,
      expected: {
        assertions: [{ field: "execution.exitCode", operator: "equals", value: 1 }],
      },
    };
    const stale = makeEntry({
      observationId: "observation-mixed-stale",
      claimId: "claim-mixed-stale",
      observationSnapshotId: "snapshot-2",
      evaluation: "none",
    });
    const accepting = makeEntry({
      observationId: "observation-accepting",
      claimId: "claim-accepting",
    });
    accepting.observation = {
      ...accepting.observation,
      execution: { ...accepting.observation.execution, exitCode: 1 },
    };
    const input = graph(failing);
    input.observations = [failing.observation, stale.observation, accepting.observation];
    input.claims = [
      {
        ...failing.claim,
        observationIds: [failing.observation.observationId, stale.observation.observationId],
      },
      {
        ...accepting.claim,
        obligationId: failing.obligation.id,
        criterionId: failing.criterion.criterionId,
      },
    ];
    input.evaluations = [failing.evaluation!, accepting.evaluation!];

    expect(resolveProofCarryingQaVerdict(input).qaVerdict).toBe("PASS");
  });

  test("keeps aggregate FAIL when an explicit failure is mixed with a blocked claim", () => {
    const failed = makeEntry({
      obligationId: "obligation-explicit-fail",
      criterionId: "criterion-explicit-fail",
      observationId: "observation-explicit-fail",
      claimId: "claim-explicit-fail",
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false, expectedResultViolated: true },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });
    const blocked = makeEntry({
      obligationId: "obligation-mixed-blocked",
      criterionId: "criterion-mixed-blocked",
      observationId: "observation-mixed-blocked",
      claimId: "claim-mixed-blocked",
      exitStatus: "blocked",
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });

    expect(resolveProofCarryingQaVerdict(graph(failed, blocked)).qaVerdict).toBe("FAIL");
  });
  test.each(["cancelled", "timed-out"] as const)("marks %s observations incomplete", exitStatus => {
    const entry = makeEntry({
      exitStatus,
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });

    expect(outcome(entry)).toEqual({ execution: "NOT_EXECUTABLE", evidence: "REJECTED", outcome: "INCOMPLETE" });
    expect(resolveProofCarryingQaVerdict(graph(entry)).qaVerdict).toBe("INCOMPLETE");
  });
});

describe("resolveProofCarryingQaVerdict", () => {
  test("returns qa-verdict/v1 with authoritative false for a complete accepted graph", () => {
    const result = resolveProofCarryingQaVerdict(graph(makeEntry()));

    expect(result.schemaVersion).toBe("qa-verdict/v1");
    expect(result.authoritative).toBe(false);
    expect(result.qaVerdict).toBe("PASS");
    expect(result.obligationSummary).toMatchObject({ mandatory: 1, passed: 1, failed: 0, blocked: 0, incomplete: 0 });
  });
  test("keeps PASS when extra claims are blocked or weakly independent", () => {
    const accepted = makeEntry();
    const blocked = makeEntry({
      obligationId: "obligation-extra-blocked",
      criterionId: "criterion-extra-blocked",
      observationId: "observation-extra-blocked",
      claimId: "claim-extra-blocked",
      mandatory: false,
      exitStatus: "blocked",
      evaluation: "rejected",
      checks: { expectedResultDemonstrated: false },
      rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    });
    const weak = makeEntry({
      obligationId: "obligation-extra-weak",
      criterionId: "criterion-extra-weak",
      observationId: "observation-extra-weak",
      claimId: "claim-extra-weak",
      mandatory: false,
      independence: "self-check",
      evaluation: "rejected",
      checks: { independenceSatisfied: false },
      rejectionReasons: ["INDEPENDENCE_NOT_MET"],
    });
    const input = graph(accepted);
    input.observations = [accepted.observation, blocked.observation, weak.observation];
    input.claims = [
      accepted.claim,
      { ...blocked.claim, obligationId: accepted.obligation.id, criterionId: accepted.criterion.criterionId },
      { ...weak.claim, obligationId: accepted.obligation.id, criterionId: accepted.criterion.criterionId },
    ];
    input.evaluations = [accepted.evaluation!, blocked.evaluation!, weak.evaluation!];

    expect(resolveProofCarryingQaVerdict(input).qaVerdict).toBe("PASS");
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

    const all = resolveProofCarryingQaVerdict(graph(failed, blocked, incomplete));
    expect(all.qaVerdict).toBe("FAIL");

    const withoutFail = resolveProofCarryingQaVerdict(graph(blocked, incomplete));
    expect(withoutFail.qaVerdict).toBe("BLOCKED");

    const withoutBlock = resolveProofCarryingQaVerdict(graph(incomplete));
    expect(withoutBlock.qaVerdict).toBe("INCOMPLETE");

    const acceptedRisk: DefectSummary = {
      id: "defect-accepted-risk",
      material: true,
      disposition: "ACCEPTED_RISK",
      acceptanceExpiresAt: "2026-08-01T00:00:00.000Z",
    };
    const passing = graph(makeEntry());
    passing.defects = [acceptedRisk];
    expect(resolveProofCarryingQaVerdict(passing).qaVerdict).toBe("BLOCKED");

    passing.defects = [];
    expect(resolveProofCarryingQaVerdict(passing).qaVerdict).toBe("PASS");
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

    expect(resolveProofCarryingQaVerdict(input).qaVerdict).toBe("BLOCKED");
  });
  test("requires nonempty proof coverage while legacy coverage stays permissive", () => {
    const emptyBasis = graph(makeEntry());
    emptyBasis.coverage = { ...emptyBasis.coverage, basisIds: [], coveredBasisIds: [] };
    expect(resolveProofCarryingQaVerdict(emptyBasis).qaVerdict).toBe("INCOMPLETE");

    const emptyConditions = graph(makeEntry());
    emptyConditions.coverage = { ...emptyConditions.coverage, conditionIds: [], coveredConditionIds: [] };
    expect(resolveProofCarryingQaVerdict(emptyConditions).qaVerdict).toBe("INCOMPLETE");

    const legacy = legacyBase();
    legacy.coverage = {
      ...legacy.coverage,
      basisIds: [],
      coveredBasisIds: [],
      conditionIds: [],
      coveredConditionIds: [],
    };
    expect(resolveQaVerdict(legacy).qaVerdict).toBe("PASS");
  });
  test("rejects empty criterion assertions, selectors, and required artifacts", () => {
    const noAssertions = graph(makeEntry());
    noAssertions.criteria = [
      {
        ...noAssertions.criteria[0]!,
        expected: { assertions: [] },
      },
    ];
    expect(() => resolveProofCarryingQaVerdict(noAssertions)).toThrow(/assertion/i);

    const noSelectors = graph(makeEntry());
    noSelectors.criteria = [
      {
        ...noSelectors.criteria[0]!,
        requiredScope: { ...noSelectors.criteria[0]!.requiredScope, selectors: [] },
      },
    ];
    expect(() => resolveProofCarryingQaVerdict(noSelectors)).toThrow(/selector/i);

    const noArtifacts = graph(makeEntry());
    noArtifacts.criteria = [{ ...noArtifacts.criteria[0]!, requiredArtifacts: [] }];
    expect(() => resolveProofCarryingQaVerdict(noArtifacts)).toThrow(/artifact/i);
  });
  test("requires a real traceability link for every mandatory criterion", () => {
    const fabricated = graph(makeEntry());
    fabricated.traceability = [
      {
        schemaVersion: "traceability-link/v1",
        criterionId: "criterion-1",
        conditionIds: ["condition-1"],
        basisIds: ["basis-fabricated"],
        riskIds: ["risk-1"],
      },
    ];
    expect(resolveProofCarryingQaVerdict(fabricated).qaVerdict).toBe("INCOMPLETE");

    const missing = graph(makeEntry());
    missing.traceability = [];
    expect(resolveProofCarryingQaVerdict(missing).qaVerdict).toBe("INCOMPLETE");
  });

  test("rejects duplicate IDs and unknown graph references as invalid input", () => {
    const entry = makeEntry();
    const duplicateClaim = { ...entry.claim, claimId: entry.claim.claimId };
    expect(() => resolveProofCarryingQaVerdict({ ...graph(entry), claims: [entry.claim, duplicateClaim] })).toThrow(/duplicate/i);

    const unknownCriterion = {
      ...entry.claim,
      claimId: "claim-unknown-criterion",
      criterionId: "criterion-unknown",
    };
    expect(() => resolveProofCarryingQaVerdict({ ...graph(entry), claims: [unknownCriterion] })).toThrow(/unknown.*criterion|criterion.*unknown/i);
    const duplicateEvaluation = { ...entry.evaluation!, evaluationId: "evaluation-duplicate" };
    expect(() => resolveProofCarryingQaVerdict({ ...graph(entry), evaluations: [entry.evaluation!, duplicateEvaluation] })).toThrow(/duplicate evaluation/i);
  });
});

describe("resolveQaVerdict legacy compatibility", () => {
  test("still passes a legacy VerdictInput with results", () => {
    expect(resolveQaVerdict(legacyBase()).qaVerdict).toBe("PASS");
  });

  test("retains legacy snapshot mismatch rejection", () => {
    const input = legacyBase();
    const result = input.results[0]!;

    expect(() =>
      resolveQaVerdict({
        ...input,
        results: [{ ...result, snapshotId: "snapshot-2" }],
      }),
    ).toThrow("snapshot mismatch");
  });
  test("retains legacy PASS_WITH_ACCEPTED_RISK compatibility", () => {
    const input = legacyBase();
    input.defects = [
      {
        id: "defect-legacy-accepted-risk",
        material: true,
        disposition: "ACCEPTED_RISK",
        acceptanceExpiresAt: "2026-08-01T00:00:00.000Z",
      },
    ];

    expect(resolveQaVerdict(input).qaVerdict).toBe("PASS_WITH_ACCEPTED_RISK");
  });
});
