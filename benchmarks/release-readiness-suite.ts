import {
  type EvidenceClaim,
  type EvidenceEvaluation,
  type EvidenceRejectionReason,
  type Observation,
  type ProofCarryingObligation,
  type ProofCarryingVerdictInput,
  type SuccessCriterion,
  type TraceabilityLink,
} from "../system/core/qa-core";
import { sha256Digest, type ContextCacheKeyInput, type JsonValue } from "../system/runtime/context-plan";

const REQUEST_ID = "benchmark-request";
const SNAPSHOT_ID = "benchmark-snapshot-v1";
const EVALUATED_AT = "2026-08-01T00:00:00.000Z";
const LOG_DIGEST = "a".repeat(64);

export type BenchmarkOutcome =
  | "PASS"
  | "PASS_WITH_ACCEPTED_RISK"
  | "FAIL"
  | "BLOCKED"
  | "INCOMPLETE"
  | "REJECTED";
export type QualityCase = Readonly<{
  id: string;
  expected: BenchmarkOutcome;
  input: ProofCarryingVerdictInput;
}>;

type EntryOptions = Readonly<{
  suffix?: string;
  observationSnapshotId?: string;
  exitStatus?: Observation["execution"]["exitStatus"];
  evaluation?: "accepted" | "rejected" | "none";
  rejectionReasons?: readonly EvidenceRejectionReason[];
  checks?: Partial<EvidenceEvaluation["checks"]>;
}>;
type Entry = Readonly<{
  obligation: ProofCarryingObligation;
  criterion: SuccessCriterion;
  observation: Observation;
  claim: EvidenceClaim;
  evaluation?: EvidenceEvaluation;
}>;

function makeEntry(options: EntryOptions = {}): Entry {
  const suffix = options.suffix ?? "primary";
  const obligationId = `obligation-${suffix}`;
  const criterionId = `criterion-${suffix}`;
  const observationId = `observation-${suffix}`;
  const claimId = `claim-${suffix}`;
  const evaluationKind = options.evaluation ?? "accepted";
  const exitStatus = options.exitStatus ?? "passed";
  const expectedResultDemonstrated = exitStatus === "passed";
  const checks: EvidenceEvaluation["checks"] = {
    snapshotBound: true,
    fresh: true,
    scopeComplete: true,
    producerAllowed: true,
    independenceSatisfied: true,
    artifactRequirementsSatisfied: true,
    expectedResultDemonstrated,
    expectedResultViolated: false,
    integrityVerified: true,
    ...options.checks,
  };
  const criterion: SuccessCriterion = {
    schemaVersion: "success-criterion/v1",
    criterionId,
    kind: "structured-assertion",
    expected: {
      assertions: [{ field: "execution.exitStatus", operator: "equals", value: "passed" }],
    },
    requiredScope: { kind: "repository-canonical", selectors: ["system/core/qa-core.ts"] },
    requiredIndependence: "independent-producer",
    requiredArtifacts: ["log"],
  };
  const obligation: ProofCarryingObligation = {
    id: obligationId,
    mandatory: true,
    criterionIds: [criterionId],
    requiredIndependence: "independent-producer",
  };
  const observation: Observation = {
    schemaVersion: "observation/v1",
    observationId,
    requestId: REQUEST_ID,
    snapshotId: options.observationSnapshotId ?? SNAPSHOT_ID,
    producer: {
      kind: "ci",
      identity: "traceknot-benchmark",
      independence: "independent-producer",
    },
    execution: {
      kind: "command",
      identity: "traceknot benchmark fixture",
      startedAt: "2026-08-01T00:00:00.000Z",
      finishedAt: "2026-08-01T00:00:01.000Z",
      exitStatus,
      ...(exitStatus === "passed"
        ? { exitCode: 0 }
        : exitStatus === "failed"
          ? { exitCode: 1 }
          : {}),
    },
    artifacts: [{ type: "log", digest: LOG_DIGEST, path: "artifacts/benchmark.log" }],
  };
  const claim: EvidenceClaim = {
    schemaVersion: "evidence-claim/v1",
    claimId,
    requestId: REQUEST_ID,
    snapshotId: SNAPSHOT_ID,
    obligationId,
    criterionId,
    observationIds: [observationId],
    claim: "The canonical benchmark criterion passed.",
  };
  const evaluation = evaluationKind === "none" ? undefined : {
    schemaVersion: "evidence-evaluation/v1" as const,
    evaluationId: `evaluation-${suffix}`,
    requestId: REQUEST_ID,
    snapshotId: SNAPSHOT_ID,
    claimId,
    status: evaluationKind === "accepted" ? "ACCEPTED" as const : "REJECTED" as const,
    checks,
    rejectionReasons: options.rejectionReasons ?? [],
    evaluatedAt: EVALUATED_AT,
  };
  return { obligation, criterion, observation, claim, evaluation };
}

function graph(...entries: readonly Entry[]): ProofCarryingVerdictInput {
  return {
    requestId: REQUEST_ID,
    snapshotId: SNAPSHOT_ID,
    evaluatedAt: EVALUATED_AT,
    obligations: entries.map(entry => entry.obligation),
    criteria: entries.map(entry => entry.criterion),
    observations: entries.map(entry => entry.observation),
    claims: entries.map(entry => entry.claim),
    evaluations: entries.flatMap(entry => entry.evaluation === undefined ? [] : [entry.evaluation]),
    defects: [],
    coverage: {
      basisIds: ["basis-1"],
      coveredBasisIds: ["basis-1"],
      riskIds: ["risk-1"],
      coveredRiskIds: ["risk-1"],
      conditionIds: ["condition-1"],
      coveredConditionIds: ["condition-1"],
    },
    traceability: entries.map((entry): TraceabilityLink => ({
      schemaVersion: "traceability-link/v1",
      criterionId: entry.criterion.criterionId,
      conditionIds: ["condition-1"],
      basisIds: ["basis-1"],
      riskIds: ["risk-1"],
    })),
  };
}

const failed = () => makeEntry({
  suffix: "failed",
  exitStatus: "failed",
  evaluation: "rejected",
  rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
});
const blocked = () => makeEntry({
  suffix: "blocked",
  exitStatus: "blocked",
  evaluation: "rejected",
  rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
});
const incomplete = () => makeEntry({ suffix: "incomplete", evaluation: "none" });

const uncoveredBasis = graph(makeEntry());
uncoveredBasis.coverage = { ...uncoveredBasis.coverage, coveredBasisIds: [] };
const duplicateClaim = graph(makeEntry({ suffix: "duplicate-a" }), makeEntry({ suffix: "duplicate-b" }));
duplicateClaim.claims = [duplicateClaim.claims[0]!, duplicateClaim.claims[0]!];

const qualityCases: QualityCase[] = [
  { id: "blocked-precedes-incomplete", expected: "BLOCKED", input: graph(blocked(), incomplete()) },
  { id: "complete-proof-chain", expected: "PASS", input: graph(makeEntry()) },
  {
    id: "cross-snapshot-evidence",
    expected: "INCOMPLETE",
    input: graph(makeEntry({ observationSnapshotId: "benchmark-snapshot-v2" })),
  },
  { id: "duplicate-claim-rejected", expected: "REJECTED", input: duplicateClaim },
  {
    id: "fail-precedes-blocked-and-incomplete",
    expected: "FAIL",
    input: graph(failed(), blocked(), incomplete()),
  },
  { id: "missing-evaluation", expected: "INCOMPLETE", input: graph(incomplete()) },
  { id: "observed-criterion-contradiction", expected: "FAIL", input: graph(failed()) },
  { id: "required-execution-blocked", expected: "BLOCKED", input: graph(blocked()) },
  { id: "uncovered-basis", expected: "INCOMPLETE", input: uncoveredBasis },
];
export const QUALITY_CASES: readonly QualityCase[] = Object.freeze(
  qualityCases.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
);

const digest = (label: string) => sha256Digest(`traceknot-release-benchmark:${label}`);

export const CACHE_KEY_INPUT: ContextCacheKeyInput = Object.freeze({
  namespace: { visibility: "private", repositoryId: "benchmark-repository" },
  protocolDigest: digest("protocol"),
  schemaDigest: digest("schema"),
  policyDigest: digest("policy"),
  profileDigest: digest("profile"),
  relevantBasisDigest: digest("basis"),
  relevantSourceDigest: digest("source"),
  capabilityDigest: digest("capability"),
  toolchainDigest: digest("toolchain"),
  environmentDigest: digest("environment"),
} satisfies ContextCacheKeyInput);

export const CACHE_PAYLOAD: JsonValue = Object.freeze({
  schemaVersion: "release-benchmark-cache-payload/v1",
  verdict: "PASS",
  obligations: 9,
});

export const RELEVANT_CONTEXT = Object.freeze([
  { id: "basis", digest: digest("relevant-basis") },
  { id: "source", digest: digest("relevant-source") },
]);
