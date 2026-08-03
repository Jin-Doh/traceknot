import { describe, expect, test } from "bun:test";
import {
  buildVerificationPlan,
  createInitialRun,
  establishTestBasis,
  performRiskDiscovery,
  runVerification,
  transitionRunState,
  type ArtifactStore,
  type ApprovalProvider,
  type BrowserExecutor,
  type CanonicalRunState,
  type CapabilityProvider,
  executeObligations,
  type RepositoryPort,
  type UsageRecorder,
  type VerificationRequest,
  type VerificationExecutor,
  type VerificationRunDependencies,
} from "./verification-run";

const FIXED_NOW = "2026-08-03T00:00:00.000Z";
const RUN_ID = "run-001";
const REQUEST_ID = "request-001";
const SNAPSHOT_ID = "snapshot-001";

type RunInput = Parameters<typeof runVerification>[0];
type RunStateValue = CanonicalRunState["state"];
type FakeOptions = { missingCapability?: boolean; missingExecutorOutput?: boolean; missingBrowserOutput?: boolean; invalidArtifact?: boolean; missingArtifactStorage?: boolean; mismatchedProvenance?: boolean; producerIndependence?: "self-check" | "separate-verification-context" | "independent-producer" };

class FakeRepository {
  readonly runs = new Map<string, CanonicalRunState>();
  readonly stageDocuments = new Map<string, unknown>();
  failNextState?: RunStateValue;
  readonly stageWrites: string[] = [];
  async loadRun(runId: string): Promise<CanonicalRunState | undefined> { return this.runs.get(runId); }
  async saveRun(run: CanonicalRunState): Promise<void> { if (this.failNextState === run.state) { this.failNextState = undefined; throw new Error("simulated saveRun crash"); } this.runs.set(run.runId, structuredClone(run)); }
  async loadStageDocument(runId: string, stage: string): Promise<unknown | undefined> { return this.stageDocuments.get(`${runId}:${stage}`); }
  async saveStageDocument(runId: string, stage: string, document: unknown): Promise<void> { this.stageWrites.push(stage); this.stageDocuments.set(`${runId}:${stage}`, structuredClone(document)); }
}

type FakePorts = { repository: FakeRepository; executorCalls: number; browserCalls: number };

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

function makeDependencies(options: FakeOptions = {}): FakePorts & { dependencies: VerificationRunDependencies } {
  const repository = new FakeRepository();
  let executorCalls = 0;
  let browserCalls = 0;
  const executor = {
    executeObligation: async () => {
      executorCalls++;
      if (options.missingExecutorOutput || options.missingBrowserOutput) return undefined;
      return { status: "PASS", requestId: REQUEST_ID, snapshotId: options.mismatchedProvenance ? "wrong-snapshot" : SNAPSHOT_ID, producer: { kind: "deterministic-verifier", identity: "fixture-executor", independence: options.producerIndependence ?? "separate-verification-context" }, artifacts: [{ type: "verification-result", digest: options.invalidArtifact ? "not-a-digest" : "a".repeat(64) }] };
    },
  } as unknown as VerificationExecutor;
  const browser = {
    executeBrowser: async () => {
      browserCalls++;
      if (options.missingBrowserOutput) return undefined;
      return { status: "PASS", requestId: REQUEST_ID, snapshotId: SNAPSHOT_ID, producer: { kind: "deterministic-verifier", identity: "fixture-browser", independence: options.producerIndependence ?? "separate-verification-context" }, artifacts: [{ type: "verification-result", digest: "b".repeat(64) }] };
    },
  } as unknown as BrowserExecutor;
  const capabilityProvider = { has: () => !options.missingCapability } as unknown as CapabilityProvider;
  const artifactStore = {
    storeVerificationResultArtifact: async (artifact: unknown) => options.missingArtifactStorage ? undefined : artifact,
    storeArtifact: async (artifact: unknown) => options.missingArtifactStorage ? undefined : artifact,
    putArtifact: async (artifact: unknown) => options.missingArtifactStorage ? undefined : artifact,
    store: async (artifact: unknown) => options.missingArtifactStorage ? undefined : artifact,
  } as unknown as ArtifactStore;
  const approvalProvider = { requestApproval: async () => ({ approved: true, approvalId: "approval-001" }) } as unknown as ApprovalProvider;
  const usageRecorder = { recordUsage: async () => undefined, record: async () => undefined } as unknown as UsageRecorder;
  const dependencies = {
    repository: repository as unknown as RepositoryPort,
    executor,
    artifactStore,
    capabilityProvider,
    browserExecutor: browser,
    approvalProvider,
    usageRecorder,
    now: () => FIXED_NOW,
    clock: { now: () => FIXED_NOW },
  } as unknown as VerificationRunDependencies;
  return { repository, dependencies, get executorCalls() { return executorCalls; }, get browserCalls() { return browserCalls; } };
}

async function runOnce(dependencies: VerificationRunDependencies, runId = RUN_ID, requestId = REQUEST_ID): Promise<Awaited<ReturnType<typeof runVerification>>> {
  const input = { runId, request: makeRequest(requestId), dependencies, now: FIXED_NOW } as unknown as RunInput;
  return runVerification(input);
}

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
    expect(fakes.repository.stageWrites).toEqual(["request", "basis", "discovery", "plan", "execution", "evidence", "residual-risk", "verdict"]);
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
    ["missing browser output", { missingBrowserOutput: true }],
  ])("does not resolve %s as PASS", async (_name, options) => {
    const fakes = makeDependencies(options);
    const result = await runOnce(fakes.dependencies);
    expect(result.run.state).toBe("TERMINAL");
    expect(["FAIL", "BLOCKED", "INCOMPLETE"]).toContain(result.verdict.qaVerdict);
    expect(result.verdict.qaVerdict).not.toBe("PASS");
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

  test("classifies material risks, derives independent obligations, and preserves browser technique", async () => {
    const request = { ...makeRequest(), testBasis: [
      { id: "z-browser", kind: "acceptance-criterion" as const, origin: "explicit" as const, text: "The browser flow renders the deployment UI." },
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
    expect(plan.obligations.find(item => item.id === "obligation:condition:z-browser")?.evidenceType).toBe("browser-result");
    const execution = await executeObligations({ runId: RUN_ID, request, plan, dependencies: deps });
    expect(execution.observations.find(item => item.observationId === "observation:obligation:condition:z-browser")?.execution.kind).toBe("browser");
    const browserRequest = { ...makeRequest(), testBasis: [{ id: "browser-only", kind: "acceptance-criterion" as const, origin: "explicit" as const, text: "The browser flow renders." }] } satisfies VerificationRequest;
    const browserFakes = makeDependencies();
    const browserBasis = await establishTestBasis({ request: browserRequest, dependencies: browserFakes.dependencies });
    const browserDiscovery = await performRiskDiscovery({ request: browserRequest, basis: browserBasis, dependencies: browserFakes.dependencies });
    const browserPlan = await buildVerificationPlan({ request: browserRequest, basis: browserBasis, discovery: browserDiscovery, dependencies: browserFakes.dependencies });
    const browserExecution = await executeObligations({ runId: RUN_ID, request: browserRequest, plan: browserPlan, dependencies: browserFakes.dependencies });
    expect(browserExecution.observations[0]?.execution.kind).toBe("browser");
    expect(browserFakes.browserCalls).toBe(1);
    expect(browserFakes.executorCalls).toBe(0);
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

  test("reuses execution checkpoint after saveRun crash without a duplicate executor call", async () => {
    const fakes = makeDependencies();
    fakes.repository.failNextState = "EXECUTING";
    await expect(runOnce(fakes.dependencies)).rejects.toThrow("simulated saveRun crash");
    const calls = fakes.executorCalls;
    const resumed = await runOnce(fakes.dependencies);
    expect(resumed.run.state).toBe("TERMINAL");
    expect(fakes.executorCalls).toBe(calls);
  });
});
