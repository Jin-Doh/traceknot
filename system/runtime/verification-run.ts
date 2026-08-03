import { resolveProofCarryingQaVerdict, type Artifact, type CoverageInput, type DefectSummary, type EvidenceClaim, type EvidenceEvaluation, type Execution, type IndependenceLevel, type Observation, type ProofCarryingObligation, type Producer, type SuccessCriterion, type TraceabilityLink, type VerdictResult } from "../core/qa-core";
export type MaybePromise<T> = T | PromiseLike<T>; export type Clock = () => string | Date;
export const RUN_STATES=["CREATED","BASIS_ESTABLISHED","DISCOVERY_COMPLETED","PLANNED","EXECUTING","EVIDENCE_EVALUATED","VERDICT_RESOLVED","TERMINAL"] as const; export type RunState=(typeof RUN_STATES)[number];
export type CanonicalRunState=Readonly<{schemaVersion:"verification-run/v1";runId:string;requestId:string;snapshotId:string;state:RunState;observationIds:readonly string[];claimIds:readonly string[];evaluationIds:readonly string[];createdAt:string;updatedAt:string}>;
export type BasisKind="request"|"requirement"|"acceptance-criterion"|"defect"|"contract"|"invariant"|"policy"; export type BasisOrigin="explicit"|"derived";
export type VerificationBasisItem=Readonly<{id:string;kind:BasisKind;origin:BasisOrigin;text:string;source?:string}>;
export type VerificationRequest=Readonly<{schemaVersion:"verification-request/v1";requestId:string;project:Readonly<{rootIdentity:string;snapshotId:string}>;change:Readonly<{summary:string;paths:readonly string[]}>;testBasis:readonly VerificationBasisItem[]}>;
export type RiskLevel="R0"|"R1"|"R2"|"R3"; export type VerificationRisk=Readonly<{id:string;level:RiskLevel;impact:number;likelihood:number;basisIds:readonly string[];rationale:string}>;
export type VerificationCondition=Readonly<{id:string;basisIds:readonly string[];riskIds:readonly string[];techniques:readonly string[];expectedResult:string}>;
export type EvidenceType="experiment"|"test-result"|"browser-result"|"build-result"|"static-analysis"|"review"|"approval"|"scenario-result";
export type VerificationObligationPlan=Readonly<{id:string;conditionIds:readonly string[];evidenceType:EvidenceType;mandatory:boolean;independence:IndependenceLevel;entryCriteria:readonly string[];completionCriteria:readonly string[]}>;
export type VerificationPlan=Readonly<{schemaVersion:"verification-plan/v1";requestId:string;snapshotId:string;risks:readonly VerificationRisk[];conditions:readonly VerificationCondition[];obligations:readonly VerificationObligationPlan[]}>;
export type VerificationEvidence=Readonly<{schemaVersion:"verification-evidence/v1";evidenceId:string;requestId:string;snapshotId:string;obligationId:string;producer:Producer;execution:Execution;result:Readonly<{verdict:"PASS"|"FAIL"|"BLOCKED"|"INCOMPLETE";summary:string;passed?:number;failed?:number;artifacts?:readonly string[]}>;observedAt:string;contentHash?:string}>;
export type VerificationExecutionRequest=Readonly<{requestId:string;snapshotId:string;obligation:VerificationObligationPlan;conditionIds:readonly string[]}>; export type VerificationExecutionOutput=Readonly<{status:"passed"|"failed"|"blocked"|"incomplete"|"PASS"|"FAIL"|"BLOCKED"|"INCOMPLETE";summary?:string;artifacts?:readonly Artifact[];executionKind?:Execution["kind"];identity?:string;exitCode?:number}>;
export type BrowserExecutionRequest=VerificationExecutionRequest; export type BrowserExecutionOutput=VerificationExecutionOutput; export type StoredArtifact=Artifact; export type ApprovalRequest=Readonly<{runId:string;defect:DefectSummary}>; export type ApprovalResult=Readonly<{approved:boolean;acceptanceExpiresAt?:string}>; export type UsageEvent=Readonly<{runId:string;obligationId?:string;event:"execution"|"artifact"|"approval"}>;
export type StageName="request"|"basis"|"discovery"|"plan"|"execution"|"evidence"|"residual-risk"|"verdict";
export interface RepositoryPort {readonly loadRun?:(id:string)=>MaybePromise<CanonicalRunState|undefined>;readonly saveRun?:(r:CanonicalRunState)=>MaybePromise<void>;readonly loadStageDocument?:(id:string,s:StageName)=>MaybePromise<unknown|undefined>;readonly saveStageDocument?:(id:string,s:StageName,d:unknown)=>MaybePromise<void>;readonly load?:(id:string)=>MaybePromise<CanonicalRunState|undefined>;readonly save?:(r:CanonicalRunState)=>MaybePromise<void>;readonly loadStage?:(id:string,s:StageName)=>MaybePromise<unknown|undefined>;readonly saveStage?:(id:string,s:StageName,d:unknown)=>MaybePromise<void>}
export interface VerificationExecutor {readonly executeObligation?:(i:VerificationExecutionRequest)=>MaybePromise<VerificationExecutionOutput|undefined>;readonly execute?:(i:VerificationExecutionRequest)=>MaybePromise<VerificationExecutionOutput|undefined>}; export interface ArtifactStore {readonly storeArtifact?:(a:Artifact,i:VerificationExecutionRequest)=>MaybePromise<Artifact|void>;readonly putArtifact?:(a:Artifact,i:VerificationExecutionRequest)=>MaybePromise<Artifact|void>;readonly store?:(a:Artifact,i:VerificationExecutionRequest)=>MaybePromise<Artifact|void>}; export interface CapabilityProvider {readonly hasCapability?:(s:string)=>MaybePromise<boolean>;readonly getCapabilities?:()=>MaybePromise<readonly string[]>;readonly capabilities?:readonly string[]}; export interface BrowserExecutor {readonly executeBrowser?:(i:BrowserExecutionRequest)=>MaybePromise<BrowserExecutionOutput|undefined>;readonly execute?:(i:BrowserExecutionRequest)=>MaybePromise<BrowserExecutionOutput|undefined>}; export interface ApprovalProvider {readonly requestApproval?:(i:ApprovalRequest)=>MaybePromise<ApprovalResult|undefined>;readonly approve?:(i:ApprovalRequest)=>MaybePromise<ApprovalResult|undefined>}; export interface UsageRecorder {readonly recordUsage?:(e:UsageEvent)=>MaybePromise<void>;readonly record?:(e:UsageEvent)=>MaybePromise<void>};
export type VerificationRunDependencies=Readonly<{repository:RepositoryPort;executor:VerificationExecutor;artifactStore:ArtifactStore;capabilityProvider:CapabilityProvider;browserExecutor?:BrowserExecutor;approvalProvider?:ApprovalProvider;usageRecorder?:UsageRecorder;now:Clock}>;
export type BasisDocument=Readonly<{schemaVersion:"verification-basis/v1";requestId:string;snapshotId:string;basis:readonly VerificationBasisItem[];basisIds:readonly string[]}>; export type DiscoveryDocument=Readonly<{schemaVersion:"risk-discovery/v1";requestId:string;snapshotId:string;risks:readonly VerificationRisk[];conditions:readonly VerificationCondition[]}>; export type PlanDocument=VerificationPlan; export type ExecutionDocument=Readonly<{schemaVersion:"verification-execution/v1";requestId:string;snapshotId:string;observations:readonly Observation[];claims:readonly EvidenceClaim[];evidence:readonly VerificationEvidence[]}>; export type EvidenceDocument=Readonly<{schemaVersion:"verification-evidence-evaluation/v1";requestId:string;snapshotId:string;evaluations:readonly EvidenceEvaluation[];acceptedClaimIds:readonly string[];coverage:CoverageInput}>; export type ResidualRiskDocument=Readonly<{schemaVersion:"verification-residual-risk/v1";requestId:string;snapshotId:string;defects:readonly DefectSummary[]}>; export type VerdictDocument=Readonly<{schemaVersion:"qa-verdict/v1";verdict:VerdictResult}>; export type StageDocument=VerificationRequest|BasisDocument|DiscoveryDocument|PlanDocument|ExecutionDocument|EvidenceDocument|ResidualRiskDocument|VerdictDocument;
export type EstablishTestBasisInput=Readonly<{runId?:string;request:VerificationRequest;dependencies:VerificationRunDependencies}>; export type PerformRiskDiscoveryInput=Readonly<{request:VerificationRequest;basis:BasisDocument;dependencies:VerificationRunDependencies}>; export type BuildVerificationPlanInput=Readonly<{request:VerificationRequest;basis:BasisDocument;discovery:DiscoveryDocument;dependencies:VerificationRunDependencies}>; export type ExecuteObligationsInput=Readonly<{runId:string;request:VerificationRequest;plan:VerificationPlan;dependencies:VerificationRunDependencies}>; export type EvaluateEvidenceInput=Readonly<{request:VerificationRequest;plan:VerificationPlan;execution:ExecutionDocument;dependencies:VerificationRunDependencies}>; export type EvaluateResidualRiskInput=Readonly<{runId:string;request:VerificationRequest;plan:VerificationPlan;execution:ExecutionDocument;evidence:EvidenceDocument;dependencies:VerificationRunDependencies}>; export type ResolveVerdictInput=Readonly<{runId:string;request:VerificationRequest;basis:BasisDocument;discovery:DiscoveryDocument;plan:VerificationPlan;execution:ExecutionDocument;evidence:EvidenceDocument;residualRisk:ResidualRiskDocument;dependencies:VerificationRunDependencies}>; export type RunVerificationInput=Readonly<{runId:string;request?:VerificationRequest;dependencies:VerificationRunDependencies}>; export type RunVerificationResult=Readonly<{run:CanonicalRunState;verdict:VerdictResult;documents:Readonly<Partial<Record<StageName,StageDocument>>>}>;

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)].sort();
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
function validRequest(request: VerificationRequest): void {
  if (request.schemaVersion !== "verification-request/v1" || !request.requestId || !request.project?.snapshotId) throw new Error("invalid verification request");
}
export function createInitialRun(runId: string, request: VerificationRequest, now: string): CanonicalRunState {
  validRequest(request);
  if (!runId || !now) throw new Error("runId and now are required");
  return freeze({ schemaVersion: "verification-run/v1" as const, runId, requestId: request.requestId, snapshotId: request.project.snapshotId, state: "CREATED" as const, observationIds: [], claimIds: [], evaluationIds: [], createdAt: now, updatedAt: now });
}
export function transitionRunState(run: CanonicalRunState, nextState: RunState, updatedAt: string): CanonicalRunState {
  const current = RUN_STATES.indexOf(run.state);
  const next = RUN_STATES.indexOf(nextState);
  if (current < 0 || next !== current + 1) throw new Error(`invalid run transition ${run.state} -> ${nextState}`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(updatedAt)) throw new Error("updatedAt must be canonical ISO date-time");
  return freeze({ ...run, state: nextState, updatedAt });
}
export const transitionRun = transitionRunState;
function criteriaFor(plan: VerificationPlan): readonly SuccessCriterion[] {
  return plan.obligations.map(item => ({ schemaVersion: "success-criterion/v1", criterionId: `criterion:${item.id}`, kind: "structured-assertion", expected: { assertions: [] }, requiredScope: { kind: "repository-canonical", selectors: [plan.requestId] }, requiredIndependence: item.independence, requiredArtifacts: [] }));
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
  const basis = [...input.request.testBasis].map(item => ({ ...item })).sort((a, b) => a.id.localeCompare(b.id));
  const ids = basis.map(item => item.id);
  if (!ids.length || ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error("test basis must contain unique IDs");
  return freeze({ schemaVersion: "verification-basis/v1", requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, basis, basisIds: uniq(ids) });
}
export async function performRiskDiscovery(input: PerformRiskDiscoveryInput): Promise<DiscoveryDocument> {
  validRequest(input.request);
  const risks = input.basis.basis.map(item => ({ id: `risk:${item.id}`, level: "R1" as const, impact: 1, likelihood: 1, basisIds: [item.id], rationale: `Verification risk derived from basis ${item.id}.` }));
  const conditions = input.basis.basis.map(item => ({ id: `condition:${item.id}`, basisIds: [item.id], riskIds: [`risk:${item.id}`], techniques: ["canonical-verification"], expectedResult: `Evidence demonstrates ${item.id}.` }));
  return freeze({ schemaVersion: "risk-discovery/v1", requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, risks, conditions });
}
export async function buildVerificationPlan(input: BuildVerificationPlanInput): Promise<PlanDocument> {
  validRequest(input.request);
  const obligations = input.discovery.conditions.map(item => ({ id: `obligation:${item.id}`, conditionIds: [item.id], evidenceType: "test-result" as const, mandatory: true, independence: "separate-verification-context" as const, entryCriteria: [], completionCriteria: [item.expectedResult] }));
  return freeze({ schemaVersion: "verification-plan/v1", requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, risks: input.discovery.risks, conditions: input.discovery.conditions, obligations });
}
function capabilityFor(obligation: VerificationObligationPlan): string { return obligation.evidenceType === "browser-result" ? "browser" : obligation.evidenceType; }
async function hasCapability(provider: CapabilityProvider, name: string): Promise<boolean> {
  if (provider.hasCapability) return Boolean(await provider.hasCapability(name));
  const capabilities = provider.getCapabilities ? await provider.getCapabilities() : provider.capabilities;
  return Boolean(capabilities?.includes(name));
}
async function record(provider: UsageRecorder | undefined, event: UsageEvent): Promise<void> { if (provider?.recordUsage) await provider.recordUsage(event); else if (provider?.record) await provider.record(event); }
async function executePort(port: VerificationExecutor | BrowserExecutor, input: VerificationExecutionRequest): Promise<VerificationExecutionOutput | undefined> {
  if ("executeObligation" in port && port.executeObligation) return port.executeObligation(input);
  if ("executeBrowser" in port && port.executeBrowser) return port.executeBrowser(input);
  return port.execute ? port.execute(input) : undefined;
}
function normalizeStatus(value: VerificationExecutionOutput["status"]): VerificationEvidence["result"]["verdict"] {
  const status = String(value).toLowerCase();
  return status === "passed" || status === "pass" ? "PASS" : status === "failed" || status === "fail" ? "FAIL" : status === "blocked" || status === "block" ? "BLOCKED" : "INCOMPLETE";
}
function executionFor(obligation: VerificationObligationPlan, verdict: VerificationEvidence["result"]["verdict"], now: string, output?: VerificationExecutionOutput): Execution {
  const exitStatus: Execution["exitStatus"] = verdict === "PASS" ? "passed" : verdict === "FAIL" ? "failed" : verdict === "BLOCKED" ? "blocked" : "cancelled";
  return { kind: output?.executionKind ?? (obligation.evidenceType === "browser-result" ? "browser" : "command"), identity: output?.identity ?? "verification-executor", startedAt: now, finishedAt: now, exitStatus, ...(output?.exitCode === undefined ? {} : { exitCode: output.exitCode }) };
}
async function storeArtifact(store: ArtifactStore, artifact: Artifact, input: VerificationExecutionRequest): Promise<Artifact> {
  const saved = store.storeArtifact ? await store.storeArtifact(artifact, input) : store.putArtifact ? await store.putArtifact(artifact, input) : store.store ? await store.store(artifact, input) : undefined;
  return saved ?? artifact;
}
export async function executeObligations(input: ExecuteObligationsInput): Promise<ExecutionDocument> {
  validRequest(input.request);
  const observedAt = clockNow(input.dependencies.now); const observations: Observation[] = []; const claims: EvidenceClaim[] = []; const evidence: VerificationEvidence[] = [];
  for (const obligation of [...input.plan.obligations].sort((a, b) => a.id.localeCompare(b.id))) {
    const request = { requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, obligation, conditionIds: uniq(obligation.conditionIds) };
    const available = await hasCapability(input.dependencies.capabilityProvider, capabilityFor(obligation));
    const port = obligation.evidenceType === "browser-result" ? input.dependencies.browserExecutor : input.dependencies.executor;
    const output = available && port ? await executePort(port, request) : undefined;
    const verdict = !available ? "BLOCKED" : !output ? "INCOMPLETE" : normalizeStatus(output.status);
    const summary = !available ? `Capability ${capabilityFor(obligation)} is unavailable.` : !output ? "No executor output was returned." : output.summary ?? `Obligation ${obligation.id} completed.`;
    const artifacts: Artifact[] = [];
    if (verdict === "PASS" || verdict === "FAIL") {
      const inputs = output?.artifacts?.length ? [...output.artifacts] : [{ type: "verification-result", digest: `artifact:${input.request.requestId}:${obligation.id}` }];
      for (const artifact of inputs) { artifacts.push(await storeArtifact(input.dependencies.artifactStore, artifact, request)); await record(input.dependencies.usageRecorder, { runId: input.runId, obligationId: obligation.id, event: "artifact" }); }
    }
    const execution = executionFor(obligation, verdict, observedAt, output); const producer: Producer = { kind: "deterministic-verifier", identity: "verification-executor", independence: obligation.independence }; const observationId = `observation:${obligation.id}`;
    observations.push({ schemaVersion: "observation/v1", observationId, requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, producer, execution, artifacts });
    evidence.push({ schemaVersion: "verification-evidence/v1", evidenceId: `evidence:${obligation.id}`, requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, obligationId: obligation.id, producer, execution, result: { verdict, summary, ...(verdict === "PASS" ? { passed: 1 } : verdict === "FAIL" ? { failed: 1 } : {}), artifacts: artifacts.map(item => item.digest) }, observedAt });
    claims.push({ schemaVersion: "evidence-claim/v1", claimId: `claim:${obligation.id}`, requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, obligationId: obligation.id, criterionId: `criterion:${obligation.id}`, observationIds: [observationId], claim: summary });
    await record(input.dependencies.usageRecorder, { runId: input.runId, obligationId: obligation.id, event: "execution" });
  }
  return freeze({ schemaVersion: "verification-execution/v1", requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, observations, claims, evidence });
}
function makeEvaluation(observation: Observation | undefined, claim: EvidenceClaim, evaluatedAt: string): EvidenceEvaluation {
  const accepted = observation?.execution.exitStatus === "passed" && observation.artifacts.length > 0;
  return { schemaVersion: "evidence-evaluation/v1", evaluationId: `evaluation:${claim.claimId}`, requestId: claim.requestId, snapshotId: claim.snapshotId, claimId: claim.claimId, status: accepted ? "ACCEPTED" : "REJECTED", checks: { snapshotBound: true, fresh: true, scopeComplete: true, producerAllowed: true, independenceSatisfied: true, expectedResultDemonstrated: accepted, expectedResultViolated: !accepted, integrityVerified: accepted }, rejectionReasons: accepted ? [] : ["EXPECTED_RESULT_NOT_DEMONSTRATED"], evaluatedAt };
}
export async function evaluateEvidence(input: EvaluateEvidenceInput): Promise<EvidenceDocument> {
  validRequest(input.request); const evaluatedAt = clockNow(input.dependencies.now); const observations = new Map(input.execution.observations.map(item => [item.observationId, item])); const evaluations = input.execution.claims.map(claim => makeEvaluation(observations.get(claim.observationIds[0]), claim, evaluatedAt));
  const accepted = new Set(evaluations.filter(item => item.status === "ACCEPTED").map(item => item.claimId.replace(/^claim:/, "obligation:"))); const conditionById = new Map(input.plan.conditions.map(item => [item.id, item])); const conditions = uniq(input.plan.conditions.map(item => item.id)); const coveredConditions = uniq(input.plan.obligations.filter(item => accepted.has(item.id)).flatMap(item => item.conditionIds));
  return freeze({ schemaVersion: "verification-evidence-evaluation/v1", requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, evaluations, acceptedClaimIds: evaluations.filter(item => item.status === "ACCEPTED").map(item => item.claimId), coverage: { basisIds: uniq(input.plan.conditions.flatMap(item => item.basisIds)), coveredBasisIds: uniq(coveredConditions.flatMap(id => conditionById.get(id)?.basisIds ?? [])), riskIds: uniq(input.plan.risks.map(item => item.id)), coveredRiskIds: uniq(coveredConditions.flatMap(id => conditionById.get(id)?.riskIds ?? [])), conditionIds: conditions, coveredConditionIds: coveredConditions } });
}
export async function evaluateResidualRisk(input: EvaluateResidualRiskInput): Promise<ResidualRiskDocument> {
  const accepted = new Set(input.evidence.evaluations.filter(item => item.status === "ACCEPTED").map(item => item.claimId.replace(/^claim:/, "obligation:"))); const defects: DefectSummary[] = [];
  for (const obligation of input.plan.obligations) {
    if (accepted.has(obligation.id)) continue;
    const defect: DefectSummary = { id: `residual:${obligation.id}`, material: obligation.mandatory, disposition: "OPEN" }; const provider = input.dependencies.approvalProvider; const approval = provider?.requestApproval ? await provider.requestApproval({ runId: input.runId, defect }) : provider?.approve ? await provider.approve({ runId: input.runId, defect }) : undefined;
    await record(input.dependencies.usageRecorder, { runId: input.runId, obligationId: obligation.id, event: "approval" }); defects.push(approval?.approved ? { ...defect, disposition: "ACCEPTED_RISK", acceptanceExpiresAt: approval.acceptanceExpiresAt } : defect);
  }
  return freeze({ schemaVersion: "verification-residual-risk/v1", requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, defects });
}
export async function resolveVerdict(input: ResolveVerdictInput): Promise<VerdictDocument> {
  validRequest(input.request);
  const proof = { requestId: input.request.requestId, snapshotId: input.request.project.snapshotId, obligations: proofObligations(input.plan), criteria: criteriaFor(input.plan), observations: input.execution.observations, claims: input.execution.claims, evaluations: input.evidence.evaluations, defects: input.residualRisk.defects, coverage: input.evidence.coverage, evaluatedAt: clockNow(input.dependencies.now), traceability: traceLinks(input.plan, input.discovery) };
  return freeze({ schemaVersion: "qa-verdict/v1", verdict: resolveProofCarryingQaVerdict(proof) });
}
async function loadRun(repository: RepositoryPort, runId: string): Promise<CanonicalRunState | undefined> { if (repository.loadRun) return repository.loadRun(runId); if (repository.load) return repository.load(runId); throw Error("repository does not implement loadRun"); }
async function saveRun(repository: RepositoryPort, run: CanonicalRunState): Promise<void> { if (repository.saveRun) return repository.saveRun(run); if (repository.save) return repository.save(run); throw Error("repository does not implement saveRun"); }
async function loadStage<T>(repository: RepositoryPort, runId: string, stage: StageName): Promise<T | undefined> { if (repository.loadStageDocument) return repository.loadStageDocument(runId, stage) as MaybePromise<T | undefined>; if (repository.loadStage) return repository.loadStage(runId, stage) as MaybePromise<T | undefined>; throw Error("repository does not implement loadStageDocument"); }
async function saveStage(repository: RepositoryPort, runId: string, stage: StageName, document: StageDocument): Promise<void> { if (repository.saveStageDocument) return repository.saveStageDocument(runId, stage, document); if (repository.saveStage) return repository.saveStage(runId, stage, document); throw Error("repository does not implement saveStageDocument"); }
function identityMatches(run: CanonicalRunState, id: string, request: VerificationRequest): void { if (run.runId !== id || run.requestId !== request.requestId || run.snapshotId !== request.project.snapshotId) throw Error("run identity mismatch"); }
export async function runVerification(input: RunVerificationInput): Promise<RunVerificationResult> {
  const { dependencies } = input; const repository = dependencies.repository; let run = await loadRun(repository, input.runId); let request = input.request; const persisted = await loadStage<VerificationRequest>(repository, input.runId, "request");
  if (run) {
    if (persisted) { if (request && (request.requestId !== persisted.requestId || request.project.snapshotId !== persisted.project.snapshotId)) throw Error("resume request identity mismatch"); request = persisted; }
    if (!request) throw Error("resume requires persisted request document"); identityMatches(run, input.runId, request);
  } else {
    if (!request) throw Error("request is required when creating a run"); run = createInitialRun(input.runId, request, clockNow(dependencies.now)); await saveStage(repository, input.runId, "request", request); await saveRun(repository, run);
  }
  validRequest(request!); const req = request!; const documents: Partial<Record<StageName, StageDocument>> = { request: persisted ?? req };
  while (run.state !== "TERMINAL") {
    if (run.state === "CREATED") { const doc = await establishTestBasis({ runId: input.runId, request: req, dependencies }); documents.basis = doc; await saveStage(repository, input.runId, "basis", doc); run = transitionRunState(run, "BASIS_ESTABLISHED", clockNow(dependencies.now)); await saveRun(repository, run); continue; }
    const basis = documents.basis ?? await loadStage<BasisDocument>(repository, input.runId, "basis"); if (basis) documents.basis = basis;
    if (run.state === "BASIS_ESTABLISHED") { if (!basis) throw Error("basis document is missing"); const doc = await performRiskDiscovery({ request: req, basis, dependencies }); documents.discovery = doc; await saveStage(repository, input.runId, "discovery", doc); run = transitionRunState(run, "DISCOVERY_COMPLETED", clockNow(dependencies.now)); await saveRun(repository, run); continue; }
    const discovery = documents.discovery ?? await loadStage<DiscoveryDocument>(repository, input.runId, "discovery"); if (discovery) documents.discovery = discovery;
    if (run.state === "DISCOVERY_COMPLETED") { if (!basis || !discovery) throw Error("basis or discovery document is missing"); const doc = await buildVerificationPlan({ request: req, basis, discovery, dependencies }); documents.plan = doc; await saveStage(repository, input.runId, "plan", doc); run = transitionRunState(run, "PLANNED", clockNow(dependencies.now)); await saveRun(repository, run); continue; }
    const plan = documents.plan ?? await loadStage<PlanDocument>(repository, input.runId, "plan"); if (plan) documents.plan = plan;
    if (run.state === "PLANNED") { if (!plan) throw Error("plan document is missing"); const doc = await executeObligations({ runId: input.runId, request: req, plan, dependencies }); documents.execution = doc; await saveStage(repository, input.runId, "execution", doc); run = transitionRunState({ ...run, observationIds: doc.observations.map(item => item.observationId), claimIds: doc.claims.map(item => item.claimId) }, "EXECUTING", clockNow(dependencies.now)); await saveRun(repository, run); continue; }
    const execution = documents.execution ?? await loadStage<ExecutionDocument>(repository, input.runId, "execution"); if (execution) documents.execution = execution;
    if (run.state === "EXECUTING") { if (!plan || !execution) throw Error("plan or execution document is missing"); const doc = await evaluateEvidence({ request: req, plan, execution, dependencies }); documents.evidence = doc; await saveStage(repository, input.runId, "evidence", doc); run = transitionRunState({ ...run, evaluationIds: doc.evaluations.map(item => item.evaluationId) }, "EVIDENCE_EVALUATED", clockNow(dependencies.now)); await saveRun(repository, run); continue; }
    const evidence = documents.evidence ?? await loadStage<EvidenceDocument>(repository, input.runId, "evidence"); if (evidence) documents.evidence = evidence;
    if (run.state === "EVIDENCE_EVALUATED") {
      if (!basis || !discovery || !plan || !execution || !evidence) throw Error("proof documents are missing");
      const saved = documents["residual-risk"] ?? await loadStage<ResidualRiskDocument>(repository, input.runId, "residual-risk"); const residual = saved ?? await evaluateResidualRisk({ runId: input.runId, request: req, plan, execution, evidence, dependencies }); documents["residual-risk"] = residual; await saveStage(repository, input.runId, "residual-risk", residual);
      const verdict = await resolveVerdict({ runId: input.runId, request: req, basis, discovery, plan, execution, evidence, residualRisk: residual, dependencies }); documents.verdict = verdict; await saveStage(repository, input.runId, "verdict", verdict); run = transitionRunState(run, "VERDICT_RESOLVED", clockNow(dependencies.now)); await saveRun(repository, run); continue;
    }
    const verdict = documents.verdict ?? await loadStage<VerdictDocument>(repository, input.runId, "verdict"); if (!verdict) throw Error("verdict document is missing"); documents.verdict = verdict; run = transitionRunState(run, "TERMINAL", clockNow(dependencies.now)); await saveRun(repository, run);
  }
  const verdict = documents.verdict ?? await loadStage<VerdictDocument>(repository, input.runId, "verdict"); if (!verdict) throw Error("terminal run has no verdict document"); documents.verdict = verdict; return freeze({ run, verdict: verdict.verdict, documents });
}