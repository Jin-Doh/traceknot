export type RiskLevel = "R0" | "R1" | "R2" | "R3";
export type IndependenceLevel = "self-check" | "separate-verification-context" | "independent-producer" | "external-approval";
export type ObligationStatus = "PASS" | "FAIL" | "BLOCKED" | "INCOMPLETE";
export type QaVerdict = "PASS" | "PASS_WITH_ACCEPTED_RISK" | "FAIL" | "BLOCKED" | "INCOMPLETE";

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
