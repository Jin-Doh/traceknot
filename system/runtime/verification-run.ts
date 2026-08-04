import { resolveProofCarryingQaVerdict, type Artifact, type CoverageInput, type DefectSummary, type EvidenceClaim, type EvidenceEvaluation, type Execution, type IndependenceLevel, type Observation, type ProofCarryingObligation, type Producer, type SuccessCriterion, type TraceabilityLink, type VerdictResult } from "../core/qa-core";
export type MaybePromise<T> = T | PromiseLike<T>; export type Clock = () => string | Date;
export const RUN_STATES=["CREATED","BASIS_ESTABLISHED","DISCOVERY_COMPLETED","PLANNED","EXECUTING","EVIDENCE_EVALUATED","VERDICT_RESOLVED","TERMINAL"] as const; export type RunState=(typeof RUN_STATES)[number];
export type CanonicalRunState=Readonly<{schemaVersion:"verification-run/v1";runId:string;requestId:string;rootIdentity:string;snapshotId:string;state:RunState;observationIds:readonly string[];claimIds:readonly string[];evaluationIds:readonly string[];revision:number;createdAt:string;updatedAt:string}>;
export type BasisKind="request"|"requirement"|"acceptance-criterion"|"defect"|"contract"|"invariant"|"policy"; export type BasisOrigin="explicit"|"derived";
export type VerificationBasisItem=Readonly<{id:string;kind:BasisKind;origin:BasisOrigin;text:string;source?:string}>;
export type VerificationRequest=Readonly<{schemaVersion:"verification-request/v1";requestId:string;project:Readonly<{rootIdentity:string;snapshotId:string}>;change:Readonly<{summary:string;paths:readonly string[]}>;testBasis:readonly VerificationBasisItem[]}>;
export type RiskLevel="R0"|"R1"|"R2"|"R3"; export type VerificationRisk=Readonly<{id:string;level:RiskLevel;impact:number;likelihood:number;basisIds:readonly string[];rationale:string}>;
export type VerificationCondition=Readonly<{id:string;basisIds:readonly string[];riskIds:readonly string[];techniques:readonly string[];expectedResult:string}>;
export type EvidenceType="experiment"|"test-result"|"browser-result"|"build-result"|"static-analysis"|"review"|"approval"|"scenario-result";
export type VerificationObligationPlan=Readonly<{id:string;conditionIds:readonly string[];evidenceType:EvidenceType;mandatory:boolean;independence:IndependenceLevel;entryCriteria:readonly string[];completionCriteria:readonly string[]}>;
export type VerificationPlan=Readonly<{schemaVersion:"verification-plan/v1";requestId:string;snapshotId:string;risks:readonly VerificationRisk[];conditions:readonly VerificationCondition[];obligations:readonly VerificationObligationPlan[]}>;
export type CanonicalVerificationResultArtifact=Readonly<{type:"verification-result";digest:string;path?:string}>;
export type VerificationEvidence=Readonly<{schemaVersion:"verification-evidence/v1";evidenceId:string;requestId:string;snapshotId:string;obligationId:string;producer:Producer;execution:Execution;result:Readonly<{verdict:"PASS"|"FAIL"|"BLOCKED"|"INCOMPLETE";summary:string;passed?:number;failed?:number;artifacts?:readonly string[]}>;observedAt:string}>;
export type VerificationExecutionRequest=Readonly<{runId:string;requestId:string;requestDigest:string;planDigest:string;obligationDigest:string;rootIdentity:string;snapshotId:string;obligation:VerificationObligationPlan;conditionIds:readonly string[];idempotencyKey:string}>;
export type VerificationExecutionOutput=Readonly<{status:"passed"|"failed"|"blocked"|"incomplete"|"PASS"|"FAIL"|"BLOCKED"|"INCOMPLETE";runId:string;requestId:string;snapshotId:string;idempotencyKey:string;producer:Producer;summary?:string;artifacts?:readonly Artifact[];executionKind?:Execution["kind"];identity?:string;exitCode?:number}>;
export type VerificationExecutionAuthorityBinding=Readonly<{runId:string;requestId:string;requestDigest:string;planDigest:string;obligationDigest:string;rootIdentity:string;snapshotId:string;obligationId:string;idempotencyKey:string;producer:Producer;execution:Execution;result:VerificationEvidence["result"];observedAt:string;artifacts:readonly CanonicalVerificationResultArtifact[]}>;
export type ExecutionAuthority=Readonly<{schemaVersion:"verification-execution-authority/v1";authorityId:string;issuer:string;binding:VerificationExecutionAuthorityBinding}>;
export type VerificationExecutionCompletionEnvelope=Readonly<{schemaVersion:"verification-execution-completion/v1";runId:string;requestId:string;rootIdentity:string;snapshotId:string;planDigest:string;obligationId:string;idempotencyKey:string;output:VerificationExecutionOutput;authority:ExecutionAuthority}>;
export type FreshnessAuthorityBinding=Readonly<{schemaVersion:"verification-freshness-binding/v1";requestId:string;snapshotId:string;planDigest:string;executionDigest:string;freshnessEvaluatedAt:string;evaluationIds:readonly string[];evaluationsDigest:string;acceptedClaimIds:readonly string[];coverage:CoverageInput}>;
export type FreshnessAuthority=Readonly<{schemaVersion:"verification-freshness-authority/v1";authorityId:string;issuer:string;binding:FreshnessAuthorityBinding}>;
export interface FreshnessAuthorityPort {readonly issueFreshnessAuthority?:(i:FreshnessAuthorityBinding)=>MaybePromise<FreshnessAuthority|undefined>;readonly issue?:(i:FreshnessAuthorityBinding)=>MaybePromise<FreshnessAuthority|undefined>;readonly verifyFreshnessAuthority?:(a:FreshnessAuthority,i:FreshnessAuthorityBinding)=>MaybePromise<boolean|FreshnessAuthority|undefined>;readonly verify?:(a:FreshnessAuthority,i:FreshnessAuthorityBinding)=>MaybePromise<boolean|FreshnessAuthority|undefined>};
export interface ExecutionAuthorityPort {readonly issueExecutionAuthority?:(i:VerificationExecutionAuthorityBinding)=>MaybePromise<ExecutionAuthority|undefined>;readonly issueAuthority?:(i:VerificationExecutionAuthorityBinding)=>MaybePromise<ExecutionAuthority|undefined>;readonly issue?:(i:VerificationExecutionAuthorityBinding)=>MaybePromise<ExecutionAuthority|undefined>;readonly verifyExecutionAuthority?:(a:ExecutionAuthority,i:VerificationExecutionAuthorityBinding)=>MaybePromise<boolean|ExecutionAuthority|undefined>;readonly verifyAuthority?:(a:ExecutionAuthority,i:VerificationExecutionAuthorityBinding)=>MaybePromise<boolean|ExecutionAuthority|undefined>;readonly verify?:(a:ExecutionAuthority,i:VerificationExecutionAuthorityBinding)=>MaybePromise<boolean|ExecutionAuthority|undefined>};
export type FreshnessStatus = "fresh" | "stale" | "unknown";
export type FreshnessEvaluationInput = Readonly<{observation:Observation;evidence:VerificationEvidence;evaluatedAt:string}>;
export interface FreshnessPolicy {readonly evaluateFreshness?:(input:FreshnessEvaluationInput)=>MaybePromise<FreshnessStatus>;readonly evaluate?:(input:FreshnessEvaluationInput)=>MaybePromise<FreshnessStatus>};
export type FreshnessPolicyPort = FreshnessPolicy;
export type BrowserExecutionRequest=VerificationExecutionRequest; export type BrowserExecutionOutput=VerificationExecutionOutput; export type StoredArtifact=CanonicalVerificationResultArtifact; export type ApprovalRequest=Readonly<{runId:string;defect:DefectSummary}>; export type ApprovalResult=Readonly<{approved:boolean;acceptanceExpiresAt?:string}>; export type UsageEvent=Readonly<{runId:string;obligationId?:string;event:"execution"|"artifact"|"approval";executionKey?:string;eventKey?:string}>;
export type StageName="request"|"basis"|"discovery"|"plan"|"execution"|"evidence"|"residual-risk"|"verdict";
export interface VerificationExecutor {readonly atomicSameKeyIdempotency?:true;readonly executeObligation?:(i:VerificationExecutionRequest)=>MaybePromise<VerificationExecutionOutput|undefined>;readonly execute?:(i:VerificationExecutionRequest)=>MaybePromise<VerificationExecutionOutput|undefined>};
export interface ArtifactStore {readonly storeVerificationResultArtifact?:(a:CanonicalVerificationResultArtifact,i:VerificationExecutionRequest)=>MaybePromise<Artifact>;readonly storeArtifact?:(a:Artifact,i:VerificationExecutionRequest)=>MaybePromise<Artifact>;readonly putArtifact?:(a:Artifact,i:VerificationExecutionRequest)=>MaybePromise<Artifact>;readonly store?:(a:Artifact,i:VerificationExecutionRequest)=>MaybePromise<Artifact>};
export interface CapabilityProvider {readonly hasCapability?:(s:string)=>MaybePromise<boolean>;readonly has?:(s:string)=>MaybePromise<boolean>;readonly getCapabilities?:()=>MaybePromise<readonly string[]>;readonly capabilities?:readonly string[]};
export interface BrowserExecutor {readonly atomicSameKeyIdempotency?:true;readonly executeBrowser?:(i:BrowserExecutionRequest)=>MaybePromise<BrowserExecutionOutput|undefined>;readonly execute?:(i:BrowserExecutionRequest)=>MaybePromise<BrowserExecutionOutput|undefined>};
export interface ApprovalProvider {readonly requestApproval?:(i:ApprovalRequest)=>MaybePromise<ApprovalResult|undefined>;readonly approve?:(i:ApprovalRequest)=>MaybePromise<ApprovalResult|undefined>};
export interface UsageRecorder {readonly atomicSameKeyIdempotency?:true;readonly recordUsage?:(e:UsageEvent)=>MaybePromise<void>;readonly record?:(e:UsageEvent)=>MaybePromise<void>};
export type DispatchClaim=Readonly<{schemaVersion:"verification-dispatch-claim/v1";claimKey:string;acquisitionId:string;runId:string;requestId:string;rootIdentity:string;snapshotId:string;planDigest:string;obligationId:string;idempotencyKey:string;ownerId:string;leaseGeneration:number;leaseExpiresAt:string}>;
export type DispatchClaimResult=Readonly<{claimed:boolean;status:"CLAIMED"|"COMPLETED";claim:DispatchClaim;outputStored:boolean;completion?:VerificationExecutionCompletionEnvelope}>;
/** A repository may throw this only after durably persisting the supplied claim identity for this attempt token. */
export class DispatchClaimAcquisitionError extends Error {
  readonly claim: DispatchClaim;
  readonly token: symbol;
  constructor(message: string, claim: DispatchClaim, token: symbol) {
    super(message);
    this.name = "DispatchClaimAcquisitionError";
    this.claim = claim;
    this.token = token;
  }
}
export type RepositoryTransition=Readonly<{runId:string;expectedRevision?:number;stage?:StageName;document?:StageDocument;run:CanonicalRunState}>;
export interface RepositoryPort {readonly loadRun:(id:string)=>MaybePromise<CanonicalRunState|undefined>;readonly loadStageDocument:(id:string,s:StageName)=>MaybePromise<unknown|undefined>;readonly commitTransition:(transition:RepositoryTransition)=>MaybePromise<boolean>;readonly claimExecutionDispatch?:(claim:DispatchClaim,now?:string,attemptToken?:symbol)=>MaybePromise<DispatchClaimResult>;readonly completeExecutionDispatch?:(claim:DispatchClaim,completion:VerificationExecutionCompletionEnvelope|undefined,now?:string)=>MaybePromise<boolean>;readonly releaseExecutionDispatch?:(claim:DispatchClaim,now?:string)=>MaybePromise<boolean>};
export type TerminalEvidenceVerdictTransition=Readonly<{runId:string;expectedRevision?:number;evidence:EvidenceDocument;verdict:VerdictDocument;run:CanonicalRunState}>;
export interface RepositoryPort {readonly commitEvidenceAndVerdict?:(transition:TerminalEvidenceVerdictTransition)=>MaybePromise<boolean>};
export type VerificationRunDependencies=Readonly<{repository:RepositoryPort;executor:VerificationExecutor;artifactStore:ArtifactStore;capabilityProvider:CapabilityProvider;executionAuthority:ExecutionAuthorityPort;freshnessPolicy:FreshnessPolicy;freshnessAuthority:FreshnessAuthorityPort;browserExecutor?:BrowserExecutor;approvalProvider?:ApprovalProvider;usageRecorder?:UsageRecorder;now:Clock;dispatchOwnerId?:string;ownerId?:string;dispatchLeaseDurationMs?:number;leaseDurationMs?:number}>;
export type BasisDocument=Readonly<{schemaVersion:"verification-basis/v1";requestId:string;snapshotId:string;basis:readonly VerificationBasisItem[];basisIds:readonly string[]}>; export type DiscoveryDocument=Readonly<{schemaVersion:"risk-discovery/v1";requestId:string;snapshotId:string;risks:readonly VerificationRisk[];conditions:readonly VerificationCondition[]}>; export type PlanDocument=VerificationPlan; export type UsageOutboxEntry=Readonly<{executionKey:string;obligationId:string;event:"execution"|"artifact";eventKey:string}>; export type ExecutionDocument=Readonly<{schemaVersion:"verification-execution/v1";requestId:string;snapshotId:string;observations:readonly Observation[];claims:readonly EvidenceClaim[];evidence:readonly VerificationEvidence[];authorities:readonly ExecutionAuthority[];usageOutbox:readonly UsageOutboxEntry[]}>; export type EvidenceDocument=Readonly<{schemaVersion:"verification-evidence-evaluation/v1";requestId:string;snapshotId:string;freshnessEvaluatedAt:string;freshnessAuthority:FreshnessAuthority;evaluations:readonly EvidenceEvaluation[];acceptedClaimIds:readonly string[];coverage:CoverageInput}>; export type ResidualRiskDocument=Readonly<{schemaVersion:"verification-residual-risk/v1";requestId:string;snapshotId:string;defects:readonly DefectSummary[]}>; export type VerdictDocument=VerdictResult; export type StageDocument=VerificationRequest|BasisDocument|DiscoveryDocument|PlanDocument|ExecutionDocument|EvidenceDocument|ResidualRiskDocument|VerdictDocument;
export type VerificationRunDocuments={request?:VerificationRequest;basis?:BasisDocument;discovery?:DiscoveryDocument;plan?:PlanDocument;execution?:ExecutionDocument;evidence?:EvidenceDocument;"residual-risk"?:ResidualRiskDocument;verdict?:VerdictDocument};
export type EstablishTestBasisInput=Readonly<{runId?:string;request:VerificationRequest;dependencies:VerificationRunDependencies}>; export type PerformRiskDiscoveryInput=Readonly<{request:VerificationRequest;basis:BasisDocument;dependencies:VerificationRunDependencies}>; export type BuildVerificationPlanInput=Readonly<{request:VerificationRequest;basis:BasisDocument;discovery:DiscoveryDocument;dependencies:VerificationRunDependencies}>; type ExecuteObligationsInput=Readonly<{runId:string;request:VerificationRequest;plan:VerificationPlan;dependencies:VerificationRunDependencies;checkpoint?:ExecutionDocument;checkpointRunState:RunState;checkpointRevision:number}>; type EvaluateEvidenceInput=Readonly<{runId:string;request:VerificationRequest;plan:VerificationPlan;execution:ExecutionDocument;dependencies:VerificationRunDependencies;freshnessEvaluatedAt?:string;freshnessAuthority?:FreshnessAuthority}>; type EvaluateResidualRiskInput=Readonly<{runId:string;request:VerificationRequest;plan:VerificationPlan;execution:ExecutionDocument;evidence:EvidenceDocument;dependencies:VerificationRunDependencies}>; type ResolveVerdictInput=Readonly<{runId:string;request:VerificationRequest;basis:BasisDocument;discovery:DiscoveryDocument;plan:PlanDocument;execution:ExecutionDocument;evidence:EvidenceDocument;residualRisk:ResidualRiskDocument;dependencies:VerificationRunDependencies}>; export type RunVerificationInput=Readonly<{runId:string;request?:VerificationRequest;dependencies:VerificationRunDependencies}>; export type RunVerificationResult=Readonly<{run:CanonicalRunState;verdict:VerdictResult;documents:VerificationRunDocuments}>;
type ExecuteObligationsResult=Readonly<{document:ExecutionDocument;checkpointRevision:number}>;

const DIGEST = /^[0-9a-fA-F]{64}$/;
const REQUEST_DIGEST = /^[0-9a-f]{64}$/;
const ACQUISITION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uniq = (xs: readonly string[]): string[] => [...new Set(xs)].sort();
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJsonValue(value[key])]));
  return value;
}
export function canonicalizeJson(value: unknown): string {
  const result = JSON.stringify(canonicalJsonValue(value));
  if (result === undefined) throw new Error("cannot canonicalize value");
  return result;
}
function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => structurallyEqual(item, right[index]));
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && structurallyEqual(left[key], right[key]));
  }
  return false;
}
const BASIS_KINDS: readonly BasisKind[] = ["request", "requirement", "acceptance-criterion", "defect", "contract", "invariant", "policy"];
const PRODUCER_KINDS: readonly Producer["kind"][] = ["self", "harness-managed", "deterministic-verifier", "ci", "human", "external-system"];
const INDEPENDENCE_LEVELS: readonly IndependenceLevel[] = ["self-check", "separate-verification-context", "independent-producer", "external-approval"];
const EXECUTION_KINDS: readonly Execution["kind"][] = ["command", "browser", "review", "experiment", "approval"];
const EXIT_STATUSES: readonly Execution["exitStatus"][] = ["passed", "failed", "blocked", "cancelled", "timed-out"];
function exactOwnKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.length >= required.length && keys.length <= allowed.size && keys.every(key => allowed.has(key)) && required.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function canonicalProducer(value: unknown): Producer | undefined {
  if (!isRecord(value) || !PRODUCER_KINDS.includes(value.kind as Producer["kind"]) || typeof value.identity !== "string" || !value.identity || !INDEPENDENCE_LEVELS.includes(value.independence as IndependenceLevel)) return undefined;
  if (value.kind === "self" && value.independence !== "self-check") return undefined;
  return { kind: value.kind as Producer["kind"], identity: value.identity, independence: value.independence as IndependenceLevel };
}
function validProducer(value: unknown): value is Producer {
  return isRecord(value) && exactOwnKeys(value, ["kind", "identity", "independence"]) && canonicalProducer(value) !== undefined;
}
function canonicalArtifact(value: unknown): CanonicalVerificationResultArtifact | undefined {
  if (!isRecord(value) || !exactOwnKeys(value, ["type", "digest"], ["path"]) || value.type !== "verification-result" || typeof value.digest !== "string" || !DIGEST.test(value.digest) || (value.path !== undefined && (typeof value.path !== "string" || !value.path))) return undefined;
  return { type: "verification-result", digest: value.digest.toLowerCase(), ...(value.path === undefined ? {} : { path: value.path }) };
}
function validArtifact(value: unknown): value is CanonicalVerificationResultArtifact {
  return canonicalArtifact(value) !== undefined && isRecord(value) && value.digest === (value.digest as string).toLowerCase();
}
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value));
function canonicalExecution(value: unknown): Execution | undefined {
  if (!isRecord(value) || !EXECUTION_KINDS.includes(value.kind as Execution["kind"]) || typeof value.identity !== "string" || !value.identity || !validDate(value.startedAt) || !validDate(value.finishedAt) || !EXIT_STATUSES.includes(value.exitStatus as Execution["exitStatus"]) || (value.exitCode !== undefined && (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode)))) return undefined;
  const startedAt = Date.parse(value.startedAt);
  const finishedAt = Date.parse(value.finishedAt);
  if (finishedAt < startedAt) return undefined;
  return { kind: value.kind as Execution["kind"], identity: value.identity, startedAt: value.startedAt, finishedAt: value.finishedAt, exitStatus: value.exitStatus as Execution["exitStatus"], ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }) };
}
function validExecution(value: unknown): value is Execution {
  return isRecord(value) && exactOwnKeys(value, ["kind", "identity", "startedAt", "finishedAt", "exitStatus"], ["exitCode"]) && canonicalExecution(value) !== undefined;
}
function validObservation(value: unknown): value is Observation {
  if (!isRecord(value) || !exactOwnKeys(value, ["schemaVersion", "observationId", "requestId", "snapshotId", "producer", "execution", "artifacts"], ["actualValues"]) || "actualValues" in value || value.schemaVersion !== "observation/v1" || typeof value.observationId !== "string" || !value.observationId || typeof value.requestId !== "string" || !value.requestId || typeof value.snapshotId !== "string" || !value.snapshotId || !validProducer(value.producer) || !validExecution(value.execution) || !Array.isArray(value.artifacts) || value.artifacts.some(artifact => !validArtifact(artifact))) return false;
  return true;
}
export function validEvidenceClaim(value: unknown): value is EvidenceClaim {
  return isRecord(value) &&
    exactOwnKeys(value, ["schemaVersion", "claimId", "requestId", "snapshotId", "obligationId", "criterionId", "observationIds", "claim"]) &&
    value.schemaVersion === "evidence-claim/v1" &&
    typeof value.claimId === "string" && Boolean(value.claimId) &&
    typeof value.requestId === "string" && Boolean(value.requestId) &&
    typeof value.snapshotId === "string" && Boolean(value.snapshotId) &&
    typeof value.obligationId === "string" && Boolean(value.obligationId) &&
    typeof value.criterionId === "string" && Boolean(value.criterionId) &&
    typeof value.claim === "string" && Boolean(value.claim) &&
    Array.isArray(value.observationIds) &&
    value.observationIds.length > 0 &&
    value.observationIds.every(item => typeof item === "string" && Boolean(item)) &&
    new Set(value.observationIds).size === value.observationIds.length;
}
function validBasisItem(value: unknown): value is VerificationBasisItem {
  return isRecord(value) && exactOwnKeys(value, ["id", "kind", "origin", "text"], ["source"]) && typeof value.id === "string" && Boolean(value.id) && BASIS_KINDS.includes(value.kind as BasisKind) && (value.origin === "explicit" || value.origin === "derived") && typeof value.text === "string" && Boolean(value.text) && (value.source === undefined || (typeof value.source === "string" && Boolean(value.source)));
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}
function clockNow(clock: Clock): string {
  const value = clock();
  const result = value instanceof Date ? value.toISOString() : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(result) || Number.isNaN(Date.parse(result))) throw new Error("clock must return canonical ISO date-time");
  return result;
}
function validRequest(request: unknown): void {
  if (!isRecord(request) || !exactOwnKeys(request, ["schemaVersion", "requestId", "project", "change", "testBasis"]) || request.schemaVersion !== "verification-request/v1" || typeof request.requestId !== "string" || !request.requestId || !isRecord(request.project) || !exactOwnKeys(request.project, ["rootIdentity", "snapshotId"]) || typeof request.project.rootIdentity !== "string" || !request.project.rootIdentity || typeof request.project.snapshotId !== "string" || !request.project.snapshotId || !isRecord(request.change) || !exactOwnKeys(request.change, ["summary", "paths"]) || typeof request.change.summary !== "string" || !request.change.summary || !Array.isArray(request.change.paths) || request.change.paths.length < 1 || request.change.paths.some(path => typeof path !== "string" || !path) || new Set(request.change.paths as string[]).size !== request.change.paths.length || !Array.isArray(request.testBasis) || request.testBasis.length < 1 || request.testBasis.some(item => !validBasisItem(item)) || new Set(request.testBasis.map(item => (item as VerificationBasisItem).id)).size !== request.testBasis.length) throw new Error("invalid verification request");
}
function canonicalSha256(value: unknown): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalizeJson(value));
  return hasher.digest("hex");
}
export function canonicalRequestDigest(request: VerificationRequest): string {
  validRequest(request);
  return canonicalSha256(request);
}
export function canonicalPlanDigest(plan: VerificationPlan): string {
  return canonicalSha256(plan);
}
export function canonicalObligationDigest(obligation: VerificationObligationPlan): string {
  return canonicalSha256(obligation);
}
function canonicalBasis(request: VerificationRequest): BasisDocument {
  const basis = [...request.testBasis].map(item => ({ ...item })).sort((a, b) => a.id.localeCompare(b.id));
  const ids = basis.map(item => item.id);
  if (!ids.length || ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error("test basis must contain unique IDs");
  return { schemaVersion: "verification-basis/v1", requestId: request.requestId, snapshotId: request.project.snapshotId, basis, basisIds: uniq(ids) };
}
export function createInitialRun(runId: string, request: VerificationRequest, now: string): CanonicalRunState {
  validRequest(request);
  if (!runId || !validDate(now)) throw Error("runId and now are required");
  return freeze({ schemaVersion: "verification-run/v1", runId, requestId: request.requestId, rootIdentity: request.project.rootIdentity, snapshotId: request.project.snapshotId, state: "CREATED", observationIds: [], claimIds: [], evaluationIds: [], revision: 0, createdAt: now, updatedAt: now });
}
function assertCanonicalRun(value: unknown, expectedRunId?: string): asserts value is CanonicalRunState {
  const sortedUnique = (ids: readonly unknown[]): boolean => ids.every((id, index) => typeof id === "string" && Boolean(id) && (index === 0 || (typeof ids[index - 1] === "string" && (ids[index - 1] as string).localeCompare(id) < 0)));
  if (!isRecord(value) || !exactOwnKeys(value, ["schemaVersion", "runId", "requestId", "rootIdentity", "snapshotId", "state", "observationIds", "claimIds", "evaluationIds", "revision", "createdAt", "updatedAt"]) || value.schemaVersion !== "verification-run/v1" || (expectedRunId !== undefined && value.runId !== expectedRunId) || typeof value.runId !== "string" || !value.runId || typeof value.requestId !== "string" || !value.requestId || typeof value.rootIdentity !== "string" || !value.rootIdentity || typeof value.snapshotId !== "string" || !value.snapshotId || !RUN_STATES.includes(value.state as RunState) || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0 || !validDate(value.createdAt) || !validDate(value.updatedAt) || Date.parse(value.updatedAt) < Date.parse(value.createdAt) || !Array.isArray(value.observationIds) || !Array.isArray(value.claimIds) || !Array.isArray(value.evaluationIds) || [value.observationIds, value.claimIds, value.evaluationIds].some(ids => !sortedUnique(ids))) throw new Error("invalid persisted run");
}
export function transitionRunState(run: CanonicalRunState, nextState: RunState, updatedAt: string): CanonicalRunState {
  assertCanonicalRun(run);
  const current = RUN_STATES.indexOf(run.state);
  const next = RUN_STATES.indexOf(nextState);
  if (current < 0 || next !== current + 1) throw new Error(`invalid run transition ${run.state} -> ${nextState}`);
  if (!validDate(updatedAt) || Date.parse(updatedAt) < Date.parse(run.updatedAt)) throw new Error("updatedAt must be canonical and monotonic");
  return freeze({ schemaVersion: "verification-run/v1", runId: run.runId, requestId: run.requestId, rootIdentity: run.rootIdentity, snapshotId: run.snapshotId, state: nextState, observationIds: [...run.observationIds], claimIds: [...run.claimIds], evaluationIds: [...run.evaluationIds], revision: run.revision + 1, createdAt: run.createdAt, updatedAt });
}
export const transitionRun = transitionRunState;
function criteriaFor(plan: VerificationPlan): readonly SuccessCriterion[] {
  return plan.obligations.map(item => ({ schemaVersion: "success-criterion/v1" as const, criterionId: `criterion:${item.id}`, kind: "structured-assertion" as const, expected: { assertions: [{ field: "execution.exitStatus", operator: "equals" as const, value: "passed" }] }, requiredScope: { kind: "repository-canonical" as const, selectors: [plan.requestId] }, requiredIndependence: item.independence, requiredArtifacts: ["verification-result"] }));
}
function proofObligations(plan: VerificationPlan): readonly ProofCarryingObligation[] {
  return plan.obligations.map(item => ({ id: item.id, mandatory: item.mandatory, criterionIds: [`criterion:${item.id}`], requiredIndependence: item.independence }));
}
function traceLinks(plan: VerificationPlan, discovery: DiscoveryDocument): readonly TraceabilityLink[] {
  const byId = new Map(discovery.conditions.map(item => [item.id, item]));
  return plan.obligations.map(item => {
    const conditionIds = uniq(item.conditionIds);
    return { schemaVersion: "traceability-link/v1" as const, criterionId: `criterion:${item.id}`, conditionIds, basisIds: uniq(conditionIds.flatMap(id => byId.get(id)?.basisIds ?? [])), riskIds: uniq(conditionIds.flatMap(id => byId.get(id)?.riskIds ?? [])) };
  });
}
export async function establishTestBasis(input: EstablishTestBasisInput): Promise<BasisDocument> {
  validRequest(input.request);
  return freeze(canonicalBasis(input.request));
}
function material(item: VerificationBasisItem): string { return `${item.id} ${item.kind} ${item.text} ${item.source ?? ""}`.toLowerCase(); }
function requestMaterial(request: VerificationRequest): string {
  return [
    request.change.summary,
    ...request.change.paths,
  ].join(" ").toLowerCase();
}
function riskLevel(item: VerificationBasisItem, request: VerificationRequest): RiskLevel {
  const text = `${material(item)} ${requestMaterial(request)}`;
  if (/\b(release|migration|migrat\w*|persistence|persist\w*|destructive|delet\w*|drop|truncate|destroy\w*|irreversible|production|prod(?:uction)?|infrastructure|infra|deployment|deploy\w*|rollout|security|auth(?:entication|orization)?|credential(?:s)?|inject\w*)\b/.test(text) ||
      /\bunknown\s+(?:material\s+)?scope\b|\bmaterial(?:ly)?\s+unknown\s+scope\b|\bmaterial\s+scope\s+(?:is\s+)?(?:unknown|uncertain|undetermined|unbounded)\b|\bscope\s+(?:is\s+)?(?:materially\s+)?(?:unknown|uncertain|undetermined|unbounded)\b/.test(text)) return "R3";
  if (["contract", "invariant", "defect", "policy", "acceptance-criterion", "requirement"].includes(item.kind) ||
      /\b(runtime|concurr\w*|parallel\w*|race|retry|retries|recover\w*|browser|web|ui|visual|flow|frontend|front-end|orchestrat\w*|resume|checkpoint|snapshot|executor|capability|crash|timeout|cancel|idempot\w*)\b/.test(text)) return "R2";
  return "R1";
}
function browserMaterial(value: string): boolean { return /\b(browser|web|ui|visual|flow|frontend|front-end)\b/.test(value); }

function canonicalDiscovery(request: VerificationRequest, basis: BasisDocument): DiscoveryDocument {
  validRequest(request);
  const canonical = canonicalBasis(request);
  if (!structurallyEqual(basis, canonical)) throw Error("invalid discovery basis canonicalization");
  const risks = canonical.basis.map(item => { const level = riskLevel(item, request); const score = level === "R3" ? 3 : level === "R2" ? 2 : 1; return { id: `risk:${item.id}`, level, impact: score, likelihood: score, basisIds: [item.id], rationale: `Verification risk derived from ${level} basis ${item.id}.` }; }).sort((a, b) => a.id.localeCompare(b.id));
  const conditions = canonical.basis.map(item => { const techniques = browserMaterial(material(item)) ? ["browser-verification", "canonical-verification"] : ["canonical-verification"]; if (riskLevel(item, request) === "R3") techniques.push("independent-producer"); return { id: `condition:${item.id}`, basisIds: [item.id], riskIds: [`risk:${item.id}`], techniques: uniq(techniques), expectedResult: `Evidence demonstrates ${item.id}.` }; });
  if (!canonical.basis.some(item => browserMaterial(material(item))) && browserMaterial(requestMaterial(request))) {
    const basisIds = canonical.basis.map(item => item.id).sort((a, b) => a.localeCompare(b));
    const riskIds = risks.map(item => item.id).sort((a, b) => a.localeCompare(b));
    const baseId = "condition:request-browser";
    const requestConditionId = (() => {
      if (!conditions.some(item => item.id === baseId)) return baseId;
      const digest = canonicalRequestDigest(request);
      let suffix = 0;
      let candidate = `${baseId}:${digest}`;
      while (conditions.some(item => item.id === candidate)) candidate = `${baseId}:${digest}:${++suffix}`;
      return candidate;
    })();
    conditions.push({ id: requestConditionId, basisIds, riskIds, techniques: ["browser-verification", "canonical-verification"], expectedResult: "Evidence demonstrates the request-level browser change." });
  }
  conditions.sort((a, b) => a.id.localeCompare(b.id));
  return freeze({ schemaVersion: "risk-discovery/v1", requestId: request.requestId, snapshotId: request.project.snapshotId, risks, conditions });
}

export async function performRiskDiscovery(input: PerformRiskDiscoveryInput): Promise<DiscoveryDocument> {
  return canonicalDiscovery(input.request, input.basis);
}
export async function buildVerificationPlan(input: BuildVerificationPlanInput): Promise<PlanDocument> {
  validRequest(input.request);
  const canonical = canonicalDiscovery(input.request, input.basis);
  if (!structurallyEqual(canonical, input.discovery)) throw Error("invalid discovery canonicalization");
  const risks = [...input.discovery.risks].sort((a, b) => a.id.localeCompare(b.id));
  const conditions = [...input.discovery.conditions].sort((a, b) => a.id.localeCompare(b.id));
  const obligations = conditions.map(item => {
    const levels = item.riskIds.map(id => risks.find(risk => risk.id === id)?.level);
    const materialRisk = levels.some(level => level === "R2" || level === "R3");
    return { id: `obligation:${item.id}`, conditionIds: [item.id], evidenceType: item.techniques.includes("browser-verification") ? "browser-result" as const : "test-result" as const, mandatory: true, independence: materialRisk ? "independent-producer" as const : "separate-verification-context" as const, entryCriteria: [], completionCriteria: [item.expectedResult] };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return freeze({ schemaVersion: "verification-plan/v1", requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, risks, conditions, obligations });
}
function capabilityFor(obligation: VerificationObligationPlan): string { return obligation.evidenceType === "browser-result" ? "browser" : obligation.evidenceType; }
async function hasCapability(provider: CapabilityProvider, name: string): Promise<boolean> {
  if (provider.hasCapability) return Boolean(await provider.hasCapability(name));
  if (provider.has) return Boolean(await provider.has(name));
  const capabilities = provider.getCapabilities ? await provider.getCapabilities() : provider.capabilities;
  return Boolean(capabilities?.includes(name));
}
async function record(provider: UsageRecorder | undefined, event: UsageEvent): Promise<void> { if (provider?.recordUsage) await provider.recordUsage(event); else if (provider?.record) await provider.record(event); }
function usageRecorderConfigured(provider: UsageRecorder | undefined): boolean { return Boolean(provider?.recordUsage || provider?.record); }
function usageEventKey(executionKey: string, event: UsageOutboxEntry["event"]): string { return `verification-usage:${canonicalSha256([executionKey, event])}`; }
function validExecutionKey(executionKey: unknown): executionKey is string {
  return typeof executionKey === "string" && /^verification:[0-9a-f]{64}$/.test(executionKey);
}
function validUsageOutboxEntry(value: unknown, request: VerificationRequest, plan: VerificationPlan, runId: string): value is UsageOutboxEntry {
  if (!isRecord(value) || !exactOwnKeys(value, ["executionKey", "obligationId", "event", "eventKey"]) || !validExecutionKey(value.executionKey) || typeof value.obligationId !== "string" || !value.obligationId || (value.event !== "execution" && value.event !== "artifact") || typeof value.eventKey !== "string") return false;
  const obligation = plan.obligations.find(item => item.id === value.obligationId);
  if (!obligation) return false;
  const expectedKey = `verification:${canonicalSha256([runId, canonicalRequestDigest(request), canonicalPlanDigest(plan), canonicalObligationDigest(obligation)])}`;
  return value.executionKey === expectedKey && value.eventKey === usageEventKey(value.executionKey, value.event);
}
const DISPATCH_LEASE_DURATION_MS = 30_000;
function dispatchFacilityConfigured(repository: RepositoryPort): boolean {
  const methods = [repository.claimExecutionDispatch, repository.completeExecutionDispatch, repository.releaseExecutionDispatch];
  const configured = methods.filter(method => typeof method === "function").length;
  if (configured !== methods.length) throw Error("durable dispatch claim facility must provide claim, complete, and release");
  return true;
}
function dispatchOwnerFor(dependencies: VerificationRunDependencies): string {
  const owner = dependencies.dispatchOwnerId ?? dependencies.ownerId ?? "verification-runtime";
  if (typeof owner !== "string" || !owner) throw Error("dispatch owner identity is required");
  return owner;
}
function dispatchLeaseDurationFor(dependencies: VerificationRunDependencies): number {
  const duration = dependencies.dispatchLeaseDurationMs ?? dependencies.leaseDurationMs ?? DISPATCH_LEASE_DURATION_MS;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 || duration > DISPATCH_LEASE_DURATION_MS) throw Error("dispatch lease duration must be positive and no greater than 30 seconds");
  return duration;
}
function dispatchClaimKeyFor(request: VerificationExecutionRequest): string {
  return `verification-dispatch:${canonicalSha256([request.runId, request.requestId, request.rootIdentity, request.snapshotId, request.planDigest, request.obligation.id, request.idempotencyKey])}`;
}
function dispatchClaimFor(request: VerificationExecutionRequest, ownerId: string, now: string, duration: number): DispatchClaim {
  return { schemaVersion: "verification-dispatch-claim/v1", claimKey: dispatchClaimKeyFor(request), acquisitionId: globalThis.crypto.randomUUID(), runId: request.runId, requestId: request.requestId, rootIdentity: request.rootIdentity, snapshotId: request.snapshotId, planDigest: request.planDigest, obligationId: request.obligation.id, idempotencyKey: request.idempotencyKey, ownerId, leaseGeneration: 1, leaseExpiresAt: new Date(Date.parse(now) + duration).toISOString() };
}
function validDispatchClaim(value: unknown): value is DispatchClaim {
  return isRecord(value) && exactOwnKeys(value, ["schemaVersion", "claimKey", "acquisitionId", "runId", "requestId", "rootIdentity", "snapshotId", "planDigest", "obligationId", "idempotencyKey", "ownerId", "leaseGeneration", "leaseExpiresAt"]) && value.schemaVersion === "verification-dispatch-claim/v1" && typeof value.claimKey === "string" && value.claimKey.startsWith("verification-dispatch:") && typeof value.acquisitionId === "string" && ACQUISITION_ID.test(value.acquisitionId) && typeof value.runId === "string" && Boolean(value.runId) && typeof value.requestId === "string" && Boolean(value.requestId) && typeof value.rootIdentity === "string" && Boolean(value.rootIdentity) && typeof value.snapshotId === "string" && Boolean(value.snapshotId) && typeof value.planDigest === "string" && REQUEST_DIGEST.test(value.planDigest) && typeof value.obligationId === "string" && Boolean(value.obligationId) && validExecutionKey(value.idempotencyKey) && typeof value.ownerId === "string" && Boolean(value.ownerId) && typeof value.leaseGeneration === "number" && Number.isInteger(value.leaseGeneration) && value.leaseGeneration > 0 && validDate(value.leaseExpiresAt);
}
function stableDispatchClaimMatches(value: DispatchClaim, request: VerificationExecutionRequest): boolean {
  return value.claimKey === dispatchClaimKeyFor(request) && value.runId === request.runId && value.requestId === request.requestId && value.rootIdentity === request.rootIdentity && value.snapshotId === request.snapshotId && value.planDigest === request.planDigest && value.obligationId === request.obligation.id && value.idempotencyKey === request.idempotencyKey;
}
type DispatchLease=Readonly<{owned:boolean;outputStored:boolean;claim:DispatchClaim;completion?:VerificationExecutionCompletionEnvelope}>;
async function claimExecutionDispatch(repository: RepositoryPort, request: VerificationExecutionRequest, dependencies: VerificationRunDependencies): Promise<DispatchLease> {
  const now = clockNow(dependencies.now);
  const claim = dispatchClaimFor(request, dispatchOwnerFor(dependencies), now, dispatchLeaseDurationFor(dependencies));
  const claimMethod = repository.claimExecutionDispatch;
  if (!claimMethod) throw Error("atomic dispatch claim facility is required");
  const attemptToken = Symbol("verification-dispatch-claim");
  try {
    const result = await claimMethod.call(repository, claim, now, attemptToken);
    if (!isRecord(result) || !exactOwnKeys(result, ["claimed", "status", "claim", "outputStored"], ["completion"]) || typeof result.claimed !== "boolean" || (result.status !== "CLAIMED" && result.status !== "COMPLETED") || typeof result.outputStored !== "boolean" || !validDispatchClaim(result.claim) || (result.completion !== undefined && !isRecord(result.completion))) throw Error("invalid dispatch claim result");
    if (!stableDispatchClaimMatches(result.claim, request)) throw Error("dispatch claim binding mismatch");
    if (result.claimed) {
      if (result.status !== "CLAIMED" || result.outputStored || result.completion !== undefined || result.claim.ownerId !== claim.ownerId || result.claim.acquisitionId !== claim.acquisitionId || Date.parse(result.claim.leaseExpiresAt) <= Date.parse(now)) throw Error("invalid dispatch claim result");
      return { owned: true, outputStored: false, claim: result.claim };
    }
    if (result.status === "CLAIMED") throw Error("dispatch claim already exists");
    if (!result.outputStored || !result.completion || !validCompletionEnvelope(result.completion, request, result.claim)) throw Error("invalid persisted dispatch completion");
    return { owned: false, outputStored: true, claim: result.claim, completion: result.completion };
  } catch (error) {
    if (error instanceof DispatchClaimAcquisitionError && error.token === attemptToken && validDispatchClaim(error.claim) && stableDispatchClaimMatches(error.claim, request) && error.claim.ownerId === claim.ownerId && error.claim.acquisitionId === claim.acquisitionId) {
      try {
        await releaseExecutionDispatch(repository, error.claim, now);
      } catch {
        // Preserve the acquisition failure when cleanup cannot confirm release.
      }
    }
    throw error;
  }
}
async function completeExecutionDispatch(repository: RepositoryPort, claim: DispatchClaim, completion: VerificationExecutionCompletionEnvelope | undefined, now: string): Promise<void> {
  if (!repository.completeExecutionDispatch) throw Error("durable dispatch completion facility is required");
  const completed = await repository.completeExecutionDispatch.call(repository, claim, completion, now);
  if (completed !== true) throw Error("dispatch result persistence failed");
}
async function releaseExecutionDispatch(repository: RepositoryPort, claim: DispatchClaim, now: string): Promise<void> {
  if (!repository.releaseExecutionDispatch) throw Error("durable dispatch release facility is required");
  const released = await repository.releaseExecutionDispatch.call(repository, claim, now);
  if (released !== true) throw Error("dispatch claim release failed");
}
async function executeExecutor(port: VerificationExecutor, input: VerificationExecutionRequest): Promise<VerificationExecutionOutput | undefined> { if (port.executeObligation) return port.executeObligation(input); return port.execute ? port.execute(input) : undefined; }
async function executeBrowser(port: BrowserExecutor, input: BrowserExecutionRequest): Promise<BrowserExecutionOutput | undefined> { if (port.executeBrowser) return port.executeBrowser(input); return port.execute ? port.execute(input) : undefined; }
function normalizeStatus(value: VerificationExecutionOutput["status"]): VerificationEvidence["result"]["verdict"] { const status = String(value).toLowerCase(); return status === "passed" || status === "pass" ? "PASS" : status === "failed" || status === "fail" ? "FAIL" : status === "blocked" || status === "block" ? "BLOCKED" : "INCOMPLETE"; }
function idempotencyKeyFor(runId: string, requestDigest: string, planDigest: string, obligationDigest: string): string {
  return `verification:${canonicalSha256([runId, requestDigest, planDigest, obligationDigest])}`;
}
function outputReceiptMatches(output: VerificationExecutionOutput | undefined, request: VerificationExecutionRequest): boolean {
  return Boolean(output && output.runId === request.runId && output.requestId === request.requestId && output.snapshotId === request.snapshotId && output.idempotencyKey === request.idempotencyKey);
}
function resultMatchesExecution(result: VerificationEvidence["result"], execution: Execution): boolean {
  const hasPassed = Object.prototype.hasOwnProperty.call(result, "passed");
  const hasFailed = Object.prototype.hasOwnProperty.call(result, "failed");
  if (execution.exitStatus === "passed") return result.verdict === "PASS" && result.passed === 1 && !hasFailed;
  if (execution.exitStatus === "failed") return result.verdict === "FAIL" && result.failed === 1 && !hasPassed;
  if (execution.exitStatus === "blocked") return result.verdict === "BLOCKED" && !hasPassed && !hasFailed;
  return result.verdict === "INCOMPLETE" && !hasPassed && !hasFailed;
}
function canonicalResult(value: unknown): VerificationEvidence["result"] | undefined {
  if (!isRecord(value) || !exactOwnKeys(value, ["verdict", "summary"], ["passed", "failed", "artifacts"]) || !["PASS", "FAIL", "BLOCKED", "INCOMPLETE"].includes(value.verdict as string) || typeof value.summary !== "string" || !value.summary || (value.passed !== undefined && (typeof value.passed !== "number" || !Number.isInteger(value.passed) || value.passed < 0)) || (value.failed !== undefined && (typeof value.failed !== "number" || !Number.isInteger(value.failed) || value.failed < 0)) || (value.artifacts !== undefined && (!Array.isArray(value.artifacts) || value.artifacts.some(digest => typeof digest !== "string" || !DIGEST.test(digest))))) return undefined;
  const artifacts = value.artifacts === undefined ? undefined : (value.artifacts as string[]).map(digest => digest.toLowerCase());
  if (artifacts !== undefined && !structurallyEqual(artifacts, uniq(artifacts))) return undefined;
  return { verdict: value.verdict as VerificationEvidence["result"]["verdict"], summary: value.summary, ...(value.passed === undefined ? {} : { passed: value.passed }), ...(value.failed === undefined ? {} : { failed: value.failed }), ...(artifacts === undefined ? {} : { artifacts }) };
}
function validVerificationEvidence(value: unknown): value is VerificationEvidence {
  if (!isRecord(value) || !exactOwnKeys(value, ["schemaVersion", "evidenceId", "requestId", "snapshotId", "obligationId", "producer", "execution", "result", "observedAt"]) || "contentHash" in value || value.schemaVersion !== "verification-evidence/v1" || typeof value.evidenceId !== "string" || !value.evidenceId || typeof value.requestId !== "string" || !value.requestId || typeof value.snapshotId !== "string" || !value.snapshotId || typeof value.obligationId !== "string" || !value.obligationId || !validProducer(value.producer) || !validExecution(value.execution) || canonicalResult(value.result) === undefined || !validDate(value.observedAt)) return false;
  return true;
}
function validAuthority(value: unknown): value is ExecutionAuthority {
  if (!isRecord(value) || !exactOwnKeys(value, ["schemaVersion", "authorityId", "issuer", "binding"]) || value.schemaVersion !== "verification-execution-authority/v1" || typeof value.authorityId !== "string" || !value.authorityId || typeof value.issuer !== "string" || !value.issuer || !isRecord(value.binding) || !exactOwnKeys(value.binding, ["runId", "requestId", "requestDigest", "planDigest", "obligationDigest", "rootIdentity", "snapshotId", "obligationId", "idempotencyKey", "producer", "execution", "result", "observedAt", "artifacts"])) return false;
  const binding = value.binding;
  return typeof binding.runId === "string" && Boolean(binding.runId) && typeof binding.requestId === "string" && Boolean(binding.requestId) && typeof binding.requestDigest === "string" && REQUEST_DIGEST.test(binding.requestDigest) && typeof binding.planDigest === "string" && REQUEST_DIGEST.test(binding.planDigest) && typeof binding.obligationDigest === "string" && REQUEST_DIGEST.test(binding.obligationDigest) && typeof binding.rootIdentity === "string" && Boolean(binding.rootIdentity) && typeof binding.snapshotId === "string" && Boolean(binding.snapshotId) && typeof binding.obligationId === "string" && Boolean(binding.obligationId) && validExecutionKey(binding.idempotencyKey) && validProducer(binding.producer) && validExecution(binding.execution) && validDate(binding.observedAt) && canonicalResult(binding.result) !== undefined && Array.isArray(binding.artifacts) && binding.artifacts.every(artifact => validArtifact(artifact)) && structurallyEqual(binding.artifacts, (binding.artifacts as unknown[]).map(artifact => canonicalArtifact(artifact)!));
}
function authorityBindingFor(runId: string, requestDigest: string, planDigest: string, obligationDigest: string, rootIdentity: string, observation: Observation, item: VerificationEvidence): VerificationExecutionAuthorityBinding {
  return { runId, requestId: observation.requestId, requestDigest, planDigest, obligationDigest, rootIdentity, snapshotId: observation.snapshotId, obligationId: item.obligationId, idempotencyKey: idempotencyKeyFor(runId, requestDigest, planDigest, obligationDigest), producer: observation.producer, execution: observation.execution, result: item.result, observedAt: item.observedAt, artifacts: observation.artifacts.map(artifact => canonicalArtifact(artifact)!).map(artifact => ({ ...artifact })) };
}
function authorityBindingMatchesRequest(runId: string, request: VerificationExecutionRequest, binding: VerificationExecutionAuthorityBinding): boolean {
  return binding.runId === runId && binding.requestId === request.requestId && binding.requestDigest === request.requestDigest && binding.planDigest === request.planDigest && binding.obligationDigest === request.obligationDigest && binding.rootIdentity === request.rootIdentity && binding.snapshotId === request.snapshotId && binding.obligationId === request.obligation.id && binding.idempotencyKey === request.idempotencyKey;
}
function canonicalEvidenceFromAuthority(binding: VerificationExecutionAuthorityBinding, artifacts: readonly CanonicalVerificationResultArtifact[]): { producer: Producer; execution: Execution; result: VerificationEvidence["result"]; observedAt: string; artifacts: CanonicalVerificationResultArtifact[] } | undefined {
  const producer = canonicalProducer(binding.producer);
  const execution = canonicalExecution(binding.execution);
  const result = canonicalResult(binding.result);
  if (!producer || !execution || !result || !validDate(binding.observedAt) || binding.observedAt !== execution.finishedAt || !resultMatchesExecution(result, execution)) return undefined;
  const signedArtifacts = binding.artifacts.map(artifact => canonicalArtifact(artifact));
  if (signedArtifacts.some(artifact => !artifact)) return undefined;
  const canonicalArtifacts = signedArtifacts as CanonicalVerificationResultArtifact[];
  if (!structurallyEqual(canonicalArtifacts, binding.artifacts)) return undefined;
  const resultDigests = result.artifacts ?? [];
  if (!structurallyEqual(uniq(canonicalArtifacts.map(artifact => artifact.digest)), resultDigests)) return undefined;
  if (!structurallyEqual(canonicalArtifacts, artifacts)) return undefined;
  return { producer, execution, result, observedAt: binding.observedAt, artifacts: canonicalArtifacts };
}
function authorityBindingReplayMatches(runId: string, request: VerificationExecutionRequest, local: VerificationExecutionAuthorityBinding, candidate: VerificationExecutionAuthorityBinding): boolean {
  const comparableExecution = (execution: Execution): Record<string, unknown> => {
    const comparable: Record<string, unknown> = { ...execution };
    delete comparable.startedAt;
    delete comparable.finishedAt;
    return comparable;
  };
  const candidateResult = canonicalResult(candidate.result);
  const localResult = canonicalResult(local.result);
  return Boolean(candidateResult && localResult && authorityBindingMatchesRequest(runId, request, candidate) && structurallyEqual(candidate.producer, local.producer) && structurallyEqual(candidateResult, localResult) && structurallyEqual(candidate.artifacts, local.artifacts) && structurallyEqual(comparableExecution(candidate.execution), comparableExecution(local.execution)));
}
function assertExecutionEvidenceBindings(execution: ExecutionDocument, request?: VerificationRequest, plan?: VerificationPlan, runId?: string): void {
  if (!isRecord(execution) || !exactOwnKeys(execution, ["schemaVersion", "requestId", "snapshotId", "observations", "claims", "evidence", "authorities", "usageOutbox"]) || execution.schemaVersion !== "verification-execution/v1" || !Array.isArray(execution.observations) || !Array.isArray(execution.claims) || !Array.isArray(execution.evidence) || !Array.isArray(execution.authorities) || !Array.isArray(execution.usageOutbox)) throw Error("invalid execution document");
  const observations = new Map<string, Observation>();
  const claims = new Map<string, EvidenceClaim>();
  const evidence = new Map<string, VerificationEvidence>();
  const expectedObligations = plan ? new Set(plan.obligations.map(item => item.id)) : undefined;
  const sorted = (values: readonly string[]): boolean => values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value) < 0);
  if (!sorted(execution.observations.map(item => item.observationId)) || !sorted(execution.claims.map(item => item.claimId)) || !sorted(execution.evidence.map(item => item.evidenceId)) || !sorted(execution.authorities.map(item => item.binding.obligationId)) || !sorted(execution.usageOutbox.map(item => item.eventKey))) throw Error("invalid execution canonical ordering");
  for (const observation of execution.observations) {
    if (!validObservation(observation)) throw Error("invalid execution observation binding");
    const obligationId = observation.observationId.slice("observation:".length);
    if (!observation.observationId.startsWith("observation:") || !obligationId || observations.has(obligationId) || (expectedObligations && !expectedObligations.has(obligationId)) || !structurallyEqual(observation.artifacts, observation.artifacts.map(artifact => canonicalArtifact(artifact)!))) throw Error("invalid execution observation binding");
    observations.set(obligationId, observation);
  }
  for (const claim of execution.claims) {
    if (!validEvidenceClaim(claim) || claim.observationIds.length !== 1 || claim.claimId !== `claim:${claim.obligationId}` || claim.observationIds[0] !== `observation:${claim.obligationId}` || claims.has(claim.obligationId) || (expectedObligations && !expectedObligations.has(claim.obligationId))) throw Error("invalid execution claim binding");
    claims.set(claim.obligationId, claim);
  }
  for (const item of execution.evidence) {
    if (!validVerificationEvidence(item) || item.evidenceId !== `evidence:${item.obligationId}` || evidence.has(item.obligationId) || (expectedObligations && !expectedObligations.has(item.obligationId)) || !validDate(item.observedAt)) throw Error("invalid execution evidence binding");
    evidence.set(item.obligationId, item);
  }
  if (execution.authorities.some(item => !validAuthority(item))) throw Error("invalid execution authority binding");
  const authorityByObligation = new Map(execution.authorities.map(item => [item.binding.obligationId, item]));
  const requestDigest = request ? canonicalRequestDigest(request) : undefined;
  const planDigest = plan ? canonicalPlanDigest(plan) : undefined;
  if (authorityByObligation.size !== execution.authorities.length) throw Error("invalid execution authority binding");
  if (observations.size !== claims.size || observations.size !== evidence.size || [...observations.keys()].some(id => !claims.has(id) || !evidence.has(id))) throw Error("invalid execution binding universe");
  for (const [obligationId, observation] of observations) {
    const claim = claims.get(obligationId);
    const item = evidence.get(obligationId);
    const obligation = plan?.obligations.find(candidate => candidate.id === obligationId);
    if (!claim || !item || !obligation || claim.claim !== item.result.summary || (request && (observation.requestId !== request.requestId || observation.snapshotId !== request.project.snapshotId || claim.requestId !== request.requestId || claim.snapshotId !== request.project.snapshotId || item.requestId !== request.requestId || item.snapshotId !== request.project.snapshotId)) || observation.requestId !== item.requestId || observation.snapshotId !== item.snapshotId || claim.requestId !== item.requestId || claim.snapshotId !== item.snapshotId || !structurallyEqual(observation.producer, item.producer) || !structurallyEqual(observation.execution, item.execution) || !structurallyEqual(observation.artifacts, observation.artifacts.map(artifact => canonicalArtifact(artifact)!))) throw Error("invalid execution evidence binding");
    if (!structurallyEqual(uniq(observation.artifacts.map(artifact => artifact.digest)), item.result.artifacts ?? [])) throw Error("invalid execution evidence binding");
    const persistedAuthority = authorityByObligation.get(obligationId);
    const expectedRequest = requestDigest ?? persistedAuthority?.binding.requestDigest;
    const expectedPlan = planDigest ?? persistedAuthority?.binding.planDigest;
    const expectedObligation = canonicalObligationDigest(obligation);
    const expected = authorityBindingFor(runId ?? (persistedAuthority?.binding.runId ?? ""), expectedRequest ?? "", expectedPlan ?? "", expectedObligation, request?.project.rootIdentity ?? persistedAuthority?.binding.rootIdentity ?? "", observation, item);
    if (!persistedAuthority || !structurallyEqual(persistedAuthority.binding, expected) || item.observedAt !== observation.execution.finishedAt) throw Error("invalid execution authority binding");
  }
  for (const entry of execution.usageOutbox) {
    if (!validUsageOutboxEntry(entry, request ?? ({ requestId: execution.requestId, project: { rootIdentity: "", snapshotId: execution.snapshotId } } as VerificationRequest), plan ?? ({ obligations: [], schemaVersion: "verification-plan/v1", requestId: execution.requestId, snapshotId: execution.snapshotId, risks: [], conditions: [] } as VerificationPlan), runId ?? "")) throw Error("invalid execution usage outbox");
    const item = evidence.get(entry.obligationId);
    const authority = authorityByObligation.get(entry.obligationId);
    if (!item || !authority || (entry.event === "artifact" && !(item.result.artifacts?.length))) throw Error("invalid execution usage outbox");
  }
}
async function issueExecutionAuthority(port: ExecutionAuthorityPort | undefined, binding: VerificationExecutionAuthorityBinding): Promise<ExecutionAuthority | undefined> {
  if (!port) return undefined;
  if (port.issueExecutionAuthority) return port.issueExecutionAuthority(binding);
  if (port.issueAuthority) return port.issueAuthority(binding);
  return port.issue ? port.issue(binding) : undefined;
}
async function verifyExecutionAuthority(port: ExecutionAuthorityPort | undefined, authority: ExecutionAuthority, binding: VerificationExecutionAuthorityBinding): Promise<boolean> {
  if (!port) return false;
  const result = port.verifyExecutionAuthority ? await port.verifyExecutionAuthority(authority, binding) : port.verifyAuthority ? await port.verifyAuthority(authority, binding) : port.verify ? await port.verify(authority, binding) : false;
  return result === true || (validAuthority(result) && structurallyEqual(result, authority) && structurallyEqual(result.binding, binding));
}
async function verifyPersistedExecutionAuthorities(execution: ExecutionDocument, request: VerificationRequest, plan: VerificationPlan | undefined, runId: string, port: ExecutionAuthorityPort | undefined): Promise<void> {
  assertExecutionEvidenceBindings(execution, request, plan, runId);
  if (!plan) throw Error("missing persisted execution plan");
  for (const item of execution.evidence) {
    const authority = execution.authorities.find(candidate => candidate.binding.obligationId === item.obligationId);
    if (!authority) throw Error("missing persisted execution authority");
    const observation = execution.observations.find(candidate => candidate.observationId === `observation:${item.obligationId}`);
    const obligation = plan.obligations.find(candidate => candidate.id === item.obligationId);
    if (!observation || !obligation) throw Error("invalid persisted execution authority");
    const requestDigest = canonicalRequestDigest(request);
    const planDigest = canonicalPlanDigest(plan);
    const binding = authorityBindingFor(runId, requestDigest, planDigest, canonicalObligationDigest(obligation), request.project.rootIdentity, observation, item);
    if (!await verifyExecutionAuthority(port, authority, binding)) throw Error("invalid persisted execution authority");
  }
}
const UNAVAILABLE_PRODUCER: Producer = { kind: "self", identity: "self/runtime-unavailable", independence: "self-check" };
function executionFor(obligation: VerificationObligationPlan, verdict: VerificationEvidence["result"]["verdict"], startedAt: string, finishedAt: string, output: VerificationExecutionOutput | undefined, producer: Producer): Execution {
  const exitStatus: Execution["exitStatus"] = verdict === "PASS" ? "passed" : verdict === "FAIL" ? "failed" : verdict === "BLOCKED" ? "blocked" : "cancelled";
  const fallbackKind: Execution["kind"] = obligation.evidenceType === "browser-result" ? "browser" : "command";
  const kind = output?.executionKind && EXECUTION_KINDS.includes(output.executionKind) ? output.executionKind : fallbackKind;
  const identity = typeof output?.identity === "string" && output.identity ? output.identity : producer.identity;
  return { kind, identity, startedAt, finishedAt, exitStatus, ...(typeof output?.exitCode === "number" && Number.isInteger(output.exitCode) ? { exitCode: output.exitCode } : {}) };
}
function canonicalArtifacts(values: readonly unknown[]): CanonicalVerificationResultArtifact[] {
  return values.map(value => {
    const artifact = canonicalArtifact(value);
    if (!artifact) throw Error("invalid artifact descriptor");
    return artifact;
  });
}
function canonicalExecutionOutput(value: unknown): VerificationExecutionOutput | undefined {
  if (!isRecord(value) || !exactOwnKeys(value, ["status", "runId", "requestId", "snapshotId", "idempotencyKey", "producer"], ["summary", "artifacts", "executionKind", "identity", "exitCode"]) || !["passed", "failed", "blocked", "incomplete", "PASS", "FAIL", "BLOCKED", "INCOMPLETE"].includes(value.status as string) || typeof value.runId !== "string" || !value.runId || typeof value.requestId !== "string" || !value.requestId || typeof value.snapshotId !== "string" || !value.snapshotId || !validExecutionKey(value.idempotencyKey) || !validProducer(value.producer) || (value.summary !== undefined && (typeof value.summary !== "string" || !value.summary)) || (value.executionKind !== undefined && !EXECUTION_KINDS.includes(value.executionKind as Execution["kind"])) || (value.identity !== undefined && (typeof value.identity !== "string" || !value.identity)) || (value.exitCode !== undefined && (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode)))) return undefined;
  const artifacts = value.artifacts === undefined ? undefined : Array.isArray(value.artifacts) ? Array.from(value.artifacts, item => canonicalArtifact(item)) : null;
  if (artifacts === null || artifacts?.some(item => !item)) return undefined;
  return { status: value.status as VerificationExecutionOutput["status"], runId: value.runId, requestId: value.requestId, snapshotId: value.snapshotId, idempotencyKey: value.idempotencyKey, producer: canonicalProducer(value.producer)!, ...(value.summary === undefined ? {} : { summary: value.summary }), ...(artifacts === undefined ? {} : { artifacts: artifacts as CanonicalVerificationResultArtifact[] }), ...(value.executionKind === undefined ? {} : { executionKind: value.executionKind as Execution["kind"] }), ...(value.identity === undefined ? {} : { identity: value.identity }), ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }) };
}
function validCompletionEnvelope(value: unknown, request: VerificationExecutionRequest, claim: DispatchClaim): value is VerificationExecutionCompletionEnvelope {
  if (!isRecord(value) || !exactOwnKeys(value, ["schemaVersion", "runId", "requestId", "rootIdentity", "snapshotId", "planDigest", "obligationId", "idempotencyKey", "output", "authority"]) || value.schemaVersion !== "verification-execution-completion/v1" || value.runId !== request.runId || value.requestId !== request.requestId || value.rootIdentity !== request.rootIdentity || value.snapshotId !== request.snapshotId || value.planDigest !== request.planDigest || value.obligationId !== request.obligation.id || value.idempotencyKey !== request.idempotencyKey || value.runId !== claim.runId || value.requestId !== claim.requestId || value.rootIdentity !== claim.rootIdentity || value.snapshotId !== claim.snapshotId || value.planDigest !== claim.planDigest || value.obligationId !== claim.obligationId || value.idempotencyKey !== claim.idempotencyKey || !validAuthority(value.authority)) return false;
  const output = canonicalExecutionOutput(value.output);
  if (!output || !structurallyEqual(output, value.output) || !outputReceiptMatches(output, request) || !authorityBindingMatchesRequest(request.runId, request, value.authority.binding)) return false;
  const binding = value.authority.binding;
  const artifacts = (output.artifacts ?? []) as CanonicalVerificationResultArtifact[];
  const canonical = canonicalEvidenceFromAuthority(binding, artifacts);
  if (!canonical || !structurallyEqual(canonical.producer, output.producer) || canonical.result.verdict !== normalizeStatus(output.status) || canonical.result.summary !== (output.summary ?? `Obligation ${request.obligation.id} completed.`) || !structurallyEqual(canonical.result.artifacts ?? [], uniq(artifacts.map(item => item.digest))) || canonical.execution.identity !== (output.identity ?? output.producer.identity) || canonical.execution.exitCode !== output.exitCode || canonical.execution.exitStatus !== (normalizeStatus(output.status) === "PASS" ? "passed" : normalizeStatus(output.status) === "FAIL" ? "failed" : normalizeStatus(output.status) === "BLOCKED" ? "blocked" : "cancelled") || canonical.execution.kind !== (output.executionKind ?? (request.obligation.evidenceType === "browser-result" ? "browser" : "command"))) return false;
  return true;
}
async function createCompletionEnvelope(request: VerificationExecutionRequest, claim: DispatchClaim, output: VerificationExecutionOutput | undefined, startedAt: string, finishedAt: string, dependencies: VerificationRunDependencies): Promise<VerificationExecutionCompletionEnvelope | undefined> {
  const canonicalOutput = canonicalExecutionOutput(output);
  if (!canonicalOutput || !outputReceiptMatches(canonicalOutput, request)) return undefined;
  const producer = canonicalOutput.producer;
  const artifacts = (canonicalOutput.artifacts ?? []) as CanonicalVerificationResultArtifact[];
  const verdict = normalizeStatus(canonicalOutput.status);
  const execution = executionFor(request.obligation, verdict, startedAt, finishedAt, canonicalOutput, producer);
  const result: VerificationEvidence["result"] = { verdict, summary: canonicalOutput.summary ?? `Obligation ${request.obligation.id} completed.`, ...(verdict === "PASS" ? { passed: 1 } : verdict === "FAIL" ? { failed: 1 } : {}), artifacts: uniq(artifacts.map(item => item.digest)) };
  const observation: Observation = { schemaVersion: "observation/v1", observationId: `observation:${request.obligation.id}`, requestId: request.requestId, snapshotId: request.snapshotId, producer, execution, artifacts };
  const item: VerificationEvidence = { schemaVersion: "verification-evidence/v1", evidenceId: `evidence:${request.obligation.id}`, requestId: request.requestId, snapshotId: request.snapshotId, obligationId: request.obligation.id, producer, execution, result, observedAt: finishedAt };
  const binding = authorityBindingFor(request.runId, request.requestDigest, request.planDigest, request.obligationDigest, request.rootIdentity, observation, item);
  const authority = await issueExecutionAuthority(dependencies.executionAuthority, binding);
  if (!authority || !validAuthority(authority) || !structurallyEqual(authority.binding, binding) || !await verifyExecutionAuthority(dependencies.executionAuthority, authority, binding)) return undefined;
  const envelope: VerificationExecutionCompletionEnvelope = { schemaVersion: "verification-execution-completion/v1", runId: request.runId, requestId: request.requestId, rootIdentity: request.rootIdentity, snapshotId: request.snapshotId, planDigest: request.planDigest, obligationId: request.obligation.id, idempotencyKey: request.idempotencyKey, output: canonicalOutput, authority };
  return validCompletionEnvelope(envelope, request, claim) ? freeze(envelope) : undefined;
}
async function storeArtifact(store: ArtifactStore, artifact: CanonicalVerificationResultArtifact, input: VerificationExecutionRequest): Promise<CanonicalVerificationResultArtifact | undefined> {
  const saved = store.storeVerificationResultArtifact ? await store.storeVerificationResultArtifact(artifact, input) : store.storeArtifact ? await store.storeArtifact(artifact, input) : store.putArtifact ? await store.putArtifact(artifact, input) : store.store ? await store.store(artifact, input) : undefined;
  const savedRecord = isRecord(saved) ? { type: saved.type, digest: saved.digest, ...(saved.path === undefined ? {} : { path: saved.path }) } : undefined;
  const canonical = canonicalArtifact(savedRecord);
  const expected = canonicalArtifact(artifact);
  return canonical && expected && structurallyEqual(canonical, expected) ? canonical : undefined;
}
async function canonicalizeAndStoreExecutionOutput(value: unknown, input: VerificationExecutionRequest, store: ArtifactStore): Promise<VerificationExecutionOutput | undefined> {
  const output = canonicalExecutionOutput(value);
  if (!output || !outputReceiptMatches(output, input)) return undefined;
  const artifacts = (output.artifacts ?? []) as readonly CanonicalVerificationResultArtifact[];
  const stored: CanonicalVerificationResultArtifact[] = [];
  for (const artifact of artifacts) {
    const saved = await storeArtifact(store, artifact, input);
    if (!saved) return undefined;
    stored.push(saved);
  }
  return { ...output, ...(output.artifacts === undefined ? {} : { artifacts: stored }) };
}
async function assertCanonicalPlan(request: VerificationRequest, basis: BasisDocument, discovery: DiscoveryDocument, plan: PlanDocument, dependencies: VerificationRunDependencies): Promise<void> {
  const canonical = await buildVerificationPlan({ request, basis, discovery, dependencies });
  if (!structurallyEqual(canonical, plan)) throw Error("invalid persisted plan canonicalization");
}
async function assertCanonicalVerdict(input: ResolveVerdictInput, persisted: VerdictDocument): Promise<void> {
  const canonical = await resolveVerdict(input);
  if (!structurallyEqual(canonical, persisted)) throw Error("invalid persisted verdict canonicalization");
}
function touchRun(run: CanonicalRunState, updatedAt: string): CanonicalRunState {
  assertCanonicalRun(run);
  if (!validDate(updatedAt) || Date.parse(updatedAt) < Date.parse(run.updatedAt)) throw Error("updatedAt must be canonical and monotonic");
  return freeze({ schemaVersion: "verification-run/v1", runId: run.runId, requestId: run.requestId, rootIdentity: run.rootIdentity, snapshotId: run.snapshotId, state: run.state, observationIds: [...run.observationIds], claimIds: [...run.claimIds], evaluationIds: [...run.evaluationIds], revision: run.revision + 1, createdAt: run.createdAt, updatedAt });
}
async function commitStageAndRun(repository: RepositoryPort, run: CanonicalRunState, stage: StageName | undefined, document: StageDocument | undefined, expectedRevision = run.revision - 1): Promise<CanonicalRunState> {
  if ((stage === undefined) !== (document === undefined)) throw Error("stage and document must be committed together");
  const committed = await repository.commitTransition({ runId: run.runId, expectedRevision: expectedRevision < 0 ? undefined : expectedRevision, ...(stage === undefined ? {} : { stage, document }), run });
  if (!committed) throw Error("stale repository revision");
  return run;
}
async function commitTerminalEvidenceAndVerdict(repository: RepositoryPort, run: CanonicalRunState, evidence: EvidenceDocument, verdict: VerdictDocument, expectedRevision: number): Promise<void> {
  if (!repository.commitEvidenceAndVerdict) throw Error("atomic terminal evidence/verdict persistence facility is required");
  const committed = await repository.commitEvidenceAndVerdict.call(repository, { runId: run.runId, expectedRevision: expectedRevision < 0 ? undefined : expectedRevision, evidence, verdict, run });
  if (committed !== true) throw Error("terminal evidence/verdict persistence failed");
}
async function checkpointRun(input: ExecuteObligationsInput, document: ExecutionDocument): Promise<number> {
  const current = await loadRun(input.dependencies.repository, input.runId);
  if (!current) throw Error("execution checkpoint run is missing");
  if (current.state !== input.checkpointRunState || current.revision !== input.checkpointRevision) throw Error("stale execution checkpoint state/revision");
  const touched = touchRun(current, clockNow(input.dependencies.now));
  const committed = await input.dependencies.repository.commitTransition({ runId: input.runId, expectedRevision: input.checkpointRevision, stage: "execution", document, run: touched });
  if (!committed) throw Error("stale execution checkpoint state/revision");
  return touched.revision;
}
async function executeObligations(input: ExecuteObligationsInput): Promise<ExecuteObligationsResult> {
  validRequest(input.request);
  const dispatchClaimsConfigured = dispatchFacilityConfigured(input.dependencies.repository);
  if (input.checkpoint) {
    validateStage("execution", input.checkpoint, input.request, input.runId, { plan: input.plan });
    await verifyPersistedExecutionAuthorities(input.checkpoint, input.request, input.plan, input.runId, input.dependencies.executionAuthority);
  }
  const observations: Observation[] = [...(input.checkpoint?.observations ?? [])];
  const claims: EvidenceClaim[] = [...(input.checkpoint?.claims ?? [])];
  const evidence: VerificationEvidence[] = [...(input.checkpoint?.evidence ?? [])];
  const authorities: ExecutionAuthority[] = [...(input.checkpoint?.authorities ?? [])];
  const usageOutbox: UsageOutboxEntry[] = [...(input.checkpoint?.usageOutbox ?? [])];
  const usageEnabled = usageRecorderConfigured(input.dependencies.usageRecorder);
  if (usageOutbox.length > 0 && !usageEnabled) throw Error("usage recorder is required to flush pending usage outbox");
  if (usageEnabled && input.dependencies.usageRecorder?.atomicSameKeyIdempotency !== true) throw Error("usage recorder must declare atomic same-key idempotency");
  const completed = new Set(claims.map(item => item.obligationId));
  let checkpointRevision = input.checkpointRevision;
  const persistCheckpoint = async (): Promise<void> => {
    const checkpoint: ExecutionDocument = {
      schemaVersion: "verification-execution/v1",
      requestId: input.request.requestId,
      snapshotId: input.request.project.snapshotId,
      observations: [...observations].sort((a, b) => a.observationId.localeCompare(b.observationId)),
      claims: [...claims].sort((a, b) => a.claimId.localeCompare(b.claimId)),
      evidence: [...evidence].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)),
      authorities: [...authorities].sort((a, b) => a.binding.obligationId.localeCompare(b.binding.obligationId)),
      usageOutbox: [...usageOutbox].sort((a, b) => a.eventKey.localeCompare(b.eventKey)),
    };
    assertExecutionEvidenceBindings(checkpoint, input.request, input.plan, input.runId);
    checkpointRevision = await checkpointRun({ ...input, checkpointRevision }, freeze(checkpoint));
  };
  const flushPendingUsage = async (): Promise<void> => {
    if (!usageEnabled) return;
    while (usageOutbox.length > 0) {
      usageOutbox.sort((a, b) => a.eventKey.localeCompare(b.eventKey));
      const pending = usageOutbox[0];
      if (!pending) break;
      await record(input.dependencies.usageRecorder, { runId: input.runId, obligationId: pending.obligationId, event: pending.event, executionKey: pending.executionKey, eventKey: pending.eventKey });
      usageOutbox.shift();
      await persistCheckpoint();
    }
  };
  await flushPendingUsage();
  for (const obligation of [...input.plan.obligations].sort((a, b) => a.id.localeCompare(b.id))) {
    let completionAuthority: ExecutionAuthority | undefined;
    if (completed.has(obligation.id)) continue;
    const requestDigest = canonicalRequestDigest(input.request);
    const planDigest = canonicalPlanDigest(input.plan);
    const obligationDigest = canonicalObligationDigest(obligation);
    const request = { runId: input.runId, requestId: input.request.requestId, requestDigest, planDigest, obligationDigest, rootIdentity: input.request.project.rootIdentity, snapshotId: input.request.project.snapshotId, obligation, conditionIds: uniq(obligation.conditionIds), idempotencyKey: idempotencyKeyFor(input.runId, requestDigest, planDigest, obligationDigest) };
    const lease = await claimExecutionDispatch(input.dependencies.repository, request, input.dependencies);
    let claimReleased = false;
    let completionPersisted = false;
    const releaseClaim = async (preserveError: boolean): Promise<void> => {
      if (!lease.owned || claimReleased || completionPersisted) return;
      try {
        await releaseExecutionDispatch(input.dependencies.repository, lease.claim, clockNow(input.dependencies.now));
        claimReleased = true;
      } catch (error) {
        if (!preserveError) throw error;
      }
    };
    const executionPort = obligation.evidenceType === "browser-result" ? input.dependencies.browserExecutor : input.dependencies.executor;
    try {
    let available: boolean;
    try {
      available = !lease.owned || await hasCapability(input.dependencies.capabilityProvider, capabilityFor(obligation));
      if (lease.owned && available && (!executionPort || executionPort.atomicSameKeyIdempotency !== true)) throw Error("executor must declare atomic same-key idempotency");
    } catch (error) {
      await releaseClaim(true);
      throw error;
    }
    let startedAt: string;
    let finishedAt: string;
    let output: VerificationExecutionOutput | undefined;
    if (available) {
      if (lease.owned) {
        startedAt = clockNow(input.dependencies.now);
        try {
          output = obligation.evidenceType === "browser-result"
            ? await executeBrowser(input.dependencies.browserExecutor!, request)
            : await executeExecutor(input.dependencies.executor, request);
        } catch (error) {
          await releaseClaim(true);
          throw error;
        }
        finishedAt = clockNow(input.dependencies.now);
        if (output) {
          try {
            output = await canonicalizeAndStoreExecutionOutput(output, request, input.dependencies.artifactStore);
          } catch (error) {
            await releaseClaim(true);
            throw error;
          }
        }
        const outputRequiresArtifact = output && ["PASS", "FAIL", "passed", "failed"].includes(output.status) && !(output.artifacts?.length);
        const completion = outputRequiresArtifact
          ? undefined
          : await createCompletionEnvelope(request, lease.claim, output, startedAt, finishedAt, input.dependencies);
        if (completion) {
          completionAuthority = completion.authority;
          await completeExecutionDispatch(input.dependencies.repository, lease.claim, completion, clockNow(input.dependencies.now));
          completionPersisted = true;
        } else {
          await releaseClaim(false);
          output = undefined;
        }
      } else {
        if (!lease.completion || !await verifyExecutionAuthority(input.dependencies.executionAuthority, lease.completion.authority, lease.completion.authority.binding)) throw Error("invalid persisted dispatch completion authority");
        completionAuthority = lease.completion.authority;
        output = lease.completion.output;
        startedAt = lease.completion.authority.binding.execution.startedAt;
        finishedAt = lease.completion.authority.binding.execution.finishedAt;
      }
    } else {
      await releaseClaim(false);
      startedAt = clockNow(input.dependencies.now);
      finishedAt = startedAt;
    }
    const receiptValid = outputReceiptMatches(output, request);
    let verdict: VerificationEvidence["result"]["verdict"] = !available ? "BLOCKED" : !output ? "INCOMPLETE" : !receiptValid ? "INCOMPLETE" : normalizeStatus(output.status);
    let hostGenerated = !available || !output || !receiptValid;
    if (output && receiptValid && verdict === "INCOMPLETE" && !["incomplete", "blocked"].includes(String(output.status).toLowerCase())) hostGenerated = true;
    const outputProducer = output ? canonicalProducer(output.producer) : undefined;
    let producer = outputProducer ?? UNAVAILABLE_PRODUCER;
    let summary = !available ? `Capability ${capabilityFor(obligation)} is unavailable.` : !output ? "No executor output was returned." : !receiptValid ? "Executor output did not echo the canonical idempotency receipt (provenance or idempotency mismatch)." : output.summary ?? `Obligation ${obligation.id} completed.`;
    let artifacts: CanonicalVerificationResultArtifact[] = output?.artifacts ? canonicalArtifacts(output.artifacts) : [];
    if (verdict === "PASS" || verdict === "FAIL") {
      if (!output || !outputProducer) {
        hostGenerated = true;
        verdict = "INCOMPLETE";
        summary = "Executor output did not provide a valid producer.";
      } else if (artifacts.length === 0) {
        hostGenerated = true;
        verdict = "INCOMPLETE";
        summary = "Executor output did not provide a canonical stored artifact.";
      }
    }
    if (hostGenerated) producer = UNAVAILABLE_PRODUCER;
    let execution = executionFor(obligation, verdict, startedAt, finishedAt, output, producer);
    const observationId = `observation:${obligation.id}`;
    const observationRequestId = input.request.requestId;
    const observationSnapshotId = input.request.project.snapshotId;
    let observation: Observation = { schemaVersion: "observation/v1", observationId, requestId: observationRequestId, snapshotId: observationSnapshotId, producer, execution, artifacts };
    let result: VerificationEvidence["result"] = { verdict, summary, ...(verdict === "PASS" ? { passed: 1 } : verdict === "FAIL" ? { failed: 1 } : {}), artifacts: uniq(artifacts.map(item => item.digest)) };
    let item: VerificationEvidence = { schemaVersion: "verification-evidence/v1", evidenceId: `evidence:${obligation.id}`, requestId: observationRequestId, snapshotId: observationSnapshotId, obligationId: obligation.id, producer, execution, result, observedAt: finishedAt };
    const binding = authorityBindingFor(input.runId, requestDigest, planDigest, obligationDigest, input.request.project.rootIdentity, observation, item);
    const candidate = completionAuthority ?? await issueExecutionAuthority(input.dependencies.executionAuthority, binding);
    if (!candidate || !validAuthority(candidate)) throw Error("execution authority issue failed");
    let verifiedBinding: VerificationExecutionAuthorityBinding;
    if (structurallyEqual(candidate.binding, binding)) {
      if (!await verifyExecutionAuthority(input.dependencies.executionAuthority, candidate, binding)) throw Error("execution authority verification failed");
      verifiedBinding = candidate.binding;
    } else {
      if (!authorityBindingReplayMatches(input.runId, request, binding, candidate.binding)) throw Error("execution authority replay verification failed");
      const replayCanonical = canonicalEvidenceFromAuthority(candidate.binding, artifacts);
      if (!replayCanonical) throw Error("execution authority binding is not canonical");
      const replayObservation = { ...observation, producer: replayCanonical.producer, execution: replayCanonical.execution, artifacts: replayCanonical.artifacts };
      const replayItem = { ...item, producer: replayCanonical.producer, execution: replayCanonical.execution, result: replayCanonical.result, observedAt: replayCanonical.observedAt };
      const expectedBinding = authorityBindingFor(input.runId, requestDigest, planDigest, obligationDigest, input.request.project.rootIdentity, replayObservation, replayItem);
      if (!structurallyEqual(candidate.binding, expectedBinding)) throw Error("execution authority replay binding is not canonical");
      if (!await verifyExecutionAuthority(input.dependencies.executionAuthority, candidate, expectedBinding)) throw Error("execution authority replay verification failed");
      verifiedBinding = candidate.binding;
    }
    const canonical = canonicalEvidenceFromAuthority(verifiedBinding, artifacts);
    if (!canonical) throw Error("execution authority binding is not canonical");
    producer = canonical.producer;
    execution = canonical.execution;
    artifacts = canonical.artifacts;
    verdict = canonical.result.verdict;
    summary = canonical.result.summary;
    result = canonical.result;
    observation = { ...observation, producer, execution, artifacts };
    item = { ...item, producer, execution, result, observedAt: canonical.observedAt };
    observations.push(observation);
    evidence.push(item);
    authorities.push(candidate);
    claims.push({ schemaVersion: "evidence-claim/v1", claimId: `claim:${obligation.id}`, requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, obligationId: obligation.id, criterionId: `criterion:${obligation.id}`, observationIds: [observationId], claim: summary });
    completed.add(obligation.id);
    if (usageEnabled) {
      const executionKey = request.idempotencyKey;
      if (artifacts.length > 0 && !usageOutbox.some(entry => entry.executionKey === executionKey && entry.event === "artifact")) usageOutbox.push({ executionKey, obligationId: obligation.id, event: "artifact", eventKey: usageEventKey(executionKey, "artifact") });
      if (!usageOutbox.some(entry => entry.executionKey === executionKey && entry.event === "execution")) usageOutbox.push({ executionKey, obligationId: obligation.id, event: "execution", eventKey: usageEventKey(executionKey, "execution") });
    }
    await persistCheckpoint();
    await flushPendingUsage();
    } catch (error) {
      await releaseClaim(true);
      throw error;
    }
  }
  const finalDocument: ExecutionDocument = { schemaVersion: "verification-execution/v1", requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, observations: observations.sort((a, b) => a.observationId.localeCompare(b.observationId)), claims: claims.sort((a, b) => a.claimId.localeCompare(b.claimId)), evidence: evidence.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)), authorities: authorities.sort((a, b) => a.binding.obligationId.localeCompare(b.binding.obligationId)), usageOutbox: usageOutbox.sort((a, b) => a.eventKey.localeCompare(b.eventKey)) };
  assertExecutionEvidenceBindings(finalDocument, input.request, input.plan, input.runId);
  return freeze({ document: freeze(finalDocument), checkpointRevision });
}
const independenceRank: Readonly<Record<IndependenceLevel, number>> = {"self-check":0,"separate-verification-context":1,"independent-producer":2,"external-approval":3};
function rejectionReasons(checks: EvidenceEvaluation["checks"]): EvidenceEvaluation["rejectionReasons"][number][] { const reasons: EvidenceEvaluation["rejectionReasons"][number][]=[]; if (!checks.snapshotBound) reasons.push("SNAPSHOT_MISMATCH"); if (!checks.fresh) reasons.push("STALE_EVIDENCE"); if (!checks.artifactRequirementsSatisfied) reasons.push("MISSING_ARTIFACT"); if (!checks.scopeComplete) reasons.push("INSUFFICIENT_SCOPE"); if (!checks.producerAllowed) reasons.push("UNTRUSTED_PRODUCER"); if (!checks.independenceSatisfied) reasons.push("INDEPENDENCE_NOT_MET"); if (!checks.expectedResultDemonstrated || checks.expectedResultViolated) reasons.push("EXPECTED_RESULT_NOT_DEMONSTRATED"); if (!checks.integrityVerified) reasons.push("INTEGRITY_FAILURE"); return uniq(reasons) as EvidenceEvaluation["rejectionReasons"][number][]; }
const EVIDENCE_REJECTION_REASONS: readonly EvidenceEvaluation["rejectionReasons"][number][] = ["EXPECTED_RESULT_NOT_DEMONSTRATED", "INDEPENDENCE_NOT_MET", "INSUFFICIENT_SCOPE", "INTEGRITY_FAILURE", "MISSING_ARTIFACT", "SNAPSHOT_MISMATCH", "STALE_EVIDENCE", "UNTRUSTED_PRODUCER"];
function canonicalEvidenceEvaluation(value: unknown): EvidenceEvaluation | undefined {
  if (!isRecord(value) || !exactOwnKeys(value, ["schemaVersion", "evaluationId", "requestId", "snapshotId", "claimId", "status", "checks", "rejectionReasons", "evaluatedAt"]) || value.schemaVersion !== "evidence-evaluation/v1" || typeof value.evaluationId !== "string" || !value.evaluationId || typeof value.requestId !== "string" || !value.requestId || typeof value.snapshotId !== "string" || !value.snapshotId || typeof value.claimId !== "string" || !value.claimId || (value.status !== "ACCEPTED" && value.status !== "REJECTED") || !isRecord(value.checks) || !exactOwnKeys(value.checks, ["snapshotBound", "fresh", "scopeComplete", "producerAllowed", "independenceSatisfied", "artifactRequirementsSatisfied", "expectedResultDemonstrated", "expectedResultViolated", "integrityVerified"]) || Object.values(value.checks).some(item => typeof item !== "boolean") || !Array.isArray(value.rejectionReasons) || value.rejectionReasons.some(reason => !EVIDENCE_REJECTION_REASONS.includes(reason as EvidenceEvaluation["rejectionReasons"][number])) || new Set(value.rejectionReasons).size !== value.rejectionReasons.length || !validDate(value.evaluatedAt)) return undefined;
  const checks = {
    snapshotBound: value.checks.snapshotBound as boolean,
    fresh: value.checks.fresh as boolean,
    scopeComplete: value.checks.scopeComplete as boolean,
    producerAllowed: value.checks.producerAllowed as boolean,
    independenceSatisfied: value.checks.independenceSatisfied as boolean,
    artifactRequirementsSatisfied: value.checks.artifactRequirementsSatisfied as boolean,
    expectedResultDemonstrated: value.checks.expectedResultDemonstrated as boolean,
    expectedResultViolated: value.checks.expectedResultViolated as boolean,
    integrityVerified: value.checks.integrityVerified as boolean,
  };
  return { schemaVersion: "evidence-evaluation/v1", evaluationId: value.evaluationId, requestId: value.requestId, snapshotId: value.snapshotId, claimId: value.claimId, status: value.status, checks, rejectionReasons: [...value.rejectionReasons] as EvidenceEvaluation["rejectionReasons"], evaluatedAt: value.evaluatedAt };
}
function validEvidenceEvaluation(value: unknown): value is EvidenceEvaluation {
  const canonical = canonicalEvidenceEvaluation(value);
  if (canonical === undefined || !structurallyEqual(canonical, value)) return false;
  const expectedReasons = rejectionReasons(canonical.checks);
  return structurallyEqual(canonical.rejectionReasons, expectedReasons) && canonical.status === (expectedReasons.length === 0 ? "ACCEPTED" : "REJECTED");
}
export function canonicalEvaluationsDigest(evaluations: readonly EvidenceEvaluation[]): string {
  const canonical = evaluations.map(evaluation => canonicalEvidenceEvaluation(evaluation));
  if (canonical.some(evaluation => evaluation === undefined)) throw Error("invalid evidence evaluation");
  canonical.sort((left, right) => left!.evaluationId.localeCompare(right!.evaluationId));
  return canonicalSha256(canonical);
}
async function makeEvaluation(observation: Observation | undefined, claim: EvidenceClaim, obligation: VerificationObligationPlan, evaluatedAt: string, request: VerificationRequest, freshness: FreshnessStatus): Promise<EvidenceEvaluation> {
  const producerValid = Boolean(observation && validProducer(observation.producer)); const producerAllowed = producerValid && !(observation?.producer.kind === "self" && observation.producer.independence !== "self-check"); const snapshotBound = Boolean(observation && claim.requestId === request.requestId && claim.snapshotId === request.project.snapshotId && observation.requestId === request.requestId && observation.snapshotId === request.project.snapshotId); const scopeComplete = Boolean(observation && claim.obligationId === obligation.id && claim.criterionId === `criterion:${obligation.id}` && claim.observationIds.length > 0); const artifactRequirementsSatisfied = Boolean(observation?.artifacts.some(item => validArtifact(item))); const expectedResultDemonstrated = observation?.execution.exitStatus === "passed"; const expectedResultViolated = observation?.execution.exitStatus === "failed"; const independenceSatisfied = observation?.execution.exitStatus === "cancelled" ? true : Boolean(observation && independenceRank[observation.producer.independence] >= independenceRank[obligation.independence]); const integrityVerified = Boolean(observation && producerValid && snapshotBound && observation.artifacts.every(item => validArtifact(item))); const checks = { snapshotBound, fresh: freshness === "fresh", scopeComplete, producerAllowed, independenceSatisfied, artifactRequirementsSatisfied, expectedResultDemonstrated, expectedResultViolated, integrityVerified }; const reasons = rejectionReasons(checks);
  return { schemaVersion:"evidence-evaluation/v1", evaluationId:`evaluation:${claim.claimId}`, requestId:claim.requestId, snapshotId:claim.snapshotId, claimId:claim.claimId, status:reasons.length === 0 ? "ACCEPTED" : "REJECTED", checks, rejectionReasons:reasons, evaluatedAt };
}
async function evaluateFreshness(policy: FreshnessPolicy, observation: Observation | undefined, evidence: VerificationEvidence | undefined, evaluatedAt: string): Promise<FreshnessStatus> {
  if (!observation || !evidence) return "unknown";
  const evaluate = policy.evaluateFreshness ?? policy.evaluate;
  if (!evaluate) throw Error("freshness policy is required");
  const status = await evaluate({ observation, evidence, evaluatedAt });
  return status === "fresh" || status === "stale" || status === "unknown" ? status : "unknown";
}
function canonicalEvaluatedAt(execution: ExecutionDocument): string {
  const dates = [...execution.observations.map(item => item.execution.finishedAt), ...execution.evidence.map(item => item.observedAt)].filter(validDate);
  const evaluatedAt = dates.reduce<string | undefined>((selected, candidate) => {
    if (!selected) return candidate;
    const candidateInstant = Date.parse(candidate);
    const selectedInstant = Date.parse(selected);
    return candidateInstant > selectedInstant || (candidateInstant === selectedInstant && candidate > selected) ? candidate : selected;
  }, undefined);
  if (!evaluatedAt) throw Error("execution has no canonical evaluation timestamp");
  for (const claim of execution.claims) {
    const observation = execution.observations.find(item => item.observationId === claim.observationIds[0]);
    if (!observation || Date.parse(evaluatedAt) < Math.max(Date.parse(observation.execution.finishedAt), Date.parse(execution.evidence.find(item => item.obligationId === claim.obligationId)?.observedAt ?? observation.execution.finishedAt))) throw Error("evaluation timestamp precedes referenced observation");
  }
  return evaluatedAt;
}
function validFreshnessAuthority(value: unknown): value is FreshnessAuthority {
  if (!isRecord(value) || !exactOwnKeys(value, ["schemaVersion", "authorityId", "issuer", "binding"]) || value.schemaVersion !== "verification-freshness-authority/v1" || typeof value.authorityId !== "string" || !value.authorityId || typeof value.issuer !== "string" || !value.issuer || !isRecord(value.binding) || !exactOwnKeys(value.binding, ["schemaVersion", "requestId", "snapshotId", "planDigest", "executionDigest", "freshnessEvaluatedAt", "evaluationIds", "evaluationsDigest", "acceptedClaimIds", "coverage"]) || value.binding.schemaVersion !== "verification-freshness-binding/v1" || typeof value.binding.requestId !== "string" || !value.binding.requestId || typeof value.binding.snapshotId !== "string" || !value.binding.snapshotId || typeof value.binding.planDigest !== "string" || !REQUEST_DIGEST.test(value.binding.planDigest) || typeof value.binding.executionDigest !== "string" || !REQUEST_DIGEST.test(value.binding.executionDigest) || !validDate(value.binding.freshnessEvaluatedAt) || typeof value.binding.evaluationsDigest !== "string" || !REQUEST_DIGEST.test(value.binding.evaluationsDigest) || !Array.isArray(value.binding.evaluationIds) || !Array.isArray(value.binding.acceptedClaimIds) || !isRecord(value.binding.coverage)) return false;
  const sortedUnique = (values: unknown): boolean => Array.isArray(values) && values.every((item, index) => typeof item === "string" && Boolean(item) && (index === 0 || (values[index - 1] as string).localeCompare(item) < 0));
  return sortedUnique(value.binding.evaluationIds) && sortedUnique(value.binding.acceptedClaimIds) && exactOwnKeys(value.binding.coverage, ["basisIds", "coveredBasisIds", "riskIds", "coveredRiskIds", "conditionIds", "coveredConditionIds"]) && Object.values(value.binding.coverage).every(items => sortedUnique(items));
}
function freshnessBindingFor(request: VerificationRequest, plan: VerificationPlan, execution: ExecutionDocument, freshnessEvaluatedAt: string, evaluations: readonly EvidenceEvaluation[], acceptedClaimIds: readonly string[], coverage: CoverageInput): FreshnessAuthorityBinding {
  return { schemaVersion: "verification-freshness-binding/v1", requestId: request.requestId, snapshotId: request.project.snapshotId, planDigest: canonicalPlanDigest(plan), executionDigest: canonicalSha256(execution), freshnessEvaluatedAt, evaluationIds: evaluations.map(item => item.evaluationId).sort(), evaluationsDigest: canonicalEvaluationsDigest(evaluations), acceptedClaimIds: [...acceptedClaimIds].sort(), coverage: { basisIds: [...coverage.basisIds].sort(), coveredBasisIds: [...coverage.coveredBasisIds].sort(), riskIds: [...coverage.riskIds].sort(), coveredRiskIds: [...coverage.coveredRiskIds].sort(), conditionIds: [...coverage.conditionIds].sort(), coveredConditionIds: [...coverage.coveredConditionIds].sort() } };
}
async function issueFreshnessAuthority(port: FreshnessAuthorityPort | undefined, binding: FreshnessAuthorityBinding): Promise<FreshnessAuthority | undefined> {
  if (!port) return undefined;
  if (port.issueFreshnessAuthority) return port.issueFreshnessAuthority(binding);
  return port.issue ? port.issue(binding) : undefined;
}
async function verifyFreshnessAuthority(port: FreshnessAuthorityPort | undefined, authority: FreshnessAuthority, binding: FreshnessAuthorityBinding): Promise<boolean> {
  if (!port) return false;
  const result = port.verifyFreshnessAuthority ? await port.verifyFreshnessAuthority(authority, binding) : port.verify ? await port.verify(authority, binding) : false;
  return result === true || (validFreshnessAuthority(result) && structurallyEqual(result, authority) && structurallyEqual(result.binding, binding));
}
async function evaluateEvidence(input: EvaluateEvidenceInput): Promise<EvidenceDocument> {
  validRequest(input.request);
  assertExecutionEvidenceBindings(input.execution, input.request, input.plan, input.runId);
  await verifyPersistedExecutionAuthorities(input.execution, input.request, input.plan, input.runId, input.dependencies.executionAuthority);
  const evaluatedAt = canonicalEvaluatedAt(input.execution);
  const freshnessEvaluatedAt = input.freshnessEvaluatedAt ?? clockNow(input.dependencies.now);
  if (!validDate(freshnessEvaluatedAt)) throw Error("freshness evaluation timestamp must be canonical");
  if (Date.parse(freshnessEvaluatedAt) < Date.parse(evaluatedAt)) throw Error("freshness evaluation timestamp precedes authenticated observation");
  const observations = new Map(input.execution.observations.map(item => [item.observationId, item]));
  const evidenceByObligation = new Map(input.execution.evidence.map(item => [item.obligationId, item]));
  const evaluations = await Promise.all([...input.execution.claims].sort((a,b)=>a.claimId.localeCompare(b.claimId)).map(async claim => {
    const observation = observations.get(claim.observationIds[0]);
    const evidence = evidenceByObligation.get(claim.obligationId);
    const obligation = input.plan.obligations.find(item=>item.id===claim.obligationId);
    if (!obligation) throw Error("evidence claim has no obligation");
    const freshness = await evaluateFreshness(input.dependencies.freshnessPolicy, observation, evidence, freshnessEvaluatedAt);
    return makeEvaluation(observation, claim, obligation, evaluatedAt, input.request, freshness);
  }));
  const claimsById = new Map(input.execution.claims.map(claim => [claim.claimId, claim]));
  const acceptedClaimIds = evaluations.filter(item=>item.status==="ACCEPTED").map(item=>item.claimId).sort();
  const accepted = new Set(acceptedClaimIds.map(claimId => claimsById.get(claimId)?.obligationId).filter((id):id is string=>Boolean(id)));
  const conditionById = new Map(input.plan.conditions.map(item => [item.id, item]));
  const coveredConditions = [...accepted].flatMap(obligationId => input.plan.obligations.find(item=>item.id===obligationId)?.conditionIds ?? []);
  const coverage = { basisIds: uniq(input.plan.conditions.flatMap(item=>item.basisIds)), coveredBasisIds: uniq(coveredConditions.flatMap(id=>conditionById.get(id)?.basisIds ?? [])), riskIds: uniq(input.plan.risks.map(item=>item.id)), coveredRiskIds: uniq(coveredConditions.flatMap(id=>conditionById.get(id)?.riskIds ?? [])), conditionIds: uniq(input.plan.conditions.map(item=>item.id)), coveredConditionIds: coveredConditions.sort() };
  const binding = freshnessBindingFor(input.request, input.plan, input.execution, freshnessEvaluatedAt, evaluations, acceptedClaimIds, coverage);
  let freshnessAuthority: FreshnessAuthority | undefined;
  if (input.freshnessAuthority !== undefined) {
    if (!validFreshnessAuthority(input.freshnessAuthority) || !structurallyEqual(input.freshnessAuthority.binding, binding) || !await verifyFreshnessAuthority(input.dependencies.freshnessAuthority, input.freshnessAuthority, binding)) throw Error("freshness authority verification failed");
    freshnessAuthority = input.freshnessAuthority;
  } else {
    freshnessAuthority = await issueFreshnessAuthority(input.dependencies.freshnessAuthority, binding);
  }
  if (!freshnessAuthority || !validFreshnessAuthority(freshnessAuthority) || !structurallyEqual(freshnessAuthority.binding, binding) || !await verifyFreshnessAuthority(input.dependencies.freshnessAuthority, freshnessAuthority, binding)) throw Error("freshness authority verification failed");
  return freeze({ schemaVersion:"verification-evidence-evaluation/v1", requestId:input.request.requestId, snapshotId:input.request.project.snapshotId, freshnessEvaluatedAt, freshnessAuthority, evaluations, acceptedClaimIds, coverage });
}
async function evaluateResidualRisk(input: EvaluateResidualRiskInput): Promise<ResidualRiskDocument> {
  return freeze({ schemaVersion: "verification-residual-risk/v1", requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, defects: [] });
}
async function resolveVerdict(input: ResolveVerdictInput): Promise<VerdictDocument> {
  validRequest(input.request);
  const proof = { requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, obligations: proofObligations(input.plan), criteria: criteriaFor(input.plan), observations: input.execution.observations.filter(item => item.execution.exitStatus !== "cancelled"), claims: input.execution.claims, evaluations: input.evidence.evaluations, defects: input.residualRisk.defects, coverage: input.evidence.coverage, evaluatedAt: canonicalEvaluatedAt(input.execution), traceability: traceLinks(input.plan, input.discovery) };
  return freeze(resolveProofCarryingQaVerdict(proof));
}
async function loadRun(repository: RepositoryPort, runId: string): Promise<CanonicalRunState | undefined> {
  const run = await repository.loadRun(runId);
  if (run) assertCanonicalRun(run, runId);
  return run;
}
async function loadStage<T>(repository: RepositoryPort, runId: string, stage: StageName): Promise<T | undefined> {
  return repository.loadStageDocument(runId, stage) as MaybePromise<T | undefined>;
}
const VERDICT_KEYS = ["schemaVersion", "requestId", "snapshotId", "qaVerdict", "authoritative", "obligationSummary", "coverage", "openDefectIds", "acceptedRiskIds", "residualRisks", "rationale"] as const;
const VERDICT_COVERAGE_KEYS = ["total", "covered", "uncoveredIds"] as const;
const VERDICT_COVERAGE_FIELDS = ["basis", "risks", "conditions", "mandatoryObligations"] as const;
function validVerdictCoverage(value: unknown): boolean {
  if (!isRecord(value) || !exactOwnKeys(value, VERDICT_COVERAGE_KEYS) || typeof value.total !== "number" || !Number.isInteger(value.total) || value.total < 0 || typeof value.covered !== "number" || !Number.isInteger(value.covered) || value.covered < 0 || value.covered > value.total || !Array.isArray(value.uncoveredIds) || value.uncoveredIds.some(id => typeof id !== "string" || !id) || new Set(value.uncoveredIds).size !== value.uncoveredIds.length) return false;
  return true;
}
function validVerdict(value: unknown, request: VerificationRequest): value is VerdictDocument {
  if (!isRecord(value) || !exactOwnKeys(value, VERDICT_KEYS, ["harnessCompletion"]) || value.schemaVersion !== "qa-verdict/v1" || value.requestId !== request.requestId || value.snapshotId !== request.project.snapshotId || !["PASS", "PASS_WITH_ACCEPTED_RISK", "FAIL", "BLOCKED", "INCOMPLETE"].includes(value.qaVerdict as string) || value.authoritative !== false || typeof value.rationale !== "string" || !value.rationale || (value.harnessCompletion !== undefined && !["unknown", "in_progress", "complete", "failed"].includes(value.harnessCompletion as string))) return false;
  if (!isRecord(value.obligationSummary) || !exactOwnKeys(value.obligationSummary, ["mandatory", "passed", "failed", "blocked", "incomplete"]) || Object.values(value.obligationSummary).some(count => typeof count !== "number" || !Number.isInteger(count) || count < 0)) return false;
  if (!isRecord(value.coverage) || !exactOwnKeys(value.coverage, VERDICT_COVERAGE_FIELDS)) return false;
  const coverage = value.coverage;
  if (VERDICT_COVERAGE_FIELDS.some(field => !validVerdictCoverage(coverage[field]))) return false;
  const validIds = (ids: unknown): boolean => Array.isArray(ids) && ids.every(id => typeof id === "string" && Boolean(id)) && new Set(ids).size === ids.length;
  return validIds(value.openDefectIds) && validIds(value.acceptedRiskIds) && validIds(value.residualRisks);
}
function validateStage(stage: StageName, value: unknown, request: VerificationRequest, runId: string, prior?: VerificationRunDocuments): void {
  if (stage === "request") { validRequest(value as VerificationRequest); return; }
  if (stage === "verdict") {
    if (!validVerdict(value, request)) throw Error("invalid persisted verdict stage");
    return;
  }
  if (!isRecord(value) || value.requestId !== request.requestId || value.snapshotId !== request.project.snapshotId) throw Error(`invalid persisted ${stage} stage`);
  const schema: Record<Exclude<StageName, "request">, string> = { basis:"verification-basis/v1", discovery:"risk-discovery/v1", plan:"verification-plan/v1", execution:"verification-execution/v1", evidence:"verification-evidence-evaluation/v1", "residual-risk":"verification-residual-risk/v1", verdict:"qa-verdict/v1" };
  if (value.schemaVersion !== schema[stage]) throw Error(`invalid persisted ${stage} stage`);
  if (stage === "basis") {
    if (!structurallyEqual(value, canonicalBasis(request))) throw Error("invalid persisted basis canonicalization");
  } else if (stage === "discovery") {
    if (!prior?.basis) throw Error("invalid persisted discovery stage");
    const canonical = canonicalDiscovery(request, prior.basis);
    if (!structurallyEqual(value, canonical)) throw Error("invalid persisted discovery canonicalization");
  } else if (stage === "plan") {
    if (!Array.isArray(value.risks) || !Array.isArray(value.conditions) || !Array.isArray(value.obligations)) throw Error("invalid persisted plan stage");
    const planRiskIds: string[] = value.risks.map(risk=>isRecord(risk) && typeof risk.id === "string" ? risk.id : "");
    const planConditionIds: string[] = value.conditions.map(condition=>isRecord(condition) && typeof condition.id === "string" ? condition.id : "");
    if (planRiskIds.some(id=>typeof id!=="string" || !id) || planConditionIds.some(id=>typeof id!=="string" || !id) || new Set(planRiskIds).size !== planRiskIds.length || new Set(planConditionIds).size !== planConditionIds.length || JSON.stringify(planRiskIds) !== JSON.stringify([...planRiskIds].sort()) || JSON.stringify(planConditionIds) !== JSON.stringify([...planConditionIds].sort())) throw Error("invalid persisted plan universe");
    const priorConditionIds = prior?.discovery?.conditions.map(item=>item.id).sort() ?? [];
    const priorRiskIds = prior?.discovery?.risks.map(item=>item.id).sort() ?? [];
    if (prior?.discovery && (JSON.stringify(planConditionIds) !== JSON.stringify(priorConditionIds) || JSON.stringify(planRiskIds) !== JSON.stringify(priorRiskIds))) throw Error("invalid persisted plan universe");
    const conditionSet = new Set(planConditionIds);
    const priorConditionSet = prior?.discovery ? new Set(priorConditionIds) : undefined;
    const priorRiskSet = prior?.discovery ? new Set(priorRiskIds) : undefined;
    const obligationIds = value.obligations.map(obligation=>isRecord(obligation) ? obligation.id : "");
    if (obligationIds.some(id=>typeof id!=="string" || !id) || new Set(obligationIds).size !== obligationIds.length || JSON.stringify(obligationIds) !== JSON.stringify([...obligationIds].sort())) throw Error("invalid persisted plan stage");
    if (value.conditions.some(condition=>!isRecord(condition) || (priorConditionSet && !priorConditionSet.has(condition.id as string))) || value.risks.some(risk=>!isRecord(risk) || (priorRiskSet && !priorRiskSet.has(risk.id as string)))) throw Error("invalid persisted plan reference");
    const coveredConditions = new Set<string>();
    for (const obligation of value.obligations) {
      if (!isRecord(obligation) || !Array.isArray(obligation.conditionIds) || !obligation.conditionIds.length || obligation.conditionIds.some(id=>typeof id!=="string" || !conditionSet.has(id)) || !["experiment","test-result","browser-result","build-result","static-analysis","review","approval","scenario-result"].includes(obligation.evidenceType as string)) throw Error("invalid persisted plan reference");
      for (const id of obligation.conditionIds) coveredConditions.add(id);
    }
    if (planConditionIds.some(id=>!coveredConditions.has(id))) throw Error("invalid persisted plan coverage");
  } else if (stage === "execution") {
    if (!prior?.plan) throw Error("invalid persisted execution prerequisites");
    assertExecutionEvidenceBindings(value as unknown as ExecutionDocument, request, prior.plan, runId);
  } else if (stage === "evidence") {
    if (!exactOwnKeys(value, ["schemaVersion", "requestId", "snapshotId", "freshnessEvaluatedAt", "freshnessAuthority", "evaluations", "acceptedClaimIds", "coverage"]) || !validDate(value.freshnessEvaluatedAt) || !validFreshnessAuthority(value.freshnessAuthority) || !Array.isArray(value.evaluations) || !Array.isArray(value.acceptedClaimIds) || !isRecord(value.coverage)) throw Error("invalid persisted evidence stage");
    const evaluationIds = value.evaluations.map(evaluation => isRecord(evaluation) && typeof evaluation.evaluationId === "string" ? evaluation.evaluationId : "");
    if (evaluationIds.some(id => !id) || new Set(evaluationIds).size !== evaluationIds.length || JSON.stringify(evaluationIds) !== JSON.stringify([...evaluationIds].sort())) throw Error("invalid persisted evidence stage");
    const evaluations = value.evaluations as EvidenceEvaluation[];
    if (value.freshnessAuthority.binding.evaluationsDigest !== canonicalEvaluationsDigest(evaluations)) throw Error("invalid persisted evidence evaluation digest");
    if (value.evaluations.some(evaluation => !validEvidenceEvaluation(evaluation) || evaluation.requestId !== request.requestId || evaluation.snapshotId !== request.project.snapshotId)) throw Error("invalid persisted evidence reference");
  } else if (stage === "residual-risk" && (!Array.isArray(value.defects) || value.defects.some(defect=>!isRecord(defect) || typeof defect.id!=="string" || !defect.id))) throw Error("invalid persisted residual-risk stage");
}
function validateExecutionCompleteness(execution: ExecutionDocument, plan: VerificationPlan): void {
  const expectedObligationIds = plan.obligations.map(item => item.id).sort();
  const expectedObservationIds = expectedObligationIds.map(id => `observation:${id}`).sort();
  const expectedClaimIds = expectedObligationIds.map(id => `claim:${id}`).sort();
  const expectedEvidenceIds = expectedObligationIds.map(id => `evidence:${id}`).sort();
  const actualObservationIds = execution.observations.map(item => item.observationId).sort();
  const actualClaimIds = execution.claims.map(item => item.claimId).sort();
  const actualEvidenceIds = execution.evidence.map(item => item.evidenceId).sort();
  const actualClaimObligationIds = execution.claims.map(item => item.obligationId).sort();
  const actualEvidenceObligationIds = execution.evidence.map(item => item.obligationId).sort();
  if (JSON.stringify(expectedObservationIds) !== JSON.stringify(actualObservationIds) ||
      JSON.stringify(expectedClaimIds) !== JSON.stringify(actualClaimIds) ||
      JSON.stringify(expectedEvidenceIds) !== JSON.stringify(actualEvidenceIds) ||
      JSON.stringify(expectedObligationIds) !== JSON.stringify(actualClaimObligationIds) ||
      JSON.stringify(expectedObligationIds) !== JSON.stringify(actualEvidenceObligationIds)) throw Error("execution checkpoint incomplete");
}
async function loadCheckedStage<T>(repository: RepositoryPort, runId: string, stage: StageName, request: VerificationRequest, dependencies: VerificationRunDependencies, prior?: VerificationRunDocuments): Promise<T | undefined> {
  const value = await loadStage<T>(repository, runId, stage);
  if (value !== undefined) {
    validateStage(stage, value, request, runId, prior);
    if (stage === "execution") await verifyPersistedExecutionAuthorities(value as unknown as ExecutionDocument, request, prior?.plan, runId, dependencies.executionAuthority);
    if (stage === "evidence") {
      if (!prior?.plan || !prior.execution) throw Error("invalid persisted evidence prerequisites");
      const canonical = await evaluateEvidence({ runId, request, plan: prior.plan, execution: prior.execution, dependencies, freshnessEvaluatedAt: (value as EvidenceDocument).freshnessEvaluatedAt, freshnessAuthority: (value as EvidenceDocument).freshnessAuthority });
      if (!structurallyEqual(value, canonical)) throw Error("invalid persisted evidence canonicalization");
    }
    if (stage === "residual-risk") {
      if (!prior?.plan || !prior.execution || !prior.evidence) throw Error("invalid persisted residual-risk prerequisites");
      const canonical = await evaluateResidualRisk({ runId, request, plan: prior.plan, execution: prior.execution, evidence: prior.evidence, dependencies });
      if (!structurallyEqual(value, canonical)) throw Error("invalid persisted residual-risk canonicalization");
    }
  }
  return value;
}
async function loadHistoricallyCheckedEvidence(repository: RepositoryPort, runId: string, request: VerificationRequest, dependencies: VerificationRunDependencies, prior: VerificationRunDocuments): Promise<EvidenceDocument | undefined> {
  const value = await loadStage<EvidenceDocument>(repository, runId, "evidence");
  if (value === undefined) return undefined;
  validateStage("evidence", value, request, runId, prior);
  if (!prior.plan || !prior.execution) throw Error("invalid persisted evidence prerequisites");
  if (value.freshnessAuthority.binding.executionDigest !== canonicalSha256(prior.execution)) throw Error("invalid persisted freshness execution digest");
  if (value.freshnessAuthority.binding.evaluationsDigest !== canonicalEvaluationsDigest(value.evaluations)) throw Error("invalid persisted evidence evaluation digest");
  const persistedFreshnessByObligation = new Map(prior.execution.claims.map(claim => {
    const evaluation = value.evaluations.find(item => item.claimId === claim.claimId);
    return [claim.obligationId, evaluation?.checks.fresh ? "fresh" as const : "stale" as const];
  }));
  const persistedValidationDependencies: VerificationRunDependencies = {
    ...dependencies,
    freshnessPolicy: {
      evaluateFreshness: async (input: FreshnessEvaluationInput) => persistedFreshnessByObligation.get(input.evidence.obligationId) ?? "unknown",
    },
  };
  return loadCheckedStage<EvidenceDocument>(repository, runId, "evidence", request, persistedValidationDependencies, prior);
}
function assertCanonicalRunIndexes(run: CanonicalRunState, execution: ExecutionDocument, evidence: EvidenceDocument): void {
  const observationIds = execution.observations.map(item => item.observationId).sort((a, b) => a.localeCompare(b));
  const claimIds = execution.claims.map(item => item.claimId).sort((a, b) => a.localeCompare(b));
  const evaluationIds = evidence.evaluations.map(item => item.evaluationId).sort((a, b) => a.localeCompare(b));
  if (!structurallyEqual(run.observationIds, observationIds) || !structurallyEqual(run.claimIds, claimIds) || !structurallyEqual(run.evaluationIds, evaluationIds)) throw Error("invalid persisted run indexes");
}
const repositoryRunLocks = new WeakMap<object, Map<string, Promise<void>>>();
export function getVerificationRunLockCount(repository: RepositoryPort): number {
  return repositoryRunLocks.get(repository as unknown as object)?.size ?? 0;
}
async function runVerificationUnlocked(input: RunVerificationInput): Promise<RunVerificationResult> {
  const { dependencies } = input;
  const repository = dependencies.repository;
  let run = await loadRun(repository, input.runId);
  const persisted = await loadStage<VerificationRequest>(repository, input.runId, "request");
  if (persisted) validateStage("request", persisted, input.request ?? persisted, input.runId);
  let request = input.request;
  if (run) {
    if (!persisted) throw Error("resume requires persisted request document");
    if (request && !structurallyEqual(request, persisted)) throw Error("resume request identity/structural mismatch");
    request = persisted;
    if (run.requestId !== request.requestId || run.rootIdentity !== request.project.rootIdentity || run.snapshotId !== request.project.snapshotId) throw Error("run identity mismatch");
  } else {
    request = persisted ?? request;
    if (!request) throw Error("request is required when creating a run");
    validRequest(request);
    run = createInitialRun(input.runId, request, clockNow(dependencies.now));
    const committed = await repository.commitTransition({ runId: input.runId, stage: persisted ? undefined : "request", ...(persisted ? {} : { document: request }), run });
    if (!committed) throw Error("stale repository revision");
  }
  if (!run || !request) throw Error("run and request are required");
  validRequest(request);
  const req = request;
  const documents: VerificationRunDocuments = { request: persisted ?? req };
  while (run.state !== "TERMINAL") {
    if (run.state === "CREATED") {
      const doc = await establishTestBasis({ runId: input.runId, request: req, dependencies });
      const next = transitionRunState(run, "BASIS_ESTABLISHED", clockNow(dependencies.now));
      await commitStageAndRun(repository, next, "basis", doc, run.revision);
      run = next;
      documents.basis = doc;
      continue;
    }
    const basis = documents.basis ?? await loadCheckedStage<BasisDocument>(repository, input.runId, "basis", req, dependencies, documents);
    if (basis) documents.basis = basis;
    if (run.state === "BASIS_ESTABLISHED") {
      if (!basis) throw Error("basis document is missing");
      const doc = await performRiskDiscovery({ request: req, basis, dependencies });
      const next = transitionRunState(run, "DISCOVERY_COMPLETED", clockNow(dependencies.now));
      await commitStageAndRun(repository, next, "discovery", doc, run.revision);
      run = next;
      documents.discovery = doc;
      continue;
    }
    const discovery = documents.discovery ?? await loadCheckedStage<DiscoveryDocument>(repository, input.runId, "discovery", req, dependencies, documents);
    if (discovery) documents.discovery = discovery;
    if (run.state === "DISCOVERY_COMPLETED") {
      if (!basis || !discovery) throw Error("basis or discovery document is missing");
      const doc = await buildVerificationPlan({ request: req, basis, discovery, dependencies });
      const next = transitionRunState(run, "PLANNED", clockNow(dependencies.now));
      await commitStageAndRun(repository, next, "plan", doc, run.revision);
      run = next;
      documents.plan = doc;
      continue;
    }
    const plan = documents.plan ?? await loadCheckedStage<PlanDocument>(repository, input.runId, "plan", req, dependencies, documents);
    if (plan) documents.plan = plan;
    if (plan && basis && discovery) await assertCanonicalPlan(req, basis, discovery, plan, dependencies);
    if (run.state === "PLANNED") {
      if (!plan) throw Error("plan document is missing");
      const checkpoint = documents.execution ?? await loadCheckedStage<ExecutionDocument>(repository, input.runId, "execution", req, dependencies, documents);
      const executionResult = await executeObligations({ runId: input.runId, request: req, plan, dependencies, checkpoint, checkpointRunState: run.state, checkpointRevision: run.revision });
      const doc = executionResult.document;
      const latest = await loadRun(repository, input.runId);
      if (!latest) throw Error("execution run is missing");
      if (latest.state !== run.state || latest.revision !== executionResult.checkpointRevision) throw Error("stale execution checkpoint state/revision");
      const next = transitionRunState({ schemaVersion: latest.schemaVersion, runId: latest.runId, requestId: latest.requestId, rootIdentity: latest.rootIdentity, snapshotId: latest.snapshotId, state: latest.state, observationIds: doc.observations.map(item=>item.observationId), claimIds: doc.claims.map(item=>item.claimId), evaluationIds: latest.evaluationIds, revision: latest.revision, createdAt: latest.createdAt, updatedAt: latest.updatedAt }, "EXECUTING", clockNow(dependencies.now));
      await commitStageAndRun(repository, next, "execution", doc, latest.revision);
      run = next;
      documents.execution = doc;
      continue;
    }
    const execution = documents.execution ?? await loadCheckedStage<ExecutionDocument>(repository, input.runId, "execution", req, dependencies, documents);
    if (execution) documents.execution = execution;
    if (run.state === "EXECUTING") {
      if (!plan || !execution) throw Error("plan or execution document is missing");
      validateExecutionCompleteness(execution, plan);
      const persistedEvidence = documents.evidence ?? await loadHistoricallyCheckedEvidence(repository, input.runId, req, dependencies, documents);
      if (persistedEvidence) documents.evidence = persistedEvidence;
      const doc = await evaluateEvidence({ runId: input.runId, request: req, plan, execution, dependencies });
      const next = transitionRunState({ schemaVersion: run.schemaVersion, runId: run.runId, requestId: run.requestId, rootIdentity: run.rootIdentity, snapshotId: run.snapshotId, state: run.state, observationIds: execution.observations.map(item=>item.observationId), claimIds: execution.claims.map(item=>item.claimId), evaluationIds: doc.evaluations.map(item=>item.evaluationId), revision: run.revision, createdAt: run.createdAt, updatedAt: run.updatedAt }, "EVIDENCE_EVALUATED", clockNow(dependencies.now));
      await commitStageAndRun(repository, next, "evidence", doc, run.revision);
      run = next;
      documents.evidence = doc;
      continue;
    }
    let evidence = documents.evidence ?? await loadHistoricallyCheckedEvidence(repository, input.runId, req, dependencies, documents);
    if (evidence) documents.evidence = evidence;
    if (run.state === "EVIDENCE_EVALUATED") {
      if (!basis || !discovery || !plan || !execution || !evidence) throw Error("proof documents are missing");
      const resumedFreshnessAt = clockNow(dependencies.now);
      const resumedEvidence = await evaluateEvidence({ runId: input.runId, request: req, plan, execution, dependencies, freshnessEvaluatedAt: resumedFreshnessAt, freshnessAuthority: evidence.freshnessEvaluatedAt === resumedFreshnessAt ? evidence.freshnessAuthority : undefined });
      if (!structurallyEqual(resumedEvidence, evidence)) {
        const touched = touchRun(run, resumedFreshnessAt);
        await commitStageAndRun(repository, touched, "evidence", resumedEvidence, run.revision);
        run = touched;
        evidence = resumedEvidence;
        documents.evidence = evidence;
      }
      const saved = documents["residual-risk"] ?? await loadCheckedStage<ResidualRiskDocument>(repository, input.runId, "residual-risk", req, dependencies, documents);
      let residual = saved;
      if (!residual) {
        residual = await evaluateResidualRisk({ runId: input.runId, request: req, plan, execution, evidence, dependencies });
        const previousRevision = run.revision;
        const touched = touchRun(run, clockNow(dependencies.now));
        await commitStageAndRun(repository, touched, "residual-risk", residual, previousRevision);
        run = touched;
      }
      documents["residual-risk"] = residual;
      const verdict = await resolveVerdict({ runId: input.runId, request: req, basis, discovery, plan, execution, evidence, residualRisk: residual, dependencies });
      const next = transitionRunState(run, "VERDICT_RESOLVED", clockNow(dependencies.now));
      await commitStageAndRun(repository, next, "verdict", verdict, run.revision);
      run = next;
      documents.verdict = verdict;
      continue;
    }
    const residual = documents["residual-risk"] ?? await loadCheckedStage<ResidualRiskDocument>(repository, input.runId, "residual-risk", req, dependencies, documents);
    if (residual) documents["residual-risk"] = residual;
    const verdict = documents.verdict ?? await loadCheckedStage<VerdictDocument>(repository, input.runId, "verdict", req, dependencies, documents);
    if (!basis || !discovery || !plan || !execution || !evidence || !residual || !verdict) throw Error("proof documents are missing");
    await assertCanonicalVerdict({ runId: input.runId, request: req, basis, discovery, plan, execution, evidence, residualRisk: residual, dependencies }, verdict);
    assertCanonicalRunIndexes(run, execution, evidence);
    const resumedFreshnessAt = clockNow(dependencies.now);
    const resumedEvidence = await evaluateEvidence({ runId: input.runId, request: req, plan, execution, dependencies, freshnessEvaluatedAt: resumedFreshnessAt, freshnessAuthority: evidence.freshnessEvaluatedAt === resumedFreshnessAt ? evidence.freshnessAuthority : undefined });
    const canonicalVerdict = await resolveVerdict({ runId: input.runId, request: req, basis, discovery, plan, execution, evidence: resumedEvidence, residualRisk: residual, dependencies });
    const next = transitionRunState(run, "TERMINAL", clockNow(dependencies.now));
    await commitTerminalEvidenceAndVerdict(repository, next, resumedEvidence, canonicalVerdict, run.revision);
    run = next;
    documents.evidence = resumedEvidence;
    documents.verdict = canonicalVerdict;
  }
  const finalBasis = documents.basis ?? await loadCheckedStage<BasisDocument>(repository, input.runId, "basis", req, dependencies, documents);
  if (!finalBasis) throw Error("basis document is missing");
  documents.basis = finalBasis;
  const finalDiscovery = documents.discovery ?? await loadCheckedStage<DiscoveryDocument>(repository, input.runId, "discovery", req, dependencies, documents);
  if (!finalDiscovery) throw Error("discovery document is missing");
  documents.discovery = finalDiscovery;
  const finalPlan = documents.plan ?? await loadCheckedStage<PlanDocument>(repository, input.runId, "plan", req, dependencies, documents);
  if (!finalPlan) throw Error("plan document is missing");
  documents.plan = finalPlan;
  await assertCanonicalPlan(req, finalBasis, finalDiscovery, finalPlan, dependencies);
  const finalExecution = documents.execution ?? await loadCheckedStage<ExecutionDocument>(repository, input.runId, "execution", req, dependencies, documents);
  if (!finalExecution) throw Error("execution document is missing");
  documents.execution = finalExecution;
  validateExecutionCompleteness(finalExecution, finalPlan);
  let finalEvidence = documents.evidence ?? await loadHistoricallyCheckedEvidence(repository, input.runId, req, dependencies, documents);
  if (!finalEvidence) throw Error("evidence document is missing");
  documents.evidence = finalEvidence;
  const historicalEvidence = finalEvidence;
  const finalResidual = documents["residual-risk"] ?? await loadCheckedStage<ResidualRiskDocument>(repository, input.runId, "residual-risk", req, dependencies, documents);
  if (!finalResidual) throw Error("residual-risk document is missing");
  documents["residual-risk"] = finalResidual;
  let finalVerdict = documents.verdict ?? await loadCheckedStage<VerdictDocument>(repository, input.runId, "verdict", req, dependencies, documents);
  if (!finalVerdict) throw Error("terminal run has no verdict document");
  await assertCanonicalVerdict({ runId: input.runId, request: req, basis: finalBasis, discovery: finalDiscovery, plan: finalPlan, execution: finalExecution, evidence: historicalEvidence, residualRisk: finalResidual, dependencies }, finalVerdict);
  const resumedFreshnessAt = clockNow(dependencies.now);
  const resumedEvidence = await evaluateEvidence({ runId: input.runId, request: req, plan: finalPlan, execution: finalExecution, dependencies, freshnessEvaluatedAt: resumedFreshnessAt, freshnessAuthority: finalEvidence.freshnessEvaluatedAt === resumedFreshnessAt ? finalEvidence.freshnessAuthority : undefined });
  const refreshedEvidence = !structurallyEqual(resumedEvidence, finalEvidence);
  const canonicalVerdict = await resolveVerdict({ runId: input.runId, request: req, basis: finalBasis, discovery: finalDiscovery, plan: finalPlan, execution: finalExecution, evidence: resumedEvidence, residualRisk: finalResidual, dependencies });
  if (refreshedEvidence) {
    const touched = touchRun(run, resumedFreshnessAt);
    await commitTerminalEvidenceAndVerdict(repository, touched, resumedEvidence, canonicalVerdict, run.revision);
    run = touched;
    finalEvidence = resumedEvidence;
    finalVerdict = canonicalVerdict;
    documents.evidence = finalEvidence;
  } else if (!structurallyEqual(canonicalVerdict, finalVerdict)) {
    const touched = touchRun(run, clockNow(dependencies.now));
    await commitStageAndRun(repository, touched, "verdict", canonicalVerdict, run.revision);
    run = touched;
    finalVerdict = canonicalVerdict;
  }
  documents.verdict = finalVerdict;
  assertCanonicalRunIndexes(run, finalExecution, finalEvidence);
  return freeze({ run, verdict: finalVerdict, documents });
}
export async function runVerification(input: RunVerificationInput): Promise<RunVerificationResult> {
  const repositoryKey = input.dependencies.repository as unknown as object;
  let locks = repositoryRunLocks.get(repositoryKey);
  if (!locks) {
    locks = new Map();
    repositoryRunLocks.set(repositoryKey, locks);
  }
  const prior = locks.get(input.runId) ?? Promise.resolve();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const entry = prior.then(() => wait);
  locks.set(input.runId, entry);
  try {
    await prior;
    return await runVerificationUnlocked(input);
  } finally {
    release();
    if (locks.get(input.runId) === entry) locks.delete(input.runId);
  }
}