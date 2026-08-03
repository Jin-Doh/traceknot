import { describe, expect, test } from "bun:test";
import {
  createInitialRun,
  runVerification,
  transitionRunState,
  type ArtifactStore,
  type ApprovalProvider,
  type BrowserExecutor,
  type CanonicalRunState,
  type CapabilityProvider,
  type RepositoryPort,
  type UsageRecorder,
  type VerificationExecutor,
  type VerificationRunDependencies,
} from "./verification-run";

const FIXED_NOW = "2026-08-03T00:00:00.000Z";
const RUN_ID = "run-001";
const REQUEST_ID = "request-001";
const SNAPSHOT_ID = "snapshot-001";

type RunInput = Parameters<typeof runVerification>[0];
type RunStateValue = CanonicalRunState["state"];

type FakeOptions = { missingCapability?: boolean; missingExecutorOutput?: boolean; missingBrowserOutput?: boolean };

class FakeRepository {
  readonly runs = new Map<string, CanonicalRunState>();
  readonly stageDocuments = new Map<string, unknown>();
  readonly stageWrites: string[] = [];
  async loadRun(runId: string): Promise<CanonicalRunState | undefined> { return this.runs.get(runId); }
  async saveRun(run: CanonicalRunState): Promise<void> { this.runs.set(run.runId, structuredClone(run)); }
  async loadStageDocument(runId: string, stage: string): Promise<unknown | undefined> { return this.stageDocuments.get(`${runId}:${stage}`); }
  async saveStageDocument(runId: string, stage: string, document: unknown): Promise<void> {
    this.stageWrites.push(stage);
    this.stageDocuments.set(`${runId}:${stage}`, structuredClone(document));
  }
}

type FakePorts = { repository: FakeRepository; executorCalls: number; browserCalls: number };

function makeRequest(requestId = REQUEST_ID) {
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
      if (options.missingExecutorOutput) return undefined;
      return { status: "PASS", passed: true, snapshotId: SNAPSHOT_ID, observationId: "observation-001", claimId: "claim-001", evaluationId: "evaluation-001", evidenceId: "evidence-001", artifacts: [{ type: "verification-output", digest: "digest-001" }] };
    },
  } as unknown as VerificationExecutor;
  const browser = {
    executeBrowser: async () => {
      browserCalls++;
      if (options.missingBrowserOutput) return undefined;
      return { status: "PASS", passed: true, snapshotId: SNAPSHOT_ID, observationId: "browser-observation-001", claimId: "browser-claim-001", evaluationId: "browser-evaluation-001", evidenceId: "browser-evidence-001", artifacts: [{ type: "browser-output", digest: "browser-digest-001" }] };
    },
  } as unknown as BrowserExecutor;
  const capabilityProvider = {
    advertise: () => (options.missingCapability ? [] : ["repository-verification", "evidence-storage"]),
    has: () => !options.missingCapability,
  } as unknown as CapabilityProvider;
  const artifactStore = {
    storeArtifact: async () => ({ type: "verification-output", digest: "digest-001" }),
    putArtifact: async () => ({ type: "verification-output", digest: "digest-001" }),
    store: async () => ({ type: "verification-output", digest: "digest-001" }),
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
    expect(fakes.executorCalls).toBeGreaterThan(0);
    expect(fakes.repository.stageWrites).toEqual(["BASIS_ESTABLISHED", "DISCOVERY_COMPLETED", "PLANNED", "EXECUTING", "EVIDENCE_EVALUATED", "VERDICT_RESOLVED", "TERMINAL"]);
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
    expect(fakes.executorCalls).toBeGreaterThan(executorCallsBeforeResume);
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
    expect(["BLOCKED", "INCOMPLETE"]).toContain(result.verdict.qaVerdict);
    expect(result.verdict.qaVerdict).not.toBe("PASS");
  });
});
