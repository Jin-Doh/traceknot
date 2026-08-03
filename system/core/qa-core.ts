export type RiskLevel = "R0" | "R1" | "R2" | "R3";
export type IndependenceLevel = "self-check" | "separate-verification-context" | "independent-producer" | "external-approval";
export type QaVerdict = "PASS" | "PASS_WITH_ACCEPTED_RISK" | "FAIL" | "BLOCKED" | "INCOMPLETE";
export type ObligationStatus = "PASS" | "FAIL" | "BLOCKED" | "INCOMPLETE";

export type VerificationObligation = {
  id: string;
  mandatory: boolean;
  conditionIds: readonly string[];
  requiredIndependence: IndependenceLevel;
};

export type ObligationResult = {
  obligationId: string;
  snapshotId: string;
  status: ObligationStatus;
  producerIndependence: IndependenceLevel;
  evidenceId?: string;
};

export type ProofCarryingObligation = {
  id: string;
  mandatory: boolean;
  criterionIds: readonly string[];
  requiredIndependence: IndependenceLevel;
};

export type SuccessCriterion = {
  schemaVersion: "success-criterion/v1";
  criterionId: string;
  kind: "structured-assertion" | "qualitative-review";
  expected: {
    assertions: readonly {
      field: string;
      operator: "equals" | "not-equals" | "less-than-or-equal" | "greater-than-or-equal" | "contains";
      value: string | number | boolean | null;
    }[];
  };
  requiredScope: {
    kind: "repository-canonical" | "suite" | "files" | "flow" | "review";
    selectors: readonly string[];
  };
  requiredIndependence: IndependenceLevel;
  requiredArtifacts: readonly string[];
};

export type Producer = {
  kind: "self" | "harness-managed" | "deterministic-verifier" | "ci" | "human" | "external-system";
  identity: string;
  independence: IndependenceLevel;
};

export type Execution = {
  kind: "command" | "browser" | "review" | "experiment" | "approval";
  identity: string;
  startedAt: string;
  finishedAt: string;
  exitStatus: "passed" | "failed" | "blocked" | "cancelled" | "timed-out";
  exitCode?: number;
};

export type Artifact = {
  type: string;
  digest: string;
  path?: string;
};

export type ActualValue = {
  field: string;
  value: string | number | boolean | null;
};

export type Observation = {
  schemaVersion: "observation/v1";
  observationId: string;
  requestId: string;
  snapshotId: string;
  producer: Producer;
  execution: Execution;
  artifacts: readonly Artifact[];
  actualValues?: readonly ActualValue[];
};

export type VerificationObservation = Observation;

export type EvidenceClaim = {
  schemaVersion: "evidence-claim/v1";
  claimId: string;
  requestId: string;
  snapshotId: string;
  obligationId: string;
  criterionId: string;
  observationIds: readonly string[];
  claim: string;
};
export type TraceabilityLink = {
  schemaVersion: "traceability-link/v1";
  criterionId: string;
  conditionIds: readonly string[];
  basisIds: readonly string[];
  riskIds: readonly string[];
};

export type EvidenceRejectionReason =
  | "SNAPSHOT_MISMATCH"
  | "STALE_EVIDENCE"
  | "MISSING_ARTIFACT"
  | "INSUFFICIENT_SCOPE"
  | "UNTRUSTED_PRODUCER"
  | "INDEPENDENCE_NOT_MET"
  | "EXPECTED_RESULT_NOT_DEMONSTRATED"
  | "INTEGRITY_FAILURE";

export type EvidenceEvaluation = {
  schemaVersion: "evidence-evaluation/v1";
  evaluationId: string;
  requestId: string;
  snapshotId: string;
  claimId: string;
  status: "ACCEPTED" | "REJECTED";
  checks: {
    snapshotBound: boolean;
    fresh: boolean;
    scopeComplete: boolean;
    producerAllowed: boolean;
    independenceSatisfied: boolean;
    artifactRequirementsSatisfied: boolean;
    expectedResultDemonstrated: boolean;
    expectedResultViolated: boolean;
    integrityVerified: boolean;
  };
  rejectionReasons: readonly EvidenceRejectionReason[];
  evaluatedAt: string;
};

export type EvidenceAcceptanceResult = {
  accepted: boolean;
  rejectionReasons: EvidenceRejectionReason[];
};

export type ExecutionState = "PENDING" | "RUNNING" | "COMPLETED" | "NOT_EXECUTABLE";
export type EvidenceState = "NONE" | "SUBMITTED" | "PARTIALLY_ACCEPTED" | "ACCEPTED" | "REJECTED";
export type ObligationOutcome = "UNRESOLVED" | "PASSED" | "FAILED" | "BLOCKED" | "INCOMPLETE";

export type ObligationState = {
  execution: ExecutionState;
  evidence: EvidenceState;
  outcome: ObligationOutcome;
};

export type DefectDisposition = "OPEN" | "CLOSED" | "ACCEPTED_RISK";

export type DefectSummary = {
  id: string;
  material: boolean;
  disposition: DefectDisposition;
  acceptanceExpiresAt?: string;
};

export type CoverageInput = {
  basisIds: readonly string[];
  coveredBasisIds: readonly string[];
  riskIds: readonly string[];
  coveredRiskIds: readonly string[];
  conditionIds: readonly string[];
  coveredConditionIds: readonly string[];
};

export type VerdictInput = {
  requestId: string;
  snapshotId: string;
  obligations: readonly VerificationObligation[];
  results: readonly ObligationResult[];
  defects: readonly DefectSummary[];
  coverage: CoverageInput;
  evaluatedAt: string;
};

export type ProofCarryingVerdictInput = {
  requestId: string;
  snapshotId: string;
  obligations: readonly ProofCarryingObligation[];
  criteria: readonly SuccessCriterion[];
  observations: readonly Observation[];
  claims: readonly EvidenceClaim[];
  evaluations: readonly EvidenceEvaluation[];
  defects: readonly DefectSummary[];
  coverage: CoverageInput;
  evaluatedAt: string;
  traceability: readonly TraceabilityLink[];
};

export type CoverageResult = { total: number; covered: number; uncoveredIds: string[] };

export type VerdictResult = {
  schemaVersion: "qa-verdict/v1";
  requestId: string;
  snapshotId: string;
  qaVerdict: QaVerdict;
  authoritative: false;
  obligationSummary: { mandatory: number; passed: number; failed: number; blocked: number; incomplete: number };
  coverage: {
    basis: CoverageResult;
    risks: CoverageResult;
    conditions: CoverageResult;
    mandatoryObligations: CoverageResult;
  };
  openDefectIds: string[];
  acceptedRiskIds: string[];
  residualRisks: string[];
  rationale: string;
};

const independenceRank: Readonly<Record<IndependenceLevel, number>> = {
  "self-check": 0,
  "separate-verification-context": 1,
  "independent-producer": 2,
  "external-approval": 3,
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function coverage(all: readonly string[], covered: readonly string[]): CoverageResult {
  const totalIds = unique(all);
  const coveredSet = new Set(covered);
  const uncoveredIds = totalIds.filter(id => !coveredSet.has(id));
  return { total: totalIds.length, covered: totalIds.length - uncoveredIds.length, uncoveredIds };
}

function validAcceptance(defect: DefectSummary, evaluatedAt: string): boolean {
  if (defect.disposition !== "ACCEPTED_RISK" || !defect.acceptanceExpiresAt) return false;
  return Date.parse(defect.acceptanceExpiresAt) > Date.parse(evaluatedAt);
}

function addReasons(target: Set<EvidenceRejectionReason>, reasons: readonly EvidenceRejectionReason[]): void {
  for (const reason of reasons) target.add(reason);
}

function reasonsFromChecks(checks: EvidenceEvaluation["checks"], target: Set<EvidenceRejectionReason>): void {
  if (!checks.snapshotBound) target.add("SNAPSHOT_MISMATCH");
  if (!checks.fresh) target.add("STALE_EVIDENCE");
  if (!checks.artifactRequirementsSatisfied) target.add("MISSING_ARTIFACT");
  if (!checks.scopeComplete) target.add("INSUFFICIENT_SCOPE");
  if (!checks.producerAllowed) target.add("UNTRUSTED_PRODUCER");
  if (!checks.independenceSatisfied) target.add("INDEPENDENCE_NOT_MET");
  if (!checks.expectedResultDemonstrated || checks.expectedResultViolated) target.add("EXPECTED_RESULT_NOT_DEMONSTRATED");
  if (!checks.integrityVerified) target.add("INTEGRITY_FAILURE");
}

function reasonArray(reasons: Set<EvidenceRejectionReason>): EvidenceRejectionReason[] {
  return [...reasons].sort();
}

function reasonsMatch(actual: readonly EvidenceRejectionReason[], expected: Set<EvidenceRejectionReason>): boolean {
  const actualSorted = [...actual].sort();
  const expectedSorted = reasonArray(expected);
  return actualSorted.length === expectedSorted.length && actualSorted.every((reason, index) => reason === expectedSorted[index]);
}


function assertUniqueIds<T>(records: readonly T[], idOf: (record: T) => string, label: string): Map<string, T> {
  const byId = new Map<string, T>();
  for (const record of records) {
    const id = idOf(record);
    if (byId.has(id)) throw new Error(`duplicate ${label} ${id}`);
    byId.set(id, record);
  }
  return byId;
}
type AssertionValue = string | number | boolean | null;

function lookupAssertionValue(observation: Observation, field: string): { supported: boolean; value?: AssertionValue } {
  if (field === "execution.exitStatus") return { supported: true, value: observation.execution.exitStatus };
  if (field === "execution.exitCode") {
    return observation.execution.exitCode === undefined
      ? { supported: false }
      : { supported: true, value: observation.execution.exitCode };
  }
  const actualValue = observation.actualValues?.find(item => item.field === field);
  return actualValue ? { supported: true, value: actualValue.value } : { supported: false };
}

function assertionApplicable(
  assertion: SuccessCriterion["expected"]["assertions"][number],
  observed: { supported: boolean; value?: AssertionValue },
): boolean {
  if (!observed.supported) return false;
  if (assertion.operator === "less-than-or-equal" || assertion.operator === "greater-than-or-equal") {
    return typeof observed.value === "number" && typeof assertion.value === "number";
  }
  if (assertion.operator === "contains") {
    return typeof observed.value === "string" && typeof assertion.value === "string";
  }
  return true;
}

function assertionMatches(
  assertion: SuccessCriterion["expected"]["assertions"][number],
  observed: { supported: boolean; value?: AssertionValue },
): boolean {
  if (!assertionApplicable(assertion, observed)) return false;
  const actual = observed.value;
  if (assertion.operator === "equals") return actual === assertion.value;
  if (assertion.operator === "not-equals") return actual !== assertion.value;
  if (assertion.operator === "less-than-or-equal") {
    return typeof actual === "number" && typeof assertion.value === "number" && actual <= assertion.value;
  }
  if (assertion.operator === "greater-than-or-equal") {
    return typeof actual === "number" && typeof assertion.value === "number" && actual >= assertion.value;
  }
  return typeof actual === "string" && typeof assertion.value === "string" && actual.includes(assertion.value);
}

function assertionContradicts(criterion: SuccessCriterion, observation: Observation): boolean {
  if (observation.execution.exitStatus !== "passed" && observation.execution.exitStatus !== "failed") return false;
  return criterion.expected.assertions.some(assertion => {
    const observed = lookupAssertionValue(observation, assertion.field);
    return assertionApplicable(assertion, observed) && !assertionMatches(assertion, observed);
  });
}

function assertionsDemonstrated(criterion: SuccessCriterion, observations: readonly Observation[]): boolean {
  return criterion.expected.assertions.every(assertion =>
    observations.some(observation => assertionMatches(assertion, lookupAssertionValue(observation, assertion.field))),
  );
}
function assertUniqueStrings(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label} ${value}`);
    seen.add(value);
  }
}
function assertValidCriterion(criterion: SuccessCriterion): void {
  if (criterion.expected.assertions.length === 0) throw new Error(`criterion ${criterion.criterionId} requires assertions`);
  if (criterion.requiredScope.selectors.length === 0) throw new Error(`criterion ${criterion.criterionId} requires scope selectors`);
  if (criterion.requiredArtifacts.length === 0) throw new Error(`criterion ${criterion.criterionId} requires artifacts`);
  assertUniqueStrings(criterion.requiredArtifacts, `required artifact in ${criterion.criterionId}`);
}

type GraphIndexes = {
  obligationsById: Map<string, ProofCarryingObligation>;
  criteriaById: Map<string, SuccessCriterion>;
  observationsById: Map<string, Observation>;
  claimsById: Map<string, EvidenceClaim>;
  evaluationsById: Map<string, EvidenceEvaluation>;
  claimsByObligation: Map<string, EvidenceClaim[]>;
  evaluationsByClaim: Map<string, EvidenceEvaluation[]>;
};

function buildGraphIndexes(
  obligations: readonly ProofCarryingObligation[],
  criteria: readonly SuccessCriterion[],
  observations: readonly Observation[],
  claims: readonly EvidenceClaim[],
  evaluations: readonly EvidenceEvaluation[],
): GraphIndexes {
  const obligationsById = assertUniqueIds(obligations, item => item.id, "obligation");
  const criteriaById = assertUniqueIds(criteria, item => item.criterionId, "criterion");
  const observationsById = assertUniqueIds(observations, item => item.observationId, "observation");
  for (const observation of observations) {
    assertUniqueStrings(
      (observation.actualValues ?? []).map(actualValue => actualValue.field),
      `actual value field in ${observation.observationId}`,
    );
  }
  const claimsById = assertUniqueIds(claims, item => item.claimId, "claim");
  const evaluationsById = assertUniqueIds(evaluations, item => item.evaluationId, "evaluation");
  const claimsByObligation = new Map<string, EvidenceClaim[]>();
  const evaluationsByClaim = new Map<string, EvidenceEvaluation[]>();

  for (const obligation of obligations) {
    if (obligation.criterionIds.length === 0) throw new Error(`obligation ${obligation.id} requires criterionIds`);
    assertUniqueStrings(obligation.criterionIds, `criterion reference in ${obligation.id}`);
    for (const criterionId of obligation.criterionIds) {
      if (!criteriaById.has(criterionId)) throw new Error(`unknown criterion ${criterionId}`);
    }
  }
  for (const criterion of criteria) assertValidCriterion(criterion);
  for (const claim of claims) {
    assertUniqueStrings(claim.observationIds, `observation reference in ${claim.claimId}`);
    if (!obligationsById.has(claim.obligationId)) throw new Error(`unknown obligation ${claim.obligationId}`);
    if (!criteriaById.has(claim.criterionId)) throw new Error(`unknown criterion ${claim.criterionId}`);
    let groupedClaims = claimsByObligation.get(claim.obligationId);
    if (!groupedClaims) {
      groupedClaims = [];
      claimsByObligation.set(claim.obligationId, groupedClaims);
    }
    groupedClaims.push(claim);
  }
  for (const evaluation of evaluations) {
    if (!claimsById.has(evaluation.claimId)) throw new Error(`unknown claim ${evaluation.claimId}`);
    let groupedEvaluations = evaluationsByClaim.get(evaluation.claimId);
    if (!groupedEvaluations) {
      groupedEvaluations = [];
      evaluationsByClaim.set(evaluation.claimId, groupedEvaluations);
    }
    groupedEvaluations.push(evaluation);
  }
  return { obligationsById, criteriaById, observationsById, claimsById, evaluationsById, claimsByObligation, evaluationsByClaim };
}
function validTraceability(input: ProofCarryingVerdictInput, indexes: GraphIndexes): boolean {
  if (!input.traceability) return false;
  const linksByCriterion = assertUniqueIds(input.traceability, item => item.criterionId, "traceability link");
  const basisIds = new Set(input.coverage.basisIds);
  const coveredBasisIds = new Set(input.coverage.coveredBasisIds);
  const conditionIds = new Set(input.coverage.conditionIds);
  const coveredConditionIds = new Set(input.coverage.coveredConditionIds);
  const riskIds = new Set(input.coverage.riskIds);
  const coveredRiskIds = new Set(input.coverage.coveredRiskIds);
  const mandatoryCriteria = new Set<string>();
  for (const obligation of input.obligations) {
    if (!obligation.mandatory) continue;
    for (const criterionId of obligation.criterionIds) mandatoryCriteria.add(criterionId);
  }
  let valid = true;
  for (const criterionId of mandatoryCriteria) {
    if (!linksByCriterion.has(criterionId)) valid = false;
  }
  for (const link of input.traceability) {
    if (!indexes.criteriaById.has(link.criterionId)) valid = false;
    if (link.conditionIds.length === 0 || link.basisIds.length === 0) valid = false;
    assertUniqueStrings(link.conditionIds, `condition in traceability ${link.criterionId}`);
    assertUniqueStrings(link.basisIds, `basis in traceability ${link.criterionId}`);
    assertUniqueStrings(link.riskIds, `risk in traceability ${link.criterionId}`);
    for (const conditionId of link.conditionIds) {
      if (!conditionIds.has(conditionId) || !coveredConditionIds.has(conditionId)) valid = false;
    }
    for (const basisId of link.basisIds) {
      if (!basisIds.has(basisId) || !coveredBasisIds.has(basisId)) valid = false;
    }
    for (const riskId of link.riskIds) {
      if (!riskIds.has(riskId) || !coveredRiskIds.has(riskId)) valid = false;
    }
  }
  return valid;
}

type EvidenceEvaluationContext = {
  requestId: string;
  snapshotId: string;
  obligation: ProofCarryingObligation;
  criterion: SuccessCriterion;
  claim: EvidenceClaim;
  evaluation: EvidenceEvaluation;
  observationsById: Map<string, Observation>;
};

function evaluateEvidenceIndexed(input: EvidenceEvaluationContext): EvidenceAcceptanceResult {
  const reasons = new Set<EvidenceRejectionReason>();
  const { requestId, snapshotId, obligation, criterion, claim, evaluation } = input;
  if (
    claim.requestId !== requestId ||
    claim.snapshotId !== snapshotId ||
    evaluation.requestId !== requestId ||
    evaluation.snapshotId !== snapshotId
  ) {
    reasons.add("SNAPSHOT_MISMATCH");
  }
  if (
    claim.obligationId !== obligation.id ||
    claim.criterionId !== criterion.criterionId ||
    evaluation.claimId !== claim.claimId ||
    !obligation.criterionIds.includes(criterion.criterionId)
  ) reasons.add("INSUFFICIENT_SCOPE");

  const requiredIndependence = Math.max(
    independenceRank[obligation.requiredIndependence],
    independenceRank[criterion.requiredIndependence],
  );
  const artifactTypes = new Set<string>();
  const targetObservations: Observation[] = [];
  let observationCount = 0;
  for (const observationId of claim.observationIds) {
    const observation = input.observationsById.get(observationId);
    if (!observation) {
      reasons.add("MISSING_ARTIFACT");
      continue;
    }
    observationCount++;
    const target =
      observation.requestId === requestId && observation.snapshotId === snapshotId;
    if (!target) reasons.add("SNAPSHOT_MISMATCH");
    else targetObservations.push(observation);
    if (independenceRank[observation.producer.independence] < requiredIndependence) reasons.add("INDEPENDENCE_NOT_MET");
    if (observation.producer.kind === "self" && observation.producer.independence !== "self-check") {
      reasons.add("UNTRUSTED_PRODUCER");
      reasons.add("INDEPENDENCE_NOT_MET");
    }
    if (observation.execution.exitStatus !== "passed" || assertionContradicts(criterion, observation)) {
      reasons.add("EXPECTED_RESULT_NOT_DEMONSTRATED");
    }
    for (const artifact of observation.artifacts) artifactTypes.add(artifact.type);
  }
  if (observationCount === 0) reasons.add("MISSING_ARTIFACT");
  if (targetObservations.length > 0 && !assertionsDemonstrated(criterion, targetObservations)) {
    reasons.add("EXPECTED_RESULT_NOT_DEMONSTRATED");
  }
  for (const artifactType of criterion.requiredArtifacts) {
    if (!artifactTypes.has(artifactType)) reasons.add("MISSING_ARTIFACT");
  }
  const checkReasons = new Set<EvidenceRejectionReason>();
  reasonsFromChecks(evaluation.checks, checkReasons);
  addReasons(reasons, reasonArray(checkReasons));

  if (evaluation.status === "REJECTED") {
    if (checkReasons.size === 0 || !reasonsMatch(evaluation.rejectionReasons, reasons)) {
      reasons.add("INTEGRITY_FAILURE");
    }
  } else if (evaluation.rejectionReasons.length > 0 && !reasonsMatch(evaluation.rejectionReasons, reasons)) {
    reasons.add("INTEGRITY_FAILURE");
  }

  const checksPass =
    evaluation.checks.snapshotBound &&
    evaluation.checks.fresh &&
    evaluation.checks.scopeComplete &&
    evaluation.checks.producerAllowed &&
    evaluation.checks.independenceSatisfied &&
    evaluation.checks.artifactRequirementsSatisfied &&
    evaluation.checks.expectedResultDemonstrated &&
    !evaluation.checks.expectedResultViolated &&
    evaluation.checks.integrityVerified;
  const accepted =
    evaluation.status === "ACCEPTED" &&
    checksPass &&
    evaluation.rejectionReasons.length === 0 &&
    reasons.size === 0;
  return { accepted, rejectionReasons: reasonArray(reasons) };
}

export type EvaluateEvidenceInput = {
  requestId: string;
  snapshotId: string;
  obligation: ProofCarryingObligation;
  criterion: SuccessCriterion;
  claim: EvidenceClaim;
  evaluation: EvidenceEvaluation;
  observations: readonly Observation[];
};

export function evaluateEvidence(input: EvaluateEvidenceInput): EvidenceAcceptanceResult {
  assertUniqueStrings(input.claim.observationIds, `observation reference in ${input.claim.claimId}`);
  assertValidCriterion(input.criterion);
  const observationsById = assertUniqueIds(input.observations, item => item.observationId, "observation");
  for (const observation of input.observations) {
    assertUniqueStrings(
      (observation.actualValues ?? []).map(actualValue => actualValue.field),
      `actual value field in ${observation.observationId}`,
    );
  }
  return evaluateEvidenceIndexed({
    requestId: input.requestId,
    snapshotId: input.snapshotId,
    obligation: input.obligation,
    criterion: input.criterion,
    claim: input.claim,
    evaluation: input.evaluation,
    observationsById,
  });
}

function linkedExecution(
  requestId: string,
  snapshotId: string,
  obligation: ProofCarryingObligation,
  claims: readonly EvidenceClaim[],
  observationsById: Map<string, Observation>,
): { state: ExecutionState; observationIds: Set<string> } {
  const linkedIds = new Set<string>();
  let hasRunning = false;
  let hasCompleted = false;
  let hasNotExecutable = false;
  for (const claim of claims) {
    if (
      claim.requestId !== requestId ||
      claim.snapshotId !== snapshotId ||
      claim.obligationId !== obligation.id ||
      !obligation.criterionIds.includes(claim.criterionId)
    ) continue;
    for (const observationId of claim.observationIds) {
      const observation = observationsById.get(observationId);
      if (!observation || observation.requestId !== requestId || observation.snapshotId !== snapshotId) continue;
      if (linkedIds.has(observationId)) continue;
      linkedIds.add(observationId);
      if (observation.execution.exitStatus === "blocked" || observation.execution.exitStatus === "cancelled" || observation.execution.exitStatus === "timed-out") {
        hasNotExecutable = true;
      } else if (observation.execution.exitStatus === "passed" || observation.execution.exitStatus === "failed") {
        hasCompleted = true;
      } else {
        hasRunning = true;
      }
    }
  }
  const state = hasNotExecutable ? "NOT_EXECUTABLE" : hasRunning ? "RUNNING" : hasCompleted ? "COMPLETED" : "PENDING";
  return { state, observationIds: linkedIds };
}

function resolveObligationOutcomeIndexed(
  input: { requestId: string; snapshotId: string; obligation: ProofCarryingObligation },
  indexes: GraphIndexes,
): ObligationState {
  const claims = indexes.claimsByObligation.get(input.obligation.id) ?? [];
  const execution = linkedExecution(input.requestId, input.snapshotId, input.obligation, claims, indexes.observationsById);
  const acceptedCriteria = new Set<string>();
  let hasEvaluation = false;
  let observedFailure = false;
  let independenceUnmet = false;

  for (const claim of claims) {
    const criterion = indexes.criteriaById.get(claim.criterionId);
    if (!criterion) continue;
    const claimInScope =
      claim.requestId === input.requestId &&
      claim.snapshotId === input.snapshotId &&
      claim.obligationId === input.obligation.id &&
      input.obligation.criterionIds.includes(claim.criterionId);
    const requiredIndependence = Math.max(
      independenceRank[input.obligation.requiredIndependence],
      independenceRank[criterion.requiredIndependence],
    );
    let claimContradicts = false;
    let hasTargetObservation = false;
    let allTargetObservations = true;
    for (const observationId of claim.observationIds) {
      const observation = indexes.observationsById.get(observationId);
      if (!observation) {
        allTargetObservations = false;
        continue;
      }
      const observationInScope = observation.requestId === input.requestId && observation.snapshotId === input.snapshotId;
      if (!claimInScope || !observationInScope) {
        allTargetObservations = false;
        continue;
      }
      hasTargetObservation = true;
      if (independenceRank[observation.producer.independence] < requiredIndependence) independenceUnmet = true;
      if (assertionContradicts(criterion, observation)) claimContradicts = true;
    }
    const evaluations = indexes.evaluationsByClaim.get(claim.claimId) ?? [];
    for (const evaluation of evaluations) {
      hasEvaluation = true;
      const evaluationInScope =
        claimInScope &&
        evaluation.requestId === input.requestId &&
        evaluation.snapshotId === input.snapshotId &&
        evaluation.claimId === claim.claimId;
      const acceptance = evaluateEvidenceIndexed({
        requestId: input.requestId,
        snapshotId: input.snapshotId,
        obligation: input.obligation,
        criterion,
        claim,
        evaluation,
        observationsById: indexes.observationsById,
      });
      if (acceptance.accepted) acceptedCriteria.add(criterion.criterionId);
      if (evaluationInScope && acceptance.rejectionReasons.includes("INDEPENDENCE_NOT_MET")) independenceUnmet = true;
      const negativeEvidenceEligible =
        evaluation.status === "REJECTED" &&
        evaluationInScope &&
        hasTargetObservation &&
        allTargetObservations &&
        evaluation.checks.snapshotBound &&
        evaluation.checks.fresh &&
        evaluation.checks.scopeComplete &&
        evaluation.checks.producerAllowed &&
        evaluation.checks.independenceSatisfied &&
        evaluation.checks.artifactRequirementsSatisfied &&
        evaluation.checks.integrityVerified &&
        acceptance.rejectionReasons.every(reason => reason === "EXPECTED_RESULT_NOT_DEMONSTRATED");
      if (negativeEvidenceEligible && (evaluation.checks.expectedResultViolated || claimContradicts)) {
        observedFailure = true;
      }
    }
  }

  let allAccepted = true;
  for (const criterionId of input.obligation.criterionIds) {
    if (!acceptedCriteria.has(criterionId)) {
      allAccepted = false;
      break;
    }
  }
  let evidence: EvidenceState;
  if (!hasEvaluation) evidence = "NONE";
  else if (allAccepted) evidence = "ACCEPTED";
  else if (acceptedCriteria.size > 0) evidence = "PARTIALLY_ACCEPTED";
  else evidence = "REJECTED";

  let outcome: ObligationOutcome;
  if (observedFailure) outcome = "FAILED";
  else if (allAccepted && claims.length > 0) outcome = "PASSED";
  else if (execution.state === "NOT_EXECUTABLE") {
    let blocked = false;
    for (const observationId of execution.observationIds) {
      if (indexes.observationsById.get(observationId)?.execution.exitStatus === "blocked") {
        blocked = true;
        break;
      }
    }
    outcome = blocked || independenceUnmet ? "BLOCKED" : "INCOMPLETE";
  } else if (independenceUnmet) outcome = "BLOCKED";
  else outcome = "INCOMPLETE";
  return { execution: execution.state, evidence, outcome };
}

export type ResolveObligationOutcomeInput = {
  requestId: string;
  snapshotId: string;
  obligation: ProofCarryingObligation;
  criteria: readonly SuccessCriterion[];
  claims: readonly EvidenceClaim[];
  evaluations: readonly EvidenceEvaluation[];
  observations: readonly Observation[];
};

export function resolveObligationOutcome(input: ResolveObligationOutcomeInput): ObligationState {
  const indexes = buildGraphIndexes([input.obligation], input.criteria, input.observations, input.claims, input.evaluations);
  return resolveObligationOutcomeIndexed(input, indexes);
}

export function resolveProofCarryingQaVerdict(input: ProofCarryingVerdictInput): VerdictResult {
  if (!input.requestId || !input.snapshotId) throw new Error("requestId and snapshotId are required");
  if (Number.isNaN(Date.parse(input.evaluatedAt))) throw new Error("evaluatedAt must be an ISO date-time");
  const indexes = buildGraphIndexes(input.obligations, input.criteria, input.observations, input.claims, input.evaluations);
  const traceabilityComplete = validTraceability(input, indexes);
  const mandatory = input.obligations.filter(item => item.mandatory);

  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let incomplete = 0;
  const satisfiedIds: string[] = [];
  for (const obligation of mandatory) {
    const state = resolveObligationOutcomeIndexed({ requestId: input.requestId, snapshotId: input.snapshotId, obligation }, indexes);
    if (state.outcome === "PASSED") {
      passed++;
      satisfiedIds.push(obligation.id);
    } else if (state.outcome === "FAILED") failed++;
    else if (state.outcome === "BLOCKED") blocked++;
    else incomplete++;
  }

  const openMaterial: string[] = [];
  const invalidAcceptance: string[] = [];
  const accepted: string[] = [];
  const defectIds = new Set<string>();
  for (const defect of input.defects) {
    if (defectIds.has(defect.id)) throw new Error(`duplicate defect ${defect.id}`);
    defectIds.add(defect.id);
    if (!defect.material) continue;
    if (defect.disposition === "OPEN") openMaterial.push(defect.id);
    else if (defect.disposition === "ACCEPTED_RISK") invalidAcceptance.push(defect.id);
  }
  openMaterial.sort();
  invalidAcceptance.sort();
  accepted.sort();

  const basisCoverage = coverage(input.coverage.basisIds, input.coverage.coveredBasisIds);
  const riskCoverage = coverage(input.coverage.riskIds, input.coverage.coveredRiskIds);
  const conditionCoverage = coverage(input.coverage.conditionIds, input.coverage.coveredConditionIds);
  const obligationCoverage = coverage(mandatory.map(item => item.id), satisfiedIds);
  const coverageIncomplete =
    !traceabilityComplete ||
    input.coverage.basisIds.length === 0 ||
    input.coverage.conditionIds.length === 0 ||
    basisCoverage.uncoveredIds.length > 0 ||
    riskCoverage.uncoveredIds.length > 0 ||
    conditionCoverage.uncoveredIds.length > 0;
  let qaVerdict: QaVerdict;
  let rationale: string;
  if (failed > 0 || openMaterial.length > 0) {
    qaVerdict = "FAIL";
    rationale = "A mandatory obligation failed or an unaccepted material defect remains.";
  } else if (blocked > 0 || invalidAcceptance.length > 0) {
    qaVerdict = "BLOCKED";
    rationale = "A mandatory obligation is blocked or material accepted risk lacks a canonical external approval record in the proof-carrying core.";
  } else if (incomplete > 0 || coverageIncomplete) {
    qaVerdict = "INCOMPLETE";
    rationale = "Mandatory evidence or required basis, risk, or condition coverage is incomplete.";
  } else if (accepted.length > 0) {
    qaVerdict = "PASS_WITH_ACCEPTED_RISK";
    rationale = "All mandatory obligations passed and remaining material risks have valid acceptance.";
  } else {
    qaVerdict = "PASS";
    rationale = "All mandatory obligations and required coverage passed with no unaccepted material risk.";
  }

  const openDefectIds = unique([...openMaterial, ...invalidAcceptance]);
  const residualRisks = unique([...openMaterial, ...invalidAcceptance, ...accepted]);
  return {
    schemaVersion: "qa-verdict/v1",
    requestId: input.requestId,
    snapshotId: input.snapshotId,
    qaVerdict,
    authoritative: false,
    obligationSummary: { mandatory: mandatory.length, passed, failed, blocked, incomplete },
    coverage: { basis: basisCoverage, risks: riskCoverage, conditions: conditionCoverage, mandatoryObligations: obligationCoverage },
    openDefectIds,
    acceptedRiskIds: accepted,
    residualRisks,
    rationale,
  };
}
export function resolveQaVerdict(input: VerdictInput): VerdictResult {
  if (!input.requestId || !input.snapshotId) throw new Error("requestId and snapshotId are required");
  if (Number.isNaN(Date.parse(input.evaluatedAt))) throw new Error("evaluatedAt must be an ISO date-time");

  const mandatory = input.obligations.filter(item => item.mandatory);
  const resultById = new Map<string, ObligationResult>();
  for (const result of input.results) {
    if (resultById.has(result.obligationId)) throw new Error(`duplicate result for ${result.obligationId}`);
    if (result.snapshotId !== input.snapshotId) throw new Error(`snapshot mismatch for ${result.obligationId}`);
    resultById.set(result.obligationId, result);
  }

  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let incomplete = 0;
  const satisfiedIds: string[] = [];

  for (const obligation of mandatory) {
    const result = resultById.get(obligation.id);
    if (!result) {
      incomplete++;
      continue;
    }
    if (result.status === "PASS" && independenceRank[result.producerIndependence] < independenceRank[obligation.requiredIndependence]) {
      blocked++;
      continue;
    }
    if (result.status === "PASS" && !result.evidenceId) {
      incomplete++;
      continue;
    }
    if (result.status === "PASS") {
      passed++;
      satisfiedIds.push(obligation.id);
    } else if (result.status === "FAIL") failed++;
    else if (result.status === "BLOCKED") blocked++;
    else incomplete++;
  }

  const openMaterial = input.defects.filter(defect => defect.material && defect.disposition === "OPEN");
  const invalidAcceptance = input.defects.filter(defect => defect.material && defect.disposition === "ACCEPTED_RISK" && !validAcceptance(defect, input.evaluatedAt));
  const accepted = input.defects.filter(defect => defect.material && validAcceptance(defect, input.evaluatedAt));

  const basisCoverage = coverage(input.coverage.basisIds, input.coverage.coveredBasisIds);
  const riskCoverage = coverage(input.coverage.riskIds, input.coverage.coveredRiskIds);
  const conditionCoverage = coverage(input.coverage.conditionIds, input.coverage.coveredConditionIds);
  const obligationCoverage = coverage(mandatory.map(item => item.id), satisfiedIds);
  const coverageIncomplete = [basisCoverage, riskCoverage, conditionCoverage].some(item => item.uncoveredIds.length > 0);

  let qaVerdict: QaVerdict;
  let rationale: string;
  if (failed > 0 || openMaterial.length > 0) {
    qaVerdict = "FAIL";
    rationale = "A mandatory obligation failed or an unaccepted material defect remains.";
  } else if (blocked > 0 || invalidAcceptance.length > 0) {
    qaVerdict = "BLOCKED";
    rationale = "A mandatory obligation is blocked or a material risk acceptance is missing or expired.";
  } else if (incomplete > 0 || coverageIncomplete) {
    qaVerdict = "INCOMPLETE";
    rationale = "Mandatory evidence or required basis, risk, or condition coverage is incomplete.";
  } else if (accepted.length > 0) {
    qaVerdict = "PASS_WITH_ACCEPTED_RISK";
    rationale = "All mandatory obligations passed and remaining material risks have valid acceptance.";
  } else {
    qaVerdict = "PASS";
    rationale = "All mandatory obligations and required coverage passed with no unaccepted material risk.";
  }

  return {
    schemaVersion: "qa-verdict/v1",
    requestId: input.requestId,
    snapshotId: input.snapshotId,
    qaVerdict,
    authoritative: false,
    obligationSummary: { mandatory: mandatory.length, passed, failed, blocked, incomplete },
    coverage: { basis: basisCoverage, risks: riskCoverage, conditions: conditionCoverage, mandatoryObligations: obligationCoverage },
    openDefectIds: unique([...openMaterial, ...invalidAcceptance].map(item => item.id)),
    acceptedRiskIds: unique(accepted.map(item => item.id)),
    residualRisks: unique([...openMaterial, ...invalidAcceptance, ...accepted].map(item => item.id)),
    rationale,
  };
}
