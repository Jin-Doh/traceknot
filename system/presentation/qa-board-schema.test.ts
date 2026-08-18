import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseSessionBoardUpdate, publishSessionBoardUpdate, type SessionBoardUpdate } from "./qa-board-store";
import type { QaBoardView } from "./qa-board";
import { pruneStorage } from "../runtime/storage-retention";

const root = resolve(import.meta.dir, "../..");
const readSchema = (name: string): object => JSON.parse(readFileSync(join(root, "contracts", name), "utf8")) as object;

function updateSchemaValidator(): (value: unknown) => boolean {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addSchema(readSchema("qa-board-view.schema.json"));
  return ajv.compile(readSchema("traceknot-session-board-update.schema.json"));
}

function view(overrides: Partial<QaBoardView> = {}): QaBoardView {
  return {
    runId: "run-1",
    requestId: "request-1",
    rootIdentity: "root-1",
    snapshotId: "snapshot-1",
    revision: 1,
    sourceState: "TERMINAL",
    sourceUpdatedAt: "2026-08-18T00:00:00Z",
    changeSummary: "schema contract test",
    assurance: { context: "release", requiredIndependence: "separate-verification-context", releaseStatus: "satisfied" },
    verdict: "PASS",
    authoritative: false,
    rationale: "all mandatory obligations passed",
    counts: { mandatory: 1, passed: 1, failed: 0, blocked: 0, incomplete: 0 },
    findings: [{
      obligationId: "obligation-1",
      mandatory: true,
      status: "PASS",
      expectedResults: ["command exits successfully"],
      summary: "verification passed",
      producer: { kind: "deterministic-verifier", identity: "traceknot", independence: "separate-verification-context" },
      evaluation: { status: "ACCEPTED", rejectionReasons: [] },
      screenshots: [],
      artifacts: [{ type: "verification-result", digest: "a".repeat(64), path: "evidence/result.json" }],
    }],
    coverage: {
      basis: { total: 1, covered: 1, uncoveredIds: [] },
      risks: { total: 1, covered: 1, uncoveredIds: [] },
      conditions: { total: 1, covered: 1, uncoveredIds: [] },
      mandatoryObligations: { total: 1, covered: 1, uncoveredIds: [] },
    },
    openDefectIds: [],
    acceptedRiskIds: [],
    residualRisks: [],
    ...overrides,
  };
}

function update(viewValue = view()): SessionBoardUpdate {
  return {
    schemaVersion: "traceknot-session-board-update/v1",
    sessionId: "session-1",
    sessionHost: "omp",
    generatedAt: "2026-08-18T00:00:00Z",
    invocationId: "inv-1",
    view: viewValue,
  };
}

test("the public session update schema accepts the canonical parser shape", () => {
  const validate = updateSchemaValidator();
  expect(validate(update())).toBe(true);
  expect(() => parseSessionBoardUpdate(update())).not.toThrow();
});

test("the public session update schema rejects invalid closed shapes and bounded timestamps", () => {
  const validate = updateSchemaValidator();
  const extraFinding = structuredClone(update());
  (extraFinding.view.findings[0] as Record<string, unknown>).unexpected = true;
  expect(validate(extraFinding)).toBe(false);
  expect(() => parseSessionBoardUpdate(extraFinding)).toThrow();

  const unsafePath = structuredClone(update());
  (unsafePath.view.findings[0]!.artifacts[0] as Record<string, unknown>).path = "../result.json";
  expect(validate(unsafePath)).toBe(false);
  expect(() => parseSessionBoardUpdate(unsafePath)).toThrow();

  const invalidTimestamp = { ...structuredClone(update()), generatedAt: "2026-99-99T99:99:99Z" };
  expect(validate(invalidTimestamp)).toBe(false);
  expect(() => parseSessionBoardUpdate(invalidTimestamp)).toThrow("timestamp");

  const contradictoryPass = update(view({
    counts: { mandatory: 1, passed: 0, failed: 1, blocked: 0, incomplete: 0 },
    findings: [{
      obligationId: "obligation-1",
      mandatory: true,
      status: "FAIL",
      expectedResults: ["command exits successfully"],
      summary: "verification failed",
      screenshots: [],
      artifacts: [],
    }],
    coverage: {
      basis: { total: 1, covered: 1, uncoveredIds: [] },
      risks: { total: 1, covered: 1, uncoveredIds: [] },
      conditions: { total: 1, covered: 1, uncoveredIds: [] },
      mandatoryObligations: { total: 1, covered: 0, uncoveredIds: ["obligation-1"] },
    },
  }));
  expect(validate(contradictoryPass)).toBe(false);
  expect(() => parseSessionBoardUpdate(contradictoryPass)).toThrow("precedence");
});

test("the runtime parser is the canonical validator for cross-field and calendar semantics", () => {
  const validate = updateSchemaValidator();
  const inconsistentCounts = update(view({
    counts: { mandatory: 2, passed: 2, failed: 0, blocked: 0, incomplete: 0 },
  }));
  expect(validate(inconsistentCounts)).toBe(true);
  expect(() => parseSessionBoardUpdate(inconsistentCounts)).toThrow("does not match findings");

  const nonLeapDay = { ...structuredClone(update()), generatedAt: "2025-02-29T00:00:00Z" };
  expect(validate(nonLeapDay)).toBe(true);
  expect(() => parseSessionBoardUpdate(nonLeapDay)).toThrow("timestamp");
});

test("a real emitted session storage maintenance report validates its closed board entry", async () => {
  const temp = await mkdtemp(join(tmpdir(), "traceknot-board-schema-test-"));
  const stateDir = join(temp, "state");
  const artifactDir = join(temp, "artifacts");
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(artifactDir, { mode: 0o700 });
  try {
    const publication = await publishSessionBoardUpdate({
      update: parseSessionBoardUpdate(update()),
      stateDir,
      artifactReader: { readArtifact: async () => new Uint8Array() },
    });
    const report = await pruneStorage({ stateDir, artifactDir, now: "2026-08-18T00:00:00Z" });
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(readSchema("storage-maintenance-report.schema.json"));
    expect(validate(report), validate.errors ? JSON.stringify(validate.errors) : undefined).toBe(true);
    const validateCurrent = new Ajv2020({ strict: true, allErrors: true }).compile(readSchema("traceknot-session-board-current.schema.json"));
    expect(validateCurrent(publication.current), validateCurrent.errors ? JSON.stringify(validateCurrent.errors) : undefined).toBe(true);
    const sessionEntry = report.inventory.boards.find(entry => entry.sessionKey === publication.sessionKey);
    expect(sessionEntry).toMatchObject({ kind: "board", sessionKey: publication.sessionKey, sourceState: "TERMINAL" });
    expect(JSON.parse(await readFile(join(publication.directory, "manifest.json"), "utf8")).sessionKey).toBe(publication.sessionKey);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
