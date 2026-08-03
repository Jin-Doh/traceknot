export type RiskLevel = "R0" | "R1" | "R2" | "R3";
export type IndependenceLevel = "self-check" | "separate-verification-context" | "independent-producer" | "external-approval";
export type QaVerdict = "PASS" | "PASS_WITH_ACCEPTED_RISK" | "FAIL" | "BLOCKED" | "INCOMPLETE";

export type VerificationObligation = {
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

export type Observation = {
  schemaVersion: "observation/v1";
  observationId: string;
  requestId: string;
  snapshotId: string;
  producer: Producer;
  execution: Execution;
  artifacts: readonly Artifact[];
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
    expectedResultDemonstrated: boolean;
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
  criteria: readonly SuccessCriterion[];
  observations: readonly Observation[];
  claims: readonly EvidenceClaim[];
  evaluations: readonly EvidenceEvaluation[];
  defects: readonly DefectSummary[];
  coverage: CoverageInput;
  evaluatedAt: string;
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
  if (!checks.scopeComplete) target.add("INSUFFICIENT_SCOPE");
  if (!checks.producerAllowed) target.add("UNTRUSTED_PRODUCER");
  if (!checks.independenceSatisfied) target.add("INDEPENDENCE_NOT_MET");
  if (!checks.expectedResultDemonstrated) target.add("EXPECTED_RESULT_NOT_DEMONSTRATED");
  if (!checks.integrityVerified) target.add("INTEGRITY_FAILURE");
}

function reasonArray(reasons: Set<EvidenceRejectionReason>): EvidenceRejectionReason[] {
  return [...reasons].sort();
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

function assertUniqueStrings(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label} ${value}`);
    seen.add(value);
  }
}

type GraphIndexes = {
  obligationsById: Map<string, VerificationObligation>;
  criteriaById: Map<string, SuccessCriterion>;
  observationsById: Map<string, Observation>;
  claimsById: Map<string, EvidenceClaim>;
  evaluationsById: Map<string, EvidenceEvaluation>;
  claimsByObligation: Map<string, EvidenceClaim[]>;
  evaluationsByClaim: Map<string, EvidenceEvaluation[]>;
};

function buildGraphIndexes(
  obligations: readonly VerificationObligation[],
  criteria: readonly SuccessCriterion[],
  observations: readonly Observation[],
  claims: readonly EvidenceClaim[],
  evaluations: readonly EvidenceEvaluation[],
): GraphIndexes {
  const obligationsById = assertUniqueIds(obligations, item => item.id, "obligation");
  const criteriaById = assertUniqueIds(criteria, item => item.criterionId, "criterion");
  const observationsById = assertUniqueIds(observations, item => item.observationId, "observation");
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
  for (const criterion of criteria) {
    assertUniqueStrings(criterion.requiredArtifacts, `required artifact in ${criterion.criterionId}`);
  }
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

type EvidenceEvaluationContext = {
  requestId: string;
  snapshotId: string;
  obligation: VerificationObligation;
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
  let observationCount = 0;
  for (const observationId of claim.observationIds) {
    const observation = input.observationsById.get(observationId);
    if (!observation) {
      reasons.add("MISSING_ARTIFACT");
      continue;
    }
    observationCount++;
    if (observation.requestId !== requestId || observation.snapshotId !== snapshotId) reasons.add("SNAPSHOT_MISMATCH");
    if (independenceRank[observation.producer.independence] < requiredIndependence) reasons.add("INDEPENDENCE_NOT_MET");
    for (const artifact of observation.artifacts) artifactTypes.add(artifact.type);
    if (observation.execution.exitStatus === "cancelled" || observation.execution.exitStatus === "timed-out") {
      reasons.add("EXPECTED_RESULT_NOT_DEMONSTRATED");
    }
  }
  if (observationCount === 0) reasons.add("MISSING_ARTIFACT");
  for (const artifactType of criterion.requiredArtifacts) {
    if (!artifactTypes.has(artifactType)) reasons.add("MISSING_ARTIFACT");
  }

  reasonsFromChecks(evaluation.checks, reasons);
  addReasons(reasons, evaluation.rejectionReasons);
  const checksPass =
    evaluation.checks.snapshotBound &&
    evaluation.checks.fresh &&
    evaluation.checks.scopeComplete &&
    evaluation.checks.producerAllowed &&
    evaluation.checks.independenceSatisfied &&
    evaluation.checks.expectedResultDemonstrated &&
    evaluation.checks.integrityVerified;
  const accepted = evaluation.status === "ACCEPTED" && checksPass && evaluation.rejectionReasons.length === 0 && reasons.size === 0;
  return { accepted, rejectionReasons: reasonArray(reasons) };
}

export type EvaluateEvidenceInput = {
  requestId: string;
  snapshotId: string;
  obligation: VerificationObligation;
  criterion: SuccessCriterion;
  claim: EvidenceClaim;
  evaluation: EvidenceEvaluation;
  observations: readonly Observation[];
};

export function evaluateEvidence(input: EvaluateEvidenceInput): EvidenceAcceptanceResult {
  assertUniqueStrings(input.claim.observationIds, `observation reference in ${input.claim.claimId}`);
  assertUniqueStrings(input.criterion.requiredArtifacts, `required artifact in ${input.criterion.criterionId}`);
  const observationsById = assertUniqueIds(input.observations, item => item.observationId, "observation");
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
  claims: readonly EvidenceClaim[],
  observationsById: Map<string, Observation>,
): { state: ExecutionState; observationIds: Set<string> } {
  const linkedIds = new Set<string>();
  let hasRunning = false;
  let hasCompleted = false;
  let hasNotExecutable = false;
  for (const claim of claims) {
    for (const observationId of claim.observationIds) {
      if (linkedIds.has(observationId)) continue;
      linkedIds.add(observationId);
      const observation = observationsById.get(observationId);
      if (!observation) continue;
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
  input: { requestId: string; snapshotId: string; obligation: VerificationObligation },
  indexes: GraphIndexes,
): ObligationState {
  const claims = indexes.claimsByObligation.get(input.obligation.id) ?? [];
  const execution = linkedExecution(claims, indexes.observationsById);
  const acceptedCriteria = new Set<string>();
  let hasEvaluation = false;
  let hasRejectedExpectedResult = false;
  let independenceUnmet = false;

  for (const claim of claims) {
    const criterion = indexes.criteriaById.get(claim.criterionId);
    if (!criterion) continue;
    const requiredIndependence = Math.max(
      independenceRank[input.obligation.requiredIndependence],
      independenceRank[criterion.requiredIndependence],
    );
    for (const observationId of claim.observationIds) {
      const observation = indexes.observationsById.get(observationId);
      if (observation && independenceRank[observation.producer.independence] < requiredIndependence) independenceUnmet = true;
    }
    const evaluations = indexes.evaluationsByClaim.get(claim.claimId) ?? [];
    for (const evaluation of evaluations) {
      hasEvaluation = true;
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
      if (acceptance.rejectionReasons.includes("EXPECTED_RESULT_NOT_DEMONSTRATED")) hasRejectedExpectedResult = true;
      if (acceptance.rejectionReasons.includes("INDEPENDENCE_NOT_MET")) independenceUnmet = true;
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
  if (execution.state === "COMPLETED" && hasRejectedExpectedResult) outcome = "FAILED";
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
  else if (allAccepted && claims.length > 0) outcome = "PASSED";
  else outcome = "INCOMPLETE";
  return { execution: execution.state, evidence, outcome };
}

export type ResolveObligationOutcomeInput = {
  requestId: string;
  snapshotId: string;
  obligation: VerificationObligation;
  criteria: readonly SuccessCriterion[];
  claims: readonly EvidenceClaim[];
  evaluations: readonly EvidenceEvaluation[];
  observations: readonly Observation[];
};

export function resolveObligationOutcome(input: ResolveObligationOutcomeInput): ObligationState {
  const indexes = buildGraphIndexes([input.obligation], input.criteria, input.observations, input.claims, input.evaluations);
  return resolveObligationOutcomeIndexed(input, indexes);
}

export function resolveQaVerdict(input: VerdictInput): VerdictResult {
  if (!input.requestId || !input.snapshotId) throw new Error("requestId and snapshotId are required");
  if (Number.isNaN(Date.parse(input.evaluatedAt))) throw new Error("evaluatedAt must be an ISO date-time");
  const indexes = buildGraphIndexes(input.obligations, input.criteria, input.observations, input.claims, input.evaluations);
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
    else if (defect.disposition === "ACCEPTED_RISK" && validAcceptance(defect, input.evaluatedAt)) accepted.push(defect.id);
    else if (defect.disposition === "ACCEPTED_RISK") invalidAcceptance.push(defect.id);
  }
  openMaterial.sort();
  invalidAcceptance.sort();
  accepted.sort();

  const basisCoverage = coverage(input.coverage.basisIds, input.coverage.coveredBasisIds);
  const riskCoverage = coverage(input.coverage.riskIds, input.coverage.coveredRiskIds);
  const conditionCoverage = coverage(input.coverage.conditionIds, input.coverage.coveredConditionIds);
  const obligationCoverage = coverage(mandatory.map(item => item.id), satisfiedIds);
  const coverageIncomplete = basisCoverage.uncoveredIds.length > 0 || riskCoverage.uncoveredIds.length > 0 || conditionCoverage.uncoveredIds.length > 0;

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
