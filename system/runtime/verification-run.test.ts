import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import type { Artifact } from "../core/qa-core";
import type { VisualCompositionOracle } from "../core/visual-composition";
import { type UiApplicabilityApprovalReceipt, type UiApplicabilityApprovalSubject, type UiProfileEvidence, type UiResilienceOracle, type UiResilienceProfile } from "../core/ui-resilience";
import {
  buildVerificationPlan,
  DispatchClaimAcquisitionError,
  createInitialRun,
  establishTestBasis,
  canonicalRequestDigest,
  performRiskDiscovery,
  getVerificationRunLockCount,
  runVerification,
  transitionRunState,
  type ArtifactStore,
  type ApprovalProvider,
  type UsageEvent,
  type BrowserExecutor,
  type CanonicalRunState,
  type CapabilityProvider,

  type ExecutionAuthority,
  type DispatchClaim,
  type FreshnessAuthority,
  type VerificationExecutionCompletionEnvelope,
  type RepositoryPort,
  type UsageRecorder,
  type VerificationExecutor,
  type VerificationExecutionOutput,
  type VerificationExecutionRequest,
  type VerificationRequest,
  type VerificationRunDependencies,
  type ExecutionDocument,
  type ExecutionCheckpointTransition,
  type TerminalEvidenceVerdictTransition,
} from "./verification-run";

const FIXED_NOW = "2026-08-03T00:00:00.000Z";
const RUN_ID = "run-001";
const REQUEST_ID = "request-001";
const SNAPSHOT_ID = "snapshot-001";

type RunInput = Parameters<typeof runVerification>[0];
type RunStateValue = CanonicalRunState["state"];
type FakeOptions = { missingCapability?: boolean; missingExecutorOutput?: boolean; missingBrowserOutput?: boolean; invalidArtifact?: boolean; missingArtifactStorage?: boolean; mismatchedProvenance?: boolean; producerKind?: "self" | "harness-managed" | "deterministic-verifier" | "ci" | "human" | "external-system"; producerIndependence?: "self-check" | "separate-verification-context" | "independent-producer"; missingAuthority?: boolean; mismatchedAuthority?: boolean; rejectedAuthority?: boolean; invalidProducer?: boolean; visualCompositionOracle?: boolean; mismatchedOracleProducer?: boolean; omitStoredScreenshot?: boolean; browserStatus?: "PASS" | "BLOCKED" | "INCOMPLETE"; failedVisualAssertion?: boolean; visualBlocking?: boolean };

type FakeDispatchClaimResult = { claimed: boolean; status: "CLAIMED" | "COMPLETED"; claim: DispatchClaim; outputStored: boolean; completion?: VerificationExecutionCompletionEnvelope };
type FakeRepositoryStore = {
  runs: Map<string, CanonicalRunState>;
  stageDocuments: Map<string, unknown>;
  dispatchClaims: Map<string, { claim: DispatchClaim; status: "CLAIMED" | "COMPLETED"; outputStored: boolean; completion?: VerificationExecutionCompletionEnvelope }>;
};
class FakeRepository {
  readonly generationFencedDispatchCompletion = true;
  readonly generationFencedDispatchCheckpoint = true;
  readonly runs: Map<string, CanonicalRunState>;
  readonly stageDocuments: Map<string, unknown>;
  readonly dispatchClaims: Map<string, { claim: DispatchClaim; status: "CLAIMED" | "COMPLETED"; outputStored: boolean; completion?: VerificationExecutionCompletionEnvelope }>;
  constructor(store?: FakeRepositoryStore) {
    const backing = store ?? { runs: new Map(), stageDocuments: new Map(), dispatchClaims: new Map() };
    this.runs = backing.runs;
    this.stageDocuments = backing.stageDocuments;
    this.dispatchClaims = backing.dispatchClaims;
  }
  failNextState?: RunStateValue;
  failNextStage?: string;
  takeoverBeforeExecutionCheckpoint = false;
  readonly stageWrites: string[] = [];
  readonly runWrites: CanonicalRunState[] = [];
  async loadRun(runId: string): Promise<CanonicalRunState | undefined> { return this.runs.get(runId); }
  async loadStageDocument(runId: string, stage: string): Promise<unknown | undefined> { return this.stageDocuments.get(`${runId}:${stage}`); }
  async claimExecutionDispatch(claim: DispatchClaim, now = FIXED_NOW, _attemptToken?: symbol): Promise<FakeDispatchClaimResult> {
    const existing = this.dispatchClaims.get(claim.claimKey);
    if (existing?.status === "COMPLETED") return { claimed: false, ...structuredClone(existing) };
    if (existing) {
      if (Date.parse(now) <= Date.parse(existing.claim.leaseExpiresAt)) return { claimed: false, ...structuredClone(existing) };
      const takeover = { ...claim, leaseGeneration: existing.claim.leaseGeneration + 1 };
      this.dispatchClaims.set(claim.claimKey, { claim: structuredClone(takeover), status: "CLAIMED", outputStored: false });
      return { claimed: true, claim: structuredClone(takeover), status: "CLAIMED", outputStored: false };
    }
    const created = { claim: structuredClone(claim), status: "CLAIMED" as const, outputStored: false };
    this.dispatchClaims.set(claim.claimKey, created);
    return { claimed: true, ...structuredClone(created) };
  }
  async completeExecutionDispatch(claim: DispatchClaim, completion: VerificationExecutionCompletionEnvelope | undefined, _now = FIXED_NOW): Promise<boolean> {
    const existing = this.dispatchClaims.get(claim.claimKey);
    if (!existing || existing.status !== "CLAIMED" || existing.claim.ownerId !== claim.ownerId || existing.claim.leaseGeneration !== claim.leaseGeneration || existing.claim.acquisitionId !== claim.acquisitionId) return false;
    this.dispatchClaims.set(claim.claimKey, { ...existing, status: "COMPLETED", outputStored: completion !== undefined, ...(completion === undefined ? {} : { completion: structuredClone(completion) }) });
    return true;
  }
  async releaseExecutionDispatch(claim: DispatchClaim, now = FIXED_NOW): Promise<boolean> {
    const existing = this.dispatchClaims.get(claim.claimKey);
    if (!existing || existing.status !== "CLAIMED" || existing.claim.ownerId !== claim.ownerId || existing.claim.leaseGeneration !== claim.leaseGeneration || existing.claim.acquisitionId !== claim.acquisitionId || Date.parse(now) > Date.parse(existing.claim.leaseExpiresAt)) return false;
    this.dispatchClaims.delete(claim.claimKey);
    return true;
  }
  async commitExecutionCheckpoint(transition: ExecutionCheckpointTransition, claim: DispatchClaim): Promise<boolean> {
    const existing = this.dispatchClaims.get(claim.claimKey);
    if (existing?.status === "CLAIMED" && this.takeoverBeforeExecutionCheckpoint) {
      this.takeoverBeforeExecutionCheckpoint = false;
      this.dispatchClaims.set(claim.claimKey, { claim: { ...existing.claim, ownerId: "takeover-worker", leaseGeneration: existing.claim.leaseGeneration + 1, acquisitionId: "00000000-0000-4000-8000-000000000099" }, status: "CLAIMED", outputStored: false });
    }
    const current = this.dispatchClaims.get(claim.claimKey);
    if (!current || current.status !== "CLAIMED" || current.claim.ownerId !== claim.ownerId || current.claim.leaseGeneration !== claim.leaseGeneration || current.claim.acquisitionId !== claim.acquisitionId) return false;
    return this.commitTransition({ ...transition, stage: "execution" });
  }
  async commitTransition(transition: { runId: string; expectedRevision?: number; stage?: string; document?: unknown; run: CanonicalRunState }): Promise<boolean> {
    const current = this.runs.get(transition.runId);
    if (transition.expectedRevision === undefined
      ? current !== undefined || transition.run.revision !== 0
      : (!current || current.revision !== transition.expectedRevision || transition.run.revision !== current.revision + 1)) return false;
    if (this.failNextState === transition.run.state) {
      this.failNextState = undefined;
      throw new Error("simulated saveRun crash");
    }
    if (transition.stage && this.failNextStage === transition.stage) {
      this.failNextStage = undefined;
      throw new Error("simulated saveStage crash");
    }
    const clonedRun = structuredClone(transition.run);
    const clonedDocument = transition.stage === undefined ? undefined : structuredClone(transition.document);
    this.runWrites.push(clonedRun);
    this.runs.set(transition.runId, clonedRun);
    if (transition.stage !== undefined) {
      this.stageWrites.push(transition.stage);
      this.stageDocuments.set(`${transition.runId}:${transition.stage}`, clonedDocument);
    }
    return true;
  }
  async commitEvidenceAndVerdict(transition: TerminalEvidenceVerdictTransition): Promise<boolean> {
    const current = this.runs.get(transition.runId);
    if (transition.expectedRevision === undefined
      ? current !== undefined || transition.run.revision !== 0
      : (!current || current.revision !== transition.expectedRevision || transition.run.revision !== current.revision + 1)) return false;
    if (this.failNextState === transition.run.state) {
      this.failNextState = undefined;
      throw new Error("simulated saveRun crash");
    }
    if (this.failNextStage === "evidence" || this.failNextStage === "verdict") {
      this.failNextStage = undefined;
      throw new Error("simulated saveStage crash");
    }
    const clonedRun = structuredClone(transition.run);
    this.runWrites.push(clonedRun);
    this.runs.set(transition.runId, clonedRun);
    this.stageWrites.push("evidence", "verdict");
    this.stageDocuments.set(`${transition.runId}:evidence`, structuredClone(transition.evidence));
    this.stageDocuments.set(`${transition.runId}:verdict`, structuredClone(transition.verdict));
    return true;
  }
}

type FakePorts = { repository: FakeRepository; executorCalls: number; browserCalls: number; authorityCalls: number };
type FakeDependencies = FakePorts & { dependencies: VerificationRunDependencies };

function makeRequest(requestId = REQUEST_ID): VerificationRequest {
  return {
    schemaVersion: "verification-request/v1",
    requestId,
    project: { rootIdentity: "repository", snapshotId: SNAPSHOT_ID },
    change: { summary: "verify the requested change", paths: ["system/runtime/verification-run.ts"] },
    testBasis: [
      { id: "basis-001", kind: "acceptance-criterion", origin: "explicit", text: "The run produces a terminal verdict.", source: "request" },
      { id: "condition-001", kind: "invariant", origin: "explicit", text: "Evidence is snapshot-bound.", source: "request" },
    ],
  };
}

function makeCompositionRequest(requestId = "request-visual-composition"): VerificationRequest {
  return {
    ...makeRequest(requestId),
    change: { summary: "Adjust responsive section spacing and panel hierarchy.", paths: ["frontend/catalog.tsx"], uiImpact: "significant" },
    testBasis: [{ id: "basis-layout", kind: "acceptance-criterion", origin: "explicit", text: "Primary and supporting regions preserve the approved layout spacing." }],
    visualComposition: {
      schemaVersion: "visual-composition-scope/v1",
      decision: "required",
      basisIds: ["basis-layout"],
      rationale: "Responsive section spacing changes at the affected desktop and mobile breakpoints.",
      surfaces: [{ surfaceId: "surface-catalog", stateIds: ["populated"], viewportIds: ["desktop", "mobile"] }],
      viewports: [
        { id: "desktop", width: 1440, height: 900 },
        { id: "mobile", width: 390, height: 844, devicePixelRatio: 3 },
      ],
    },
    uiResilience: (() => {
      const scope = makeResilienceRequest(requestId).uiResilience!;
      return { ...scope, basisIds: ["basis-layout"], surfaces: scope.surfaces.map(surface => ({ ...surface, regions: surface.regions.map(region => ({ ...region, basisIds: ["basis-layout"] })), profileApplicability: surface.profileApplicability.map(profile => ({ ...profile, basisIds: ["basis-layout"], ...(profile.approvalReceipt === undefined ? {} : { approvalReceipt: { ...profile.approvalReceipt, basisIds: ["basis-layout"] } }) })) })) };
    })(),
  };
}

const TOKEN_RESOLUTION_DIGEST = new Bun.CryptoHasher("sha256")
  .update(JSON.stringify({ schemaVersion: "design-token-resolution/v1", systemId: "synthetic-design-system", token: "layout.sectionGap", unit: "css-px", value: 32 }))
  .digest("hex");
const compositionScreenshotDigest = (role: string, viewportId: string) => new Bun.CryptoHasher("sha256").update(`${role}:${viewportId}:populated`).digest("hex");


function makeCompositionOracle(request: VerificationExecutionRequest, producer: VisualCompositionOracle["producer"], options: FakeOptions = {}): VisualCompositionOracle {
  const conditionId = request.obligation.visualCompositionRequirement?.conditionId;
  if (!conditionId) throw new Error("composition fixture received a non-composition obligation");
  return {
    schemaVersion: "visual-composition-oracle/v1",
    oracleId: `oracle:${request.runId}`,
    requestId: request.requestId,
    snapshotId: request.snapshotId,
    conditionId,
    producer,
    captures: ["desktop", "mobile"].map(viewportId => ({
      captureId: `capture-${viewportId}`,
      surfaceId: "surface-catalog",
      stateId: "populated",
      viewportId,
      viewport: viewportId === "desktop" ? { id: "desktop", width: 1440, height: 900 } : { id: "mobile", width: 390, height: 844, devicePixelRatio: 3 },
      screenshots: [
        { evidenceId: `evidence-full-page-${viewportId}`, role: "full-page", digest: compositionScreenshotDigest("full-page", viewportId) },
        { evidenceId: `evidence-focused-region-${viewportId}`, role: "focused-region", regionId: "main", digest: compositionScreenshotDigest("focused-region", viewportId) },
      ],
      regions: [
        { regionId: "main", role: "primary", x: 0, y: 0, width: viewportId === "desktop" ? 900 : 390, height: 500 },
        { regionId: "supporting", role: "supporting", x: 0, y: 532, width: viewportId === "desktop" ? 900 : 390, height: 200 },
      ],
      assertions: [{
        assertionId: `section-separation-${viewportId}`,
        relation: "separation",
        regionIds: ["main", "supporting"],
        axis: "vertical",
        operator: "greater-than-or-equal",
        expected: 32,
        actual: options.failedVisualAssertion ? 0 : 32,
        unit: "css-px",
        source: { kind: "design-token", systemId: "synthetic-design-system", token: "layout.sectionGap", unit: "css-px", resolvedValue: 32, resolutionArtifactDigest: TOKEN_RESOLUTION_DIGEST, basisIds: ["basis-layout"] },
      }],
    })),
    representativeStateLimitations: ["Loading and error states use the unchanged shared shell."],
    blockingReasons: options.visualBlocking ? ["token service unavailable"] : [],
  };
}
const resilienceProfiles: readonly UiResilienceProfile[] = ["text-overflow", "resize-text-200", "reflow-320", "text-spacing-wcag", "pseudo-localization", "rtl", "reduced-motion", "hover-focus-content"];
function resilienceApprovalReceipt(requestId: string, profile: UiResilienceProfile, basisId = "basis-content"): UiApplicabilityApprovalReceipt {
  const rationale = `${profile} capability is absent.`;
  return { schemaVersion: "ui-applicability-approval-receipt/v1", receiptId: `receipt:${profile}`, issuer: "fixture-applicability-authority", keyId: "fixture-key", requestId, snapshotId: SNAPSHOT_ID, conditionId: "condition:request-ui-resilience", surfaceId: "catalog", profile, basisIds: [basisId], rationale, signature: `signed:${profile}` };
}
function makeResilienceRequest(requestId = "request-ui-resilience"): VerificationRequest {
  const required = new Set<UiResilienceProfile>(["text-overflow", "resize-text-200", "text-spacing-wcag"]);
  return {
    ...makeRequest(requestId),
    change: { summary: "Keep catalog labels readable under content stress.", paths: ["frontend/catalog.tsx"], uiImpact: "significant" },
    testBasis: [{ id: "basis-content", kind: "acceptance-criterion", origin: "explicit", text: "Catalog labels remain fully readable without unintended clipping." }],
    visualComposition: {
      schemaVersion: "visual-composition-scope/v1",
      decision: "not-required",
      basisIds: ["basis-content"],
      rationale: "The test isolates content resilience without changing composition.",
      surfaces: [],
      viewports: [],
    },
    uiResilience: {
      schemaVersion: "ui-resilience-scope/v1",
      decision: "required",
      basisIds: ["basis-content"],
      rationale: "The rendered text surface accepts variable user and localized content.",
      viewports: [{ id: "desktop", width: 1440, height: 900 }],
      surfaces: [{
        surfaceId: "catalog",
        stateIds: ["populated"],
        viewportIds: ["desktop"],
        capabilities: ["rendered-text"],
        fixtures: [
          { fixtureId: "representative", kind: "representative", contentDigest: "1".repeat(64) },
          { fixtureId: "natural", kind: "long-natural-language", contentDigest: "2".repeat(64) },
          { fixtureId: "token", kind: "long-unbroken-token", contentDigest: "3".repeat(64) },
        ],
        regions: [{ regionId: "label", policy: "no-overflow", basisIds: ["basis-content"] }],
        profileApplicability: resilienceProfiles.map(profile => {
          if (required.has(profile)) return { profile, status: "required" as const, basisIds: ["basis-content"], rationale: `${profile} applies to rendered text.` };
          const approvalReceipt = resilienceApprovalReceipt(requestId, profile);
          return { profile, status: "not-applicable" as const, basisIds: ["basis-content"], rationale: approvalReceipt.rationale, approvalReceipt };
        }),
      }],
    },
  };
}
function resilienceProfileEvidence(profile: UiResilienceProfile): UiProfileEvidence {
  if (profile === "text-overflow") return { profile };
  if (profile === "resize-text-200") return { profile, textScalePercent: 200 };
  if (profile === "text-spacing-wcag") return { profile, lineHeightRatio: 1.5, paragraphSpacingRatio: 2, letterSpacingRatio: 0.12, wordSpacingRatio: 0.16, onlySpacingPropertiesChanged: true };
  throw new Error(`unexpected resilience profile ${profile}`);
}
function makeResilienceOracle(request: VerificationExecutionRequest, producer: UiResilienceOracle["producer"]): UiResilienceOracle {
  const requirement = request.obligation.uiResilienceRequirement;
  if (!requirement) throw new Error("resilience fixture received a non-resilience obligation");
  return {
    schemaVersion: "ui-resilience-oracle/v1",
    oracleId: `oracle:${request.runId}`,
    requestId: request.requestId,
    snapshotId: request.snapshotId,
    conditionId: requirement.conditionId,
    producer,
    runs: requirement.requiredRuns.map((run, index) => ({
      runId: `resilience-run-${index}`,
      surfaceId: run.surfaceId,
      stateId: run.stateId,
      viewportId: run.viewportId,
      viewport: requirement.viewports.find(viewport => viewport.id === run.viewportId)!,
      profile: run.profile,
      fixtureId: run.fixtureId,
      fixtureContentDigest: run.fixtureContentDigest,
      browser: "Chromium 140",
      userAgent: "fixture-browser",
      profileEvidence: resilienceProfileEvidence(run.profile),
      observations: run.regions.map(region => ({
        observationId: `resilience-observation-${index}-${region.regionId}`,
        regionId: region.regionId,
        policy: region.policy,
        clientWidth: 320,
        clientHeight: 40,
        scrollWidth: 320,
        scrollHeight: 40,
        fragmentRects: [{ x: 0, y: 0, width: 300, height: 20 }],
        clippingAncestors: [],
        paintFeatures: [],
        renderedLineCount: 1,
        contentTruncated: false,
        truncationIndicatorVisible: false,
        screenshotDigest: new Bun.CryptoHasher("sha256").update(`resilience:${index}:${region.regionId}`).digest("hex"),
      })),
    })),
    blockingReasons: [],
  };
}

function makeDependencies(options: FakeOptions = {}, repositoryOverride?: FakeRepository): FakeDependencies {
  const repository = repositoryOverride ?? new FakeRepository();
  let executorCalls = 0;
  let browserCalls = 0;
  const executor = {
    atomicSameKeyIdempotency: true as const,
    executeObligation: async (request: VerificationExecutionRequest) => {
      executorCalls++;
      if (options.missingExecutorOutput) return undefined;
      return { status: "PASS" as const, runId: request.runId, requestId: request.requestId, snapshotId: options.mismatchedProvenance ? "wrong-snapshot" : request.snapshotId, idempotencyKey: request.idempotencyKey, producer: options.invalidProducer ? undefined : { kind: options.producerKind ?? "deterministic-verifier", identity: "fixture-executor", independence: options.producerIndependence ?? "independent-producer" }, artifacts: [{ type: "verification-result", digest: options.invalidArtifact ? "not-a-digest" : "a".repeat(64) }] };
    },
  } as unknown as VerificationExecutor;
  const browser = {
    atomicSameKeyIdempotency: true as const,
    executeBrowser: async (request: VerificationExecutionRequest) => {
      browserCalls++;
      if (options.missingBrowserOutput) return undefined;
      const producer = { kind: options.producerKind ?? "deterministic-verifier", identity: "fixture-browser", independence: options.producerIndependence ?? "independent-producer" } as const;
      const visualCompositionOracle = options.visualCompositionOracle && request.obligation.visualCompositionRequirement ? makeCompositionOracle(request, options.mismatchedOracleProducer ? { ...producer, identity: "other-browser" } : producer, options) : undefined;
      const uiResilienceOracle = request.obligation.uiResilienceRequirement ? makeResilienceOracle(request, producer) : undefined;
      const screenshotArtifacts: Artifact[] = visualCompositionOracle
        ? visualCompositionOracle.captures.flatMap(capture => capture.screenshots.filter(screenshot => !options.omitStoredScreenshot || screenshot.role === "full-page").map(screenshot => ({ type: "screenshot" as const, digest: screenshot.digest })))
        : [];
      if (visualCompositionOracle) screenshotArtifacts.push({ type: "design-token-resolution", digest: TOKEN_RESOLUTION_DIGEST });
      if (uiResilienceOracle) {
        screenshotArtifacts.push(...uiResilienceOracle.runs.flatMap(run => run.observations.map(observation => ({ type: "screenshot" as const, digest: observation.screenshotDigest }))));
        screenshotArtifacts.push(...request.obligation.uiResilienceRequirement!.applicabilityApprovals.map(approval => ({ type: "ui-applicability-approval" as const, digest: approval.approvalArtifactDigest })));
      }
      return {
        status: options.browserStatus ?? "PASS",
        runId: request.runId,
        requestId: request.requestId,
        snapshotId: request.snapshotId,
        idempotencyKey: request.idempotencyKey,
        producer,
        artifacts: [{ type: "verification-result", digest: "b".repeat(64) }, ...screenshotArtifacts],
        ...(visualCompositionOracle ? { visualCompositionOracle } : {}),
        ...(uiResilienceOracle ? { uiResilienceOracle } : {}),
      };
    },
  } as unknown as BrowserExecutor;
  let authorityCalls = 0;
  const authorities = new Map<string, ExecutionAuthority>();
  const executionAuthority = {
    atomicCanonicalBindingIdempotency: true as const,
    issueExecutionAuthority: async (binding: ExecutionAuthority["binding"]): Promise<ExecutionAuthority | undefined> => {
      if (options.missingAuthority) return undefined;
      const key = JSON.stringify(binding);
      const existing = authorities.get(key);
      if (existing) return existing;
      const issuedBinding = options.mismatchedAuthority ? { ...structuredClone(binding), snapshotId: "wrong-snapshot" } : structuredClone(binding);
      const authority: ExecutionAuthority = { schemaVersion: "verification-execution-authority/v1", authorityId: `authority:${binding.obligationId}`, issuer: "fixture-authority", binding: issuedBinding };
      authorities.set(key, authority);
      return authority;
    },
    verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: ExecutionAuthority["binding"]): Promise<boolean> => {
      authorityCalls++;
      if (options.rejectedAuthority) return false;
      const stored = authorities.get(JSON.stringify(binding));
      return Boolean(stored && JSON.stringify(stored) === JSON.stringify(authority) && JSON.stringify(stored.binding) === JSON.stringify(binding));
    },
  };
  const freshnessAuthorities = new Map<string, FreshnessAuthority>();
  const freshnessAuthority = {
    atomicSameKeyIdempotency: true as const,
    issueFreshnessAuthority: async (binding: FreshnessAuthority["binding"]): Promise<FreshnessAuthority> => {
      const key = JSON.stringify(binding);
      const existing = freshnessAuthorities.get(key);
      if (existing) return existing;
      const authority: FreshnessAuthority = { schemaVersion: "verification-freshness-authority/v1", authorityId: `freshness:${binding.executionDigest}`, issuer: "fixture-freshness-authority", binding: structuredClone(binding) };
      freshnessAuthorities.set(key, authority);
      return authority;
    },
    verifyFreshnessAuthority: async (authority: FreshnessAuthority, binding: FreshnessAuthority["binding"]): Promise<boolean> => {
      const stored = freshnessAuthorities.get(JSON.stringify(binding));
      return Boolean(stored && JSON.stringify(stored) === JSON.stringify(authority) && JSON.stringify(stored.binding) === JSON.stringify(binding));
    },
  };
  const capabilityProvider = { has: () => !options.missingCapability } as unknown as CapabilityProvider;
  const artifactStore: ArtifactStore = {
    atomicSameKeyIdempotency: true,
    storeVerificationResultArtifact: async (artifact: Artifact) => options.missingArtifactStorage ? { type: "unexpected-artifact", digest: "c".repeat(64) } : artifact,
    storeArtifact: async (artifact: Artifact) => options.missingArtifactStorage ? { type: "unexpected-artifact", digest: "c".repeat(64) } : artifact,
    putArtifact: async (artifact: Artifact) => options.missingArtifactStorage ? { type: "unexpected-artifact", digest: "c".repeat(64) } : artifact,
    store: async (artifact: Artifact) => options.missingArtifactStorage ? { type: "unexpected-artifact", digest: "c".repeat(64) } : artifact,
  };
  const approvalProvider = { requestApproval: async () => ({ approved: true, approvalId: "approval-001" }) } as unknown as ApprovalProvider;
  const usageRecorder = { atomicSameKeyIdempotency: true as const, recordUsage: async () => undefined, record: async () => undefined } as unknown as UsageRecorder;
  const dependencies = {
    executionAuthority,
    freshnessAuthority,
    freshnessPolicy: { evaluateFreshness: async () => "fresh" as const },
    repository: repository as unknown as RepositoryPort,
    executor,
    uiApplicabilityApprovalVerifier: { independentAuthentication: true, verifyApproval: async () => true },
    artifactStore,
    capabilityProvider,
    browserExecutor: browser,
    approvalProvider,
    usageRecorder,
    now: () => FIXED_NOW,
    clock: { now: () => FIXED_NOW },
  } as unknown as VerificationRunDependencies;
  return { repository, dependencies, get executorCalls() { return executorCalls; }, get browserCalls() { return browserCalls; }, get authorityCalls() { return authorityCalls; } };
}

async function runOnce(dependencies: VerificationRunDependencies, runId = RUN_ID, requestId = REQUEST_ID): Promise<Awaited<ReturnType<typeof runVerification>>> {
  const input = { runId, request: makeRequest(requestId), dependencies, now: FIXED_NOW } as unknown as RunInput;
  return runVerification(input);
}

async function makeSignedExternalCompletion(runId: string): Promise<{ request: VerificationRequest; completion: VerificationExecutionCompletionEnvelope }> {
  const request = { ...makeRequest(`${runId}-request`), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
  const store: FakeRepositoryStore = { runs: new Map(), stageDocuments: new Map(), dispatchClaims: new Map() };
  const fakes = makeDependencies({}, new FakeRepository(store));
  await runVerification({ runId, request, dependencies: fakes.dependencies });
  const completion = [...store.dispatchClaims.values()][0]?.completion;
  if (!completion) throw new Error("missing fixture completion envelope");
  return {
    request,
    completion: {
      ...completion,
      authority: {
        ...completion.authority,
        keyId: "e".repeat(64),
        signature: "fixture-signature",
      },
    },
  };
}

function reorderObjectKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => reorderObjectKeysDeep(item)) as T;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().reverse().map(key => [key, reorderObjectKeysDeep(record[key])])) as T;
  }
  return value;
}
function makeReplayAuthority(
  fakes: FakeDependencies,
  mutate: (binding: ExecutionAuthority["binding"]) => ExecutionAuthority["binding"],
): { dependencies: VerificationRunDependencies; issued: ExecutionAuthority[]; signed: ExecutionAuthority[] } {
  const authorities = new Map<string, ExecutionAuthority>();
  const issued: ExecutionAuthority[] = [];
  const signed: ExecutionAuthority[] = [];
  const executionAuthority = {
    atomicCanonicalBindingIdempotency: true as const,
    issueExecutionAuthority: async (binding: ExecutionAuthority["binding"]): Promise<ExecutionAuthority> => {
      const key = JSON.stringify(binding);
      const existing = authorities.get(key);
      if (existing) return existing;
      const authority: ExecutionAuthority = {
        schemaVersion: "verification-execution-authority/v1",
        authorityId: `authority:${binding.obligationId}`,
        issuer: "replay-fixture",
        binding: mutate(structuredClone(binding)),
      };
      authorities.set(key, authority);
      issued.push(authority);
      signed.push(structuredClone(authority));
      return authority;
    },
    verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: ExecutionAuthority["binding"]): Promise<boolean> => {
      const stored = authorities.get(JSON.stringify(binding));
      return Boolean(stored && JSON.stringify(stored) === JSON.stringify(authority) && JSON.stringify(stored.binding) === JSON.stringify(binding));
    },
  };
  return { dependencies: { ...fakes.dependencies, executionAuthority }, issued, signed };
}
function makeCanonicalBindingExecutionAuthority(): { port: VerificationRunDependencies["executionAuthority"]; issued: ExecutionAuthority[] } {
  const authorities = new Map<string, ExecutionAuthority>();
  const issued: ExecutionAuthority[] = [];
  const port = {
    atomicCanonicalBindingIdempotency: true as const,
    issueExecutionAuthority: async (binding: ExecutionAuthority["binding"]): Promise<ExecutionAuthority> => {
      const key = JSON.stringify(binding);
      const existing = authorities.get(key);
      if (existing) return existing;
      const authority: ExecutionAuthority = { schemaVersion: "verification-execution-authority/v1", authorityId: `authority:${binding.obligationId}`, issuer: "one-shot-fixture", binding: structuredClone(binding) };
      authorities.set(key, authority);
      issued.push(authority);
      return authority;
    },
    verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: ExecutionAuthority["binding"]): Promise<boolean> => {
      const stored = authorities.get(JSON.stringify(binding));
      return Boolean(stored && JSON.stringify(stored) === JSON.stringify(authority) && JSON.stringify(stored.binding) === JSON.stringify(binding));
    },
  };
  return { port, issued };
}
test.each(["uppercase", "reordered"] as const)("rejects a %s noncanonical authority replay before persistence without mutating the signed binding", async mode => {
  const fakes = makeDependencies();
  const request = { ...makeRequest(`authority-noncanonical-${mode}`), testBasis: [makeRequest().testBasis[0]!] };
  const runId = `authority-noncanonical-${mode}`;
  const mutate: (binding: ExecutionAuthority["binding"]) => ExecutionAuthority["binding"] = binding => {
    const execution = { ...binding.execution, startedAt: "2026-08-03T00:00:10.000Z", finishedAt: "2026-08-03T00:00:11.000Z" };
    const resultArtifacts = [...(binding.result.artifacts ?? [])];
    const artifactDigests = mode === "uppercase" ? resultArtifacts.map(digest => digest.toUpperCase()) : resultArtifacts.reverse();
    const result = { ...binding.result, artifacts: mode === "uppercase" ? resultArtifacts.map(digest => digest.toUpperCase()) : [...resultArtifacts] };
    return { ...binding, execution, observedAt: execution.finishedAt, result, artifactDigests };
  };
  const replay = makeReplayAuthority(fakes, mutate);
  const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async executionRequest => ({
    status: "PASS",
    runId: executionRequest.runId,
    requestId: executionRequest.requestId,
    snapshotId: executionRequest.snapshotId,
    idempotencyKey: executionRequest.idempotencyKey,
    producer: { kind: "deterministic-verifier", identity: "replay-executor", independence: "independent-producer" },
    artifacts: mode === "reordered"
      ? [{ type: "verification-result", digest: "a".repeat(64) }, { type: "verification-result", digest: "b".repeat(64) }]
      : [{ type: "verification-result", digest: "a".repeat(64) }],
  }), }
  const dependencies = { ...replay.dependencies, executor };
  await expect(runVerification({ runId, request, dependencies })).rejects.toThrow(/execution authority/);
  expect(replay.issued).toHaveLength(1);
  expect(replay.issued[0]).toEqual(replay.signed[0]);
  expect(replay.issued[0]?.binding.artifacts.map(artifact => artifact.digest)).toEqual(mode === "uppercase" ? ["a".repeat(64)] : ["a".repeat(64), "b".repeat(64)]);
  expect(fakes.repository.stageWrites).not.toContain("execution");
  expect(fakes.repository.runs.get(runId)?.state).toBe("PLANNED");
});
test("rejects self producer with independent independence in an authority replay", async () => {
  const fakes = makeDependencies();
  const request = { ...makeRequest("authority-self-independent"), testBasis: [makeRequest().testBasis[0]!] };
  const replay = makeReplayAuthority(fakes, binding => ({ ...binding, producer: { kind: "self", identity: "replayed-self", independence: "independent-producer" } }));
  await expect(runVerification({ runId: "authority-self-independent", request, dependencies: replay.dependencies })).rejects.toThrow("execution authority issue failed");
  expect(fakes.repository.stageWrites).not.toContain("execution");
});
test.each([
  "2026-02-30T00:00:00Z",
  "2026-01-01T24:00:00Z",
] as const)("rejects calendar-invalid runtime timestamps: %s", async timestamp => {
  const fakes = makeDependencies();
  await expect(runOnce({ ...fakes.dependencies, now: () => timestamp }, `calendar-invalid-${timestamp}`)).rejects.toThrow("clock must return canonical ISO date-time");
});

test("rejects invalid resumed string clocks before executor or artifact writes", async () => {
  const fakes = makeDependencies();
  await runOnce(fakes.dependencies);
  const run = fakes.repository.runs.get(RUN_ID);
  if (!run) throw new Error("missing persisted run");
  fakes.repository.runs.set(RUN_ID, { ...run, state: "PLANNED", updatedAt: FIXED_NOW });
  fakes.repository.stageDocuments.delete(`${RUN_ID}:execution`);
  fakes.repository.stageDocuments.delete(`${RUN_ID}:evidence`);
  fakes.repository.stageDocuments.delete(`${RUN_ID}:verdict`);
  fakes.repository.dispatchClaims.clear();
  const executorCalls = fakes.executorCalls;
  let artifactWrites = 0;
  const storeVerificationResultArtifact = fakes.dependencies.artifactStore.storeVerificationResultArtifact!;
  const artifactStore: ArtifactStore = {
    ...fakes.dependencies.artifactStore,
    storeVerificationResultArtifact: async (artifact, input) => {
      artifactWrites++;
      return storeVerificationResultArtifact(artifact, input);
    },
  };
    const resumedAuthority = makeCanonicalBindingExecutionAuthority().port;
  await expect(runVerification({
    runId: RUN_ID,
    dependencies: { ...fakes.dependencies, artifactStore, executionAuthority: resumedAuthority, now: () => "2026-02-30T00:00:00Z" },
  })).rejects.toThrow("clock must return canonical ISO date-time");
  expect(fakes.executorCalls).toBe(executorCalls);
  expect(artifactWrites).toBe(0);
});

test("rejects reversed sub-millisecond executor chronology before artifact writes", async () => {
  const fakes = makeDependencies();
  let executorReturned = false;
  let artifactWrites = 0;
  const executeObligation = fakes.dependencies.executor.executeObligation!;
  const storeVerificationResultArtifact = fakes.dependencies.artifactStore.storeVerificationResultArtifact!;
  const executor: VerificationExecutor = {
    ...fakes.dependencies.executor,
    executeObligation: async input => {
      const output = await executeObligation(input);
      executorReturned = true;
      return output;
    },
  };
  const artifactStore: ArtifactStore = {
    ...fakes.dependencies.artifactStore,
    storeVerificationResultArtifact: async (artifact, input) => {
      artifactWrites++;
      return storeVerificationResultArtifact(artifact, input);
    },
  };
  await expect(runOnce({
    ...fakes.dependencies,
    executor,
    artifactStore,
    now: () => executorReturned ? "2026-08-03T00:00:00.0001Z" : "2026-08-03T00:00:00.0009Z",
  }, "sub-millisecond-reversal")).rejects.toThrow("execution clock moved backwards");
  expect(artifactWrites).toBe(0);
});

test("canonical request digest is key-order stable and value/array-order sensitive", () => {
  const request = makeRequest();
  const reordered = reorderObjectKeysDeep(request);
  expect(canonicalRequestDigest(request)).toMatch(/^[0-9a-f]{64}$/);
  expect(canonicalRequestDigest(reordered)).toBe(canonicalRequestDigest(request));
  const changedValue = { ...request, change: { ...request.change, summary: "verify a different change" } };
  expect(canonicalRequestDigest(changedValue)).not.toBe(canonicalRequestDigest(request));
  const changedArrayOrder = { ...request, testBasis: [...request.testBasis].reverse() };
  expect(canonicalRequestDigest(changedArrayOrder)).not.toBe(canonicalRequestDigest(request));
});
test("orders canonical basis IDs by locale-independent code units", async () => {
  const testBasis: VerificationRequest["testBasis"] = [
    { id: "ä", kind: "acceptance-criterion", origin: "explicit", text: "Unicode basis", source: "request" },
    { id: "z", kind: "invariant", origin: "explicit", text: "ASCII basis", source: "request" },
  ];
  const request = {
    ...makeRequest("unicode-basis-order"),
    testBasis,
  } satisfies VerificationRequest;
  const { dependencies } = makeDependencies();

  const basis = await establishTestBasis({ request, dependencies });

  expect(basis.basis.map(item => item.id)).toEqual(["z", "ä"]);
});
test.each(["fresh", "stale", "unknown"] as const)("requires the freshness policy to authenticate %s evidence", async status => {
  const fakes = makeDependencies();
  const freshnessInputs: Array<{ evaluatedAt: string; observedAt: string }> = [];
  const dependencies = {
    ...fakes.dependencies,
    freshnessPolicy: {
      evaluateFreshness: async (input: { evaluatedAt: string; evidence: { observedAt: string } }) => {
        freshnessInputs.push({ evaluatedAt: input.evaluatedAt, observedAt: input.evidence.observedAt });
        return status;
      },
    },
  } as unknown as VerificationRunDependencies;
  const result = await runOnce(dependencies, `freshness-${status}`);
  const evaluations = result.documents.evidence?.evaluations ?? [];
  expect(evaluations).not.toHaveLength(0);
  expect(evaluations.every(item => item.checks.fresh === (status === "fresh"))).toBe(true);
  expect(evaluations.filter(item => status !== "fresh").every(item => item.rejectionReasons.includes("STALE_EVIDENCE"))).toBe(true);
  expect(freshnessInputs.every(item => item.evaluatedAt === FIXED_NOW && item.observedAt === FIXED_NOW)).toBe(true);
  expect(status === "fresh" ? result.verdict.qaVerdict : result.verdict.qaVerdict).not.toBe(status === "fresh" ? "INCOMPLETE" : "PASS");
});

test("uses the current freshness instant without rewriting authenticated chronology on stale replay", async () => {
  const fakes = makeDependencies();
  let now = FIXED_NOW;
  const freshnessInputs: string[] = [];
  const dependencies = {
    ...fakes.dependencies,
    now: () => now,
    freshnessPolicy: {
      evaluateFreshness: async (input: { evaluatedAt: string; evidence: { observedAt: string } }) => {
        freshnessInputs.push(input.evaluatedAt);
        return Date.parse(input.evaluatedAt) >= Date.parse(input.evidence.observedAt) && now === FIXED_NOW ? "fresh" as const : "stale" as const;
      },
    },
  } as unknown as VerificationRunDependencies;
  const runId = "freshness-stale-replay";
  const first = await runOnce(dependencies, runId);
  const chronology = first.documents.evidence?.evaluations.map(item => item.evaluatedAt);
  expect(first.verdict.qaVerdict).toBe("PASS");
  const run = fakes.repository.runs.get(runId);
  if (!run) throw new Error("missing persisted run");
  fakes.repository.runs.set(runId, { ...run, state: "EXECUTING" });
  now = "2026-08-03T00:00:10.000Z";
  const replay = await runVerification({ runId, dependencies });
  expect(replay.verdict.qaVerdict).not.toBe("PASS");
  expect(freshnessInputs.at(-1)).toBe(now);
  expect(replay.documents.evidence?.evaluations.map(item => item.evaluatedAt)).toEqual(chronology);
});

test("rejects a persisted execution timestamp mutation before freshness re-evaluation", async () => {
  const fakes = makeDependencies();
  const runId = "mixed-fractional-timestamps";
  const first = await runOnce(fakes.dependencies, runId);
  const execution = first.documents.execution;
  const run = fakes.repository.runs.get(runId);
  if (!execution || !run) throw new Error("missing persisted execution");
  const high = "2026-08-03T00:00:00.90Z";
  const low = "2026-08-03T00:00:00.899Z";
  const highObservationId = execution.observations[0]?.observationId;
  if (!highObservationId) throw new Error("missing persisted observation");
  const timestampFor = (observationId: string) => observationId === highObservationId ? high : low;
  const observations = execution.observations.map(item => ({ ...item, execution: { ...item.execution, startedAt: timestampFor(item.observationId), finishedAt: timestampFor(item.observationId) } }));
  const evidence = execution.evidence.map(item => {
    const timestamp = timestampFor(`observation:${item.obligationId}`);
    return { ...item, execution: { ...item.execution, startedAt: timestamp, finishedAt: timestamp }, observedAt: timestamp };
  });
  const authorities = execution.authorities.map(authority => {
    const timestamp = timestampFor(`observation:${authority.binding.obligationId}`);
    return { ...authority, binding: { ...authority.binding, execution: { ...authority.binding.execution, startedAt: timestamp, finishedAt: timestamp }, observedAt: timestamp } };
  });
  fakes.repository.stageDocuments.set(`${runId}:execution`, { ...execution, observations, evidence, authorities });
  fakes.repository.runs.set(runId, { ...run, state: "EXECUTING" });
  const dependencies = { ...fakes.dependencies, now: () => high, executionAuthority: { ...fakes.dependencies.executionAuthority, verifyExecutionAuthority: async () => true } };
  await expect(runVerification({ runId, dependencies })).rejects.toThrow("invalid persisted freshness execution digest");
});

test.each([
  ["extra root key", (request: VerificationRequest) => ({ ...request, extra: true })],
  ["extra project key", (request: VerificationRequest) => ({ ...request, project: { ...request.project, extra: true } })],
  ["extra change key", (request: VerificationRequest) => ({ ...request, change: { ...request.change, extra: true } })],
  ["extra basis key", (request: VerificationRequest) => ({ ...request, testBasis: [{ ...request.testBasis[0]!, extra: true }, ...request.testBasis.slice(1)] })],
  ["empty request ID", (request: VerificationRequest) => ({ ...request, requestId: "" })],
  ["empty summary", (request: VerificationRequest) => ({ ...request, change: { ...request.change, summary: "" } })],
  ["empty basis text", (request: VerificationRequest) => ({ ...request, testBasis: [{ ...request.testBasis[0]!, text: "" }, ...request.testBasis.slice(1)] })],
  ["empty optional source", (request: VerificationRequest) => ({ ...request, testBasis: [{ ...request.testBasis[0]!, source: "" }, ...request.testBasis.slice(1)] })],
  ["empty basis", (request: VerificationRequest) => ({ ...request, testBasis: [] })],
  ["empty paths", (request: VerificationRequest) => ({ ...request, change: { ...request.change, paths: [] } })],
  ["duplicate paths", (request: VerificationRequest) => ({ ...request, change: { ...request.change, paths: ["same.ts", "same.ts"] } })],
  ["duplicate basis IDs", (request: VerificationRequest) => ({ ...request, testBasis: [
    { ...request.testBasis[0]!, text: "The first basis item differs from the second." },
    { ...request.testBasis[1]!, id: request.testBasis[0]!.id, text: "The second basis item uses the same ID." },
  ] })],
] as const)("rejects malformed requests before digest, writes, or dispatch: %s", async (_name, mutate) => {
  const invalid = mutate(makeRequest()) as VerificationRequest;
  expect(() => canonicalRequestDigest(invalid)).toThrow("invalid verification request");
  const fakes = makeDependencies();
  await expect(runVerification({ runId: "invalid-request", request: invalid, dependencies: fakes.dependencies })).rejects.toThrow("invalid verification request");
  expect(fakes.repository.stageWrites).toEqual([]);
  expect(fakes.repository.runWrites).toEqual([]);
  expect(fakes.executorCalls).toBe(0);
});

test("canonicalizes executor and artifact-store artifacts before authority and persistence", async () => {
  const fakes = makeDependencies();
  const digest = "A".repeat(64);
  const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => ({
    status: "PASS",
    runId: request.runId,
    requestId: request.requestId,
    snapshotId: request.snapshotId,
    idempotencyKey: request.idempotencyKey,
    producer: { kind: "deterministic-verifier", identity: "uppercase-executor", independence: "independent-producer" },
    artifacts: [{ type: "verification-result", digest }, { type: "verification-result", digest: digest.toLowerCase(), path: "/tmp/result" }, { type: "approved-visual-reference", digest }] as unknown as Artifact[],
  }), }
  const artifactStore: ArtifactStore = {
    atomicSameKeyIdempotency: true,
    storeVerificationResultArtifact: async artifact => ({ ...artifact, digest: artifact.digest.toUpperCase(), extra: "discard" } as unknown as Artifact),
    storeArtifact: async artifact => ({ ...artifact, digest: artifact.digest.toUpperCase(), extra: "discard" } as unknown as Artifact),
  };
  const result = await runOnce({ ...fakes.dependencies, executor, artifactStore }, "artifact-normalization");
  const execution = result.documents.execution;
  expect(result.verdict.qaVerdict).toBe("PASS");
  expect(execution?.observations[0]?.artifacts).toEqual([{ type: "verification-result", digest: digest.toLowerCase() }, { type: "verification-result", digest: digest.toLowerCase(), path: "/tmp/result" }, { type: "approved-visual-reference", digest: digest.toLowerCase() }]);
  expect(execution?.evidence[0]?.result.artifacts).toEqual([digest.toLowerCase()]);
  const resultDigests = execution?.evidence[0]?.result.artifacts ?? [];
  expect(new Set(resultDigests).size).toBe(resultDigests.length);
  const schema = JSON.parse(await Bun.file(`${import.meta.dir}/../../contracts/evidence.schema.json`).text()) as object;
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  for (const evidence of execution?.evidence ?? []) {
    expect(validate(evidence), validate.errors ? JSON.stringify(validate.errors) : undefined).toBe(true);
  }
  expect(execution?.observations.every(item => item.artifacts.every(artifact => /^[a-f0-9]{64}$/.test(artifact.digest) && Object.keys(artifact).every(key => ["type", "digest", "path"].includes(key))))).toBe(true);
});

test("rejects artifact stores without atomic same-key idempotency before writes", async () => {
  const fakes = makeDependencies();
  let artifactWrites = 0;
  const artifactStore = {
    storeVerificationResultArtifact: async (artifact: Artifact) => {
      artifactWrites++;
      return artifact;
    },
  } as ArtifactStore;
  await expect(runOnce({ ...fakes.dependencies, artifactStore }, "artifact-store-idempotency-contract")).rejects.toThrow("artifact store must declare atomic same-key idempotency");
  expect(artifactWrites).toBe(0);
});

test("rejects empty and non-string artifact digests or paths without storing them", async () => {
  for (const malformed of [
    { type: "verification-result", digest: "" },
    { type: "verification-result", digest: "f".repeat(64), path: "" },
    { type: "verification-result", digest: "f".repeat(64), path: 42 },
  ]) {
    const fakes = makeDependencies();
    let stores = 0;
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => ({
      status: "PASS", runId: request.runId, requestId: request.requestId, snapshotId: request.snapshotId, idempotencyKey: request.idempotencyKey,
      producer: { kind: "deterministic-verifier", identity: "malformed-artifact-executor", independence: "independent-producer" },
      artifacts: [malformed] as unknown as Artifact[],
    }), }
    const artifactStore: ArtifactStore = { atomicSameKeyIdempotency: true, storeVerificationResultArtifact: async artifact => { stores++; return artifact; } };
    const result = await runOnce({ ...fakes.dependencies, executor, artifactStore }, `malformed-artifact-${stores}`);
    expect(result.verdict.qaVerdict).not.toBe("PASS");
    expect(stores).toBe(0);
  }
});
test("fails closed when a valid artifact is accompanied by a malformed artifact", async () => {
  const fakes = makeDependencies();
  let stores = 0;
  const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => ({
    status: "PASS", runId: request.runId, requestId: request.requestId, snapshotId: request.snapshotId, idempotencyKey: request.idempotencyKey,
    producer: { kind: "deterministic-verifier", identity: "mixed-artifact-executor", independence: "independent-producer" },
    artifacts: [{ type: "verification-result", digest: "a".repeat(64) }, { type: "verification-result", digest: "", path: "" }] as unknown as Artifact[],
  }), }
  const artifactStore: ArtifactStore = { atomicSameKeyIdempotency: true, storeVerificationResultArtifact: async artifact => { stores++; return artifact; } };
  const result = await runOnce({ ...fakes.dependencies, executor, artifactStore }, "mixed-malformed-artifact");
  expect(result.verdict.qaVerdict).not.toBe("PASS");
  expect(stores).toBe(0);
});
test.each(["BLOCKED", "INCOMPLETE"] as const)("rejects sparse diagnostic artifacts before storage for %s output", async status => {
  const fakes = makeDependencies();
  const digest = "a".repeat(64);
  const sparseArtifacts: Artifact[] = [];
  sparseArtifacts[1] = { type: "verification-result", digest };
  let stores = 0;
  const executor: VerificationExecutor = {
    atomicSameKeyIdempotency: true,
    executeObligation: async request => ({
      status,
      runId: request.runId,
      requestId: request.requestId,
      snapshotId: request.snapshotId,
      idempotencyKey: request.idempotencyKey,
      producer: { kind: "deterministic-verifier", identity: "sparse-diagnostic-executor", independence: "independent-producer" },
      summary: `sparse diagnostic ${status.toLowerCase()}`,
      artifacts: sparseArtifacts,
    }),
  };
  const artifactStore: ArtifactStore = {
    atomicSameKeyIdempotency: true,
    storeVerificationResultArtifact: async artifact => { stores++; return artifact; },
  };
  const result = await runOnce({ ...fakes.dependencies, executor, artifactStore }, `sparse-diagnostic-${status.toLowerCase()}`);
  expect(result.verdict.qaVerdict).toBe("INCOMPLETE");
  expect(stores).toBe(0);
});
test.each([
  ["malformed response", null],
  ["wrong response type", { type: "unexpected-artifact", digest: "b".repeat(64) }],
  ["empty response path", { type: "verification-result", digest: "b".repeat(64), path: "" }],
  ["mismatched response digest", { type: "verification-result", digest: "c".repeat(64) }],
] as const)("fails closed when a valid artifact is accompanied by an artifact-store %s", async (_name, malformedResponse) => {
  const fakes = makeDependencies();
  const validDigest = "a".repeat(64);
  const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => ({
    status: "PASS",
    runId: request.runId,
    requestId: request.requestId,
    snapshotId: request.snapshotId,
    idempotencyKey: request.idempotencyKey,
    producer: { kind: "deterministic-verifier", identity: "mixed-store-executor", independence: "independent-producer" },
    artifacts: [
      { type: "verification-result", digest: validDigest },
      { type: "verification-result", digest: "b".repeat(64) },
    ],
  }), }
  const artifactStore: ArtifactStore = {
    atomicSameKeyIdempotency: true,
    storeVerificationResultArtifact: async artifact => artifact.digest === validDigest ? artifact : malformedResponse as unknown as Artifact,
  };
  const result = await runOnce({ ...fakes.dependencies, executor, artifactStore }, `mixed-store-${_name.replaceAll(" ", "-")}`);
  const execution = result.documents.execution;
  expect(result.verdict.qaVerdict).toBe("INCOMPLETE");
  expect(execution?.evidence.every(item => item.result.verdict !== "PASS")).toBe(true);
  expect(execution?.authorities.some(authority => authority.binding.result.verdict === "PASS")).toBe(false);
});
test("releases the dispatch claim and retries after an artifact store exception", async () => {
  const fakes = makeDependencies();
  const runId = "artifact-store-retry";
  const request = { ...makeRequest("artifact-store-retry-request"), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
  let storeCalls = 0;
  const artifactStore: ArtifactStore = {
    atomicSameKeyIdempotency: true,
    storeVerificationResultArtifact: async artifact => {
      storeCalls++;
      if (storeCalls === 1) throw new Error("artifact store failed before write");
      return artifact;
    },
  };
  const dependencies = { ...fakes.dependencies, artifactStore };
  await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("artifact store failed before write");
  expect(fakes.repository.dispatchClaims.size).toBe(0);
  expect(fakes.repository.runs.get(runId)?.state).toBe("PLANNED");
  const executorCallsAfterFailure = fakes.executorCalls;
  const resumed = await runVerification({ runId, dependencies });
  expect(fakes.executorCalls).toBeGreaterThan(executorCallsAfterFailure);
  expect(storeCalls).toBeGreaterThan(1);
  expect(resumed.run.state).toBe("TERMINAL");
  expect(resumed.verdict.qaVerdict).toBe("PASS");
  const claim = [...fakes.repository.dispatchClaims.values()][0];
  expect(claim?.status).toBe("COMPLETED");
  expect(claim?.completion?.output.artifacts).toEqual([{ type: "verification-result", digest: "a".repeat(64) }]);
});
test("releases the dispatch claim when the execution authority issuer throws and retries immediately", async () => {
  const fakes = makeDependencies();
  const runId = "authority-issuer-retry";
  const request = { ...makeRequest("authority-issuer-retry-request"), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
  let failIssuer = true;
  let artifactEffects = 0;
  const storedReceipts = new Set<string>();
  const artifactStore: ArtifactStore = {
    atomicSameKeyIdempotency: true,
    storeVerificationResultArtifact: async (artifact, input) => {
      const receipt = `${input.idempotencyKey}:${artifact.digest}`;
      if (!storedReceipts.has(receipt)) {
        storedReceipts.add(receipt);
        artifactEffects++;
      }
      return artifact;
    },
  };
  const baseAuthority = fakes.dependencies.executionAuthority;
  const dependencies = {
    ...fakes.dependencies,
    artifactStore,
    executionAuthority: {
      atomicCanonicalBindingIdempotency: true as const,
      issueExecutionAuthority: async (binding: ExecutionAuthority["binding"]) => {
        if (failIssuer) {
          failIssuer = false;
          throw new Error("execution authority issuer failed");
        }
        return baseAuthority.issueExecutionAuthority!(binding);
      },
      verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: ExecutionAuthority["binding"]) => baseAuthority.verifyExecutionAuthority!(authority, binding),
    },
  };
  await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("execution authority issuer failed");
  expect(artifactEffects).toBe(1);
  expect(fakes.repository.dispatchClaims.size).toBe(0);
  expect(fakes.repository.stageDocuments.has(`${runId}:execution`)).toBe(false);
  const executorCallsAfterFailure = fakes.executorCalls;
  const resumed = await runVerification({ runId, dependencies });
  expect(artifactEffects).toBe(1);
  expect(fakes.executorCalls).toBeGreaterThan(executorCallsAfterFailure);
  expect(resumed.run.state).toBe("TERMINAL");
  expect(resumed.verdict.qaVerdict).toBe("PASS");
  const dispatch = [...fakes.repository.dispatchClaims.values()];
  expect(dispatch).toHaveLength(1);
  expect(dispatch[0]?.status).toBe("COMPLETED");
  expect(dispatch[0]?.completion).toBeDefined();
});
test("releases the dispatch claim when execution authority verification throws and retries immediately", async () => {
  const fakes = makeDependencies();
  const runId = "authority-verifier-retry";
  const request = { ...makeRequest("authority-verifier-retry-request"), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
  let failVerifier = true;
  const baseAuthority = fakes.dependencies.executionAuthority;
  const dependencies = {
    ...fakes.dependencies,
    executionAuthority: {
      atomicCanonicalBindingIdempotency: true as const,
      issueExecutionAuthority: async (binding: ExecutionAuthority["binding"]) => baseAuthority.issueExecutionAuthority!(binding),
      verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: ExecutionAuthority["binding"]) => {
        if (failVerifier) {
          failVerifier = false;
          throw new Error("execution authority verifier failed");
        }
        return baseAuthority.verifyExecutionAuthority!(authority, binding);
      },
    },
  };
  await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("execution authority verifier failed");
  expect(fakes.repository.dispatchClaims.size).toBe(0);
  expect(fakes.repository.stageDocuments.has(`${runId}:execution`)).toBe(false);
  const executorCallsAfterFailure = fakes.executorCalls;
  const resumed = await runVerification({ runId, dependencies });
  expect(fakes.executorCalls).toBeGreaterThan(executorCallsAfterFailure);
  expect(resumed.run.state).toBe("TERMINAL");
  expect(resumed.verdict.qaVerdict).toBe("PASS");
  const dispatch = [...fakes.repository.dispatchClaims.values()];
  expect(dispatch).toHaveLength(1);
  expect(dispatch[0]?.status).toBe("COMPLETED");
  expect(dispatch[0]?.completion).toBeDefined();
});
test.each(["BLOCKED", "INCOMPLETE"] as const)("retains diagnostic artifacts for a fresh %s output", async status => {
  const fakes = makeDependencies();
  const request = { ...makeRequest(`diagnostic-${status.toLowerCase()}`), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
  const runId = `diagnostic-fresh-${status.toLowerCase()}`;
  const digest = status === "BLOCKED" ? "b".repeat(64) : "d".repeat(64);
  let stores = 0;
  const executor: VerificationExecutor = {
    atomicSameKeyIdempotency: true,
    executeObligation: async executionRequest => ({
      status,
      runId: executionRequest.runId,
      requestId: executionRequest.requestId,
      snapshotId: executionRequest.snapshotId,
      idempotencyKey: executionRequest.idempotencyKey,
      producer: { kind: "deterministic-verifier", identity: "diagnostic-executor", independence: "independent-producer" },
      summary: `diagnostic ${status.toLowerCase()}`,
      artifacts: [{ type: "verification-result", digest }],
    }),
  };
  const artifactStore: ArtifactStore = {
    atomicSameKeyIdempotency: true,
    storeVerificationResultArtifact: async artifact => { stores++; return artifact; },
  };
  const dependencies = { ...fakes.dependencies, executor, artifactStore };
  const result = await runVerification({ runId, request, dependencies });
  const execution = result.documents.execution;
  const completion = [...fakes.repository.dispatchClaims.values()][0]?.completion;
  expect(result.verdict.qaVerdict).toBe(status);
  expect(stores).toBe(1);
  expect(execution?.observations[0]?.artifacts).toEqual([{ type: "verification-result", digest }]);
  expect(execution?.evidence[0]?.result.artifacts).toEqual([digest]);
  expect(execution?.authorities[0]?.binding.artifacts).toEqual([{ type: "verification-result", digest }]);
  expect(completion?.output.status).toBe(status);
  expect(completion?.output.artifacts).toEqual([{ type: "verification-result", digest }]);
});

test.each(["BLOCKED", "INCOMPLETE"] as const)("retains diagnostic artifacts through completion crash/resume for %s output", async status => {
  const fakes = makeDependencies();
  fakes.repository.failNextStage = "execution";
  const request = { ...makeRequest(`diagnostic-crash-${status.toLowerCase()}`), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
  const runId = `diagnostic-crash-${status.toLowerCase()}`;
  const digest = status === "BLOCKED" ? "c".repeat(64) : "e".repeat(64);
  let stores = 0;
  let executorCalls = 0;
  const executor: VerificationExecutor = {
    atomicSameKeyIdempotency: true,
    executeObligation: async executionRequest => {
      executorCalls++;
      return {
        status,
        runId: executionRequest.runId,
        requestId: executionRequest.requestId,
        snapshotId: executionRequest.snapshotId,
        idempotencyKey: executionRequest.idempotencyKey,
        producer: { kind: "deterministic-verifier", identity: "diagnostic-crash-executor", independence: "independent-producer" },
        summary: `diagnostic ${status.toLowerCase()} after crash`,
        artifacts: [{ type: "verification-result", digest }],
      };
    },
  };
  const artifactStore: ArtifactStore = {
    atomicSameKeyIdempotency: true,
    storeVerificationResultArtifact: async artifact => { stores++; return artifact; },
  };
  const dependencies = { ...fakes.dependencies, executor, artifactStore };
  await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("simulated saveStage crash");
  expect(stores).toBe(1);
  expect(executorCalls).toBe(1);
  const persistedCompletion = [...fakes.repository.dispatchClaims.values()][0]?.completion;
  expect(persistedCompletion?.output.artifacts).toEqual([{ type: "verification-result", digest }]);
  const resumed = await runVerification({ runId, dependencies });
  expect(resumed.verdict.qaVerdict).toBe(status);
  expect(stores).toBe(1);
  expect(executorCalls).toBe(1);
  expect(resumed.documents.execution?.observations[0]?.artifacts).toEqual([{ type: "verification-result", digest }]);
  expect(resumed.documents.execution?.authorities[0]?.binding.artifacts).toEqual([{ type: "verification-result", digest }]);
});

test.each([
  "foreign run",
  "foreign request",
  "foreign snapshot",
  "foreign idempotency",
  "malformed producer",
  "malformed artifacts field",
  "malformed summary field",
] as const)("rejects %s executor output before artifact storage", async mode => {
  const fakes = makeDependencies();
  let stores = 0;
  const artifactStore: ArtifactStore = {
    atomicSameKeyIdempotency: true,
    storeVerificationResultArtifact: async artifact => { stores++; return artifact; },
  };
  const executor: VerificationExecutor = {
    atomicSameKeyIdempotency: true,
    executeObligation: async executionRequest => {
      const base = {
        status: "PASS" as const,
        runId: executionRequest.runId,
        requestId: executionRequest.requestId,
        snapshotId: executionRequest.snapshotId,
        idempotencyKey: executionRequest.idempotencyKey,
        producer: { kind: "deterministic-verifier" as const, identity: "foreign-output-executor", independence: "independent-producer" as const },
        artifacts: [{ type: "verification-result", digest: "m".repeat(64) }],
      };
      const mutated = mode === "foreign run"
        ? { ...base, runId: "foreign-run" }
        : mode === "foreign request"
          ? { ...base, requestId: "foreign-request" }
          : mode === "foreign snapshot"
            ? { ...base, snapshotId: "foreign-snapshot" }
            : mode === "foreign idempotency"
              ? { ...base, idempotencyKey: `verification:${"0".repeat(64)}` }
              : mode === "malformed producer"
                ? { ...base, producer: undefined }
                : mode === "malformed artifacts field"
                  ? { ...base, artifacts: { digest: "m".repeat(64) } }
                  : { ...base, summary: 42 };
      return mutated as unknown as VerificationExecutionOutput;
    },
  };
  const result = await runOnce({ ...fakes.dependencies, executor, artifactStore }, `invalid-output-${mode.replaceAll(" ", "-")}`);
  expect(result.verdict.qaVerdict).toBe("INCOMPLETE");
  expect(stores).toBe(0);
});


describe("verification run orchestration", () => {
  test("executes every stage and persists a terminal canonical run", async () => {
    const fakes = makeDependencies();
    const result = await runOnce(fakes.dependencies);
    expect(result.run.schemaVersion).toBe("verification-run/v1");
    expect(result.run.runId).toBe(RUN_ID);
    expect(result.run.state).toBe("TERMINAL");
    expect(result.run.createdAt).toBe(FIXED_NOW);
    expect(result.run.updatedAt).toBe(FIXED_NOW);
    expect(fakes.repository.runs.get(RUN_ID)?.state).toBe("TERMINAL");
    expect(result.verdict.qaVerdict).toBe("PASS");
    expect(result.documents.evidence?.evaluations.every(item => item.checks.artifactRequirementsSatisfied)).toBe(true);
    expect(fakes.executorCalls).toBeGreaterThan(0);
    expect(fakes.repository.stageWrites.slice(0, 4)).toEqual(["request", "basis", "discovery", "plan"]);
    expect(fakes.repository.stageWrites.filter(stage => stage === "execution").length).toBeGreaterThanOrEqual(2);
  });
  test("issues one authority per canonical binding on normal completion", async () => {
    const fakes = makeDependencies();
    const oneShot = makeCanonicalBindingExecutionAuthority();
    const result = await runOnce({ ...fakes.dependencies, executionAuthority: oneShot.port }, "authority-one-shot-normal");
    expect(result.run.state).toBe("TERMINAL");
    expect(oneShot.issued).toHaveLength(result.documents.execution?.authorities.length ?? 0);
    expect(new Set(oneShot.issued.map(authority => authority.binding.idempotencyKey)).size).toBe(oneShot.issued.length);
  });

  test("completes an unreplaced dispatch generation after lease expiry without reissuing authority", async () => {
    const fakes = makeDependencies();
    const oneShot = makeCanonicalBindingExecutionAuthority();
    const executeObligation = fakes.dependencies.executor.executeObligation!;
    let executorReturned = false;
    const executor: VerificationExecutor = {
      ...fakes.dependencies.executor,
      executeObligation: async input => {
        const output = await executeObligation(input);
        executorReturned = true;
        return output;
      },
    };
    const request = { ...makeRequest("authority-expired-lease"), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const result = await runVerification({
      runId: "authority-expired-lease",
      request,
      dependencies: {
        ...fakes.dependencies,
        executor,
        executionAuthority: oneShot.port,
        now: () => executorReturned ? "2026-08-03T00:00:31.000Z" : FIXED_NOW,
      },
    });
    expect(result.run.state).toBe("TERMINAL");
    expect(oneShot.issued).toHaveLength(1);
  });

  test("rejects repositories without generation-fenced dispatch completion before execution", async () => {
    const repository = new FakeRepository();
    Object.defineProperty(repository, "generationFencedDispatchCompletion", { value: undefined });
    const fakes = makeDependencies({}, repository);
    await expect(runOnce(fakes.dependencies, "repository-dispatch-contract")).rejects.toThrow("repository must declare generation-fenced dispatch completion");
    expect(fakes.executorCalls).toBe(0);
    expect(repository.runWrites).toHaveLength(0);
  });

  test("reuses the completion authority after a crash before execution checkpoint persistence", async () => {
    const fakes = makeDependencies();
    fakes.repository.failNextStage = "execution";
    const oneShot = makeCanonicalBindingExecutionAuthority();
    const dependencies = { ...fakes.dependencies, executionAuthority: oneShot.port };
    const runId = "authority-one-shot-crash-resume";
    await expect(runOnce(dependencies, runId)).rejects.toThrow("simulated saveStage crash");
    const issuedBeforeResume = oneShot.issued.length;
    const executorCalls = fakes.executorCalls;
    const resumed = await runOnce(dependencies, runId);
    expect(resumed.run.state).toBe("TERMINAL");
    expect(oneShot.issued.length).toBe(issuedBeforeResume + 1);
    expect(fakes.executorCalls).toBe(executorCalls + 1);
  });

  test.each([["absent", undefined], ["false", false]] as const)("rejects a configured usage recorder with %s idempotency declaration before recording", async (_name, declaration) => {
    const fakes = makeDependencies();
    let calls = 0;
    const usageRecorder = declaration === undefined
      ? { recordUsage: async () => { calls++; } }
      : { atomicSameKeyIdempotency: declaration, recordUsage: async () => { calls++; } };
    const dependencies = { ...fakes.dependencies, usageRecorder: usageRecorder as unknown as UsageRecorder };
    const runId = `usage-recorder-contract-${_name}`;
    await expect(runOnce(dependencies, runId)).rejects.toThrow("usage recorder must declare atomic same-key idempotency");
    expect(calls).toBe(0);
    expect(fakes.executorCalls).toBe(0);
    expect(fakes.repository.stageWrites).not.toContain("execution");
  });

  test("resumes from a persisted intermediate state without repeating completed stages", async () => {
    const fakes = makeDependencies();
    const first = await runOnce(fakes.dependencies);
    const completed = fakes.repository.runs.get(RUN_ID);
    if (!completed) throw new Error("expected the first run to persist canonical state");
    const intermediate = { ...completed, state: "PLANNED" as RunStateValue, updatedAt: FIXED_NOW } satisfies CanonicalRunState;
    fakes.repository.runs.set(RUN_ID, intermediate);
    const writesBeforeResume = fakes.repository.stageWrites.length;
    const executorCallsBeforeResume = fakes.executorCalls;
    const browserCallsBeforeResume = fakes.browserCalls;
    const resumed = await runOnce(fakes.dependencies);
    expect(resumed.run.state).toBe("TERMINAL");
    expect(resumed.verdict).toEqual(first.verdict);
    expect(fakes.repository.stageWrites.slice(writesBeforeResume)).not.toContain("BASIS_ESTABLISHED");
    expect(fakes.repository.stageWrites.slice(writesBeforeResume)).not.toContain("DISCOVERY_COMPLETED");
    expect(fakes.executorCalls).toBe(executorCallsBeforeResume);
    expect(fakes.browserCalls).toBeGreaterThanOrEqual(browserCallsBeforeResume);
  });
  test("resumes a persisted plan after recursively reordering object keys", async () => {
    const fakes = makeDependencies();
    const first = await runOnce(fakes.dependencies);
    const run = fakes.repository.runs.get(RUN_ID);
    const plan = fakes.repository.stageDocuments.get(`${RUN_ID}:plan`) as Record<string, unknown>;
    if (!run || !plan) throw new Error("missing persisted plan");
    const reordered = reorderObjectKeysDeep(plan);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(plan));
    fakes.repository.stageDocuments.set(`${RUN_ID}:plan`, reordered);
    fakes.repository.runs.set(RUN_ID, { ...run, state: "PLANNED", updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    const resumed = await runOnce(fakes.dependencies);
    expect(resumed.run.state).toBe("TERMINAL");
    expect(resumed.verdict).toEqual(first.verdict);
    expect(fakes.executorCalls).toBe(executorCalls);
  });

  test("resumes a persisted verdict after recursively reordering object keys", async () => {
    const fakes = makeDependencies();
    const first = await runOnce(fakes.dependencies);
    const saved = fakes.repository.stageDocuments.get(`${RUN_ID}:verdict`) as Record<string, unknown>;
    if (!saved) throw new Error("missing persisted verdict");
    const reordered = reorderObjectKeysDeep(saved);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(saved));
    fakes.repository.stageDocuments.set(`${RUN_ID}:verdict`, reordered);
    const executorCalls = fakes.executorCalls;
    const resumed = await runOnce(fakes.dependencies);
    expect(resumed.run.state).toBe("TERMINAL");
    expect(resumed.verdict).toEqual(first.verdict);
    expect(fakes.executorCalls).toBe(executorCalls);
  });

  test("rejects invalid, skipped, and backward state transitions", () => {
    const initial = createInitialRun(RUN_ID, makeRequest(), FIXED_NOW);
    expect(() => transitionRunState(initial, "DISCOVERY_COMPLETED" as RunStateValue, FIXED_NOW)).toThrow();
    expect(() => transitionRunState(initial, "CREATED" as RunStateValue, FIXED_NOW)).toThrow();
    const basis = transitionRunState(initial, "BASIS_ESTABLISHED" as RunStateValue, FIXED_NOW);
    expect(() => transitionRunState(basis, "PLANNED" as RunStateValue, FIXED_NOW)).toThrow();
    expect(() => transitionRunState(basis, "CREATED" as RunStateValue, FIXED_NOW)).toThrow();
    expect(() => transitionRunState(initial, "NOT_A_STATE" as RunStateValue, FIXED_NOW)).toThrow();
  });

  test.each([
    ["missing capability", { missingCapability: true }],
    ["missing executor output", { missingExecutorOutput: true }],
  ])("does not resolve %s as PASS", async (_name, options) => {
    const fakes = makeDependencies(options);
    const result = await runOnce(fakes.dependencies);
    expect(result.run.state).toBe("TERMINAL");
    expect(["FAIL", "BLOCKED", "INCOMPLETE"]).toContain(result.verdict.qaVerdict);
    expect(result.verdict.qaVerdict).not.toBe("PASS");
  });
  test.each([
    ["rejected evidence with non-violating PASS output", { invalidArtifact: true }, "INCOMPLETE"],
    ["missing capability", { missingCapability: true }, "BLOCKED"],
    ["missing executor output", { missingExecutorOutput: true }, "INCOMPLETE"],
  ] as const)("preserves the core verdict for %s", async (_name, options, expected) => {
    const result = await runOnce(makeDependencies(options).dependencies, `verdict-${_name.replaceAll(" ", "-")}`);
    expect(result.verdict.qaVerdict).toBe(expected);
  });
  test("preserves FAILED for an explicit failed executor output", async () => {
    const fakes = makeDependencies();
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => ({
      status: "FAIL",
      runId: request.runId,
      requestId: request.requestId,
      snapshotId: request.snapshotId,
      idempotencyKey: request.idempotencyKey,
      producer: { kind: "deterministic-verifier", identity: "fixture-failing-executor", independence: "independent-producer" },
      artifacts: [{ type: "verification-result", digest: "f".repeat(64) }],
    }), }
    const result = await runVerification({ runId: "explicit-failure", request: makeRequest(), dependencies: { ...fakes.dependencies, executor } });
    expect(result.verdict.qaVerdict).toBe("FAIL");
    const failedEvidence = result.documents.execution?.evidence.filter(item => item.result.verdict === "FAIL") ?? [];
    expect(failedEvidence.length).toBeGreaterThan(0);
    expect(result.documents.execution?.authorities.every(authority => authority.binding.result.verdict === "FAIL" && authority.binding.artifacts.length === 1 && authority.binding.artifacts[0]?.digest === "f".repeat(64))).toBe(true);
  });
  test.each([
    ["PASS", 1],
    ["FAIL", 0],
  ] as const)("rejects contradictory %s output with exit code %d before authority", async (status, exitCode) => {
    const fakes = makeDependencies();
    let artifactCalls = 0;
    const storeArtifact = async (artifact: Artifact): Promise<Artifact> => {
      artifactCalls++;
      return artifact;
    };
    const artifactStore: ArtifactStore = {
      atomicSameKeyIdempotency: true,
      storeVerificationResultArtifact: storeArtifact,
      storeArtifact,
      putArtifact: storeArtifact,
      store: storeArtifact,
    };
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => ({
      status,
      exitCode,
      runId: request.runId,
      requestId: request.requestId,
      snapshotId: request.snapshotId,
      idempotencyKey: request.idempotencyKey,
      producer: { kind: "deterministic-verifier", identity: "fixture-contradictory-executor", independence: "independent-producer" },
      artifacts: [{ type: "verification-result", digest: "c".repeat(64) }],
    }) };

    await expect(runVerification({
      runId: `contradictory-${status.toLowerCase()}-${exitCode}`,
      request: makeRequest(),
      dependencies: { ...fakes.dependencies, executor, artifactStore },
    })).rejects.toThrow("executor output status contradicts exit code");
    expect(artifactCalls).toBe(0);
    expect(fakes.repository.stageWrites).not.toContain("execution");
  });
  test.each([
    ["invalid executor digest", { invalidArtifact: true }],
    ["missing artifact storage", { missingArtifactStorage: true }],
    ["mismatched output provenance", { mismatchedProvenance: true }],
    ["producer below required independence", { producerIndependence: "self-check" as const }],
  ])("fails closed for %s", async (_name, options) => {
    const result = await runOnce(makeDependencies(options).dependencies);
    expect(result.verdict.qaVerdict).not.toBe("PASS");
  });
  test("rejects self producer with independent independence and resumes without redispatch", async () => {
    const fakes = makeDependencies({ producerKind: "self", producerIndependence: "independent-producer" });
    const runId = "self-independent-fresh";
    const first = await runVerification({ runId, request: makeRequest(), dependencies: fakes.dependencies });
    expect(first.documents.execution?.evidence.every(item => item.result.verdict === "INCOMPLETE")).toBe(true);
    expect(first.documents.execution?.observations.every(item => item.producer.kind === "self" && item.producer.independence === "self-check")).toBe(true);
    expect(first.verdict.qaVerdict).not.toBe("PASS");
    const executorCalls = fakes.executorCalls;
    const browserCalls = fakes.browserCalls;
    const resumed = await runVerification({ runId, dependencies: fakes.dependencies });
    expect(resumed.verdict).toEqual(first.verdict);
    expect(fakes.executorCalls).toBe(executorCalls);
    expect(fakes.browserCalls).toBe(browserCalls);
  });

  test("rejects self producer with independent independence in persisted execution", async () => {
    const fakes = makeDependencies();
    const runId = "self-independent-persisted";
    const first = await runVerification({ runId, request: makeRequest(), dependencies: fakes.dependencies });
    const execution = structuredClone(first.documents.execution) as ExecutionDocument;
    const invalidProducer = { kind: "self" as const, identity: "persisted-self", independence: "independent-producer" as const };
    const observations = execution.observations.map(item => ({ ...item, producer: invalidProducer }));
    const evidence = execution.evidence.map(item => ({ ...item, producer: invalidProducer }));
    const authorities = execution.authorities.map(item => ({ ...item, binding: { ...item.binding, producer: invalidProducer } }));
    fakes.repository.stageDocuments.set(`${runId}:execution`, { ...execution, observations, evidence, authorities });
    await expect(runVerification({ runId, dependencies: fakes.dependencies })).rejects.toThrow(/invalid .*execution/);
  });
  test.each([
    ["invalid artifact", { invalidArtifact: true }],
    ["missing artifact storage", { missingArtifactStorage: true }],
    ["invalid producer", { invalidProducer: true }],
  ] as const)("does not persist PASS execution evidence for %s", async (_name, options) => {
    const result = await runOnce(makeDependencies(options).dependencies, `evidence-${_name.replaceAll(" ", "-")}`);
    expect(result.documents.execution?.evidence.every(item => item.result.verdict !== "PASS")).toBe(true);
  });
  test.each(["requestId", "snapshotId"] as const)("fails closed when executor omits output %s provenance", async field => {
    const fakes = makeDependencies();
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async (request: VerificationExecutionRequest) => {
      const output: VerificationExecutionOutput = {
        status: "PASS",
        runId: request.runId,
        requestId: request.requestId,
        snapshotId: request.snapshotId,
        idempotencyKey: request.idempotencyKey,
        producer: { kind: "deterministic-verifier", identity: "fixture-executor", independence: "independent-producer" },
        artifacts: [{ type: "verification-result", digest: "a".repeat(64) }],
      };
      const malformed = { ...output };
      const mutable = malformed as { requestId?: string; snapshotId?: string };
      if (field === "requestId") delete mutable.requestId;
      else delete mutable.snapshotId;
      return malformed;
    }, }

    const result = await runVerification({ runId: `missing-${field}`, request: makeRequest(), dependencies: { ...fakes.dependencies, executor } });
    expect(result.documents.execution?.observations.every(observation => field === "requestId" ? observation.requestId === REQUEST_ID : observation.snapshotId === SNAPSHOT_ID)).toBe(true);
  });
  test.each(["missing", "mismatched"] as const)("terminal resume preserves the %s receipt verdict without recalling executor", async mode => {
    const fakes = makeDependencies(mode === "missing" ? { missingExecutorOutput: true } : { mismatchedProvenance: true });
    const runId = `terminal-receipt-${mode}`;
    const first = await runVerification({ runId, request: makeRequest(), dependencies: fakes.dependencies });
    const executorCalls = fakes.executorCalls;
    expect(first.verdict.qaVerdict).toBe("INCOMPLETE");
    expect(first.verdict.qaVerdict).not.toBe("PASS");
    expect(first.documents.execution?.observations.every(item => item.requestId === REQUEST_ID && item.snapshotId === SNAPSHOT_ID)).toBe(true);
    const resumed = await runVerification({ runId, dependencies: fakes.dependencies });
    expect(resumed.verdict).toEqual(first.verdict);
    expect(fakes.executorCalls).toBe(executorCalls);
  });
  test.each(["missing", "mismatched"] as const)("does not accept executor PASS with %s idempotency key", async mode => {
    const fakes = makeDependencies();
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async (request: VerificationExecutionRequest) => ({
      status: "PASS",
      runId: request.runId,
      requestId: request.requestId,
      snapshotId: request.snapshotId,
      idempotencyKey: mode === "missing" ? undefined : "wrong-idempotency-key",
      producer: { kind: "deterministic-verifier", identity: "fixture-executor", independence: "independent-producer" },
      artifacts: [{ type: "verification-result", digest: "a".repeat(64) }],
    } as unknown as VerificationExecutionOutput), }
    const result = await runVerification({ runId: `idempotency-${mode}`, request: makeRequest(), dependencies: { ...fakes.dependencies, executor } });
    expect(result.verdict.qaVerdict).not.toBe("PASS");
    expect(result.documents.execution?.evidence.every(item => item.result.verdict !== "PASS" || item.result.passed !== 1)).toBe(true);
  });

  test("encodes idempotency components without collisions", async () => {
    const fakes = makeDependencies();
    const seen: VerificationExecutionRequest[] = [];
    const original = fakes.dependencies.executor.executeObligation;
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => {
      seen.push(request);
      return original ? original(request) : undefined;
    }, }
    const dependencies = { ...fakes.dependencies, executor };
    await runOnce(dependencies, "tenant:a", "req");
    await runOnce(dependencies, "tenant", "a:req");
    const first = seen.find(request => request.runId === "tenant:a");
    const second = seen.find(request => request.runId === "tenant" && request.requestId === "a:req");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.obligation.id).toBe(second?.obligation.id);
    expect(first?.snapshotId).toBe(second?.snapshotId);
    expect(first?.idempotencyKey).not.toBe(second?.idempotencyKey);
  });

  test("replays identical idempotency components to the same key", async () => {
    const capture = async (): Promise<VerificationExecutionRequest> => {
      const fakes = makeDependencies();
      let captured: VerificationExecutionRequest | undefined;
      const original = fakes.dependencies.executor.executeObligation;
      const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => {
        captured ??= request;
        return original ? original(request) : undefined;
      }, }
      await runOnce({ ...fakes.dependencies, executor }, "stable-run", "stable-request");
      if (!captured) throw new Error("expected executor request");
      return captured;
    };
    const first = await capture();
    const second = await capture();
    expect(second.runId).toBe(first.runId);
    expect(second.requestId).toBe(first.requestId);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.obligation.id).toBe(first.obligation.id);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  test("classifies material risks, derives tiered obligations, and preserves browser technique", async () => {
    const request = { ...makeRequest(), testBasis: [
      { id: "z-browser", kind: "acceptance-criterion" as const, origin: "explicit" as const, text: "The browser flow renders the UI." },
      { id: "a-security", kind: "requirement" as const, origin: "explicit" as const, text: "Security migration must be reviewed." },
      { id: "m-contract", kind: "contract" as const, origin: "derived" as const, text: "The public contract remains stable." },
      { id: "r-basic", kind: "requirement" as const, origin: "explicit" as const, text: "A basic check runs." },
    ] } satisfies VerificationRequest;
    const deps = makeDependencies().dependencies;
    const basis = await establishTestBasis({ request, dependencies: deps });
    const discovery = await performRiskDiscovery({ request, basis, dependencies: deps });
    const plan = await buildVerificationPlan({ request, basis, discovery, dependencies: deps });
    expect(discovery.risks.map(item => item.id)).toEqual(["risk:a-security", "risk:m-contract", "risk:r-basic", "risk:z-browser"]);
    expect(discovery.risks.find(item => item.id === "risk:a-security")?.level).toBe("R3");
    expect(discovery.risks.find(item => item.id === "risk:m-contract")?.level).toBe("R2");
    expect(plan.obligations.find(item => item.id === "obligation:condition:a-security")?.independence).toBe("independent-producer");
    expect(discovery.risks.find(item => item.id === "risk:r-basic")?.level).toBe("R2");
    expect(discovery.risks.find(item => item.id === "risk:z-browser")?.level).toBe("R2");
    expect(plan.obligations.find(item => item.id === "obligation:condition:m-contract")?.independence).toBe("separate-verification-context");
    expect(plan.obligations.find(item => item.id === "obligation:condition:r-basic")?.independence).toBe("separate-verification-context");
    expect(plan.obligations.find(item => item.id === "obligation:condition:z-browser")?.independence).toBe("separate-verification-context");
    expect(plan.obligations.find(item => item.id === "obligation:condition:z-browser")?.evidenceType).toBe("browser-result");
    const execution = (await runVerification({ runId: RUN_ID, request, dependencies: deps })).documents.execution;
    if (!execution) throw new Error("missing execution");
    expect(execution.observations.find(item => item.observationId === "observation:obligation:condition:z-browser")?.execution.kind).toBe("browser");
    const browserRequest = { ...makeRequest(), testBasis: [{ id: "browser-only", kind: "acceptance-criterion" as const, origin: "explicit" as const, text: "The browser flow renders." }] } satisfies VerificationRequest;
    const browserFakes = makeDependencies();
    const browserBasis = await establishTestBasis({ request: browserRequest, dependencies: browserFakes.dependencies });
    const browserDiscovery = await performRiskDiscovery({ request: browserRequest, basis: browserBasis, dependencies: browserFakes.dependencies });
    const browserPlan = await buildVerificationPlan({ request: browserRequest, basis: browserBasis, discovery: browserDiscovery, dependencies: browserFakes.dependencies });
    const browserExecution = (await runVerification({ runId: RUN_ID, request: browserRequest, dependencies: browserFakes.dependencies })).documents.execution;
    if (!browserExecution) throw new Error("missing browser execution");
    expect(browserExecution.observations[0]?.execution.kind).toBe("browser");
    expect(browserFakes.browserCalls).toBe(1);
    expect(browserFakes.executorCalls).toBe(0);
  });
  test("keeps local UI assurance separate and requires independent producers for release", async () => {
    const dependencies = makeDependencies().dependencies;
    const releaseRequest = { ...makeCompositionRequest("release-assurance"), assuranceContext: "release" as const };
    const localRequest = { ...makeCompositionRequest("local-assurance"), assuranceContext: "local" as const };
    const releaseBasis = await establishTestBasis({ request: releaseRequest, dependencies });
    const releaseDiscovery = await performRiskDiscovery({ request: releaseRequest, basis: releaseBasis, dependencies });
    const releasePlan = await buildVerificationPlan({ request: releaseRequest, basis: releaseBasis, discovery: releaseDiscovery, dependencies });
    const localBasis = await establishTestBasis({ request: localRequest, dependencies });
    const localDiscovery = await performRiskDiscovery({ request: localRequest, basis: localBasis, dependencies });
    const localPlan = await buildVerificationPlan({ request: localRequest, basis: localBasis, discovery: localDiscovery, dependencies });
    expect(releasePlan.obligations.filter(item => item.visualCompositionRequirement || item.uiResilienceRequirement).every(item => item.independence === "independent-producer")).toBe(true);
    expect(localPlan.obligations.filter(item => item.visualCompositionRequirement || item.uiResilienceRequirement).every(item => item.independence === "separate-verification-context")).toBe(true);
  });
  test("accepts canonical discovery and rejects downgraded or foreign discovery at the direct plan API", async () => {
    const request = makeRequest("direct-plan-discovery");
    const fakes = makeDependencies();
    const basis = await establishTestBasis({ request, dependencies: fakes.dependencies });
    const discovery = await performRiskDiscovery({ request, basis, dependencies: fakes.dependencies });
    const plan = await buildVerificationPlan({ request, basis, discovery, dependencies: fakes.dependencies });
    expect(plan.schemaVersion).toBe("verification-plan/v1");
    expect(plan.requestId).toBe(request.requestId);
    const downgraded = {
      ...discovery,
      risks: discovery.risks.map((risk, index) => index === 0 ? { ...risk, level: "R1" as const, impact: 1, likelihood: 1 } : risk),
    };
    await expect(buildVerificationPlan({ request, basis, discovery: downgraded, dependencies: fakes.dependencies })).rejects.toThrow("invalid discovery canonicalization");
    const foreignRequest = makeRequest("foreign-direct-plan-discovery");
    const foreignBasis = await establishTestBasis({ request: foreignRequest, dependencies: fakes.dependencies });
    const foreignDiscovery = await performRiskDiscovery({ request: foreignRequest, basis: foreignBasis, dependencies: fakes.dependencies });
    await expect(buildVerificationPlan({ request, basis, discovery: foreignDiscovery, dependencies: fakes.dependencies })).rejects.toThrow("invalid discovery canonicalization");
  });
  test("derives R3 independent-producer obligations from migration change material with neutral basis", async () => {
    const request = { ...makeRequest(), change: { summary: "Apply the database migration safely.", paths: ["src/neutral-check.ts"] }, testBasis: [{ id: "neutral", kind: "request" as const, origin: "explicit" as const, text: "The requested check is recorded." }] } satisfies VerificationRequest;
    const dependencies = makeDependencies().dependencies;
    const basis = await establishTestBasis({ request, dependencies });
    const discovery = await performRiskDiscovery({ request, basis, dependencies });
    const plan = await buildVerificationPlan({ request, basis, discovery, dependencies });
    expect(discovery.risks[0]?.level).toBe("R3");
    expect(discovery.conditions[0]?.techniques).toContain("independent-producer");
    expect(plan.obligations[0]?.independence).toBe("independent-producer");
    const localRequest = { ...request, requestId: "local-r3", assuranceContext: "local" as const };
    const localBasis = await establishTestBasis({ request: localRequest, dependencies });
    const localDiscovery = await performRiskDiscovery({ request: localRequest, basis: localBasis, dependencies });
    const localPlan = await buildVerificationPlan({ request: localRequest, basis: localBasis, discovery: localDiscovery, dependencies });
    expect(localDiscovery.conditions[0]?.techniques).toContain("independent-producer");
    expect(localPlan.obligations[0]?.independence).toBe("independent-producer");
  });
  test.each(["auth", "authentication", "authorization", "credential", "credentials", "injection", "injected"] as const)("derives R3 independent-producer obligations from %s basis material", async signal => {
    const request = { ...makeRequest(`basis-signal-${signal}`), change: { summary: "Apply a neutral verification change.", paths: ["src/neutral-check.ts"] }, testBasis: [{ id: "neutral", kind: "request" as const, origin: "explicit" as const, text: `The neutral basis includes ${signal}.` }] } satisfies VerificationRequest;
    const dependencies = makeDependencies().dependencies;
    const basis = await establishTestBasis({ request, dependencies });
    const discovery = await performRiskDiscovery({ request, basis, dependencies });
    const plan = await buildVerificationPlan({ request, basis, discovery, dependencies });
    expect(discovery.risks[0]?.level).toBe("R3");
    expect(discovery.conditions[0]?.techniques).toContain("independent-producer");
    expect(plan.obligations[0]?.independence).toBe("independent-producer");
  });
  test.each(["auth", "authentication", "authorization", "credential", "credentials", "injection", "injected"] as const)("derives R3 independent-producer obligations from %s declared change material", async signal => {
    const request = { ...makeRequest(`change-signal-${signal}`), change: { summary: `Apply neutral ${signal} handling.`, paths: ["src/neutral-check.ts"] }, testBasis: [{ id: "neutral", kind: "request" as const, origin: "explicit" as const, text: "The requested check is recorded." }] } satisfies VerificationRequest;
    const dependencies = makeDependencies().dependencies;
    const basis = await establishTestBasis({ request, dependencies });
    const discovery = await performRiskDiscovery({ request, basis, dependencies });
    const plan = await buildVerificationPlan({ request, basis, discovery, dependencies });
    expect(discovery.risks[0]?.level).toBe("R3");
    expect(discovery.conditions[0]?.techniques).toContain("independent-producer");
    expect(plan.obligations[0]?.independence).toBe("independent-producer");
  });

  test("derives browser result and executor from UI/frontend change material with neutral basis", async () => {
    const request = { ...makeRequest(), change: { summary: "Refresh the frontend UI browser flow.", paths: ["frontend/components/"] }, testBasis: [{ id: "neutral", kind: "request" as const, origin: "explicit" as const, text: "The requested check is recorded." }] } satisfies VerificationRequest;
    const fakes = makeDependencies();
    const basis = await establishTestBasis({ request, dependencies: fakes.dependencies });
    const discovery = await performRiskDiscovery({ request, basis, dependencies: fakes.dependencies });
    const plan = await buildVerificationPlan({ request, basis, discovery, dependencies: fakes.dependencies });
    expect(discovery.risks[0]?.level).toBe("R2");
    expect(discovery.conditions).toHaveLength(2);
    expect(discovery.conditions.filter(item => item.techniques.includes("browser-verification"))).toHaveLength(1);
    expect(discovery.conditions.find(item => item.id === "condition:request-browser")?.basisIds).toEqual(["neutral"]);
    expect(discovery.conditions.find(item => item.id === "condition:request-browser")?.riskIds).toEqual(["risk:neutral"]);
    const execution = (await runVerification({ runId: "neutral-browser", request, dependencies: fakes.dependencies })).documents.execution;
    if (!execution) throw new Error("missing execution");
    expect(plan.obligations.filter(item => item.evidenceType === "browser-result")).toHaveLength(1);
    expect(execution.observations.filter(item => item.execution.kind === "browser")).toHaveLength(1);
    expect(fakes.browserCalls).toBe(1);
    expect(fakes.executorCalls).toBeGreaterThan(0);
  });

  test("requires an explicit scope decision for significant UI requests", async () => {
    const request = {
      ...makeRequest("composition-scope-required"),
      change: { summary: "Adjust section spacing.", paths: ["frontend/catalog.tsx"], uiImpact: "significant" },
    } satisfies VerificationRequest;
    await expect(establishTestBasis({ request, dependencies: makeDependencies().dependencies })).rejects.toThrow("must declare visual composition and UI resilience scopes");
    const schema = JSON.parse(await Bun.file(`${import.meta.dir}/../../contracts/verification-request.schema.json`).text()) as object;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(request)).toBe(false);
  });

  test("rejects visual scopes without an explicit UI impact classification", async () => {
    const classified = makeCompositionRequest("composition-impact-required");
    const { uiImpact: _, ...change } = classified.change;
    const request = { ...classified, change };
    await expect(establishTestBasis({ request, dependencies: makeDependencies().dependencies })).rejects.toThrow("require an explicit UI impact classification");
    const schema = JSON.parse(await Bun.file(`${import.meta.dir}/../../contracts/verification-request.schema.json`).text()) as object;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(request)).toBe(false);
  });

  test("keeps browser-only verification separate when composition is explicitly out of scope", async () => {
    const request = {
      ...makeRequest("composition-not-required"),
      change: { summary: "Refresh the UI copy without changing layout.", paths: ["frontend/catalog.tsx"], uiImpact: "functional-only" },
      visualComposition: {
        schemaVersion: "visual-composition-scope/v1",
        decision: "not-required",
        basisIds: ["basis-001"],
        rationale: "The rendered geometry and responsive composition are unchanged.",
        surfaces: [],
        viewports: [],
      },
    } satisfies VerificationRequest;
    const dependencies = makeDependencies().dependencies;
    const basis = await establishTestBasis({ request, dependencies });
    const discovery = await performRiskDiscovery({ request, basis, dependencies });
    expect(discovery.conditions.some(item => item.techniques.includes("visual-composition"))).toBe(false);
  });

  test("cannot pass composition scope with functional browser success but no composition oracle", async () => {
    const result = await runVerification({ runId: "composition-oracle-missing", request: makeCompositionRequest("composition-oracle-missing"), dependencies: makeDependencies().dependencies });
    expect(result.verdict.qaVerdict).toBe("INCOMPLETE");
    const compositionEvidence = result.documents.execution?.evidence.find(item => item.obligationId.includes("visual-composition"));
    expect(compositionEvidence?.result.verdict).toBe("INCOMPLETE");
    expect(compositionEvidence?.result.summary).toContain("VISUAL_COMPOSITION_ORACLE_MISSING");
  });

  test("passes composition scope only with independent oracle and stored whole-page and focused screenshots", async () => {
    const fakes = makeDependencies({ visualCompositionOracle: true });
    const result = await runVerification({ runId: "composition-oracle-pass", request: makeCompositionRequest("composition-oracle-pass"), dependencies: fakes.dependencies });
    expect(result.verdict.qaVerdict).toBe("PASS");
    const compositionObservation = result.documents.execution?.observations.find(item => item.observationId.includes("visual-composition"));
    expect(compositionObservation?.artifacts).toEqual(expect.arrayContaining([
      { type: "screenshot", digest: compositionScreenshotDigest("full-page", "desktop") },
      { type: "screenshot", digest: compositionScreenshotDigest("focused-region", "desktop") },
    ]));
    const compositionEvidence = result.documents.execution?.evidence.find(item => item.obligationId.includes("visual-composition"));
    const compositionAuthority = result.documents.execution?.authorities.find(item => item.binding.obligationId.includes("visual-composition"));
    expect(compositionEvidence?.visualCompositionOracleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(compositionAuthority?.binding.visualCompositionOracleDigest).toBe(compositionEvidence?.visualCompositionOracleDigest);
  });
  test("plans, evaluates, and authority-binds deterministic UI resilience evidence", async () => {
    const request = makeResilienceRequest("ui-resilience-runtime-pass");
    const fakes = makeDependencies();
    const producer = { kind: "deterministic-verifier", identity: "resilience-browser", independence: "independent-producer" } as const;
    const browserExecutor: BrowserExecutor = {
      atomicSameKeyIdempotency: true,
      executeBrowser: async executionRequest => {
        const oracle = executionRequest.obligation.uiResilienceRequirement ? makeResilienceOracle(executionRequest, producer) : undefined;
        const artifacts: Artifact[] = [{ type: "verification-result", digest: "9".repeat(64) }];
        if (oracle) {
          artifacts.push(...oracle.runs.flatMap(run => run.observations.map(observation => ({ type: "screenshot" as const, digest: observation.screenshotDigest }))));
          artifacts.push(...executionRequest.obligation.uiResilienceRequirement!.applicabilityApprovals.map(approval => ({ type: "ui-applicability-approval" as const, digest: approval.approvalArtifactDigest })));
        }
        return { status: "PASS", runId: executionRequest.runId, requestId: executionRequest.requestId, snapshotId: executionRequest.snapshotId, idempotencyKey: executionRequest.idempotencyKey, producer, artifacts, ...(oracle ? { uiResilienceOracle: oracle } : {}) };
      },
    };
    const result = await runVerification({ runId: "ui-resilience-runtime-pass", request, dependencies: { ...fakes.dependencies, browserExecutor } });
    expect(result.verdict.qaVerdict).toBe("PASS");
    const resilienceEvidence = result.documents.execution?.evidence.find(item => item.obligationId.includes("ui-resilience"));
    const resilienceAuthority = result.documents.execution?.authorities.find(item => item.binding.obligationId.includes("ui-resilience"));
    const evidenceSchema = JSON.parse(await Bun.file(`${import.meta.dir}/../../contracts/evidence.schema.json`).text()) as object;
    expect(resilienceEvidence?.uiResilienceOracleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(resilienceAuthority?.binding.uiResilienceOracleDigest).toBe(resilienceEvidence?.uiResilienceOracleDigest);
    const basis = await establishTestBasis({ request, dependencies: fakes.dependencies });
    const discovery = await performRiskDiscovery({ request, basis, dependencies: fakes.dependencies });
    const plan = await buildVerificationPlan({ request, basis, discovery, dependencies: fakes.dependencies });
    const requestSchema = JSON.parse(await Bun.file(`${import.meta.dir}/../../contracts/verification-request.schema.json`).text()) as object;
    const planSchema = JSON.parse(await Bun.file(`${import.meta.dir}/../../contracts/verification-plan.schema.json`).text()) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    expect(ajv.compile(requestSchema)(request)).toBe(true);
    expect(ajv.compile(planSchema)(plan)).toBe(true);
    expect(ajv.compile(evidenceSchema)(resilienceEvidence)).toBe(true);
  });

  test("authenticates each applicability approval against its complete request-bound subject", async () => {
    const request = makeResilienceRequest("ui-applicability-subject-binding");
    const fakes = makeDependencies();
    const subjects: UiApplicabilityApprovalSubject[] = [];
    const result = await runVerification({
      runId: "ui-applicability-subject-binding",
      request,
      dependencies: {
        ...fakes.dependencies,
        uiApplicabilityApprovalVerifier: {
          independentAuthentication: true,
          verifyApproval: async subject => {
            subjects.push(subject);
            return subject.profile !== "rtl";
          },
        },
      },
    });
    expect(subjects.length).toBeGreaterThan(0);
    expect(subjects.every(subject =>
      subject.requestId === request.requestId
      && subject.snapshotId === request.project.snapshotId
      && subject.conditionId === "condition:request-ui-resilience"
      && subject.surfaceId === "catalog"
      && subject.basisIds.length === 1
      && subject.approvalReceipt.requestId === subject.requestId
      && subject.approvalReceipt.snapshotId === subject.snapshotId
      && subject.approvalReceipt.profile === subject.profile
    )).toBe(true);
    expect(result.verdict.qaVerdict).not.toBe("PASS");
    const resilienceEvidence = result.documents.execution?.evidence.find(item => item.obligationId.includes("ui-resilience"));
    expect(resilienceEvidence?.result.summary).toContain("APPLICABILITY_APPROVAL_UNAUTHENTICATED:catalog:rtl");
  });

  test("evaluates a blocked executor oracle and preserves assertion failure precedence", async () => {
    const fakes = makeDependencies({ visualCompositionOracle: true, browserStatus: "BLOCKED", failedVisualAssertion: true, visualBlocking: true });
    const result = await runVerification({ runId: "composition-blocked-with-failure", request: makeCompositionRequest("composition-blocked-with-failure"), dependencies: fakes.dependencies });
    const compositionEvidence = result.documents.execution?.evidence.find(item => item.obligationId.includes("visual-composition"));
    expect(compositionEvidence?.result.verdict).toBe("FAIL");
    expect(compositionEvidence?.result.summary).toContain("COMPOSITION_ASSERTION_FAILED");
  });
  test("does not attribute a mismatched oracle failure to the executor producer", async () => {
    const fakes = makeDependencies({ visualCompositionOracle: true, mismatchedOracleProducer: true, failedVisualAssertion: true });
    const result = await runVerification({ runId: "composition-producer-mismatch", request: makeCompositionRequest("composition-producer-mismatch"), dependencies: fakes.dependencies });
    const compositionEvidence = result.documents.execution?.evidence.find(item => item.obligationId.includes("visual-composition"));
    expect(compositionEvidence?.result.verdict).toBe("INCOMPLETE");
    expect(compositionEvidence?.result.summary).toContain("ORACLE_PRODUCER_MISMATCH");
  });


  test("rejects a persisted passing composition result with both oracle digests removed", async () => {
    const runId = "composition-oracle-digest-removed";
    const fakes = makeDependencies({ visualCompositionOracle: true });
    const result = await runVerification({ runId, request: makeCompositionRequest(runId), dependencies: fakes.dependencies });
    expect(result.verdict.qaVerdict).toBe("PASS");
    const saved = fakes.repository.stageDocuments.get(`${runId}:execution`) as ExecutionDocument;
    const evidence = saved.evidence.map(item => {
      if (!item.obligationId.includes("visual-composition")) return item;
      const { visualCompositionOracleDigest: _removed, ...withoutDigest } = item;
      return withoutDigest;
    });
    const authorities = saved.authorities.map(authority => {
      if (!authority.binding.obligationId.includes("visual-composition")) return authority;
      const { visualCompositionOracleDigest: _removed, ...binding } = authority.binding;
      return { ...authority, binding };
    });
    fakes.repository.stageDocuments.set(`${runId}:execution`, { ...saved, evidence, authorities });
    await expect(runVerification({ runId, dependencies: fakes.dependencies })).rejects.toThrow("invalid execution visual composition evidence binding");
  });

  test("validates composition request and emitted plan with canonical AJV schemas", async () => {
    const request = makeCompositionRequest("composition-ajv-contract");
    const dependencies = makeDependencies().dependencies;
    const basis = await establishTestBasis({ request, dependencies });
    const discovery = await performRiskDiscovery({ request, basis, dependencies });
    const plan = await buildVerificationPlan({ request, basis, discovery, dependencies });
    const requestSchema = JSON.parse(await Bun.file(`${import.meta.dir}/../../contracts/verification-request.schema.json`).text()) as object;
    const planSchema = JSON.parse(await Bun.file(`${import.meta.dir}/../../contracts/verification-plan.schema.json`).text()) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validateRequest = ajv.compile(requestSchema);
    const validatePlan = ajv.compile(planSchema);
    expect(validateRequest(request), validateRequest.errors ? JSON.stringify(validateRequest.errors) : undefined).toBe(true);
    expect(validatePlan(plan), validatePlan.errors ? JSON.stringify(validatePlan.errors) : undefined).toBe(true);
  });

  test("requires independent composition evidence for explicitly significant UI with neutral basis text", async () => {
    const request = {
      ...makeCompositionRequest("composition-significant-neutral"),
      testBasis: [{ id: "basis-layout", kind: "request" as const, origin: "explicit" as const, text: "Keep the approved spacing." }],
    } satisfies VerificationRequest;
    const dependencies = makeDependencies().dependencies;
    const basis = await establishTestBasis({ request, dependencies });
    const discovery = await performRiskDiscovery({ request, basis, dependencies });
    const plan = await buildVerificationPlan({ request, basis, discovery, dependencies });
    const compositionObligation = plan.obligations.find(item => item.visualCompositionRequirement);
    expect(compositionObligation?.independence).toBe("independent-producer");
    expect(compositionObligation?.visualCompositionRequirement?.minimumIndependence).toBe("independent-producer");
  });

  test("cannot pass when a focused screenshot digest is not backed by stored screenshot evidence", async () => {
    const fakes = makeDependencies({ visualCompositionOracle: true, omitStoredScreenshot: true });
    const result = await runVerification({ runId: "composition-focused-missing", request: makeCompositionRequest("composition-focused-missing"), dependencies: fakes.dependencies });
    expect(result.verdict.qaVerdict).toBe("INCOMPLETE");
    expect(result.documents.execution?.evidence.find(item => item.obligationId.includes("visual-composition"))?.result.summary).toContain("SCREENSHOT_ARTIFACT_MISSING");
  });

  test("cannot pass R2 composition approval from the implementer's self-check", async () => {
    const fakes = makeDependencies({ visualCompositionOracle: true, producerKind: "self", producerIndependence: "self-check" });
    const result = await runVerification({ runId: "composition-self-check", request: makeCompositionRequest("composition-self-check"), dependencies: fakes.dependencies });
    expect(result.verdict.qaVerdict).not.toBe("PASS");
    expect(result.documents.execution?.evidence.find(item => item.obligationId.includes("visual-composition"))?.result.summary).toContain("INDEPENDENCE_NOT_MET");
  });
  test("keeps explicit UI and backend basis conditions as one browser and one generic obligation", async () => {
    const request = { ...makeRequest("mixed-explicit-ui-backend"), change: { summary: "Verify the backend endpoint.", paths: ["server/api.ts"] }, testBasis: [
      { id: "backend", kind: "requirement" as const, origin: "explicit" as const, text: "The backend API accepts valid requests." },
      { id: "ui", kind: "acceptance-criterion" as const, origin: "explicit" as const, text: "The UI browser flow renders correctly." },
    ] } satisfies VerificationRequest;
    const fakes = makeDependencies();
    const basis = await establishTestBasis({ request, dependencies: fakes.dependencies });
    const discovery = await performRiskDiscovery({ request, basis, dependencies: fakes.dependencies });
    const plan = await buildVerificationPlan({ request, basis, discovery, dependencies: fakes.dependencies });
    expect(discovery.conditions).toHaveLength(2);
    expect(discovery.conditions.find(item => item.id === "condition:ui")?.techniques).toContain("browser-verification");
    expect(discovery.conditions.find(item => item.id === "condition:backend")?.techniques).not.toContain("browser-verification");
    const execution = (await runVerification({ runId: "mixed-explicit-ui-backend", request, dependencies: fakes.dependencies })).documents.execution;
    if (!execution) throw new Error("missing execution");
    expect(plan.obligations.filter(item => item.evidenceType === "test-result")).toHaveLength(1);
    expect(execution.observations.filter(item => item.execution.kind === "browser")).toHaveLength(1);
    expect(execution.observations.filter(item => item.execution.kind === "command")).toHaveLength(1);
    expect(fakes.browserCalls).toBe(1);
    expect(fakes.executorCalls).toBe(1);
  });

  test("adds one request browser condition over complete universes for neutral UI material and preserves it on resume", async () => {
    const request = { ...makeRequest("mixed-neutral-request-browser"), change: { summary: "Refresh the frontend UI browser flow.", paths: ["frontend/app.tsx"] }, testBasis: [
      { id: "neutral-a", kind: "request" as const, origin: "explicit" as const, text: "The requested check is recorded." },
      { id: "neutral-b", kind: "request" as const, origin: "explicit" as const, text: "The result is summarized." },
    ] } satisfies VerificationRequest;
    const fakes = makeDependencies();
    const basis = await establishTestBasis({ request, dependencies: fakes.dependencies });
    const discovery = await performRiskDiscovery({ request, basis, dependencies: fakes.dependencies });
    const plan = await buildVerificationPlan({ request, basis, discovery, dependencies: fakes.dependencies });
    const requestBrowser = discovery.conditions.filter(item => item.techniques.includes("browser-verification"));
    expect(requestBrowser).toHaveLength(1);
    expect(requestBrowser[0]?.id).toBe("condition:request-browser");
    expect(requestBrowser[0]?.basisIds).toEqual(["neutral-a", "neutral-b"]);
    expect(requestBrowser[0]?.riskIds).toEqual(["risk:neutral-a", "risk:neutral-b"]);
    expect(new Set(discovery.conditions.map(item => item.id)).size).toBe(discovery.conditions.length);
    expect(plan.obligations).toHaveLength(3);
    expect(plan.obligations.filter(item => item.evidenceType === "browser-result")).toHaveLength(1);
    const rerenderedDiscovery = await performRiskDiscovery({ request, basis, dependencies: fakes.dependencies });
    const rerenderedPlan = await buildVerificationPlan({ request, basis, discovery: rerenderedDiscovery, dependencies: fakes.dependencies });
    expect(rerenderedDiscovery).toEqual(discovery);
    expect(rerenderedPlan).toEqual(plan);
    const runFakes = makeDependencies();
    const first = await runVerification({ runId: "mixed-neutral-request-browser", request, dependencies: runFakes.dependencies });
    const executorCalls = runFakes.executorCalls;
    const browserCalls = runFakes.browserCalls;
    expect(executorCalls).toBe(2);
    expect(browserCalls).toBe(1);
    const resumed = await runVerification({ runId: "mixed-neutral-request-browser", dependencies: runFakes.dependencies });
    expect(resumed.documents.discovery).toEqual(first.documents.discovery);
    expect(resumed.documents.plan).toEqual(first.documents.plan);
    expect(runFakes.executorCalls).toBe(executorCalls);
    expect(runFakes.browserCalls).toBe(browserCalls);
  });
  test("validates runtime-emitted evidence with the canonical AJV schema", async () => {
    const fakes = makeDependencies();
    const result = await runOnce(fakes.dependencies, "runtime-ajv");
    const schema = JSON.parse(await Bun.file(`${import.meta.dir}/../../contracts/evidence.schema.json`).text()) as object;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    for (const evidence of result.documents.execution?.evidence ?? []) {
      expect(validate(evidence), validate.errors ? JSON.stringify(validate.errors) : undefined).toBe(true);
    }
  });
  test("validates the saved direct verdict and documents.verdict with the canonical AJV schema", async () => {
    const fakes = makeDependencies();
    const result = await runOnce(fakes.dependencies, "runtime-verdict-ajv");
    const schema = JSON.parse(await Bun.file(`${import.meta.dir}/../../contracts/verdict.schema.json`).text()) as object;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const saved = fakes.repository.stageDocuments.get("runtime-verdict-ajv:verdict");
    expect(saved).toBeDefined();
    for (const verdict of [result.verdict, result.documents.verdict, saved]) {
      expect(validate(verdict), validate.errors ? JSON.stringify(validate.errors) : undefined).toBe(true);
    }
  });

  test.each([
    "release",
    "migration",
    "persistence",
    "destructive operation",
    "production infrastructure",
    "deployment rollout",
    "security",
    "unknown material scope",
  ])("classifies derived %s triggers as R3", async trigger => {
    const request = { ...makeRequest(), testBasis: [{ id: `derived-${trigger.replaceAll(" ", "-")}`, kind: "request" as const, origin: "derived" as const, text: `The change has ${trigger}.` }] } satisfies VerificationRequest;
    const fakes = makeDependencies();
    const basis = await establishTestBasis({ request, dependencies: fakes.dependencies });
    const discovery = await performRiskDiscovery({ request, basis, dependencies: fakes.dependencies });
    expect(discovery.risks[0]?.level).toBe("R3");
  });

  test("rejects malformed persisted stages before use", async () => {
    const fakes = makeDependencies();
    await runOnce(fakes.dependencies);
    const run = fakes.repository.runs.get(RUN_ID);
    if (!run) throw new Error("missing run");
    fakes.repository.runs.set(RUN_ID, { ...run, state: "PLANNED", updatedAt: FIXED_NOW });
    fakes.repository.stageDocuments.set(`${RUN_ID}:basis`, { schemaVersion: "wrong", requestId: REQUEST_ID, snapshotId: SNAPSHOT_ID });
    await expect(runOnce(fakes.dependencies)).rejects.toThrow("invalid persisted basis");
  });
  test.each(["PLANNED", "TERMINAL"] as const)("rejects an extra persisted run key on %s resume before transition, dispatch, or write", async state => {
    const fakes = makeDependencies();
    await runOnce(fakes.dependencies);
    const run = fakes.repository.runs.get(RUN_ID);
    if (!run) throw new Error("missing run");
    fakes.repository.runs.set(RUN_ID, { ...run, state, unexpected: true } as unknown as CanonicalRunState);
    const runWrites = fakes.repository.runWrites.length;
    const stageWrites = fakes.repository.stageWrites.length;
    const executorCalls = fakes.executorCalls;
    await expect(runOnce(fakes.dependencies)).rejects.toThrow("invalid persisted run");
    expect(fakes.repository.runWrites.length).toBe(runWrites);
    expect(fakes.repository.stageWrites.length).toBe(stageWrites);
    expect(fakes.executorCalls).toBe(executorCalls);
  });
  test("rejects unsorted persisted run indexes during repository load", async () => {
    const fakes = makeDependencies();
    await runOnce(fakes.dependencies);
    const run = fakes.repository.runs.get(RUN_ID);
    if (!run || run.observationIds.length < 2) throw new Error("missing indexed terminal run");
    fakes.repository.runs.set(RUN_ID, { ...run, observationIds: [...run.observationIds].reverse() });
    await expect(runOnce(fakes.dependencies)).rejects.toThrow("invalid persisted run");
  });
  test("rejects a persisted basis risk downgrade with unchanged IDs before execution", async () => {
    const request = { ...makeRequest(), testBasis: [{ id: "migration-001", kind: "requirement" as const, origin: "explicit" as const, text: "The production migration is reviewed.", source: "request" }] } satisfies VerificationRequest;
    const fakes = makeDependencies();
    await runVerification({ runId: RUN_ID, request, dependencies: fakes.dependencies });
    const run = fakes.repository.runs.get(RUN_ID);
    const persisted = fakes.repository.stageDocuments.get(`${RUN_ID}:basis`) as { basis: Array<{ id: string; text: string }>; };
    if (!run || !persisted) throw new Error("missing persisted basis");
    const tampered = { ...persisted, basis: persisted.basis.map(item => ({ ...item, text: "A basic check is performed." })) };
    expect(tampered.basis.map(item => item.id)).toEqual(persisted.basis.map(item => item.id));
    fakes.repository.stageDocuments.set(`${RUN_ID}:basis`, tampered);
    fakes.repository.runs.set(RUN_ID, { ...run, state: "PLANNED", updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    await expect(runVerification({ runId: RUN_ID, request, dependencies: fakes.dependencies })).rejects.toThrow("invalid persisted basis");
    expect(fakes.executorCalls).toBe(executorCalls);
  });

  test("rejects a tampered basis on terminal resume before verdict", async () => {
    const fakes = makeDependencies();
    const first = await runOnce(fakes.dependencies);
    const run = fakes.repository.runs.get(RUN_ID);
    const persisted = fakes.repository.stageDocuments.get(`${RUN_ID}:basis`) as { basis: Array<Record<string, unknown>> };
    if (!run || !persisted) throw new Error("missing persisted basis");
    const tampered = { ...persisted, basis: persisted.basis.map(item => ({ ...item, source: "tampered-source" })) };
    fakes.repository.stageDocuments.set(`${RUN_ID}:basis`, tampered);
    const executorCalls = fakes.executorCalls;
    await expect(runVerification({ runId: RUN_ID, request: makeRequest(), dependencies: fakes.dependencies })).rejects.toThrow("invalid persisted basis");
    expect(fakes.executorCalls).toBe(executorCalls);
    expect(first.verdict.qaVerdict).toBe("PASS");
  });
  test.each(["DISCOVERY_COMPLETED", "TERMINAL"] as const)("rejects a persisted discovery risk downgrade with unchanged IDs on %s resume", async state => {
    const request = { ...makeRequest(), testBasis: [{ id: "migration-001", kind: "requirement" as const, origin: "explicit" as const, text: "The production migration is reviewed.", source: "request" }] } satisfies VerificationRequest;
    const fakes = makeDependencies();
    await runVerification({ runId: RUN_ID, request, dependencies: fakes.dependencies });
    const run = fakes.repository.runs.get(RUN_ID);
    const persisted = fakes.repository.stageDocuments.get(`${RUN_ID}:discovery`) as { risks: Array<{ id: string; level: "R1" | "R2" | "R3" }> };
    if (!run || !persisted) throw new Error("missing persisted discovery");
    const tampered = { ...persisted, risks: persisted.risks.map(item => ({ ...item, level: "R1" as const })) };
    expect(tampered.risks.map(item => item.id)).toEqual(persisted.risks.map(item => item.id));
    fakes.repository.stageDocuments.set(`${RUN_ID}:discovery`, tampered);
    fakes.repository.runs.set(RUN_ID, { ...run, state, updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    await expect(runVerification({ runId: RUN_ID, request, dependencies: fakes.dependencies })).rejects.toThrow("invalid persisted discovery canonicalization");
    expect(fakes.executorCalls).toBe(executorCalls);
  });


  test("rejects cross-stage plan references before execution", async () => {
    const fakes = makeDependencies();
    await runOnce(fakes.dependencies);
    const run = fakes.repository.runs.get(RUN_ID);
    const plan = fakes.repository.stageDocuments.get(`${RUN_ID}:plan`) as Record<string, unknown>;
    if (!run || !plan) throw new Error("missing persisted plan");
    const obligations = (plan.obligations as Array<Record<string, unknown>>).map(item => ({ ...item, conditionIds: ["condition:unknown"] }));
    fakes.repository.stageDocuments.set(`${RUN_ID}:plan`, { ...plan, obligations });
    fakes.repository.runs.set(RUN_ID, { ...run, state: "PLANNED", updatedAt: FIXED_NOW });
    await expect(runOnce(fakes.dependencies)).rejects.toThrow("invalid persisted plan reference");
  });

  test("requires persisted request and root identity on resume", async () => {
    const fakes = makeDependencies();
    await runOnce(fakes.dependencies);
    const run = fakes.repository.runs.get(RUN_ID);
    if (!run) throw new Error("missing run");
    fakes.repository.stageDocuments.delete(`${RUN_ID}:request`);
    fakes.repository.runs.set(RUN_ID, { ...run, state: "PLANNED", updatedAt: FIXED_NOW });
    await expect(runOnce(fakes.dependencies)).rejects.toThrow("persisted request");
    const second = makeDependencies();
    await runOnce(second.dependencies);
    const changed = { ...makeRequest(), project: { rootIdentity: "other-repository", snapshotId: SNAPSHOT_ID } };
    await expect(runVerification({ runId: RUN_ID, request: changed, dependencies: second.dependencies })).rejects.toThrow("resume request identity");
  });
  test("rejects a mismatched caller request against an orphaned persisted request before run creation", async () => {
    const fakes = makeDependencies();
    const runId = "orphaned-persisted-request";
    const persisted = makeRequest("orphaned-persisted-request-document");
    const supplied = { ...persisted, change: { summary: "different caller request", paths: ["unexpected/path.ts"] } } satisfies VerificationRequest;
    fakes.repository.stageDocuments.set(`${runId}:request`, persisted);
    const runWrites = fakes.repository.runWrites.length;
    const stageWrites = fakes.repository.stageWrites.length;
    await expect(runVerification({ runId, request: supplied, dependencies: fakes.dependencies })).rejects.toThrow("resume request identity/structural mismatch");
    expect(fakes.repository.runs.has(runId)).toBe(false);
    expect(fakes.repository.runWrites.length).toBe(runWrites);
    expect(fakes.repository.stageWrites.length).toBe(stageWrites);
    expect(fakes.executorCalls).toBe(0);
  });
  test("requires full request equality and rejects changed basis before side effects", async () => {
    const fakes = makeDependencies();
    let artifactCalls = 0;
    let usageCalls = 0;
    const artifactStore: ArtifactStore = { atomicSameKeyIdempotency: true, storeVerificationResultArtifact: async artifact => { artifactCalls++; return artifact; } };
    const usageRecorder: UsageRecorder = { atomicSameKeyIdempotency: true, recordUsage: async () => { usageCalls++; } };
    const dependencies = { ...fakes.dependencies, artifactStore, usageRecorder };
    await runOnce(dependencies);
    const changed = { ...makeRequest(), change: { summary: "changed request B", paths: ["other/path.ts"] }, testBasis: [{ id: "basis-B", kind: "acceptance-criterion" as const, origin: "explicit" as const, text: "A different test basis." }] } satisfies VerificationRequest;
    const executorCalls = fakes.executorCalls;
    const effects = { artifactCalls, usageCalls };
    await expect(runVerification({ runId: RUN_ID, request: changed, dependencies })).rejects.toThrow("resume request identity");
    expect(fakes.executorCalls).toBe(executorCalls);
    expect({ artifactCalls, usageCalls }).toEqual(effects);
    await expect(runVerification({ runId: RUN_ID, dependencies })).resolves.toMatchObject({ run: { state: "TERMINAL" } });
  });
  test("rejects a coordinated request-less persisted rewrite before executor or repository writes", async () => {
    const fakes = makeDependencies();
    const original = await runOnce(fakes.dependencies);
    const originalExecution = fakes.repository.stageDocuments.get(`${RUN_ID}:execution`) as ExecutionDocument;
    if (!originalExecution) throw new Error("missing original execution");
    const rewrittenRequest = { ...makeRequest(), change: { summary: "Apply the database migration release.", paths: ["db/migrations/"] } } satisfies VerificationRequest;
    const rewrittenFakes = makeDependencies();
    const rewritten = await runVerification({ runId: RUN_ID, request: rewrittenRequest, dependencies: rewrittenFakes.dependencies });
    for (const stage of ["request", "basis", "discovery", "plan", "evidence", "residual-risk", "verdict"] as const) {
      const document = rewrittenFakes.repository.stageDocuments.get(`${RUN_ID}:${stage}`);
      if (document === undefined) throw new Error(`missing rewritten ${stage}`);
      fakes.repository.stageDocuments.set(`${RUN_ID}:${stage}`, structuredClone(document));
    }
    const rewrittenExecution = rewrittenFakes.repository.stageDocuments.get(`${RUN_ID}:execution`) as ExecutionDocument;
    if (!rewrittenExecution) throw new Error("missing rewritten execution");
    fakes.repository.stageDocuments.set(`${RUN_ID}:execution`, { ...structuredClone(rewrittenExecution), authorities: structuredClone(originalExecution.authorities) });
    const executorCalls = fakes.executorCalls;
    const stageWrites = fakes.repository.stageWrites.length;
    const runWrites = fakes.repository.runWrites.length;
    await expect(runVerification({ runId: RUN_ID, dependencies: fakes.dependencies })).rejects.toThrow("invalid execution authority binding");
    expect(fakes.executorCalls).toBe(executorCalls);
    expect(fakes.repository.stageWrites.length).toBe(stageWrites);
    expect(fakes.repository.runWrites.length).toBe(runWrites);
    expect(original.verdict.qaVerdict).toBe("PASS");
    expect(rewritten.verdict.qaVerdict).toBe("PASS");
  });

  test("reuses execution checkpoint after saveRun crash without a duplicate executor call", async () => {
    const fakes = makeDependencies();
    fakes.repository.failNextState = "EXECUTING";
    await expect(runOnce(fakes.dependencies)).rejects.toThrow("simulated saveRun crash");

    const calls = fakes.executorCalls;
    const resumed = await runOnce(fakes.dependencies);
    expect(resumed.run.state).toBe("TERMINAL");
    expect(fakes.executorCalls).toBe(calls);
  });
  test("rejects a persisted plan with a truncated risk universe before execution", async () => {
    const fakes = makeDependencies();
    await runOnce(fakes.dependencies);
    const run = fakes.repository.runs.get(RUN_ID);
    const plan = fakes.repository.stageDocuments.get(`${RUN_ID}:plan`) as Record<string, unknown>;
    if (!run || !plan) throw new Error("missing persisted plan");
    fakes.repository.stageDocuments.set(`${RUN_ID}:plan`, { ...plan, risks: (plan.risks as unknown[]).slice(1) });
    fakes.repository.runs.set(RUN_ID, { ...run, state: "PLANNED", updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    await expect(runOnce(fakes.dependencies)).rejects.toThrow("invalid persisted plan universe");
    expect(fakes.executorCalls).toBe(executorCalls);
  });
  test.each(["independence", "evidenceType", "completionCriteria"] as const)("rejects a persisted plan with a tampered obligation %s before execution", async field => {
    const fakes = makeDependencies();
    await runOnce(fakes.dependencies);
    const run = fakes.repository.runs.get(RUN_ID);
    const plan = fakes.repository.stageDocuments.get(`${RUN_ID}:plan`) as Record<string, unknown>;
    if (!run || !plan) throw new Error("missing persisted plan");
    const obligations = (plan.obligations as Array<Record<string, unknown>>).map(item => {
      const obligation = { ...item };
      if (field === "independence") obligation.independence = "self-check";
      if (field === "evidenceType") obligation.evidenceType = "review";
      if (field === "completionCriteria") obligation.completionCriteria = ["tampered completion"];
      return obligation;
    });
    fakes.repository.stageDocuments.set(`${RUN_ID}:plan`, { ...plan, obligations });
    fakes.repository.runs.set(RUN_ID, { ...run, state: "PLANNED", updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    await expect(runOnce(fakes.dependencies)).rejects.toThrow("invalid persisted plan canonicalization");
    expect(fakes.executorCalls).toBe(executorCalls);
  });

  test("rejects PASS-A/FAIL-B swapped claim observations before resumed evaluation", async () => {
    const fakes = makeDependencies();
    let executorCalls = 0;
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => {
      executorCalls++;
      const pass = request.obligation.id === "obligation:condition:basis-001";
      return {
        status: pass ? "PASS" : "FAIL",
        runId: request.runId,
        requestId: request.requestId,
        snapshotId: request.snapshotId,
        idempotencyKey: request.idempotencyKey,
        producer: { kind: "deterministic-verifier", identity: "fixture-executor", independence: "independent-producer" },
        artifacts: [{ type: "verification-result", digest: `${pass ? "a" : "b"}`.repeat(64) }],
        summary: pass ? "PASS A" : "FAIL B",
      };
    }, }
    const dependencies = { ...fakes.dependencies, executor };
    const first = await runOnce(dependencies);
    expect(first.verdict.qaVerdict).toBe("FAIL");
    expect(executorCalls).toBe(2);
    const run = fakes.repository.runs.get(RUN_ID);
    const saved = fakes.repository.stageDocuments.get(`${RUN_ID}:execution`) as { claims: Array<{ obligationId: string; observationIds: readonly string[] }>; [key: string]: unknown };
    if (!run || !saved || saved.claims.length !== 2) throw new Error("missing complete execution");
    const swappedClaims = saved.claims.map((claim, index) => ({ ...claim, observationIds: [saved.claims[(index + 1) % saved.claims.length]!.observationIds[0]!] }));
    fakes.repository.stageDocuments.set(`${RUN_ID}:execution`, { ...saved, claims: swappedClaims });
    fakes.repository.runs.set(RUN_ID, { ...run, state: "EXECUTING", updatedAt: FIXED_NOW });
    await expect(runVerification({ runId: RUN_ID, request: makeRequest(), dependencies })).rejects.toThrow(/invalid .*execution/);
    expect(executorCalls).toBe(2);
  });
  test.each(["requestId", "snapshotId", "producer", "execution", "artifacts", "FAIL verdict", "extra count"] as const)("rejects persisted observation/evidence split-brain for %s before evaluation", async contradiction => {
    const fakes = makeDependencies();
    await runOnce(fakes.dependencies);
    const run = fakes.repository.runs.get(RUN_ID);
    const saved = fakes.repository.stageDocuments.get(`${RUN_ID}:execution`) as ExecutionDocument;
    if (!run || !saved) throw new Error("missing complete execution");
    const evidence = [...saved.evidence];
    const target = evidence[0]!;
    if (contradiction === "requestId") evidence[0] = { ...target, requestId: "wrong-request" };
    if (contradiction === "snapshotId") evidence[0] = { ...target, snapshotId: "wrong-snapshot" };
    if (contradiction === "producer") evidence[0] = { ...target, producer: { ...target.producer, identity: "tampered-producer" } };
    if (contradiction === "execution") evidence[0] = { ...target, execution: { ...target.execution, exitStatus: "failed" } };
    if (contradiction === "artifacts") evidence[0] = { ...target, result: { ...target.result, artifacts: [...(target.result.artifacts ?? []), "b".repeat(64)] } };
    if (contradiction === "FAIL verdict") evidence[0] = { ...target, result: { ...target.result, verdict: "FAIL", passed: undefined, failed: 1 } };
    if (contradiction === "extra count") evidence[0] = { ...target, result: { ...target.result, failed: 1 } };
    const tampered = { ...saved, evidence };
    fakes.repository.stageDocuments.set(`${RUN_ID}:execution`, tampered);
    fakes.repository.runs.set(RUN_ID, { ...run, state: "EXECUTING", updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    await expect(runOnce(fakes.dependencies)).rejects.toThrow();
    expect(fakes.executorCalls).toBe(executorCalls);
  });
  test.each(["EXECUTING", "TERMINAL"] as const)("rejects persisted evidence envelope tampering before writes or redispatch on %s resume", async state => {
    for (const mutation of ["extra key", "invalid contentHash"] as const) {
      const fakes = makeDependencies();
      const runId = `evidence-envelope-${state.toLowerCase()}-${mutation.replace(" ", "-")}`;
      await runOnce(fakes.dependencies, runId);
      const run = fakes.repository.runs.get(runId);
      const saved = fakes.repository.stageDocuments.get(`${runId}:execution`) as ExecutionDocument;
      if (!run || !saved || !saved.evidence[0]) throw new Error("missing complete execution");
      const target = saved.evidence[0];
      const tamperedEvidence = mutation === "extra key"
        ? { ...target, unexpected: true }
        : { ...target, contentHash: "a".repeat(64) };
      fakes.repository.stageDocuments.set(`${runId}:execution`, { ...saved, evidence: [tamperedEvidence, ...saved.evidence.slice(1)] });
      fakes.repository.runs.set(runId, { ...run, state, updatedAt: FIXED_NOW });
      const executorCalls = fakes.executorCalls;
      const stageWrites = fakes.repository.stageWrites.length;
      const runWrites = fakes.repository.runWrites.length;
      await expect(runVerification({ runId, request: makeRequest(), dependencies: fakes.dependencies })).rejects.toThrow(/invalid .*execution/);
      expect(fakes.executorCalls).toBe(executorCalls);
      expect(fakes.repository.stageWrites.length).toBe(stageWrites);
      expect(fakes.repository.runWrites.length).toBe(runWrites);
    }
  });
  test.each(["EXECUTING", "TERMINAL"] as const)("rejects persisted claim tampering before writes or executor redispatch on %s resume", async state => {
    for (const mutation of ["extra key", "empty claim", "altered nonempty claim"] as const) {
      const fakes = makeDependencies();
      const runId = `claim-envelope-${state.toLowerCase()}-${mutation.replaceAll(" ", "-")}`;
      await runOnce(fakes.dependencies, runId);
      const run = fakes.repository.runs.get(runId);
      const saved = fakes.repository.stageDocuments.get(`${runId}:execution`) as ExecutionDocument;
      if (!run || !saved || !saved.claims[0]) throw new Error("missing complete execution");
      const target = saved.claims[0];
      const tamperedClaim = mutation === "extra key"
        ? { ...target, unexpected: true }
        : mutation === "empty claim"
          ? { ...target, claim: "" }
          : { ...target, claim: `${target.claim} tampered` };
      fakes.repository.stageDocuments.set(`${runId}:execution`, { ...saved, claims: [tamperedClaim, ...saved.claims.slice(1)] });
      fakes.repository.runs.set(runId, { ...run, state, updatedAt: FIXED_NOW });
      const executorCalls = fakes.executorCalls;
      const stageWrites = fakes.repository.stageWrites.length;
      const runWrites = fakes.repository.runWrites.length;
      await expect(runVerification({ runId, request: makeRequest(), dependencies: fakes.dependencies })).rejects.toThrow();
      expect(fakes.executorCalls).toBe(executorCalls);
      expect(fakes.repository.stageWrites.length).toBe(stageWrites);
      expect(fakes.repository.runWrites.length).toBe(runWrites);
    }
  });
  test.each(["EXECUTING", "TERMINAL"] as const)("rejects persisted observation envelope tampering before writes or redispatch on %s resume", async state => {
    for (const mutation of ["extra key", "empty actualValues", "nested actual value"] as const) {
      const fakes = makeDependencies();
      const runId = `observation-envelope-${state.toLowerCase()}-${mutation.replaceAll(" ", "-")}`;
      await runOnce(fakes.dependencies, runId);
      const run = fakes.repository.runs.get(runId);
      const saved = fakes.repository.stageDocuments.get(`${runId}:execution`) as ExecutionDocument;
      if (!run || !saved || !saved.observations[0]) throw new Error("missing complete execution");
      const target = saved.observations[0];
      const tamperedObservation = mutation === "extra key"
        ? { ...target, unexpected: true }
        : mutation === "empty actualValues"
          ? { ...target, actualValues: {} }
          : { ...target, actualValues: { result: { value: true } } };
      fakes.repository.stageDocuments.set(`${runId}:execution`, { ...saved, observations: [tamperedObservation, ...saved.observations.slice(1)] });
      fakes.repository.runs.set(runId, { ...run, state, updatedAt: FIXED_NOW });
      const executorCalls = fakes.executorCalls;
      const stageWrites = fakes.repository.stageWrites.length;
      const runWrites = fakes.repository.runWrites.length;
      await expect(runVerification({ runId, request: makeRequest(), dependencies: fakes.dependencies })).rejects.toThrow(/invalid .*execution/);
      expect(fakes.executorCalls).toBe(executorCalls);
      expect(fakes.repository.stageWrites.length).toBe(stageWrites);
      expect(fakes.repository.runWrites.length).toBe(runWrites);
    }
  });
  test.each(["EXECUTING", "TERMINAL"] as const)("rejects persisted observation actualValues before writes or executor redispatch on %s resume", async state => {
    const fakes = makeDependencies();
    const runId = `observation-null-${state.toLowerCase()}`;
    await runOnce(fakes.dependencies, runId);
    const run = fakes.repository.runs.get(runId);
    const saved = fakes.repository.stageDocuments.get(`${runId}:execution`) as ExecutionDocument;
    if (!run || !saved || !saved.observations[0]) throw new Error("missing complete execution");
    const target = saved.observations[0];
    const persistedObservation = { ...target, actualValues: { result: null } };
    fakes.repository.stageDocuments.set(`${runId}:execution`, { ...saved, observations: [persistedObservation, ...saved.observations.slice(1)] });
    fakes.repository.runs.set(runId, { ...run, state, updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    const stageWrites = fakes.repository.stageWrites.length;
    const runWrites = fakes.repository.runWrites.length;
    await expect(runVerification({ runId, request: makeRequest(), dependencies: fakes.dependencies })).rejects.toThrow(/invalid .*execution/);
    expect(fakes.executorCalls).toBe(executorCalls);
    expect(fakes.repository.stageWrites.length).toBe(stageWrites);
    expect(fakes.repository.runWrites.length).toBe(runWrites);
  });
  test.each(["EXECUTING", "TERMINAL"] as const)("rejects persisted observation array actualValues before writes or executor redispatch on %s resume", async state => {
    const fakes = makeDependencies();
    const runId = `observation-array-${state.toLowerCase()}`;
    await runOnce(fakes.dependencies, runId);
    const run = fakes.repository.runs.get(runId);
    const saved = fakes.repository.stageDocuments.get(`${runId}:execution`) as ExecutionDocument;
    if (!run || !saved || !saved.observations[0]) throw new Error("missing complete execution");
    const target = saved.observations[0];
    const persistedObservation = { ...target, actualValues: ["array-value"] } as unknown as typeof target;
    fakes.repository.stageDocuments.set(`${runId}:execution`, { ...saved, observations: [persistedObservation, ...saved.observations.slice(1)] });
    fakes.repository.runs.set(runId, { ...run, state, updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    const stageWrites = fakes.repository.stageWrites.length;
    const runWrites = fakes.repository.runWrites.length;
    await expect(runVerification({ runId, request: makeRequest(), dependencies: fakes.dependencies })).rejects.toThrow(/invalid .*execution/);
    expect(fakes.executorCalls).toBe(executorCalls);
    expect(fakes.repository.stageWrites.length).toBe(stageWrites);
    expect(fakes.repository.runWrites.length).toBe(runWrites);
  });
  test("rejects persisted observation and evidence PASS mutation against fixed FAIL authority before executor recall", async () => {
    const fakes = makeDependencies();
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => ({
      status: "FAIL",
      runId: request.runId,
      requestId: request.requestId,
      snapshotId: request.snapshotId,
      idempotencyKey: request.idempotencyKey,
      producer: { kind: "deterministic-verifier", identity: "fixture-failing-executor", independence: "independent-producer" },
      artifacts: [{ type: "verification-result", digest: "f".repeat(64) }],
    }), }
    const dependencies = { ...fakes.dependencies, executor };
    const runId = "authority-observation-tamper";
    expect((await runOnce(dependencies, runId)).verdict.qaVerdict).toBe("FAIL");
    const run = fakes.repository.runs.get(runId);
    const saved = fakes.repository.stageDocuments.get(`${runId}:execution`) as ExecutionDocument;
    if (!run || !saved) throw new Error("missing persisted execution");
    const targetObservation = saved.observations[0]!;
    const targetEvidence = saved.evidence.find(item => item.obligationId === targetObservation.observationId.slice("observation:".length))!;
    const observations = saved.observations.map(item => item.observationId === targetObservation.observationId ? { ...item, execution: { ...item.execution, exitStatus: "passed" as const } } : item);
    const evidence = saved.evidence.map(item => {
      if (item.evidenceId !== targetEvidence.evidenceId) return item;
      const { failed: _failed, ...passResult } = item.result;
      return { ...item, execution: { ...item.execution, exitStatus: "passed" as const }, result: { ...passResult, verdict: "PASS" as const, passed: 1 } };
    });
    fakes.repository.stageDocuments.set(`${runId}:execution`, { ...saved, observations, evidence });
    fakes.repository.runs.set(runId, { ...run, state: "EXECUTING", updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    await expect(runOnce(dependencies, runId)).rejects.toThrow("invalid execution authority binding");
    expect(fakes.executorCalls).toBe(executorCalls);
  });
  test("rejects persisted evidence observedAt mutation against fixed authority before evaluation", async () => {
    const fakes = makeDependencies();
    const runId = "authority-observed-at-tamper";
    const first = await runOnce(fakes.dependencies, runId);
    expect(first.verdict.qaVerdict).toBe("PASS");
    const run = fakes.repository.runs.get(runId);
    const saved = fakes.repository.stageDocuments.get(`${runId}:execution`) as ExecutionDocument;
    if (!run || !saved) throw new Error("missing persisted execution");
    const target = saved.evidence[0];
    if (!target) throw new Error("missing persisted evidence");
    const evidence = saved.evidence.map(item => item.evidenceId === target.evidenceId ? { ...item, observedAt: "2026-08-03T00:01:00.000Z" } : item);
    fakes.repository.stageDocuments.set(`${runId}:execution`, { ...saved, evidence });
    fakes.repository.runs.set(runId, { ...run, state: "EXECUTING", updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    const writesBeforeResume = fakes.repository.stageWrites.length;
    await expect(runOnce(fakes.dependencies, runId)).rejects.toThrow("invalid execution authority binding");
    expect(fakes.executorCalls).toBe(executorCalls);
    expect(fakes.repository.stageWrites.slice(writesBeforeResume)).not.toContain("evidence");
    expect(fakes.repository.stageWrites.slice(writesBeforeResume)).not.toContain("verdict");
  });
  test("rejects a persisted authority requestDigest mutation before executor recall", async () => {
    const fakes = makeDependencies();
    const runId = "authority-request-digest-tamper";
    await runOnce(fakes.dependencies, runId);
    const run = fakes.repository.runs.get(runId);
    const saved = fakes.repository.stageDocuments.get(`${runId}:execution`) as ExecutionDocument;
    if (!run || !saved || !saved.authorities?.[0]) throw new Error("missing persisted authority");
    const authorities = saved.authorities.map((authority, index) => index === 0 ? { ...authority, binding: { ...authority.binding, requestDigest: "0".repeat(64) } } : authority);
    fakes.repository.stageDocuments.set(`${runId}:execution`, { ...saved, authorities });
    fakes.repository.runs.set(runId, { ...run, state: "EXECUTING", updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    const stageWrites = fakes.repository.stageWrites.length;
    await expect(runVerification({ runId, request: makeRequest(), dependencies: fakes.dependencies })).rejects.toThrow("invalid execution authority binding");
    expect(fakes.executorCalls).toBe(executorCalls);
    expect(fakes.repository.stageWrites.length).toBe(stageWrites);
  });
  test.each([
    ["missing", { missingAuthority: true }],
    ["mismatched", { mismatchedAuthority: true }],
  ] as const)("rejects before saving when execution authority is %s", async (_name, options) => {
    const fakes = makeDependencies(options);
    const runId = `authority-${_name}`;
    await expect(runOnce(fakes.dependencies, runId)).rejects.toThrow(/execution authority/);
    expect(fakes.repository.stageDocuments.has(`${runId}:execution`)).toBe(false);
  });
  test("aborts when an issued execution authority fails verification", async () => {
    const fakes = makeDependencies({ rejectedAuthority: true });
    const runId = "authority-verification-false";
    await expect(runOnce(fakes.dependencies, runId)).rejects.toThrow("execution authority verification failed");
    expect(fakes.authorityCalls).toBe(1);
    expect(fakes.repository.stageDocuments.has(`${runId}:execution`)).toBe(false);
    expect(fakes.repository.runs.get(runId)?.state).toBe("PLANNED");
  });
  test.each([undefined, false] as const)("rejects execution authority without atomic canonical-binding idempotency declaration: %s", async declaration => {
    const fakes = makeDependencies();
    let issueCalls = 0;
    const issueExecutionAuthority = fakes.dependencies.executionAuthority.issueExecutionAuthority!;
    const dependencies = {
      ...fakes.dependencies,
      executionAuthority: {
        ...(declaration === undefined ? {} : { atomicCanonicalBindingIdempotency: declaration }),
        issueExecutionAuthority: async (binding: ExecutionAuthority["binding"]) => {
          issueCalls++;
          return issueExecutionAuthority(binding);
        },
        verifyExecutionAuthority: fakes.dependencies.executionAuthority.verifyExecutionAuthority,
      },
    } as unknown as VerificationRunDependencies;
    await expect(runOnce(dependencies, `execution-authority-binding-idempotency-${String(declaration)}`)).rejects.toThrow("execution authority must declare atomic canonical-binding idempotency");
    expect(issueCalls).toBe(0);
    expect(fakes.executorCalls).toBe(0);
  });
  test("fences a fallback checkpoint after dispatch lease takeover", async () => {
    const repository = new FakeRepository();
    repository.takeoverBeforeExecutionCheckpoint = true;
    const fakes = makeDependencies({ missingCapability: true }, repository);
    const runId = "fallback-checkpoint-takeover";
    await expect(runOnce(fakes.dependencies, runId)).rejects.toThrow("stale dispatch execution checkpoint");
    expect(fakes.executorCalls).toBe(0);
    expect(repository.stageDocuments.has(`${runId}:execution`)).toBe(false);
    expect(repository.runs.get(runId)?.state).toBe("PLANNED");
    const resumed = await runVerification({
      runId,
      dependencies: {
        ...fakes.dependencies,
        dispatchOwnerId: "takeover-winner",
        capabilityProvider: { has: () => true },
        now: () => "2026-08-03T00:01:00.000Z",
      },
    });
    expect(resumed.run.state).toBe("TERMINAL");
    expect(resumed.verdict.qaVerdict).toBe("PASS");
    expect(fakes.executorCalls).toBeGreaterThan(0);
  });
  test.each([
    ["missing capability", { missingCapability: true }, "BLOCKED"],
    ["missing executor output", { missingExecutorOutput: true }, "INCOMPLETE"],
  ] as const)("authenticates and resumes host-generated %s outcomes", async (_name, options, expected) => {
    const fakes = makeDependencies(options);
    const runId = `host-authority-${expected.toLowerCase()}`;
    const first = await runOnce(fakes.dependencies, runId);
    const execution = first.documents.execution;
    if (!execution) throw new Error("missing persisted execution");
    expect(execution.authorities).toHaveLength(execution.evidence.length);
    expect(execution.authorities.every(authority => authority.binding.result.verdict === expected && authority.binding.producer.identity === "self/runtime-unavailable")).toBe(true);
    const executorCalls = fakes.executorCalls;
    const resumed = await runOnce(fakes.dependencies, runId);
    expect(resumed.verdict).toEqual(first.verdict);
    expect(fakes.executorCalls).toBe(executorCalls);
  });

  test.each(["BLOCKED", "INCOMPLETE"] as const)("rejects authenticated FAIL tandem mutation to %s after authority removal", async status => {
    const fakes = makeDependencies();
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => ({
      status: "FAIL",
      runId: request.runId,
      requestId: request.requestId,
      snapshotId: request.snapshotId,
      idempotencyKey: request.idempotencyKey,
      producer: { kind: "deterministic-verifier", identity: "fixture-failing-executor", independence: "independent-producer" },
      artifacts: [{ type: "verification-result", digest: "f".repeat(64) }],
    }), }
    const dependencies = { ...fakes.dependencies, executor };
    const runId = `authority-tandem-${status.toLowerCase()}`;
    await expect(runVerification({ runId, request: makeRequest(), dependencies })).resolves.toMatchObject({ verdict: { qaVerdict: "FAIL" } });
    const run = fakes.repository.runs.get(runId);
    const saved = fakes.repository.stageDocuments.get(`${runId}:execution`) as ExecutionDocument;
    if (!run || !saved) throw new Error("missing persisted execution");
    const target = saved.evidence[0];
    if (!target) throw new Error("missing persisted evidence");
    const targetObservationId = `observation:${target.obligationId}`;
    const targetExecution = { ...target.execution, exitStatus: status === "BLOCKED" ? "blocked" as const : "cancelled" as const };
    const { passed: _passed, failed: _failed, ...resultWithoutCounts } = target.result;
    const result = { ...resultWithoutCounts, verdict: status };
    const execution: ExecutionDocument = {
      ...saved,
      observations: saved.observations.map(observation => observation.observationId === targetObservationId ? { ...observation, execution: targetExecution } : observation),
      evidence: saved.evidence.map(item => item.evidenceId === target.evidenceId ? { ...item, execution: targetExecution, result } : item),
      authorities: saved.authorities.filter(authority => authority.binding.obligationId !== target.obligationId),
    };
    fakes.repository.stageDocuments.set(`${runId}:execution`, execution);
    fakes.repository.runs.set(runId, { ...run, state: "PLANNED", updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    await expect(runOnce(fakes.dependencies, runId)).rejects.toThrow("invalid execution authority binding");
    expect(fakes.executorCalls).toBe(executorCalls);
  });

  test("resumes VERDICT_RESOLVED with exact canonical indexes and saves TERMINAL without executor recall", async () => {
    const fakes = makeDependencies();
    const runId = "canonical-preterminal-indexes";
    const first = await runOnce(fakes.dependencies, runId);
    const persisted = fakes.repository.runs.get(runId);
    const execution = first.documents.execution;
    const evidence = first.documents.evidence;
    if (!persisted || !execution || !evidence) throw new Error("missing canonical documents");
    const executorCalls = fakes.executorCalls;
    const runWritesBeforeResume = fakes.repository.runWrites.length;
    fakes.repository.runs.set(runId, { ...persisted, state: "VERDICT_RESOLVED", updatedAt: FIXED_NOW });
    const resumed = await runOnce(fakes.dependencies, runId);
    expect(resumed.run.state).toBe("TERMINAL");
    expect(resumed.run.observationIds).toEqual(execution.observations.map(item => item.observationId));
    expect(resumed.run.claimIds).toEqual(execution.claims.map(item => item.claimId));
    expect(resumed.run.evaluationIds).toEqual(evidence.evaluations.map(item => item.evaluationId));
    expect(fakes.repository.runWrites.slice(runWritesBeforeResume).map(run => run.state)).toEqual(["TERMINAL"]);
    expect(fakes.executorCalls).toBe(executorCalls);
  });

  test.each([
    ["observationIds", "foreign"], ["observationIds", "missing"], ["observationIds", "extra"], ["observationIds", "reordered"],
    ["claimIds", "foreign"], ["claimIds", "missing"], ["claimIds", "extra"], ["claimIds", "reordered"],
    ["evaluationIds", "foreign"], ["evaluationIds", "missing"], ["evaluationIds", "extra"], ["evaluationIds", "reordered"],
  ] as const)("rejects %s %s mutation before terminal transition or executor recall", async (field, mutation) => {
    const fakes = makeDependencies();
    const runId = `run-index-${field}-${mutation}`;
    await runOnce(fakes.dependencies, runId);
    const run = fakes.repository.runs.get(runId);
    if (!run) throw new Error("missing run");
    const ids = field === "observationIds" ? [...run.observationIds] : field === "claimIds" ? [...run.claimIds] : [...run.evaluationIds];
    const mutated = mutation === "foreign"
      ? ids.map((id, index) => index === 0 ? `${id}:foreign` : id)
      : mutation === "missing"
        ? ids.slice(1)
        : mutation === "extra"
          ? [...ids, `${field}:extra`]
          : [...ids].reverse();
    fakes.repository.runs.set(runId, { ...run, state: "VERDICT_RESOLVED", [field]: mutated, updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    const runWritesBeforeResume = fakes.repository.runWrites.length;
    await expect(runOnce(fakes.dependencies, runId)).rejects.toThrow(/invalid persisted run(?: indexes)?/);
    expect(fakes.repository.runs.get(runId)?.state).toBe("VERDICT_RESOLVED");
    expect(fakes.repository.runWrites.length).toBe(runWritesBeforeResume);
    expect(fakes.executorCalls).toBe(executorCalls);
  });


  test("verifies persisted authority on terminal resume without executor recall", async () => {
    const fakes = makeDependencies();
    const first = await runOnce(fakes.dependencies, "authority-terminal");
    expect(first.verdict.qaVerdict).toBe("PASS");
    const executorCalls = fakes.executorCalls;
    const authorityCalls = fakes.authorityCalls;
    const resumed = await runOnce(fakes.dependencies, "authority-terminal");
    expect(resumed.verdict).toEqual(first.verdict);
    expect(fakes.executorCalls).toBe(executorCalls);
    expect(fakes.authorityCalls).toBeGreaterThan(authorityCalls);
  });
  test("rejects a tampered accepted evaluation before executor dispatch", async () => {
    const fakes = makeDependencies();
    const runId = "evidence-evaluation-tamper";
    await runOnce(fakes.dependencies, runId);
    const run = fakes.repository.runs.get(runId);
    const saved = fakes.repository.stageDocuments.get(`${runId}:evidence`) as Record<string, unknown>;
    if (!run || !saved) throw new Error("missing persisted evidence");
    const evaluations = (saved.evaluations as Array<Record<string, unknown>>).map((evaluation, index) => index === 0 ? { ...evaluation, status: "REJECTED" } : evaluation);
    fakes.repository.stageDocuments.set(`${runId}:evidence`, { ...saved, evaluations });
    fakes.repository.runs.set(runId, { ...run, state: "EVIDENCE_EVALUATED", updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    await expect(runOnce(fakes.dependencies, runId)).rejects.toThrow();
    expect(fakes.executorCalls).toBe(executorCalls);
  });
  test.each(["EVIDENCE_EVALUATED", "TERMINAL"] as const)("rejects a persisted REJECTED evaluation checks.fresh mutation before %s resume issuer side effects", async state => {
    const fakes = makeDependencies();
    const runId = `freshness-evaluation-fresh-tamper-${state.toLowerCase()}`;
    let issueCalls = 0;
    const issueFreshnessAuthority = fakes.dependencies.freshnessAuthority.issueFreshnessAuthority!;
    const verifyFreshnessAuthority = fakes.dependencies.freshnessAuthority.verifyFreshnessAuthority!;
    const dependencies = {
      ...fakes.dependencies,
      freshnessPolicy: { evaluateFreshness: async () => "stale" as const },
      freshnessAuthority: {
        atomicSameKeyIdempotency: true as const,
        issueFreshnessAuthority: async (binding: FreshnessAuthority["binding"]) => {
          issueCalls++;
          return issueFreshnessAuthority(binding);
        },
        verifyFreshnessAuthority,
      },
    } as unknown as VerificationRunDependencies;
    const first = await runOnce(dependencies, runId);
    const run = fakes.repository.runs.get(runId);
    const saved = fakes.repository.stageDocuments.get(`${runId}:evidence`) as Record<string, unknown>;
    if (!run || !saved) throw new Error("missing persisted evidence");
    const evaluations = (saved.evaluations as Array<Record<string, unknown>>).map((evaluation, index) => index === 0
      ? { ...evaluation, checks: { ...(evaluation.checks as Record<string, boolean>), fresh: true } }
      : evaluation);
    fakes.repository.stageDocuments.set(`${runId}:evidence`, { ...saved, evaluations });
    fakes.repository.runs.set(runId, { ...run, state, updatedAt: FIXED_NOW });
    issueCalls = 0;
    const runWritesBeforeResume = fakes.repository.runWrites.length;
    await expect(runOnce(dependencies, runId)).rejects.toThrow("invalid persisted evidence evaluation digest");
    expect(fakes.repository.runs.get(runId)?.state).toBe(state);
    expect(fakes.repository.runWrites.length).toBe(runWritesBeforeResume);
    expect(issueCalls).toBe(0);
    expect(first.run.state).toBe("TERMINAL");
  });
  test.each(["add", "remove"] as const)("rejects a persisted STALE_EVIDENCE %s mutation before terminal resume issuer side effects", async mutation => {
    const fakes = makeDependencies(mutation === "add" ? { producerKind: "harness-managed", producerIndependence: "separate-verification-context" } : {});
    const runId = `freshness-stale-reason-${mutation}`;
    let issueCalls = 0;
    const issueFreshnessAuthority = fakes.dependencies.freshnessAuthority.issueFreshnessAuthority!;
    const verifyFreshnessAuthority = fakes.dependencies.freshnessAuthority.verifyFreshnessAuthority!;
    const dependencies = {
      ...fakes.dependencies,
      freshnessPolicy: { evaluateFreshness: async () => mutation === "add" ? "fresh" as const : "stale" as const },
      freshnessAuthority: {
        atomicSameKeyIdempotency: true as const,
        issueFreshnessAuthority: async (binding: FreshnessAuthority["binding"]) => {
          issueCalls++;
          return issueFreshnessAuthority(binding);
        },
        verifyFreshnessAuthority,
      },
    } as unknown as VerificationRunDependencies;
    await runOnce(dependencies, runId);
    const run = fakes.repository.runs.get(runId);
    const saved = fakes.repository.stageDocuments.get(`${runId}:evidence`) as Record<string, unknown>;
    if (!run || !saved) throw new Error("missing persisted evidence");
    const evaluations = (saved.evaluations as Array<Record<string, unknown>>).map((evaluation, index) => {
      if (index !== 0) return evaluation;
      const rejectionReasons = [...(evaluation.rejectionReasons as string[])];
      return { ...evaluation, rejectionReasons: mutation === "add" ? [...rejectionReasons, "STALE_EVIDENCE"] : rejectionReasons.filter(reason => reason !== "STALE_EVIDENCE") };
    });
    fakes.repository.stageDocuments.set(`${runId}:evidence`, { ...saved, evaluations });
    fakes.repository.runs.set(runId, { ...run, state: "TERMINAL", updatedAt: FIXED_NOW });
    issueCalls = 0;
    const runWritesBeforeResume = fakes.repository.runWrites.length;
    await expect(runOnce(dependencies, runId)).rejects.toThrow("invalid persisted evidence evaluation digest");
    expect(fakes.repository.runs.get(runId)?.state).toBe("TERMINAL");
    expect(fakes.repository.runWrites.length).toBe(runWritesBeforeResume);
    expect(issueCalls).toBe(0);
  });
  test("rejects a material residual defect inserted after failed verdict save", async () => {
    const fakes = makeDependencies();
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => ({
      status: "FAIL",
      runId: request.runId,
      requestId: request.requestId,
      snapshotId: request.snapshotId,
      idempotencyKey: request.idempotencyKey,
      producer: { kind: "deterministic-verifier", identity: "fixture-failing-executor", independence: "independent-producer" },
      artifacts: [{ type: "verification-result", digest: "f".repeat(64) }],
    }), }
    const dependencies = { ...fakes.dependencies, executor };
    const runId = "residual-risk-tamper";
    const first = await runOnce(dependencies, runId);
    expect(first.verdict.qaVerdict).toBe("FAIL");
    const run = fakes.repository.runs.get(runId);
    const saved = fakes.repository.stageDocuments.get(`${runId}:residual-risk`) as Record<string, unknown>;
    if (!run || !saved) throw new Error("missing persisted residual risk");
    fakes.repository.stageDocuments.set(`${runId}:residual-risk`, { ...saved, defects: [{ id: "defect:tampered" }] });
    fakes.repository.runs.set(runId, { ...run, state: "VERDICT_RESOLVED", updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    await expect(runOnce(dependencies, runId)).rejects.toThrow("invalid persisted residual-risk canonicalization");
    expect(fakes.executorCalls).toBe(executorCalls);
  });


  test("validates direct verdict identity on terminal and verdict-resolved resume", async () => {
    const fakes = makeDependencies();
    const first = await runOnce(fakes.dependencies);
    const saved = fakes.repository.stageDocuments.get(`${RUN_ID}:verdict`) as Record<string, unknown>;
    const rerun = await runVerification({ runId: RUN_ID, request: makeRequest(), dependencies: fakes.dependencies });
    expect(rerun.verdict).toEqual(first.verdict);
    fakes.repository.stageDocuments.set(`${RUN_ID}:verdict`, { ...saved, requestId: "wrong-request" });
    await expect(runOnce(fakes.dependencies)).rejects.toThrow("invalid persisted verdict stage");
    fakes.repository.stageDocuments.set(`${RUN_ID}:verdict`, saved);
    const run = fakes.repository.runs.get(RUN_ID);
    if (!run) throw new Error("missing run");
    fakes.repository.runs.set(RUN_ID, { ...run, state: "VERDICT_RESOLVED", updatedAt: FIXED_NOW });
    fakes.repository.stageDocuments.set(`${RUN_ID}:verdict`, { ...saved, snapshotId: "wrong-snapshot" });
    await expect(runOnce(fakes.dependencies)).rejects.toThrow("invalid persisted verdict stage");
  });

  test.each(["TERMINAL", "VERDICT_RESOLVED"] as const)("rejects a tampered direct verdict payload on %s resume", async state => {
    const fakes = makeDependencies({ missingExecutorOutput: true });
    await runOnce(fakes.dependencies);
    const run = fakes.repository.runs.get(RUN_ID);
    const saved = fakes.repository.stageDocuments.get(`${RUN_ID}:verdict`) as Record<string, unknown>;
    if (!run) throw new Error("missing run");
    fakes.repository.runs.set(RUN_ID, { ...run, state, updatedAt: FIXED_NOW });
    fakes.repository.stageDocuments.set(`${RUN_ID}:verdict`, { ...saved, qaVerdict: "PASS" });
    const executorCalls = fakes.executorCalls;
    await expect(runOnce(fakes.dependencies)).rejects.toThrow("invalid persisted verdict canonicalization");
    expect(fakes.executorCalls).toBe(executorCalls);
  });

  test("persists one checkpoint per obligation and retries after a failed executor claim", async () => {
    const fakes = makeDependencies();
    const seen: string[] = [];
    const original = fakes.dependencies.executor.executeObligation;
    let throwOnSecond = true;
    const flakyExecutor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => {
      seen.push(request.obligation.id);
      if (throwOnSecond && seen.length === 2) { throwOnSecond = false; throw new Error("second obligation failed"); }
      return original ? original(request) : undefined;
    }, }
    const dependencies = { ...fakes.dependencies, executor: flakyExecutor };
    await expect(runOnce(dependencies)).rejects.toThrow("second obligation failed");
    const checkpoint = fakes.repository.stageDocuments.get(`${RUN_ID}:execution`) as { claims: readonly { obligationId: string }[] };
    expect(checkpoint.claims).toHaveLength(1);
    expect(seen).toHaveLength(2);
    const resumed = await runOnce(dependencies);
    expect(resumed.run.state).toBe("TERMINAL");
    expect(seen).toHaveLength(3);
    expect(seen[2]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[0]);
  });

  test("saves the completed checkpoint before fallible usage recording", async () => {
    const fakes = makeDependencies();
    let artifactStores = 0;
    const artifactStore: ArtifactStore = {
      atomicSameKeyIdempotency: true,
      storeVerificationResultArtifact: async artifact => { artifactStores++; return artifact; },
    };
    let executionUsageCalls = 0;
    let throwOnce = true;
    const usageRecorder: UsageRecorder = {
      atomicSameKeyIdempotency: true,
      recordUsage: async event => {
        if (event.event === "execution") {
          executionUsageCalls++;
          if (throwOnce) { throwOnce = false; throw new Error("usage recorder failed"); }
        }
      },
    };
    const dependencies = { ...fakes.dependencies, artifactStore, usageRecorder };
    await expect(runOnce(dependencies)).rejects.toThrow("usage recorder failed");
    const checkpoint = fakes.repository.stageDocuments.get(`${RUN_ID}:execution`) as { claims: readonly { obligationId: string }[] };
    expect(checkpoint.claims).toHaveLength(1);
    const executorCalls = fakes.executorCalls;
    const artifactCalls = artifactStores;
    const resumed = await runOnce(dependencies);
    expect(resumed.run.state).toBe("TERMINAL");
    expect(fakes.executorCalls).toBe(executorCalls + 1);
    expect(artifactStores).toBe(artifactCalls + 1);
    expect(executionUsageCalls).toBe(3);
  });
  test("retries durable artifact and execution usage keys without recalling a completed executor", async () => {
    const fakes = makeDependencies();
    const request = { ...makeRequest(), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const events: UsageEvent[] = [];
    const committed = new Map<string, UsageEvent>();
    let throwOnce = true;
    const usageRecorder: UsageRecorder = {
      atomicSameKeyIdempotency: true,
      recordUsage: async event => {
        if (!event.eventKey) throw new Error("usage event missing key");
        const previous = committed.get(event.eventKey);
        if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error("usage event key payload changed");
        committed.set(event.eventKey, event);
        events.push(event);
        if (event.event === "execution" && throwOnce) { throwOnce = false; throw new Error("usage recorder failed once"); }
      },
    };
    const dependencies = { ...fakes.dependencies, usageRecorder };
    await expect(runVerification({ runId: "usage-outbox", request, dependencies })).rejects.toThrow("usage recorder failed once");
    expect(fakes.executorCalls).toBe(1);
    const checkpoint = fakes.repository.stageDocuments.get("usage-outbox:execution") as ExecutionDocument;
    expect(checkpoint.usageOutbox?.length).toBeGreaterThan(0);
    const pendingExecution = checkpoint.usageOutbox?.find(entry => entry.event === "execution");
    expect(pendingExecution?.event).toBe("execution");
    const resumed = await runVerification({ runId: "usage-outbox", dependencies });
    expect(resumed.run.state).toBe("TERMINAL");
    expect(fakes.executorCalls).toBe(1);
    const artifactEvents = events.filter(event => event.event === "artifact");
    const executionEvents = events.filter(event => event.event === "execution");
    expect(artifactEvents).toHaveLength(1);
    expect(executionEvents).toHaveLength(2);
    expect(artifactEvents[0]?.eventKey).toBeTruthy();
    expect(executionEvents[0]?.eventKey).toBe(executionEvents[1]?.eventKey);
    expect(executionEvents[0]?.eventKey).toBe(pendingExecution?.eventKey);
    expect(executionEvents[0]?.executionKey).toBe(executionEvents[1]?.executionKey);
    expect(committed.size).toBe(2);
  });

  test("keeps a pending usage outbox non-terminal without a recorder and flushes it after recorder restoration", async () => {
    const fakes = makeDependencies();
    const request = { ...makeRequest(), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const runId = "usage-outbox-recorder-omitted";
    const initialEvents: UsageEvent[] = [];
    let failOnce = true;
    const failingRecorder: UsageRecorder = {
      atomicSameKeyIdempotency: true,
      recordUsage: async event => {
        initialEvents.push(event);
        if (event.event === "execution" && failOnce) { failOnce = false; throw new Error("usage recorder failed before resume"); }
      },
    };
    const initialDependencies = { ...fakes.dependencies, usageRecorder: failingRecorder };
    await expect(runVerification({ runId, request, dependencies: initialDependencies })).rejects.toThrow("usage recorder failed before resume");
    const checkpoint = fakes.repository.stageDocuments.get(`${runId}:execution`) as ExecutionDocument;
    expect(checkpoint.usageOutbox?.length).toBeGreaterThan(0);
    const executorCalls = fakes.executorCalls;

    const omittedDependencies = { ...initialDependencies, usageRecorder: undefined };
    await expect(runVerification({ runId, dependencies: omittedDependencies })).rejects.toThrow("usage recorder is required to flush pending usage outbox");
    expect(fakes.repository.runs.get(runId)?.state).toBe("PLANNED");
    expect(fakes.executorCalls).toBe(executorCalls);

    const restoredEvents: UsageEvent[] = [];
    const restoredDependencies = { ...omittedDependencies, usageRecorder: { atomicSameKeyIdempotency: true, recordUsage: async (event: UsageEvent) => { restoredEvents.push(event); } } satisfies UsageRecorder };
    const resumed = await runVerification({ runId, dependencies: restoredDependencies });
    expect(resumed.run.state).toBe("TERMINAL");
    expect(fakes.executorCalls).toBe(executorCalls);
    expect(restoredEvents.length).toBeGreaterThan(0);
    expect(restoredEvents.some(event => event.eventKey === checkpoint.usageOutbox?.find(entry => entry.event === "execution")?.eventKey)).toBe(true);
    expect((fakes.repository.stageDocuments.get(`${runId}:execution`) as ExecutionDocument).usageOutbox).toHaveLength(0);
    expect(initialEvents.filter(event => event.event === "artifact")).toHaveLength(1);
  });

  test("rejects a usage outbox execution key bound to a foreign run before external dispatch", async () => {
    const fakes = makeDependencies();
    const request = { ...makeRequest(), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const runId = "usage-outbox-run-binding";
    let failOnce = true;
    const usageRecorder: UsageRecorder = {
      atomicSameKeyIdempotency: true,
      recordUsage: async event => {
        if (event.event === "execution" && failOnce) { failOnce = false; throw new Error("usage recorder failed for tamper fixture"); }
      },
    };
    const dependencies = { ...fakes.dependencies, usageRecorder };
    await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("usage recorder failed for tamper fixture");
    const checkpoint = fakes.repository.stageDocuments.get(`${runId}:execution`) as ExecutionDocument;
    const pending = checkpoint.usageOutbox?.[0];
    if (!pending) throw new Error("expected a pending usage outbox entry");
    const foreignEntry = { ...pending, executionKey: `verification:${"0".repeat(64)}`, eventKey: "tampered-event-key" };
    fakes.repository.stageDocuments.set(`${runId}:execution`, { ...checkpoint, usageOutbox: [foreignEntry] });
    const executorCalls = fakes.executorCalls;
    await expect(runVerification({ runId, dependencies })).rejects.toThrow(/invalid .*usage outbox/);
    expect(fakes.executorCalls).toBe(executorCalls);
  });
  test("reuses one deterministic idempotency side effect when artifact storage fails after external completion", async () => {
    const fakes = makeDependencies();
    const requests: string[] = [];
    const sideEffects = new Map<string, number>();
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => {
      requests.push(request.idempotencyKey);
      if (!sideEffects.has(request.idempotencyKey)) sideEffects.set(request.idempotencyKey, 1);
      return { status: "PASS", runId: request.runId, requestId: request.requestId, snapshotId: request.snapshotId, idempotencyKey: request.idempotencyKey, producer: { kind: "deterministic-verifier", identity: "deduplicating-executor", independence: "independent-producer" }, artifacts: [{ type: "verification-result", digest: "d".repeat(64) }] };
    }, }
    let throwOnce = true;
    const artifactStore: ArtifactStore = {
      atomicSameKeyIdempotency: true,
      storeVerificationResultArtifact: async artifact => {
        if (throwOnce) { throwOnce = false; throw new Error("artifact storage failed after external completion"); }
        return artifact;
      },
    };
    const dependencies = { ...fakes.dependencies, executor, artifactStore };
    await expect(runOnce(dependencies)).rejects.toThrow("artifact storage failed after external completion");
    await expect(runOnce(dependencies)).resolves.toMatchObject({ run: { state: "TERMINAL" } });
    expect(requests).toHaveLength(3);
    expect(requests[0]).toBe(requests[1]);
    expect(requests[2]).not.toBe(requests[0]);
    expect(new Set(requests).size).toBe(2);
    expect([...sideEffects.values()].every(count => count === 1)).toBe(true);
  });

  test.each(["PASS", "FAIL"] as const)("reuses the authenticated authority binding after checkpoint save failure with an advancing clock for %s", async status => {
    const fakes = makeDependencies();
    fakes.repository.failNextStage = "execution";
    const request = { ...makeRequest(`authority-replay-${status}`), testBasis: [makeRequest().testBasis[0]!] };
    const runId = `authority-replay-${status}`;
    let now = FIXED_NOW;
    let executorCalls = 0;
    const requests: string[] = [];
    const sideEffects = new Map<string, number>();
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async executionRequest => {
      executorCalls++;
      requests.push(executionRequest.idempotencyKey);
      if (!sideEffects.has(executionRequest.idempotencyKey)) sideEffects.set(executionRequest.idempotencyKey, 1);
      return { status, runId: executionRequest.runId, requestId: executionRequest.requestId, snapshotId: executionRequest.snapshotId, idempotencyKey: executionRequest.idempotencyKey, producer: { kind: "deterministic-verifier", identity: "deduplicating-executor", independence: "independent-producer" }, artifacts: [{ type: "verification-result", digest: "e".repeat(64) }] };
    }, }
    const authorities = new Map<string, ExecutionAuthority>();
    const issuedBindings: ExecutionAuthority["binding"][] = [];
    const executionAuthority = {
      atomicCanonicalBindingIdempotency: true as const,
      issueExecutionAuthority: async (binding: ExecutionAuthority["binding"]): Promise<ExecutionAuthority> => {
        issuedBindings.push(structuredClone(binding));
        const key = JSON.stringify(binding);
        const existing = authorities.get(key);
        if (existing) return existing;
        const authority: ExecutionAuthority = { schemaVersion: "verification-execution-authority/v1", authorityId: `authority:${binding.obligationId}`, issuer: "deduplicating-authority", binding: structuredClone(binding) };
        authorities.set(key, authority);
        return authority;
      },
      verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: ExecutionAuthority["binding"]): Promise<boolean> => {
        const stored = authorities.get(JSON.stringify(binding));
        return Boolean(stored && JSON.stringify(stored) === JSON.stringify(authority) && JSON.stringify(stored.binding) === JSON.stringify(binding));
      },
    };
    const dependencies = { ...fakes.dependencies, executor, executionAuthority, now: () => now };
    await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("simulated saveStage crash");
    const original = issuedBindings[0];
    if (!original) throw new Error("missing original authority binding");
    now = "2026-08-03T00:00:10.000Z";
    const resumed = await runVerification({ runId, dependencies });
    expect(resumed.run.state).toBe("TERMINAL");
    expect(resumed.verdict.qaVerdict).toBe(status);
    expect(executorCalls).toBe(1);
    expect(requests).toHaveLength(1);
    expect([...sideEffects.values()]).toEqual([1]);
    const persisted = resumed.documents.execution;
    const authority = persisted?.authorities?.[0];
    const observation = persisted?.observations[0];
    const evidence = persisted?.evidence[0];
    expect(authority?.binding.execution.startedAt).toBe(original.execution.startedAt);
    expect(authority?.binding.execution.finishedAt).toBe(original.execution.finishedAt);
    expect(authority?.binding.observedAt).toBe(original.observedAt);
    expect(observation?.execution).toEqual(original.execution);
    expect(evidence?.observedAt).toBe(original.observedAt);
  });


  test("keeps fallback dispatch ownership until the execution checkpoint commits", async () => {
    const fakes = makeDependencies({ missingCapability: true });
    const events: string[] = [];
    const commitTransition = fakes.repository.commitTransition.bind(fakes.repository);
    fakes.repository.commitTransition = async transition => {
      if (transition.stage === "execution") events.push("checkpoint");
      return commitTransition(transition);
    };
    const releaseExecutionDispatch = fakes.repository.releaseExecutionDispatch.bind(fakes.repository);
    fakes.repository.releaseExecutionDispatch = async (claim, now) => {
      events.push("release");
      return releaseExecutionDispatch(claim, now);
    };
    const result = await runOnce(fakes.dependencies, "fallback-claim-order");
    expect(result.documents.execution?.evidence.every(item => item.result.verdict === "BLOCKED")).toBe(true);
    expect(events).toContain("release");
    let checkpointCommitted = false;
    for (const event of events) {
      if (event === "checkpoint") checkpointCommitted = true;
      if (event === "release") {
        expect(checkpointCommitted).toBe(true);
        checkpointCommitted = false;
      }
    }
  });

  test("uses canonical unavailable provenance while preserving rejected evidence checks", async () => {
    const fakes = makeDependencies({ missingExecutorOutput: true });
    const result = await runOnce(fakes.dependencies);
    for (const observation of result.documents.execution?.observations ?? []) {
      expect(observation.requestId).toBe(REQUEST_ID);
      expect(observation.snapshotId).toBe(SNAPSHOT_ID);
      expect(observation.producer.identity).toBe("self/runtime-unavailable");
      expect(observation.producer.independence).toBe("self-check");
    }
    expect(result.documents.evidence?.evaluations.every(item => !item.checks.expectedResultDemonstrated && !item.checks.artifactRequirementsSatisfied)).toBe(true);
    expect(result.verdict.qaVerdict).not.toBe("PASS");
  });

  test("routes browser-only missing output to browser executor without invoking generic executor", async () => {
    const request = { ...makeRequest(), testBasis: [{ id: "browser-only", kind: "acceptance-criterion" as const, origin: "explicit" as const, text: "The browser flow renders." }] } satisfies VerificationRequest;
    const fakes = makeDependencies({ missingBrowserOutput: true });
    const result = await runVerification({ runId: "browser-missing-output", request, dependencies: fakes.dependencies });
    expect(fakes.browserCalls).toBe(1);
    expect(fakes.executorCalls).toBe(0);
    expect(result.verdict.qaVerdict).not.toBe("PASS");
  });
  test("serializes repeated same-run calls and releases run locks without double dispatch", async () => {
    const fakes = makeDependencies();
    const [first, second] = await Promise.all([runOnce(fakes.dependencies, "concurrent-run"), runOnce(fakes.dependencies, "concurrent-run")]);
    expect(first.verdict).toEqual(second.verdict);
    expect(fakes.executorCalls).toBe(first.documents.execution?.observations.length ?? 0);
    expect(fakes.repository.runs.get("concurrent-run")?.state).toBe("TERMINAL");
    expect(getVerificationRunLockCount(fakes.dependencies.repository)).toBe(0);
    await runOnce(fakes.dependencies, "concurrent-run");
    await runOnce(fakes.dependencies, "concurrent-run");
    expect(getVerificationRunLockCount(fakes.dependencies.repository)).toBe(0);
  });
  test("keeps concurrent same-run calls serialized while the first call is in flight", async () => {
    const fakes = makeDependencies();
    const runId = "concurrent-in-flight-run";
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let calls = 0;
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => {
      calls++;
      if (calls === 1) {
        markFirstStarted();
        await firstGate;
      }
      return fakes.dependencies.executor.executeObligation!(request);
    }, }
    const dependencies = { ...fakes.dependencies, executor };
    const first = runOnce(dependencies, runId);
    await firstStarted;
    const second = runOnce(dependencies, runId);
    expect(getVerificationRunLockCount(dependencies.repository)).toBe(1);
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.verdict).toEqual(secondResult.verdict);
    expect(getVerificationRunLockCount(dependencies.repository)).toBe(0);
  });

  test("fails closed on a partial dispatch claim facility before claim or executor calls", async () => {
    const fakes = makeDependencies();
    let claimCalls = 0;
    const partialRepository: RepositoryPort = {
      loadRun: fakes.repository.loadRun.bind(fakes.repository),
      loadStageDocument: fakes.repository.loadStageDocument.bind(fakes.repository),
      commitTransition: fakes.repository.commitTransition.bind(fakes.repository),
      claimExecutionDispatch: async (...args) => {
        claimCalls++;
        return fakes.repository.claimExecutionDispatch(...args);
      },
    };
    const dependencies = { ...fakes.dependencies, repository: partialRepository };
    await expect(runOnce(dependencies, "partial-dispatch-facility")).rejects.toThrow("dispatch claim facility must provide claim, complete, and release");
    expect(claimCalls).toBe(0);
    expect(fakes.executorCalls).toBe(0);
  });
  test("releases an owned claim when capability lookup rejects and permits an immediate retry", async () => {
    const fakes = makeDependencies();
    const runId = "preflight-capability-retry";
    const request = { ...makeRequest(), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    let rejecting = true;
    let capabilityCalls = 0;
    const dependencies = {
      ...fakes.dependencies,
      capabilityProvider: {
        hasCapability: async () => {
          capabilityCalls++;
          if (rejecting) throw new Error("capability lookup failed");
          return true;
        },
      },
    } as unknown as VerificationRunDependencies;
    await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("capability lookup failed");
    expect(fakes.repository.dispatchClaims.size).toBe(0);
    expect(fakes.executorCalls).toBe(0);
    rejecting = false;
    const resumed = await runVerification({ runId, dependencies });
    expect(resumed.run.state).toBe("TERMINAL");
    expect(resumed.verdict.qaVerdict).toBe("PASS");
    expect(capabilityCalls).toBe(2);
    expect(fakes.executorCalls).toBe(1);
  });
  test.each(["missing", "non-atomic"] as const)("releases an owned claim on %s executor preflight failure and permits an immediate retry", async mode => {
    const fakes = makeDependencies();
    const runId = `preflight-executor-${mode}-retry`;
    const request = { ...makeRequest(), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    let invalidExecutorCalls = 0;
    const invalidExecutor = (mode === "missing"
      ? {}
      : {
        atomicSameKeyIdempotency: false,
        executeObligation: async () => {
          invalidExecutorCalls++;
          return undefined;
        },
      }) as unknown as VerificationExecutor;
    const dependencies = { ...fakes.dependencies, executor: invalidExecutor };
    await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("executor must declare atomic same-key idempotency");
    expect(fakes.repository.dispatchClaims.size).toBe(0);
    expect(invalidExecutorCalls).toBe(0);
    const resumed = await runVerification({ runId, dependencies: { ...dependencies, executor: fakes.dependencies.executor } });
    expect(resumed.run.state).toBe("TERMINAL");
    expect(resumed.verdict.qaVerdict).toBe("PASS");
    expect(fakes.executorCalls).toBe(1);
  });

  test("releases a proofed claim after acquisition throws and permits an immediate retry", async () => {
    const store: FakeRepositoryStore = { runs: new Map(), stageDocuments: new Map(), dispatchClaims: new Map() };
    let originalError!: DispatchClaimAcquisitionError;
    class CrashAfterClaimRepository extends FakeRepository {
      crash = true;
      override async claimExecutionDispatch(claim: DispatchClaim, now = FIXED_NOW, attemptToken?: symbol) {
        if (!attemptToken) throw new Error("missing claim attempt token");
        const result = await super.claimExecutionDispatch(claim, now, attemptToken);
        if (this.crash) {
          this.crash = false;
          originalError = new DispatchClaimAcquisitionError("simulated crash after durable claim", result.claim, attemptToken);
          throw originalError;
        }
        return result;
      }
    }
    const runId = "claim-crash-recovery";
    const request = { ...makeRequest(), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const firstRepository = new CrashAfterClaimRepository(store);
    const first = makeDependencies({}, firstRepository);
    const firstRun = runVerification({ runId, request, dependencies: first.dependencies });
    let rejection: unknown;
    try {
      await firstRun;
    } catch (error) {
      rejection = error;
    }
    expect(originalError).toBeInstanceOf(DispatchClaimAcquisitionError);
    expect(rejection).toBe(originalError);
    expect(first.executorCalls).toBe(0);
    expect(store.dispatchClaims.size).toBe(0);
    expect(store.stageDocuments.has(`${runId}:execution`)).toBe(false);
    const second = makeDependencies({}, new FakeRepository(store));
    const resumed = await runVerification({ runId, dependencies: second.dependencies });
    expect(second.executorCalls).toBe(1);
    expect(resumed.run.state).toBe("TERMINAL");
    expect(resumed.verdict.qaVerdict).toBe("PASS");
    const dispatch = [...store.dispatchClaims.values()];
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]?.status).toBe("COMPLETED");
    expect(dispatch[0]?.completion).toBeDefined();
  });
  test("does not release a same-owner claim from a forged different-generation proof", async () => {
    const store: FakeRepositoryStore = { runs: new Map(), stageDocuments: new Map(), dispatchClaims: new Map() };
    class ForgedProofRepository extends FakeRepository {
      releaseCalls = 0;
      override async releaseExecutionDispatch(claim: DispatchClaim, now = FIXED_NOW) {
        this.releaseCalls++;
        return super.releaseExecutionDispatch(claim, now);
      }
      override async claimExecutionDispatch(claim: DispatchClaim, now = FIXED_NOW, attemptToken?: symbol): Promise<FakeDispatchClaimResult> {
        if (!attemptToken) throw new Error("missing claim attempt token");
        const result = await super.claimExecutionDispatch(claim, now, attemptToken);
        throw new DispatchClaimAcquisitionError("forged claim acquisition proof", { ...result.claim, leaseGeneration: result.claim.leaseGeneration + 1, acquisitionId: globalThis.crypto.randomUUID() }, Symbol("forged-attempt"));
      }
    }
    const runId = "claim-forged-proof";
    const request = { ...makeRequest(), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const repository = new ForgedProofRepository(store);
    const first = makeDependencies({}, repository);
    await expect(runVerification({ runId, request, dependencies: first.dependencies })).rejects.toThrow("forged claim acquisition proof");
    expect(repository.releaseCalls).toBe(0);
    expect(store.dispatchClaims.size).toBe(1);
    expect([...store.dispatchClaims.values()][0]?.claim.ownerId).toBe("verification-runtime");
    expect([...store.dispatchClaims.values()][0]?.claim.leaseGeneration).toBe(1);
    const retry = makeDependencies({}, new FakeRepository(store));
    await expect(runVerification({ runId, dependencies: retry.dependencies })).rejects.toThrow("dispatch claim already exists");
  });

  test("fences stale completion and release after a repository-CAS takeover", async () => {
    const store: FakeRepositoryStore = { runs: new Map(), stageDocuments: new Map(), dispatchClaims: new Map() };
    const runId = "claim-stale-owner";
    const request = { ...makeRequest(), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    let now = FIXED_NOW;
    const first = makeDependencies({}, new FakeRepository(store));
    let markStarted!: () => void;
    let releaseFirst!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const sideEffects = new Map<string, number>();
    const invocationKeys: string[] = [];
    const executeIdempotently = async (request: VerificationExecutionRequest): Promise<VerificationExecutionOutput> => {
      invocationKeys.push(request.idempotencyKey);
      if (!sideEffects.has(request.idempotencyKey)) sideEffects.set(request.idempotencyKey, 1);
      return {
        status: "PASS",
        runId: request.runId,
        requestId: request.requestId,
        snapshotId: request.snapshotId,
        idempotencyKey: request.idempotencyKey,
        producer: { kind: "deterministic-verifier", identity: "idempotent-executor", independence: "independent-producer" },
        artifacts: [{ type: "verification-result", digest: "d".repeat(64) }],
      };
    };
    const firstExecutor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async request => {
      markStarted();
      await firstGate;
      return executeIdempotently(request);
    }, }
    const firstRun = runVerification({ runId, request, dependencies: { ...first.dependencies, dispatchOwnerId: "owner-a", now: () => now, executor: firstExecutor } });
    await started;
    const staleClaim = structuredClone([...store.dispatchClaims.values()][0]?.claim);
    if (!staleClaim) throw new Error("missing first owner claim");
    now = new Date(Date.parse(staleClaim.leaseExpiresAt) + 1).toISOString();
    const second = makeDependencies({}, new FakeRepository(store));
    const secondRun = runVerification({ runId, dependencies: { ...second.dependencies, dispatchOwnerId: "owner-b", now: () => now, executor: { atomicSameKeyIdempotency: true, executeObligation: executeIdempotently } } });
    const winner = await secondRun;
    expect(winner.run.state).toBe("TERMINAL");
    expect([...store.dispatchClaims.values()][0]?.claim.ownerId).toBe("owner-b");
    expect([...store.dispatchClaims.values()][0]?.claim.leaseGeneration).toBe(2);
    expect(await first.repository.completeExecutionDispatch(staleClaim, undefined, now)).toBe(false);
    expect(await first.repository.releaseExecutionDispatch(staleClaim, now)).toBe(false);
    releaseFirst();
    await expect(firstRun).rejects.toThrow("dispatch result persistence failed");
    expect(invocationKeys).toHaveLength(2);
    expect(invocationKeys.every(key => key === staleClaim.idempotencyKey)).toBe(true);
    expect(sideEffects.get(staleClaim.idempotencyKey)).toBe(1);
    expect([...store.dispatchClaims.values()][0]?.status).toBe("COMPLETED");
    expect([...store.dispatchClaims.values()][0]?.claim.ownerId).toBe("owner-b");
  });

  test("reuses the durable idempotency result when completion crashes after repository persistence", async () => {
    const store: FakeRepositoryStore = { runs: new Map(), stageDocuments: new Map(), dispatchClaims: new Map() };
    class CrashAfterCompleteRepository extends FakeRepository {
      crash = true;
      override async completeExecutionDispatch(claim: DispatchClaim, completion: VerificationExecutionCompletionEnvelope | undefined, now = FIXED_NOW) {
        const completed = await super.completeExecutionDispatch(claim, completion, now);
        if (this.crash) {
          this.crash = false;
          throw new Error("simulated crash after execute before caller completion");
        }
        return completed;
      }
    }
    const request = { ...makeRequest(), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const repository = new CrashAfterCompleteRepository(store);
    const fakes = makeDependencies({}, repository);
    const requests: string[] = [];
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async requestInput => {
      requests.push(requestInput.idempotencyKey);
      return fakes.dependencies.executor.executeObligation!(requestInput);
    }, }
    const dependencies = { ...fakes.dependencies, executor, dispatchOwnerId: "owner-stable" };
    await expect(runVerification({ runId: "claim-complete-crash", request, dependencies })).rejects.toThrow("simulated crash after execute before caller completion");
    expect(requests).toHaveLength(1);
    const resumed = await runVerification({ runId: "claim-complete-crash", dependencies });
    expect(resumed.run.state).toBe("TERMINAL");
    expect(requests).toHaveLength(1);
    expect(new Set(requests).size).toBe(1);
    expect([...store.dispatchClaims.values()][0]?.status).toBe("COMPLETED");
  });
  test("replays an authenticated completion before capability gating after a crash", async () => {
    const store: FakeRepositoryStore = { runs: new Map(), stageDocuments: new Map(), dispatchClaims: new Map() };
    class CrashAfterCompleteRepository extends FakeRepository {
      crash = true;
      override async completeExecutionDispatch(claim: DispatchClaim, completion: VerificationExecutionCompletionEnvelope | undefined, now = FIXED_NOW) {
        const completed = await super.completeExecutionDispatch(claim, completion, now);
        if (this.crash) {
          this.crash = false;
          throw new Error("simulated completion crash before checkpoint");
        }
        return completed;
      }
    }
    const runId = "claim-complete-capability-false";
    const request = { ...makeRequest(), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const repository = new CrashAfterCompleteRepository(store);
    const fakes = makeDependencies({}, repository);
    let capabilityAvailable = true;
    let capabilityCalls = 0;
    let executorCalls = 0;
    let executionAuthorityIssues = 0;
    const issueExecutionAuthority = fakes.dependencies.executionAuthority.issueExecutionAuthority!;
    const verifyExecutionAuthority = fakes.dependencies.executionAuthority.verifyExecutionAuthority!;
    const dependencies = {
      ...fakes.dependencies,
      dispatchOwnerId: "owner-completion",
      capabilityProvider: {
        hasCapability: async () => {
          capabilityCalls++;
          return capabilityAvailable;
        },
      },
      executor: {
        atomicSameKeyIdempotency: true as const,
        executeObligation: async (requestInput: VerificationExecutionRequest) => {
          executorCalls++;
          return fakes.dependencies.executor.executeObligation!(requestInput);
        },
      },
      executionAuthority: {
        atomicCanonicalBindingIdempotency: true as const,
        issueExecutionAuthority: async (binding: ExecutionAuthority["binding"]) => {
          executionAuthorityIssues++;
          return issueExecutionAuthority(binding);
        },
        verifyExecutionAuthority: (authority: ExecutionAuthority, binding: ExecutionAuthority["binding"]) => verifyExecutionAuthority(authority, binding),
      },
    } as unknown as VerificationRunDependencies;
    await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("simulated completion crash before checkpoint");
    const persistedCompletion = [...store.dispatchClaims.values()][0]?.completion;
    if (!persistedCompletion) throw new Error("missing persisted completion");
    expect(executorCalls).toBe(1);
    expect(executionAuthorityIssues).toBe(1);
    capabilityAvailable = false;
    capabilityCalls = 0;
    const resumed = await runVerification({ runId, dependencies });
    expect(resumed.run.state).toBe("TERMINAL");
    expect(resumed.verdict.qaVerdict).toBe("PASS");
    expect(capabilityCalls).toBe(0);
    expect(executorCalls).toBe(1);
    expect(executionAuthorityIssues).toBe(1);
    expect(resumed.documents.execution?.authorities[0]).toEqual(persistedCompletion.authority);
    expect(resumed.documents.execution?.observations[0]?.artifacts).toEqual(persistedCompletion.output.artifacts);
  });
  test("imports a signed external completion durably and replays it without calling the provider again", async () => {
    const runId = "external-completion-replay";
    const { request, completion } = await makeSignedExternalCompletion(runId);
    const store: FakeRepositoryStore = { runs: new Map(), stageDocuments: new Map(), dispatchClaims: new Map() };
    class CrashAfterExternalCompleteRepository extends FakeRepository {
      crash = true;
      override async completeExecutionDispatch(claim: DispatchClaim, value: VerificationExecutionCompletionEnvelope | undefined, now = FIXED_NOW) {
        const completed = await super.completeExecutionDispatch(claim, value, now);
        if (this.crash) {
          this.crash = false;
          throw new Error("simulated external completion crash");
        }
        return completed;
      }
    }
    const repository = new CrashAfterExternalCompleteRepository(store);
    const fakes = makeDependencies({}, repository);
    let providerCalls = 0;
    let executorCalls = 0;
    const dependencies = {
      ...fakes.dependencies,
      completionProvider: { loadExecutionCompletion: async () => { providerCalls++; return completion; } },
      executionAuthority: {
        atomicCanonicalBindingIdempotency: true as const,
        verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: ExecutionAuthority["binding"]) =>
          authority.keyId === completion.authority.keyId
          && authority.signature === completion.authority.signature
          && JSON.stringify(authority.binding) === JSON.stringify(binding),
      },
      executor: { atomicSameKeyIdempotency: true as const, executeObligation: async () => { executorCalls++; throw new Error("local executor must not run"); } },
    } as unknown as VerificationRunDependencies;
    await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("simulated external completion crash");
    expect(providerCalls).toBe(1);
    expect(executorCalls).toBe(0);
    expect([...store.dispatchClaims.values()][0]).toMatchObject({ status: "COMPLETED", outputStored: true });
    const resumed = await runVerification({ runId, dependencies });
    expect(resumed.verdict.qaVerdict).toBe("PASS");
    expect(providerCalls).toBe(1);
    expect(executorCalls).toBe(0);
    expect(resumed.documents.execution?.authorities[0]).toEqual(completion.authority);
  });

  test("releases an imported completion claim when durable completion fails before persistence", async () => {
    const runId = "external-completion-persistence-failure";
    const { request, completion } = await makeSignedExternalCompletion(runId);
    class FailBeforeCompleteRepository extends FakeRepository {
      override async completeExecutionDispatch(): Promise<boolean> {
        throw new Error("completion storage unavailable");
      }
    }
    const repository = new FailBeforeCompleteRepository();
    const fakes = makeDependencies({}, repository);
    const dependencies = {
      ...fakes.dependencies,
      completionProvider: { loadExecutionCompletion: async () => completion },
      executionAuthority: {
        atomicCanonicalBindingIdempotency: true as const,
        verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: ExecutionAuthority["binding"]) =>
          authority.signature === completion.authority.signature
          && JSON.stringify(authority.binding) === JSON.stringify(binding),
      },
    } as unknown as VerificationRunDependencies;
    await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("completion storage unavailable");
    expect(repository.dispatchClaims.size).toBe(0);
  });

  test("rejects tampered external completion bindings and signatures and releases their claims", async () => {
    const runId = "external-completion-tamper";
    const { request, completion } = await makeSignedExternalCompletion(runId);
    const candidates: VerificationExecutionCompletionEnvelope[] = [
      { ...completion, authority: { ...completion.authority, binding: { ...completion.authority.binding, snapshotId: "substituted-snapshot" } } },
      { ...completion, authority: { ...completion.authority, signature: "tampered-signature" } },
    ];
    for (const candidate of candidates) {
      const repository = new FakeRepository();
      const fakes = makeDependencies({}, repository);
      const dependencies = {
        ...fakes.dependencies,
        completionProvider: { loadExecutionCompletion: async () => candidate },
        executionAuthority: {
          atomicCanonicalBindingIdempotency: true as const,
          verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: ExecutionAuthority["binding"]) =>
            authority.signature === completion.authority.signature
            && JSON.stringify(authority.binding) === JSON.stringify(binding),
        },
      } as unknown as VerificationRunDependencies;
      await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("invalid external execution completion");
      expect(repository.dispatchClaims.size).toBe(0);
    }
  });

  test("rejects external completion without a trust verifier and releases the claim", async () => {
    const runId = "external-completion-no-trust";
    const { request, completion } = await makeSignedExternalCompletion(runId);
    const repository = new FakeRepository();
    const fakes = makeDependencies({}, repository);
    const dependencies = {
      ...fakes.dependencies,
      completionProvider: { loadExecutionCompletion: async () => completion },
      executionAuthority: { atomicCanonicalBindingIdempotency: true },
    } as unknown as VerificationRunDependencies;
    await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("invalid external execution completion");
    expect(repository.dispatchClaims.size).toBe(0);
  });

  test("releases the dispatch claim when the external completion provider fails", async () => {
    const runId = "external-completion-provider-failure";
    const request = { ...makeRequest(`${runId}-request`), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const repository = new FakeRepository();
    const fakes = makeDependencies({}, repository);
    const failingDependencies = {
      ...fakes.dependencies,
      completionProvider: { loadExecutionCompletion: async () => { throw new Error("provider unavailable"); } },
    } as unknown as VerificationRunDependencies;
    await expect(runVerification({ runId, request, dependencies: failingDependencies })).rejects.toThrow("provider unavailable");
    expect(repository.dispatchClaims.size).toBe(0);
    const recovered = await runVerification({ runId, dependencies: fakes.dependencies });
    expect(recovered.run.state).toBe("TERMINAL");
    expect(recovered.verdict.qaVerdict).toBe("PASS");
  });
  test("rejects a mutated persisted completion envelope before replay", async () => {
    const store: FakeRepositoryStore = { runs: new Map(), stageDocuments: new Map(), dispatchClaims: new Map() };
    class CrashAfterCompleteRepository extends FakeRepository {
      crash = true;
      override async completeExecutionDispatch(claim: DispatchClaim, completion: VerificationExecutionCompletionEnvelope | undefined, now = FIXED_NOW) {
        const completed = await super.completeExecutionDispatch(claim, completion, now);
        if (this.crash) {
          this.crash = false;
          throw new Error("simulated completion crash");
        }
        return completed;
      }
    }
    const runId = "completion-envelope-tamper";
    const request = { ...makeRequest(), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const fakes = makeDependencies({}, new CrashAfterCompleteRepository(store));
    const requests: string[] = [];
    const executor: VerificationExecutor = {
      atomicSameKeyIdempotency: true,
      executeObligation: async requestInput => {
        requests.push(requestInput.idempotencyKey);
        return fakes.dependencies.executor.executeObligation!(requestInput);
      },
    };
    const dependencies = { ...fakes.dependencies, executor, dispatchOwnerId: "completion-tamper-owner" };
    await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("simulated completion crash");
    const entry = [...store.dispatchClaims.values()][0];
    if (!entry?.completion) throw new Error("missing persisted completion envelope");
    const tampered = structuredClone(entry.completion) as VerificationExecutionCompletionEnvelope & { output: VerificationExecutionOutput & { summary?: string } };
    tampered.output.summary = "mutated after durable completion";
    store.dispatchClaims.set(entry.claim.claimKey, { ...entry, completion: tampered });
    await expect(runVerification({ runId, dependencies })).rejects.toThrow("invalid persisted dispatch completion");
    expect(requests).toHaveLength(1);
  });
  test("rejects a substituted passing visual oracle before durable completion replay", async () => {
    const store: FakeRepositoryStore = { runs: new Map(), stageDocuments: new Map(), dispatchClaims: new Map() };
    class CrashAfterCompositionCompleteRepository extends FakeRepository {
      crash = true;
      override async completeExecutionDispatch(claim: DispatchClaim, completion: VerificationExecutionCompletionEnvelope | undefined, now = FIXED_NOW) {
        const completed = await super.completeExecutionDispatch(claim, completion, now);
        if (this.crash && completion?.output.visualCompositionOracle) {
          this.crash = false;
          throw new Error("simulated composition completion crash");
        }
        return completed;
      }
    }
    const runId = "composition-oracle-substitution";
    const request = makeCompositionRequest(runId);
    const fakes = makeDependencies({ visualCompositionOracle: true }, new CrashAfterCompositionCompleteRepository(store));
    await expect(runVerification({ runId, request, dependencies: fakes.dependencies })).rejects.toThrow("simulated composition completion crash");
    const entry = [...store.dispatchClaims.values()].find(candidate => candidate.completion?.output.visualCompositionOracle);
    if (!entry?.completion?.output.visualCompositionOracle) throw new Error("missing persisted visual composition completion");
    const oracle = entry.completion.output.visualCompositionOracle;
    const tampered = {
      ...entry.completion,
      output: {
        ...entry.completion.output,
        visualCompositionOracle: {
          ...oracle,
          captures: oracle.captures.map((capture, captureIndex) => captureIndex === 0 ? {
            ...capture,
            assertions: capture.assertions.map((assertion, assertionIndex) => assertionIndex === 0 ? { ...assertion, expected: 40, actual: 40 } : assertion),
          } : capture),
        },
      },
    };
    const browserCallsBeforeResume = fakes.browserCalls;
    store.dispatchClaims.set(entry.claim.claimKey, { ...entry, completion: tampered });
    await expect(runVerification({ runId, dependencies: fakes.dependencies })).rejects.toThrow("invalid persisted dispatch completion");
    expect(fakes.browserCalls).toBe(browserCallsBeforeResume);
  });

  test("fixed-clock adapters atomically claim and dispatch one shared obligation", async () => {
    const store: FakeRepositoryStore = { runs: new Map(), stageDocuments: new Map(), dispatchClaims: new Map() };
    const runId = "shared-adapter-run";
    const request = { ...makeRequest("shared-adapter-request"), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const seed = makeDependencies({ missingCapability: true }, new FakeRepository(store));
    await runVerification({ runId, request, dependencies: seed.dependencies });
    const seededRun = store.runs.get(runId);
    if (!seededRun) throw new Error("missing seeded run");
    store.runs.set(runId, { ...seededRun, state: "PLANNED" });
    store.stageDocuments.delete(`${runId}:execution`);
    store.stageDocuments.delete(`${runId}:evidence`);
    store.stageDocuments.delete(`${runId}:residual-risk`);
    store.stageDocuments.delete(`${runId}:verdict`);
    store.dispatchClaims.clear();
    const adapterA = makeDependencies({}, new FakeRepository(store));
    const adapterB = makeDependencies({}, new FakeRepository(store));
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let dispatchesA = 0;
    const executorA: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async requestInput => {
      dispatchesA++;
      markStarted();
      await gate;
      return adapterA.dependencies.executor.executeObligation!(requestInput);
    }, }
    const first = runVerification({ runId, request, dependencies: { ...adapterA.dependencies, executor: executorA } });
    await started;
    const second = runVerification({ runId, request, dependencies: adapterB.dependencies });
    await expect(second).rejects.toThrow("dispatch claim already exists");
    release();
    const winner = await first;
    expect(winner.run.state).toBe("TERMINAL");
    expect(dispatchesA).toBe(1);
    expect(store.dispatchClaims.size).toBe(1);
    expect(adapterB.repository.runWrites).toHaveLength(0);
  });

  test("resumes a failed EVIDENCE_EVALUATED checkpoint with persisted freshness instant", async () => {
    const fakes = makeDependencies();
    const runId = "freshness-checkpoint-resume";
    const request = { ...makeRequest("freshness-checkpoint-request"), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    let now = FIXED_NOW;
    const freshnessInputs: string[] = [];
    const executor: VerificationExecutor = { atomicSameKeyIdempotency: true, executeObligation: async executionRequest => ({
      status: "FAIL",
      runId: executionRequest.runId,
      requestId: executionRequest.requestId,
      snapshotId: executionRequest.snapshotId,
      idempotencyKey: executionRequest.idempotencyKey,
      producer: { kind: "deterministic-verifier", identity: "failing-executor", independence: "independent-producer" },
      artifacts: [{ type: "verification-result", digest: "f".repeat(64) }],
    }), }
    const dependencies = {
      ...fakes.dependencies,
      executor,
      now: () => now,
      freshnessPolicy: {
        evaluateFreshness: async (input: { evaluatedAt: string }) => {
          freshnessInputs.push(input.evaluatedAt);
          return "fresh" as const;
        },
      },
    } as unknown as VerificationRunDependencies;
    fakes.repository.failNextStage = "residual-risk";
    await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("simulated saveStage crash");
    const evidence = fakes.repository.stageDocuments.get(`${runId}:evidence`) as { freshnessEvaluatedAt: string };
    expect(evidence.freshnessEvaluatedAt).toBe(FIXED_NOW);
    now = "2026-08-03T00:01:00.000Z";
    const resumed = await runVerification({ runId, request, dependencies });
    expect(resumed.run.state).toBe("TERMINAL");
    expect(resumed.verdict.qaVerdict).toBe("FAIL");
    expect(freshnessInputs.at(-1)).toBe(now);
  });
  test("fails closed when the freshness policy revokes an accepted checkpoint on resume", async () => {
    const fakes = makeDependencies();
    const runId = "freshness-policy-revoked";
    const request = { ...makeRequest("freshness-policy-revoked-request"), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    let now = FIXED_NOW;
    let revoked = false;
    const dependencies = {
      ...fakes.dependencies,
      now: () => now,
      freshnessPolicy: {
        evaluateFreshness: async () => revoked ? "stale" as const : "fresh" as const,
      },
    } as unknown as VerificationRunDependencies;
    fakes.repository.failNextStage = "residual-risk";
    await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("simulated saveStage crash");
    revoked = true;
    now = "2026-08-03T00:01:00.000Z";
    const resumed = await runVerification({ runId, request, dependencies });
    expect(resumed.run.state).toBe("TERMINAL");
    expect(resumed.verdict.qaVerdict).not.toBe("PASS");
  });
  test("repairs a stale terminal verdict when atomic evidence/verdict persistence crashes and retry replays the same clock", async () => {
    const fakes = makeDependencies();
    const runId = "terminal-verdict-repair";
    const request = { ...makeRequest("terminal-verdict-repair-request"), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    let now = FIXED_NOW;
    const dependencies = {
      ...fakes.dependencies,
      now: () => now,
      freshnessPolicy: {
        evaluateFreshness: async (input: { evaluatedAt: string }) => input.evaluatedAt === FIXED_NOW ? "fresh" as const : "stale" as const,
      },
    } as unknown as VerificationRunDependencies;
    const first = await runVerification({ runId, request, dependencies });
    expect(first.verdict.qaVerdict).toBe("PASS");
    const persistedEvidence = structuredClone(first.documents.evidence);
    const persistedVerdict = structuredClone(first.documents.verdict);
    const stageWrites = fakes.repository.stageWrites.length;
    const runWrites = fakes.repository.runWrites.length;
    now = "2026-08-03T00:01:00.000Z";
    fakes.repository.failNextStage = "verdict";
    await expect(runVerification({ runId, dependencies })).rejects.toThrow("simulated saveStage crash");
    expect(fakes.repository.stageDocuments.get(`${runId}:evidence`)).toEqual(persistedEvidence);
    expect(fakes.repository.stageDocuments.get(`${runId}:verdict`)).toEqual(persistedVerdict);
    expect(fakes.repository.stageWrites.length).toBe(stageWrites);
    expect(fakes.repository.runWrites.length).toBe(runWrites);
    const repaired = await runVerification({ runId, dependencies });
    expect(repaired.run.state).toBe("TERMINAL");
    expect(repaired.verdict.qaVerdict).not.toBe("PASS");
    const repairedEvidence = fakes.repository.stageDocuments.get(`${runId}:evidence`);
    if (!repairedEvidence || typeof repairedEvidence !== "object" || !("freshnessEvaluatedAt" in repairedEvidence) || typeof repairedEvidence.freshnessEvaluatedAt !== "string") throw new Error("missing repaired evidence");
    expect(repairedEvidence.freshnessEvaluatedAt).toBe(now);
    expect(fakes.repository.stageDocuments.get(`${runId}:verdict`)).toEqual(repaired.verdict);
  });
  test("reuses a persisted freshness authority across same-clock evidence and terminal resumes", async () => {
    const fakes = makeDependencies();
    const runId = "freshness-authority-one-shot";
    const request = { ...makeRequest("freshness-authority-one-shot-request"), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    let issueCalls = 0;
    const issueFreshnessAuthority = fakes.dependencies.freshnessAuthority.issueFreshnessAuthority!;
    const verifyFreshnessAuthority = fakes.dependencies.freshnessAuthority.verifyFreshnessAuthority!;
    const dependencies = {
      ...fakes.dependencies,
      freshnessAuthority: {
        atomicSameKeyIdempotency: true as const,
        issueFreshnessAuthority: async (binding: FreshnessAuthority["binding"]) => {
          issueCalls++;
          return issueFreshnessAuthority(binding);
        },
        verifyFreshnessAuthority: (authority: FreshnessAuthority, binding: FreshnessAuthority["binding"]) => verifyFreshnessAuthority(authority, binding),
      },
    } as unknown as VerificationRunDependencies;
    const first = await runVerification({ runId, request, dependencies });
    const resumed = await runVerification({ runId, dependencies });
    expect(first.run.state).toBe("TERMINAL");
    expect(resumed.run.state).toBe("TERMINAL");
    expect(issueCalls).toBe(1);
  });
  test.each([undefined, false] as const)("rejects freshness authority without atomic same-key idempotency declaration: %s", async declaration => {
    const fakes = makeDependencies();
    let issueCalls = 0;
    const issueFreshnessAuthority = fakes.dependencies.freshnessAuthority.issueFreshnessAuthority!;
    const dependencies = {
      ...fakes.dependencies,
      freshnessAuthority: {
        ...(declaration === undefined ? {} : { atomicSameKeyIdempotency: declaration }),
        issueFreshnessAuthority: async (binding: FreshnessAuthority["binding"]) => {
          issueCalls++;
          return issueFreshnessAuthority(binding);
        },
        verifyFreshnessAuthority: fakes.dependencies.freshnessAuthority.verifyFreshnessAuthority,
      },
    } as unknown as VerificationRunDependencies;
    await expect(runOnce(dependencies, `freshness-authority-idempotency-${String(declaration)}`)).rejects.toThrow("freshness authority must declare atomic same-key idempotency");
    expect(issueCalls).toBe(0);
    expect(fakes.executorCalls).toBe(0);
  });
  test("recovers a fixed-clock evidence commit failure with one freshness authority issuance", async () => {
    const fakes = makeDependencies();
    const runId = "freshness-authority-fixed-clock-commit-retry";
    const request = { ...makeRequest("freshness-authority-fixed-clock-commit-retry-request"), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const issued = new Map<string, FreshnessAuthority>();
    let issueCalls = 0;
    let actualIssuances = 0;
    const issueFreshnessAuthority = fakes.dependencies.freshnessAuthority.issueFreshnessAuthority!;
    const verifyFreshnessAuthority = fakes.dependencies.freshnessAuthority.verifyFreshnessAuthority!;
    const dependencies = {
      ...fakes.dependencies,
      freshnessAuthority: {
        atomicSameKeyIdempotency: true as const,
        issueFreshnessAuthority: async (binding: FreshnessAuthority["binding"]) => {
          issueCalls++;
          const key = JSON.stringify(binding);
          const existing = issued.get(key);
          if (existing) return existing;
          actualIssuances++;
          const authority = await issueFreshnessAuthority(binding);
          if (!authority) throw new Error("fixture freshness authority issuance failed");
          issued.set(key, authority);
          return authority;
        },
        verifyFreshnessAuthority,
      },
    } satisfies VerificationRunDependencies;
    fakes.repository.failNextStage = "evidence";
    await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("simulated saveStage crash");
    expect(fakes.repository.runs.get(runId)?.state).toBe("EXECUTING");
    expect(fakes.repository.stageDocuments.has(`${runId}:evidence`)).toBe(false);
    const resumed = await runVerification({ runId, dependencies });
    expect(resumed.run.state).toBe("TERMINAL");
    expect(issueCalls).toBe(2);
    expect(actualIssuances).toBe(1);
  });
  test.each(["observationIds", "claimIds", "evaluationIds"] as const)("rejects corrupted terminal %s before freshness or repository side effects", async index => {
    const fakes = makeDependencies();
    const runId = `terminal-index-${index}`;
    await runOnce(fakes.dependencies, runId);
    const run = fakes.repository.runs.get(runId);
    if (!run) throw new Error("missing terminal run");
    fakes.repository.runs.set(runId, { ...run, [index]: [...run[index], `${index}:unexpected`] });
    let freshnessCalls = 0;
    let authorityCalls = 0;
    const issueFreshnessAuthority = fakes.dependencies.freshnessAuthority.issueFreshnessAuthority!;
    const dependencies = {
      ...fakes.dependencies,
      freshnessPolicy: {
        evaluateFreshness: async () => {
          freshnessCalls++;
          return "fresh" as const;
        },
      },
      freshnessAuthority: {
        ...fakes.dependencies.freshnessAuthority,
        issueFreshnessAuthority: async (binding: FreshnessAuthority["binding"]) => {
          authorityCalls++;
          return issueFreshnessAuthority(binding);
        },
      },
      now: () => "2026-08-03T00:01:00.000Z",
    } satisfies VerificationRunDependencies;
    const runWrites = fakes.repository.runWrites.length;
    const stageWrites = fakes.repository.stageWrites.length;
    await expect(runVerification({ runId, dependencies })).rejects.toThrow("invalid persisted run indexes");
    expect(freshnessCalls).toBe(0);
    expect(authorityCalls).toBe(0);
    expect(fakes.repository.runWrites.length).toBe(runWrites);
    expect(fakes.repository.stageWrites.length).toBe(stageWrites);
  });
  test("reissues a freshness authority when same-instant policy results change", async () => {
    const fakes = makeDependencies();
    const runId = "freshness-authority-same-instant-policy-change";
    const request = {
      ...makeRequest("freshness-authority-same-instant-policy-change-request"),
      testBasis: [makeRequest().testBasis[0]!],
    } satisfies VerificationRequest;
    let status: "fresh" | "stale" = "fresh";
    let issueCalls = 0;
    const issueFreshnessAuthority = fakes.dependencies.freshnessAuthority.issueFreshnessAuthority!;
    const verifyFreshnessAuthority = fakes.dependencies.freshnessAuthority.verifyFreshnessAuthority!;
    const dependencies = {
      ...fakes.dependencies,
      freshnessPolicy: { evaluateFreshness: async () => status },
      freshnessAuthority: {
        atomicSameKeyIdempotency: true as const,
        issueFreshnessAuthority: async (binding: FreshnessAuthority["binding"]) => {
          issueCalls++;
          return issueFreshnessAuthority(binding);
        },
        verifyFreshnessAuthority: (authority: FreshnessAuthority, binding: FreshnessAuthority["binding"]) =>
          verifyFreshnessAuthority(authority, binding),
      },
    } as unknown as VerificationRunDependencies;
    const first = await runVerification({ runId, request, dependencies });
    const originalRun = fakes.repository.runs.get(runId);
    const originalEvidence = first.documents.evidence;
    if (!originalRun || !originalEvidence) throw new Error("missing persisted freshness checkpoint");
    status = "stale";
    fakes.repository.runs.set(runId, { ...originalRun, state: "EVIDENCE_EVALUATED", updatedAt: FIXED_NOW });

    const resumed = await runVerification({ runId, dependencies });

    expect(issueCalls).toBe(2);
    expect(resumed.documents.evidence?.freshnessAuthority).not.toEqual(originalEvidence.freshnessAuthority);
    expect(resumed.documents.evidence?.evaluations.every(item => item.checks.fresh === false)).toBe(true);
    expect(resumed.verdict.qaVerdict).not.toBe("PASS");
  });
  test.each(["EVIDENCE_EVALUATED", "TERMINAL"] as const)("re-evaluates a historical freshness checkpoint at the resumed instant on %s resume", async state => {
    const fakes = makeDependencies();
    const runId = `freshness-boundary-${state.toLowerCase()}`;
    const request = { ...makeRequest(`freshness-boundary-request-${state.toLowerCase()}`), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    let now = FIXED_NOW;
    const freshnessInputs: string[] = [];
    const dependencies = {
      ...fakes.dependencies,
      now: () => now,
      freshnessPolicy: {
        evaluateFreshness: async (input: { evaluatedAt: string }) => {
          freshnessInputs.push(input.evaluatedAt);
          return "fresh" as const;
        },
      },
    } as unknown as VerificationRunDependencies;
    const first = await runVerification({ runId, request, dependencies });
    const originalEvidence = first.documents.evidence;
    const originalRun = fakes.repository.runs.get(runId);
    if (!originalEvidence || !originalRun) throw new Error("missing persisted freshness checkpoint");
    now = "2026-08-03T00:00:10.000Z";
    fakes.repository.runs.set(runId, { ...originalRun, state, updatedAt: FIXED_NOW });
    const resumed = await runVerification({ runId, dependencies });
    expect(freshnessInputs.at(-1)).toBe(now);
    expect(resumed.documents.evidence?.freshnessEvaluatedAt).toBe(now);
    expect(resumed.documents.evidence?.freshnessAuthority.binding.freshnessEvaluatedAt).toBe(now);
    expect(resumed.documents.evidence?.freshnessAuthority).not.toEqual(originalEvidence.freshnessAuthority);
    expect(resumed.verdict.qaVerdict).toBe("PASS");
  });
  test.each(["EVIDENCE_EVALUATED", "TERMINAL"] as const)("fails closed instead of retaining PASS when resumed freshness is stale on %s resume", async state => {
    const fakes = makeDependencies();
    const runId = `freshness-stale-boundary-${state.toLowerCase()}`;
    const request = { ...makeRequest(`freshness-stale-boundary-request-${state.toLowerCase()}`), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    let now = FIXED_NOW;
    const freshnessInputs: string[] = [];
    const dependencies = {
      ...fakes.dependencies,
      now: () => now,
      freshnessPolicy: {
        evaluateFreshness: async (input: { evaluatedAt: string }) => {
          freshnessInputs.push(input.evaluatedAt);
          return input.evaluatedAt === FIXED_NOW ? "fresh" as const : "stale" as const;
        },
      },
    } as unknown as VerificationRunDependencies;
    const first = await runVerification({ runId, request, dependencies });
    const originalRun = fakes.repository.runs.get(runId);
    if (!first.documents.evidence || !originalRun) throw new Error("missing persisted freshness checkpoint");
    now = "2026-08-03T00:00:10.000Z";
    fakes.repository.runs.set(runId, { ...originalRun, state, updatedAt: FIXED_NOW });
    const resumed = await runVerification({ runId, dependencies });
    expect(freshnessInputs.at(-1)).toBe(now);
    expect(resumed.documents.evidence?.freshnessEvaluatedAt).toBe(now);
    expect(resumed.documents.evidence?.evaluations.every(item => item.checks.fresh === false)).toBe(true);
    expect(resumed.verdict.qaVerdict).not.toBe("PASS");
  });
  test.each(["authority", "commit"] as const)("does not terminalize VERDICT_RESOLVED historical evidence before a refreshed %s transition succeeds", async mode => {
    const fakes = makeDependencies();
    const runId = `verdict-resolved-refresh-${mode}`;
    const request = { ...makeRequest(`verdict-resolved-refresh-request-${mode}`), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    let now = FIXED_NOW;
    let rejectRefresh = false;
    const issueFreshnessAuthority = fakes.dependencies.freshnessAuthority.issueFreshnessAuthority!;
    const verifyFreshnessAuthority = fakes.dependencies.freshnessAuthority.verifyFreshnessAuthority!;
    const dependencies = {
      ...fakes.dependencies,
      now: () => now,
      freshnessPolicy: {
        evaluateFreshness: async (input: { evaluatedAt: string }) => input.evaluatedAt === FIXED_NOW ? "fresh" as const : "stale" as const,
      },
      freshnessAuthority: {
        atomicSameKeyIdempotency: true as const,
        issueFreshnessAuthority: async (binding: FreshnessAuthority["binding"]) => {
          if (rejectRefresh && binding.freshnessEvaluatedAt === now) throw new Error("simulated freshness authority failure");
          return issueFreshnessAuthority(binding);
        },
        verifyFreshnessAuthority: async (authority: FreshnessAuthority, binding: FreshnessAuthority["binding"]) => {
          if (rejectRefresh && binding.freshnessEvaluatedAt === now) throw new Error("simulated freshness authority failure");
          return verifyFreshnessAuthority(authority, binding);
        },
      },
    } as unknown as VerificationRunDependencies;
    const first = await runVerification({ runId, request, dependencies });
    const originalRun = fakes.repository.runs.get(runId);
    if (!first.documents.evidence || !originalRun) throw new Error("missing persisted VERDICT_RESOLVED checkpoint");
    const runWritesBefore = fakes.repository.runWrites.length;
    fakes.repository.runs.set(runId, { ...originalRun, state: "VERDICT_RESOLVED", updatedAt: FIXED_NOW });
    now = "2026-08-03T00:00:10.000Z";
    if (mode === "authority") rejectRefresh = true;
    else fakes.repository.failNextState = "TERMINAL";
    await expect(runVerification({ runId, dependencies })).rejects.toThrow(mode === "authority" ? "simulated freshness authority failure" : "simulated saveRun crash");
    expect(fakes.repository.runs.get(runId)?.state).toBe("VERDICT_RESOLVED");
    expect(fakes.repository.runWrites.length).toBe(runWritesBefore);
    rejectRefresh = false;
    const resumed = await runVerification({ runId, dependencies });
    expect(resumed.run.state).toBe("TERMINAL");
    expect(resumed.verdict.qaVerdict).not.toBe("PASS");
    expect(resumed.documents.evidence?.freshnessEvaluatedAt).toBe(now);
  });
  test("rejects an initial backward freshness clock before policy or freshness authority side effects", async () => {
    const fakes = makeDependencies();
    const runId = "freshness-backward-clock-initial";
    const later = "2026-08-03T00:00:10.000Z";
    let executorReturned = false;
    let policyCalls = 0;
    let issueCalls = 0;
    const executeObligation = fakes.dependencies.executor.executeObligation!;
    const executor: VerificationExecutor = {
      ...fakes.dependencies.executor,
      executeObligation: async input => {
        executorReturned = true;
        return executeObligation(input);
      },
    };
    const issueFreshnessAuthority = fakes.dependencies.freshnessAuthority.issueFreshnessAuthority!;
    const dependencies = {
      ...fakes.dependencies,
      executor,
      now: () => executorReturned && fakes.repository.runs.get(runId)?.state === "EXECUTING" ? FIXED_NOW : executorReturned ? later : FIXED_NOW,
      freshnessPolicy: { evaluateFreshness: async () => { policyCalls++; return "fresh" as const; } },
      freshnessAuthority: {
        ...fakes.dependencies.freshnessAuthority,
        issueFreshnessAuthority: async (binding: FreshnessAuthority["binding"]) => {
          issueCalls++;
          return issueFreshnessAuthority(binding);
        },
      },
    } as unknown as VerificationRunDependencies;
    const request = { ...makeRequest("freshness-backward-clock-initial-request"), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    await expect(runVerification({ runId, request, dependencies })).rejects.toThrow("freshness evaluation timestamp precedes authenticated observation");
    expect(policyCalls).toBe(0);
    expect(issueCalls).toBe(0);
    expect(fakes.repository.runs.get(runId)?.state).toBe("EXECUTING");
  });
  test("rejects a persisted execution chronology mutation before freshness re-evaluation", async () => {
    const fakes = makeDependencies();
    const runId = "freshness-backward-clock";
    const first = await runOnce(fakes.dependencies, runId);
    const run = fakes.repository.runs.get(runId);
    const execution = first.documents.execution;
    if (!run || !execution) throw new Error("missing persisted execution");
    const future = "2026-08-03T00:01:00.000Z";
    const observations = execution.observations.map(item => ({ ...item, execution: { ...item.execution, startedAt: future, finishedAt: future } }));
    const evidence = execution.evidence.map(item => ({ ...item, execution: { ...item.execution, startedAt: future, finishedAt: future }, observedAt: future }));
    const authorities = execution.authorities.map(authority => ({ ...authority, binding: { ...authority.binding, execution: { ...authority.binding.execution, startedAt: future, finishedAt: future }, observedAt: future } }));
    fakes.repository.stageDocuments.set(`${runId}:execution`, { ...execution, observations, evidence, authorities });
    fakes.repository.runs.set(runId, { ...run, state: "EXECUTING", updatedAt: FIXED_NOW });
    let policyCalls = 0;
    let issueCalls = 0;
    const issueFreshnessAuthority = fakes.dependencies.freshnessAuthority.issueFreshnessAuthority!;
    const dependencies = {
      ...fakes.dependencies,
      now: () => FIXED_NOW,
      executionAuthority: { ...fakes.dependencies.executionAuthority, verifyExecutionAuthority: async () => true },
      freshnessPolicy: { evaluateFreshness: async () => { policyCalls++; return "fresh" as const; } },
      freshnessAuthority: {
        ...fakes.dependencies.freshnessAuthority,
        issueFreshnessAuthority: async (binding: FreshnessAuthority["binding"]) => {
          issueCalls++;
          return issueFreshnessAuthority(binding);
        },
      },
    } as unknown as VerificationRunDependencies;
    await expect(runVerification({ runId, dependencies })).rejects.toThrow("invalid persisted freshness execution digest");
    expect(issueCalls).toBe(0);
    expect(fakes.repository.runs.get(runId)?.state).toBe("EXECUTING");
  });
  test("rejects a persisted freshness timestamp mutation before resume", async () => {
    const fakes = makeDependencies();
    const runId = "freshness-timestamp-tamper";
    await runOnce(fakes.dependencies, runId);
    const run = fakes.repository.runs.get(runId);
    const saved = fakes.repository.stageDocuments.get(`${runId}:evidence`) as { freshnessEvaluatedAt: string; freshnessAuthority: FreshnessAuthority };
    if (!run || !saved) throw new Error("missing persisted freshness evidence");
    fakes.repository.stageDocuments.set(`${runId}:evidence`, { ...saved, freshnessEvaluatedAt: "2026-08-03T00:01:00.000Z" });
    fakes.repository.runs.set(runId, { ...run, state: "EXECUTING", updatedAt: FIXED_NOW });
    const executorCalls = fakes.executorCalls;
    await expect(runOnce(fakes.dependencies, runId)).rejects.toThrow();
    expect(fakes.executorCalls).toBe(executorCalls);
  });
  test("rejects a mutated persisted freshness authority without issuing a replacement", async () => {
    const fakes = makeDependencies();
    const runId = "freshness-authority-tamper";
    let issueCalls = 0;
    const issueFreshnessAuthority = fakes.dependencies.freshnessAuthority.issueFreshnessAuthority!;
    const dependencies = {
      ...fakes.dependencies,
      freshnessAuthority: {
        ...fakes.dependencies.freshnessAuthority,
        issueFreshnessAuthority: async (binding: FreshnessAuthority["binding"]) => {
          issueCalls++;
          return issueFreshnessAuthority(binding);
        },
      },
    } as unknown as VerificationRunDependencies;
    await runOnce(dependencies, runId);
    expect(issueCalls).toBe(1);
    const saved = fakes.repository.stageDocuments.get(`${runId}:evidence`) as { freshnessAuthority: FreshnessAuthority };
    if (!saved) throw new Error("missing persisted freshness evidence");
    fakes.repository.stageDocuments.set(`${runId}:evidence`, {
      ...saved,
      freshnessAuthority: { ...saved.freshnessAuthority, authorityId: `${saved.freshnessAuthority.authorityId}:mutated` },
    });
    await expect(runOnce(dependencies, runId)).rejects.toThrow("freshness authority verification failed");
    expect(issueCalls).toBe(1);
  });
  test("rejects a persisted freshness execution digest mutation before replacement authority side effects", async () => {
    const fakes = makeDependencies();
    const runId = "freshness-execution-digest-tamper";
    let issueCalls = 0;
    const issueFreshnessAuthority = fakes.dependencies.freshnessAuthority.issueFreshnessAuthority!;
    const dependencies = {
      ...fakes.dependencies,
      freshnessAuthority: {
        ...fakes.dependencies.freshnessAuthority,
        issueFreshnessAuthority: async (binding: FreshnessAuthority["binding"]) => {
          issueCalls++;
          return issueFreshnessAuthority(binding);
        },
      },
    } as unknown as VerificationRunDependencies;
    await runOnce(dependencies, runId);
    expect(issueCalls).toBe(1);
    const run = fakes.repository.runs.get(runId);
    const saved = fakes.repository.stageDocuments.get(`${runId}:evidence`) as { freshnessAuthority: FreshnessAuthority };
    if (!run || !saved) throw new Error("missing persisted freshness evidence");
    fakes.repository.stageDocuments.set(`${runId}:evidence`, {
      ...saved,
      freshnessAuthority: {
        ...saved.freshnessAuthority,
        binding: { ...saved.freshnessAuthority.binding, executionDigest: "f".repeat(64) },
      },
    });
    fakes.repository.runs.set(runId, { ...run, state: "EXECUTING", updatedAt: FIXED_NOW });
    await expect(runOnce(dependencies, runId)).rejects.toThrow("invalid persisted freshness execution digest");
    expect(issueCalls).toBe(1);
  });

  test("fences a stale PLANNED execution checkpoint across an EXECUTING takeover", async () => {
    const store: FakeRepositoryStore = { runs: new Map(), stageDocuments: new Map(), dispatchClaims: new Map() };
    const runId = "checkpoint-stale-takeover";
    const request = { ...makeRequest("checkpoint-stale-takeover-request"), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const first = makeDependencies({}, new FakeRepository(store));
    let markCompletion!: () => void;
    let releaseCheckpoint!: () => void;
    const completionReached = new Promise<void>(resolve => { markCompletion = resolve; });
    const checkpointGate = new Promise<void>(resolve => { releaseCheckpoint = resolve; });
    const completeExecutionDispatch = first.repository.completeExecutionDispatch.bind(first.repository);
    first.repository.completeExecutionDispatch = async (claim, completion, now) => {
      const accepted = await completeExecutionDispatch(claim, completion, now);
      markCompletion();
      await checkpointGate;
      return accepted;
    };
    const staleRun = runVerification({ runId, request, dependencies: first.dependencies });
    await completionReached;
    const second = makeDependencies({}, new FakeRepository(store));
    const takeover = runVerification({
      runId,
      request,
      dependencies: { ...second.dependencies, executionAuthority: first.dependencies.executionAuthority },
    });
    const winner = await takeover;
    expect(winner.run.state).toBe("TERMINAL");
    const terminalSnapshot = JSON.stringify({
      run: store.runs.get(runId),
      execution: store.stageDocuments.get(`${runId}:execution`),
      evidence: store.stageDocuments.get(`${runId}:evidence`),
      verdict: store.stageDocuments.get(`${runId}:verdict`),
    });
    releaseCheckpoint();
    await expect(staleRun).rejects.toThrow("stale execution checkpoint state/revision");
    expect(JSON.stringify({
      run: store.runs.get(runId),
      execution: store.stageDocuments.get(`${runId}:execution`),
      evidence: store.stageDocuments.get(`${runId}:evidence`),
      verdict: store.stageDocuments.get(`${runId}:verdict`),
    })).toBe(terminalSnapshot);
  });

  test("rejects a stale repository writer without overwriting the terminal pair", async () => {
    const fakes = makeDependencies();
    await runOnce(fakes.dependencies, "stale-writer");
    const beforeRun = structuredClone(fakes.repository.runs.get("stale-writer"));
    const beforeExecution = structuredClone(fakes.repository.stageDocuments.get("stale-writer:execution"));
    if (!beforeRun) throw new Error("missing terminal run");
    const accepted = await fakes.repository.commitTransition({ runId: "stale-writer", expectedRevision: 0, run: beforeRun });
    expect(accepted).toBe(false);
    expect(fakes.repository.runs.get("stale-writer")).toEqual(beforeRun);
    expect(fakes.repository.stageDocuments.get("stale-writer:execution")).toEqual(beforeExecution);
  });

  test("atomic stage crash leaves the previous run and stage pair intact", async () => {
    const fakes = makeDependencies();
    fakes.repository.failNextStage = "basis";
    await expect(runOnce(fakes.dependencies, "atomic-crash")).rejects.toThrow("simulated saveStage crash");
    expect(fakes.repository.runs.get("atomic-crash")?.state).toBe("CREATED");
    expect(fakes.repository.stageDocuments.has("atomic-crash:basis")).toBe(false);
  });
});
