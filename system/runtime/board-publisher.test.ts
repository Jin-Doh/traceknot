import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createCanonicalCliBoardPublisher,
  type BoardPublisherInput,
  type CanonicalCliRunner,
} from "./board-publication";
import { parseSessionBoardUpdate, publishSessionBoardUpdate } from "../presentation/qa-board-store";
import type { QaBoardView } from "../presentation/qa-board";

const request: BoardPublisherInput = {
  rootDir: "/repo",
  requestPath: "/state/request.json",
  manifestPath: "/state/manifest.json",
  stateDir: "/state",
  artifactDir: "/state/artifacts",
  runId: "run-1",
  sessionId: "session-1",
  snapshotId: "snapshot-1",
  sessionHost: "codex",
};

type FixtureIdentity = Readonly<{
  runId: string;
  sessionId: string;
  snapshotId: string;
  sessionHost: string;
}>;

async function boardFixture(overrides: Partial<FixtureIdentity> = {}): Promise<Readonly<{ root: string; entrypoint: string; manifestPath: string }>> {
  const identity = { runId: request.runId, sessionId: request.sessionId, snapshotId: request.snapshotId, sessionHost: request.sessionHost, ...overrides };
  const root = await mkdtemp(join(tmpdir(), "traceknot-board-publisher-"));
  const view: QaBoardView = {
    runId: identity.runId,
    requestId: "request-1",
    rootIdentity: "root-1",
    snapshotId: identity.snapshotId,
    revision: 1,
    sourceState: "TERMINAL",
    sourceUpdatedAt: "2026-08-19T00:00:00Z",
    changeSummary: "canonical publisher fixture",
    assurance: { context: "local", requiredIndependence: "separate-verification-context", releaseStatus: "not-evaluated" },
    verdict: "PASS",
    authoritative: false,
    rationale: "fixture passed",
    counts: { mandatory: 0, passed: 0, failed: 0, blocked: 0, incomplete: 0 },
    findings: [],
    coverage: {
      basis: { total: 0, covered: 0, uncoveredIds: [] },
      risks: { total: 0, covered: 0, uncoveredIds: [] },
      conditions: { total: 0, covered: 0, uncoveredIds: [] },
      mandatoryObligations: { total: 0, covered: 0, uncoveredIds: [] },
    },
    openDefectIds: [],
    acceptedRiskIds: [],
    residualRisks: [],
  };
  const publication = await publishSessionBoardUpdate({
    update: parseSessionBoardUpdate({
      schemaVersion: "traceknot-session-board-update/v1",
      sessionId: identity.sessionId,
      sessionHost: identity.sessionHost,
      generatedAt: "2026-08-19T00:00:00Z",
      invocationId: "publisher-fixture",
      view,
    }),
    stateDir: root,
    artifactReader: { readArtifact: async () => new Uint8Array() },
  });
  return Object.freeze({ root, entrypoint: publication.entrypointUri, manifestPath: join(dirname(fileURLToPath(publication.entrypointUri)), "manifest.json") });
}

describe("canonical Board publisher", () => {
  test("invokes the CLI without shell interpolation and binds the observed session Board", async () => {
    const fixture = await boardFixture();
    try {
      let received: readonly string[] | undefined;
      const runner: CanonicalCliRunner = async (command, cwd) => {
        received = command;
        expect(cwd).toBe("/repo");
        return { exitCode: 0, stdout: "verification\n", stderr: `Traceknot Board: ${fixture.entrypoint}\n` };
      };
      const result = await createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: fixture.root });
      expect(received).toEqual([
        "/bin/traceknot",
        "verify",
        "--root",
        "/repo",
        "--request",
        "/state/request.json",
        "--manifest",
        "/state/manifest.json",
        "--state-dir",
        fixture.root,
        "--artifact-dir",
        "/state/artifacts",
        "--run-id",
        "run-1",
        "--session-id",
        "session-1",
        "--session-host",
        "codex",
        "--board",
      ]);
      expect(result).toEqual({
        status: "generated",
        publisher: "canonical-cli",
        entrypoint: fixture.entrypoint,
        manifestPath: fixture.manifestPath,
        runId: "run-1",
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a non-session Board even when legacy files exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceknot-board-publisher-legacy-"));
    const directory = join(root, "runs", "run-1", "boards", "11-invocation");
    const entrypointPath = join(directory, "index.html");
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(entrypointPath, "<!doctype html>");
      await writeFile(join(directory, "manifest.json"), "{}");
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${pathToFileURL(entrypointPath).href}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: root }))
        .rejects.toThrow("non-session Board URI");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when a reported session Board file is missing", async () => {
    const missingManifest = await boardFixture();
    try {
      await rm(missingManifest.manifestPath);
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${missingManifest.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: missingManifest.root }))
        .rejects.toThrow("Board manifest that does not exist");
    } finally {
      await rm(missingManifest.root, { recursive: true, force: true });
    }

    const missingEntrypoint = await boardFixture();
    try {
      await rm(fileURLToPath(missingEntrypoint.entrypoint));
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${missingEntrypoint.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: missingEntrypoint.root }))
        .rejects.toThrow("Board entrypoint that does not exist");
    } finally {
      await rm(missingEntrypoint.root, { recursive: true, force: true });
    }
  });

  test("rejects snapshot and run identity mismatches", async () => {
    for (const overrides of [{ snapshotId: "snapshot-other" }, { runId: "run-other" }]) {
      const fixture = await boardFixture(overrides);
      try {
        const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${fixture.entrypoint}\n` });
        await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: fixture.root }))
          .rejects.toThrow(/(?:snapshot|run) identity does not match the request/u);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });
  test("rejects a valid session Board outside the requested state directory", async () => {
    const fixture = await boardFixture();
    const requestedState = await mkdtemp(join(tmpdir(), "traceknot-board-publisher-requested-"));
    try {
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${fixture.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: requestedState }))
        .rejects.toThrow("outside the requested state directory");
    } finally {
      await Promise.all([rm(fixture.root, { recursive: true, force: true }), rm(requestedState, { recursive: true, force: true })]);
    }
  });


  test("accepts a verdict exit code after validating the published session Board", async () => {
    const fixture = await boardFixture();
    try {
      const runner: CanonicalCliRunner = async () => ({ exitCode: 1, stdout: "", stderr: `Traceknot Board: ${fixture.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: fixture.root })).resolves.toMatchObject({
        status: "generated",
        entrypoint: fixture.entrypoint,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("fails closed on an unsupported non-zero CLI exit", async () => {
    const runner: CanonicalCliRunner = async () => ({ exitCode: 64, stdout: "", stderr: "usage" });
    await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish(request))
      .rejects.toThrow("canonical Board publisher failed (64): usage");
  });

  test("fails closed when the CLI omits the Board URI", async () => {
    const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "PASS\n", stderr: "" });
    await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish(request))
      .rejects.toThrow("did not report a file URI");
  });
});
