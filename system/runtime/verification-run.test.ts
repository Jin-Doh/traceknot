import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import type { Artifact } from "../core/qa-core";
import {
  buildVerificationPlan,
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
  type RepositoryPort,
  type UsageRecorder,
  type VerificationExecutor,
  type VerificationExecutionOutput,
  type VerificationExecutionRequest,
  type VerificationRequest,
  type VerificationRunDependencies,
  type ExecutionDocument,
} from "./verification-run";

const FIXED_NOW = "2026-08-03T00:00:00.000Z";
const RUN_ID = "run-001";
const REQUEST_ID = "request-001";
const SNAPSHOT_ID = "snapshot-001";

type RunInput = Parameters<typeof runVerification>[0];
type RunStateValue = CanonicalRunState["state"];
type FakeOptions = { missingCapability?: boolean; missingExecutorOutput?: boolean; missingBrowserOutput?: boolean; invalidArtifact?: boolean; missingArtifactStorage?: boolean; mismatchedProvenance?: boolean; producerKind?: "self" | "harness-managed" | "deterministic-verifier" | "ci" | "human" | "external-system"; producerIndependence?: "self-check" | "separate-verification-context" | "independent-producer"; missingAuthority?: boolean; mismatchedAuthority?: boolean; invalidProducer?: boolean };

class FakeRepository {
  readonly runs = new Map<string, CanonicalRunState>();
  readonly stageDocuments = new Map<string, unknown>();
  failNextState?: RunStateValue;
  failNextStage?: string;
  readonly stageWrites: string[] = [];
  readonly runWrites: CanonicalRunState[] = [];
  async loadRun(runId: string): Promise<CanonicalRunState | undefined> { return this.runs.get(runId); }
  async loadStageDocument(runId: string, stage: string): Promise<unknown | undefined> { return this.stageDocuments.get(`${runId}:${stage}`); }
  async commitTransition(transition: { runId: string; expectedUpdatedAt?: string; stage?: string; document?: unknown; run: CanonicalRunState }): Promise<boolean> {
    const current = this.runs.get(transition.runId);
    if (transition.expectedUpdatedAt === undefined ? current !== undefined : (!current || current.updatedAt !== transition.expectedUpdatedAt)) return false;
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

function makeDependencies(options: FakeOptions = {}): FakeDependencies {
  const repository = new FakeRepository();
  let executorCalls = 0;
  let browserCalls = 0;
  const executor = {
    executeObligation: async (request: VerificationExecutionRequest) => {
      executorCalls++;
      if (options.missingExecutorOutput) return undefined;
      return { status: "PASS" as const, runId: request.runId, requestId: request.requestId, snapshotId: options.mismatchedProvenance ? "wrong-snapshot" : request.snapshotId, idempotencyKey: request.idempotencyKey, producer: options.invalidProducer ? undefined : { kind: options.producerKind ?? "deterministic-verifier", identity: "fixture-executor", independence: options.producerIndependence ?? "independent-producer" }, artifacts: [{ type: "verification-result", digest: options.invalidArtifact ? "not-a-digest" : "a".repeat(64) }] };
    },
  } as unknown as VerificationExecutor;
  const browser = {
    executeBrowser: async (request: VerificationExecutionRequest) => {
      browserCalls++;
      if (options.missingBrowserOutput) return undefined;
      return { status: "PASS" as const, runId: request.runId, requestId: request.requestId, snapshotId: request.snapshotId, idempotencyKey: request.idempotencyKey, producer: { kind: options.producerKind ?? "deterministic-verifier", identity: "fixture-browser", independence: options.producerIndependence ?? "independent-producer" }, artifacts: [{ type: "verification-result", digest: "b".repeat(64) }] };
    },
  } as unknown as BrowserExecutor;
  let authorityCalls = 0;
  const authorities = new Map<string, ExecutionAuthority>();
  const executionAuthority = {
    issueExecutionAuthority: async (binding: ExecutionAuthority["binding"]): Promise<ExecutionAuthority | undefined> => {
      if (options.missingAuthority) return undefined;
      const existing = authorities.get(binding.idempotencyKey);
      if (existing) return existing;
      const issuedBinding = options.mismatchedAuthority ? { ...structuredClone(binding), snapshotId: "wrong-snapshot" } : structuredClone(binding);
      const authority: ExecutionAuthority = { schemaVersion: "verification-execution-authority/v1", authorityId: `authority:${binding.obligationId}`, issuer: "fixture-authority", binding: issuedBinding };
      authorities.set(binding.idempotencyKey, authority);
      return authority;
    },
    verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: ExecutionAuthority["binding"]): Promise<boolean> => {
      authorityCalls++;
      const stored = authorities.get(binding.idempotencyKey);
      return Boolean(stored && JSON.stringify(stored) === JSON.stringify(authority) && JSON.stringify(stored.binding) === JSON.stringify(binding));
    },
  };
  const capabilityProvider = { has: () => !options.missingCapability } as unknown as CapabilityProvider;
  const artifactStore: ArtifactStore = {
    storeVerificationResultArtifact: async (artifact: Artifact) => options.missingArtifactStorage ? { type: "unexpected-artifact", digest: "c".repeat(64) } : artifact,
    storeArtifact: async (artifact: Artifact) => options.missingArtifactStorage ? { type: "unexpected-artifact", digest: "c".repeat(64) } : artifact,
    putArtifact: async (artifact: Artifact) => options.missingArtifactStorage ? { type: "unexpected-artifact", digest: "c".repeat(64) } : artifact,
    store: async (artifact: Artifact) => options.missingArtifactStorage ? { type: "unexpected-artifact", digest: "c".repeat(64) } : artifact,
  };
  const approvalProvider = { requestApproval: async () => ({ approved: true, approvalId: "approval-001" }) } as unknown as ApprovalProvider;
  const usageRecorder = { recordUsage: async () => undefined, record: async () => undefined } as unknown as UsageRecorder;
  const dependencies = {
    executionAuthority,
    freshnessPolicy: { evaluateFreshness: async () => "fresh" as const },
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
  return { repository, dependencies, get executorCalls() { return executorCalls; }, get browserCalls() { return browserCalls; }, get authorityCalls() { return authorityCalls; } };
}

async function runOnce(dependencies: VerificationRunDependencies, runId = RUN_ID, requestId = REQUEST_ID): Promise<Awaited<ReturnType<typeof runVerification>>> {
  const input = { runId, request: makeRequest(requestId), dependencies, now: FIXED_NOW } as unknown as RunInput;
  return runVerification(input);
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
    issueExecutionAuthority: async (binding: ExecutionAuthority["binding"]): Promise<ExecutionAuthority> => {
      const existing = authorities.get(binding.idempotencyKey);
      if (existing) return existing;
      const authority: ExecutionAuthority = {
        schemaVersion: "verification-execution-authority/v1",
        authorityId: `authority:${binding.obligationId}`,
        issuer: "replay-fixture",
        binding: mutate(structuredClone(binding)),
      };
      authorities.set(binding.idempotencyKey, authority);
      issued.push(authority);
      signed.push(structuredClone(authority));
      return authority;
    },
    verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: ExecutionAuthority["binding"]): Promise<boolean> => {
      const stored = authorities.get(binding.idempotencyKey);
      return Boolean(stored && JSON.stringify(stored) === JSON.stringify(authority) && JSON.stringify(stored.binding) === JSON.stringify(binding));
    },
  };
  return { dependencies: { ...fakes.dependencies, executionAuthority }, issued, signed };
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
  const executor: VerificationExecutor = {
    executeObligation: async executionRequest => ({
      status: "PASS",
      runId: executionRequest.runId,
      requestId: executionRequest.requestId,
      snapshotId: executionRequest.snapshotId,
      idempotencyKey: executionRequest.idempotencyKey,
      producer: { kind: "deterministic-verifier", identity: "replay-executor", independence: "independent-producer" },
      artifacts: mode === "reordered"
        ? [{ type: "verification-result", digest: "a".repeat(64) }, { type: "verification-result", digest: "b".repeat(64) }]
        : [{ type: "verification-result", digest: "a".repeat(64) }],
    }),
  };
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

test("selects the latest parsed instant across mixed fractional timestamps", async () => {
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
  const dependencies = { ...fakes.dependencies, executionAuthority: { ...fakes.dependencies.executionAuthority, verifyExecutionAuthority: async () => true } };
  const replay = await runVerification({ runId, dependencies });
  expect(replay.documents.evidence?.evaluations.every(item => item.evaluatedAt === high)).toBe(true);
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
  const executor: VerificationExecutor = {
    executeObligation: async request => ({
      status: "PASS",
      runId: request.runId,
      requestId: request.requestId,
      snapshotId: request.snapshotId,
      idempotencyKey: request.idempotencyKey,
      producer: { kind: "deterministic-verifier", identity: "uppercase-executor", independence: "independent-producer" },
      artifacts: [{ type: "verification-result", digest }, { type: "verification-result", digest: digest.toLowerCase(), path: "/tmp/result" }] as unknown as Artifact[],
    }),
  };
  const artifactStore: ArtifactStore = {
    storeVerificationResultArtifact: async artifact => ({ ...artifact, digest: artifact.digest.toUpperCase(), extra: "discard" } as unknown as Artifact),
  };
  const result = await runOnce({ ...fakes.dependencies, executor, artifactStore }, "artifact-normalization");
  const execution = result.documents.execution;
  expect(result.verdict.qaVerdict).toBe("PASS");
  expect(execution?.observations[0]?.artifacts).toEqual([{ type: "verification-result", digest: digest.toLowerCase() }, { type: "verification-result", digest: digest.toLowerCase(), path: "/tmp/result" }]);
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

test("rejects empty and non-string artifact digests or paths without storing them", async () => {
  for (const malformed of [
    { type: "verification-result", digest: "" },
    { type: "verification-result", digest: "f".repeat(64), path: "" },
    { type: "verification-result", digest: "f".repeat(64), path: 42 },
  ]) {
    const fakes = makeDependencies();
    let stores = 0;
    const executor: VerificationExecutor = {
      executeObligation: async request => ({
        status: "PASS", runId: request.runId, requestId: request.requestId, snapshotId: request.snapshotId, idempotencyKey: request.idempotencyKey,
        producer: { kind: "deterministic-verifier", identity: "malformed-artifact-executor", independence: "independent-producer" },
        artifacts: [malformed] as unknown as Artifact[],
      }),
    };
    const artifactStore: ArtifactStore = { storeVerificationResultArtifact: async artifact => { stores++; return artifact; } };
    const result = await runOnce({ ...fakes.dependencies, executor, artifactStore }, `malformed-artifact-${stores}`);
    expect(result.verdict.qaVerdict).not.toBe("PASS");
    expect(stores).toBe(0);
  }
});
test("fails closed when a valid artifact is accompanied by a malformed artifact", async () => {
  const fakes = makeDependencies();
  let stores = 0;
  const executor: VerificationExecutor = {
    executeObligation: async request => ({
      status: "PASS", runId: request.runId, requestId: request.requestId, snapshotId: request.snapshotId, idempotencyKey: request.idempotencyKey,
      producer: { kind: "deterministic-verifier", identity: "mixed-artifact-executor", independence: "independent-producer" },
      artifacts: [{ type: "verification-result", digest: "a".repeat(64) }, { type: "verification-result", digest: "", path: "" }] as unknown as Artifact[],
    }),
  };
  const artifactStore: ArtifactStore = { storeVerificationResultArtifact: async artifact => { stores++; return artifact; } };
  const result = await runOnce({ ...fakes.dependencies, executor, artifactStore }, "mixed-malformed-artifact");
  expect(result.verdict.qaVerdict).not.toBe("PASS");
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
  const executor: VerificationExecutor = {
    executeObligation: async request => ({
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
    }),
  };
  const artifactStore: ArtifactStore = {
    storeVerificationResultArtifact: async artifact => artifact.digest === validDigest ? artifact : malformedResponse as unknown as Artifact,
  };
  const result = await runOnce({ ...fakes.dependencies, executor, artifactStore }, `mixed-store-${_name.replaceAll(" ", "-")}`);
  const execution = result.documents.execution;
  expect(result.verdict.qaVerdict).toBe("INCOMPLETE");
  expect(execution?.evidence.every(item => item.result.verdict !== "PASS")).toBe(true);
  expect(execution?.authorities.some(authority => authority.binding.result.verdict === "PASS")).toBe(false);
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
    const executor: VerificationExecutor = {
      executeObligation: async request => ({
        status: "FAIL",
        runId: request.runId,
        requestId: request.requestId,
        snapshotId: request.snapshotId,
        idempotencyKey: request.idempotencyKey,
        producer: { kind: "deterministic-verifier", identity: "fixture-failing-executor", independence: "independent-producer" },
        artifacts: [{ type: "verification-result", digest: "f".repeat(64) }],
      }),
    };
    const result = await runVerification({ runId: "explicit-failure", request: makeRequest(), dependencies: { ...fakes.dependencies, executor } });
    expect(result.verdict.qaVerdict).toBe("FAIL");
    const failedEvidence = result.documents.execution?.evidence.filter(item => item.result.verdict === "FAIL") ?? [];
    expect(failedEvidence.length).toBeGreaterThan(0);
    expect(result.documents.execution?.authorities.every(authority => authority.binding.result.verdict === "FAIL" && authority.binding.artifacts.length === 1 && authority.binding.artifacts[0]?.digest === "f".repeat(64))).toBe(true);
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
    const executor: VerificationExecutor = {
      executeObligation: async (request: VerificationExecutionRequest) => {
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
      },
    };

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
    const executor: VerificationExecutor = {
      executeObligation: async (request: VerificationExecutionRequest) => ({
        status: "PASS",
        runId: request.runId,
        requestId: request.requestId,
        snapshotId: request.snapshotId,
        idempotencyKey: mode === "missing" ? undefined : "wrong-idempotency-key",
        producer: { kind: "deterministic-verifier", identity: "fixture-executor", independence: "independent-producer" },
        artifacts: [{ type: "verification-result", digest: "a".repeat(64) }],
      } as unknown as VerificationExecutionOutput),
    };
    const result = await runVerification({ runId: `idempotency-${mode}`, request: makeRequest(), dependencies: { ...fakes.dependencies, executor } });
    expect(result.verdict.qaVerdict).not.toBe("PASS");
    expect(result.documents.execution?.evidence.every(item => item.result.verdict !== "PASS" || item.result.passed !== 1)).toBe(true);
  });

  test("encodes idempotency components without collisions", async () => {
    const fakes = makeDependencies();
    const seen: VerificationExecutionRequest[] = [];
    const original = fakes.dependencies.executor.executeObligation;
    const executor: VerificationExecutor = {
      executeObligation: async request => {
        seen.push(request);
        return original ? original(request) : undefined;
      },
    };
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
      const executor: VerificationExecutor = {
        executeObligation: async request => {
          captured ??= request;
          return original ? original(request) : undefined;
        },
      };
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

  test("classifies material risks, derives independent obligations, and preserves browser technique", async () => {
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
    expect(plan.obligations.find(item => item.id === "obligation:condition:m-contract")?.independence).toBe("independent-producer");
    expect(plan.obligations.find(item => item.id === "obligation:condition:r-basic")?.independence).toBe("independent-producer");
    expect(plan.obligations.find(item => item.id === "obligation:condition:z-browser")?.independence).toBe("independent-producer");
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
    expect(fakes.executorCalls).toBe(1);
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
  test("requires full request equality and rejects changed basis before side effects", async () => {
    const fakes = makeDependencies();
    let artifactCalls = 0;
    let usageCalls = 0;
    const artifactStore: ArtifactStore = { storeVerificationResultArtifact: async artifact => { artifactCalls++; return artifact; } };
    const usageRecorder: UsageRecorder = { recordUsage: async () => { usageCalls++; } };
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
    const executor: VerificationExecutor = {
      executeObligation: async request => {
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
      },
    };
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
    const executor: VerificationExecutor = {
      executeObligation: async request => ({
        status: "FAIL",
        runId: request.runId,
        requestId: request.requestId,
        snapshotId: request.snapshotId,
        idempotencyKey: request.idempotencyKey,
        producer: { kind: "deterministic-verifier", identity: "fixture-failing-executor", independence: "independent-producer" },
        artifacts: [{ type: "verification-result", digest: "f".repeat(64) }],
      }),
    };
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
    const executor: VerificationExecutor = {
      executeObligation: async request => ({
        status: "FAIL",
        runId: request.runId,
        requestId: request.requestId,
        snapshotId: request.snapshotId,
        idempotencyKey: request.idempotencyKey,
        producer: { kind: "deterministic-verifier", identity: "fixture-failing-executor", independence: "independent-producer" },
        artifacts: [{ type: "verification-result", digest: "f".repeat(64) }],
      }),
    };
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
  test("rejects a material residual defect inserted after failed verdict save", async () => {
    const fakes = makeDependencies();
    const executor: VerificationExecutor = {
      executeObligation: async request => ({
        status: "FAIL",
        runId: request.runId,
        requestId: request.requestId,
        snapshotId: request.snapshotId,
        idempotencyKey: request.idempotencyKey,
        producer: { kind: "deterministic-verifier", identity: "fixture-failing-executor", independence: "independent-producer" },
        artifacts: [{ type: "verification-result", digest: "f".repeat(64) }],
      }),
    };
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


  test("persists one checkpoint per obligation and resumes only the unfinished obligation", async () => {
    const fakes = makeDependencies();
    const seen: string[] = [];
    const original = fakes.dependencies.executor.executeObligation;
    let throwOnSecond = true;
    const flakyExecutor: VerificationExecutor = {
      executeObligation: async request => {
        seen.push(request.obligation.id);
        if (throwOnSecond && seen.length === 2) { throwOnSecond = false; throw new Error("second obligation failed"); }
        return original ? original(request) : undefined;
      },
    };
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
      storeVerificationResultArtifact: async artifact => { artifactStores++; return artifact; },
    };
    let executionUsageCalls = 0;
    let throwOnce = true;
    const usageRecorder: UsageRecorder = {
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
    let throwOnce = true;
    const usageRecorder: UsageRecorder = {
      recordUsage: async event => {
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
  });

  test("keeps a pending usage outbox non-terminal without a recorder and flushes it after recorder restoration", async () => {
    const fakes = makeDependencies();
    const request = { ...makeRequest(), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const runId = "usage-outbox-recorder-omitted";
    const initialEvents: UsageEvent[] = [];
    let failOnce = true;
    const failingRecorder: UsageRecorder = {
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
    const restoredDependencies = { ...omittedDependencies, usageRecorder: { recordUsage: async (event: UsageEvent) => { restoredEvents.push(event); } } satisfies UsageRecorder };
    const resumed = await runVerification({ runId, dependencies: restoredDependencies });
    expect(resumed.run.state).toBe("TERMINAL");
    expect(fakes.executorCalls).toBe(executorCalls);
    expect(restoredEvents.length).toBeGreaterThan(0);
    expect(restoredEvents.some(event => event.eventKey === checkpoint.usageOutbox?.find(entry => entry.event === "execution")?.eventKey)).toBe(true);
    expect((fakes.repository.stageDocuments.get(`${runId}:execution`) as ExecutionDocument).usageOutbox).toHaveLength(0);
    expect(initialEvents.filter(event => event.event === "artifact")).toHaveLength(0);
  });

  test("rejects a usage outbox execution key bound to a foreign run before external dispatch", async () => {
    const fakes = makeDependencies();
    const request = { ...makeRequest(), testBasis: [makeRequest().testBasis[0]!] } satisfies VerificationRequest;
    const runId = "usage-outbox-run-binding";
    let failOnce = true;
    const usageRecorder: UsageRecorder = {
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
    const executor: VerificationExecutor = {
      executeObligation: async request => {
        requests.push(request.idempotencyKey);
        if (!sideEffects.has(request.idempotencyKey)) sideEffects.set(request.idempotencyKey, 1);
        return { status: "PASS", runId: request.runId, requestId: request.requestId, snapshotId: request.snapshotId, idempotencyKey: request.idempotencyKey, producer: { kind: "deterministic-verifier", identity: "deduplicating-executor", independence: "independent-producer" }, artifacts: [{ type: "verification-result", digest: "d".repeat(64) }] };
      },
    };
    let throwOnce = true;
    const artifactStore: ArtifactStore = {
      storeVerificationResultArtifact: async artifact => {
        if (throwOnce) { throwOnce = false; throw new Error("artifact storage failed after external completion"); }
        return artifact;
      },
    };
    const dependencies = { ...fakes.dependencies, executor, artifactStore };
    await expect(runOnce(dependencies)).rejects.toThrow("artifact storage failed after external completion");
    await expect(runOnce(dependencies)).resolves.toMatchObject({ run: { state: "TERMINAL" } });
    expect(requests[0]).toBe(requests[1]);
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
    const executor: VerificationExecutor = {
      executeObligation: async executionRequest => {
        executorCalls++;
        requests.push(executionRequest.idempotencyKey);
        if (!sideEffects.has(executionRequest.idempotencyKey)) sideEffects.set(executionRequest.idempotencyKey, 1);
        return { status, runId: executionRequest.runId, requestId: executionRequest.requestId, snapshotId: executionRequest.snapshotId, idempotencyKey: executionRequest.idempotencyKey, producer: { kind: "deterministic-verifier", identity: "deduplicating-executor", independence: "independent-producer" }, artifacts: [{ type: "verification-result", digest: "e".repeat(64) }] };
      },
    };
    const authorities = new Map<string, ExecutionAuthority>();
    const issuedBindings: ExecutionAuthority["binding"][] = [];
    const executionAuthority = {
      issueExecutionAuthority: async (binding: ExecutionAuthority["binding"]): Promise<ExecutionAuthority> => {
        issuedBindings.push(structuredClone(binding));
        const existing = authorities.get(binding.idempotencyKey);
        if (existing) return existing;
        const authority: ExecutionAuthority = { schemaVersion: "verification-execution-authority/v1", authorityId: `authority:${binding.obligationId}`, issuer: "deduplicating-authority", binding: structuredClone(binding) };
        authorities.set(binding.idempotencyKey, authority);
        return authority;
      },
      verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: ExecutionAuthority["binding"]): Promise<boolean> => {
        const stored = authorities.get(binding.idempotencyKey);
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
    expect(executorCalls).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
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

  test("rejects a stale repository writer without overwriting the terminal pair", async () => {
    const fakes = makeDependencies();
    await runOnce(fakes.dependencies, "stale-writer");
    const beforeRun = structuredClone(fakes.repository.runs.get("stale-writer"));
    const beforeExecution = structuredClone(fakes.repository.stageDocuments.get("stale-writer:execution"));
    if (!beforeRun) throw new Error("missing terminal run");
    const accepted = await fakes.repository.commitTransition({ runId: "stale-writer", expectedUpdatedAt: "2026-08-02T00:00:00.000Z", run: beforeRun });
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
