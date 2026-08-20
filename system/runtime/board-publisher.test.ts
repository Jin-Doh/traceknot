import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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

async function replaceEntrypoint(entrypointUri: string, htmlText: string): Promise<void> {
  const sessionRoot = dirname(fileURLToPath(entrypointUri));
  const currentPath = join(sessionRoot, "current.json");
  const current = JSON.parse(await readFile(currentPath, "utf8")) as Record<string, unknown>;
  const revisionRoot = join(sessionRoot, String(current.revisionPath));
  const manifestPath = join(revisionRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown> & { files: Array<Record<string, unknown>> };
  const html = Buffer.from(htmlText);
  await writeFile(join(revisionRoot, "index.html"), html);
  manifest.files = manifest.files.map(file => file.path === "index.html"
    ? { ...file, sha256: createHash("sha256").update(html).digest("hex"), bytes: html.byteLength }
    : file);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes);
  await writeFile(currentPath, `${JSON.stringify({
    ...current,
    entrypointSha256: createHash("sha256").update(html).digest("hex"),
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
  }, null, 2)}\n`);
}

async function replaceManifest(
  entrypointUri: string,
  mutate: (manifest: Record<string, unknown> & { files: Array<Record<string, unknown>> }) => void,
  serialize: (manifest: Record<string, unknown>) => string = manifest => `${JSON.stringify(manifest, null, 2)}\n`,
): Promise<void> {
  const sessionRoot = dirname(fileURLToPath(entrypointUri));
  const currentPath = join(sessionRoot, "current.json");
  const current = JSON.parse(await readFile(currentPath, "utf8")) as Record<string, unknown>;
  const manifestPath = join(sessionRoot, String(current.revisionPath), "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown> & { files: Array<Record<string, unknown>> };
  mutate(manifest);
  const manifestBytes = Buffer.from(serialize(manifest));
  await writeFile(manifestPath, manifestBytes);
  await writeFile(currentPath, `${JSON.stringify({
    ...current,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
  }, null, 2)}\n`);
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
        .rejects.toThrow("invalid stable session link");
    } finally {
      await rm(missingManifest.root, { recursive: true, force: true });
    }

    const missingEntrypoint = await boardFixture();
    try {
      await rm(fileURLToPath(missingEntrypoint.entrypoint));
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${missingEntrypoint.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: missingEntrypoint.root }))
        .rejects.toThrow("invalid stable session link");
    } finally {
      await rm(missingEntrypoint.root, { recursive: true, force: true });
    }
  });
  test("requires every stable localized and evidence indirection", async () => {
    for (const name of ["index.en.html", "index.ko.html", "index.zh-CN.html", "evidence"]) {
      const fixture = await boardFixture();
      try {
        await rm(join(dirname(fileURLToPath(fixture.entrypoint)), name), { recursive: true, force: true });
        const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${fixture.entrypoint}\n` });
        await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: fixture.root }))
          .rejects.toThrow("invalid stable session link");
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
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
  test("rejects a session manifest without the canonical entrypoint contract", async () => {
    const fixture = await boardFixture();
    try {
      const sessionRoot = dirname(fileURLToPath(fixture.entrypoint));
      const currentPath = join(sessionRoot, "current.json");
      const current = JSON.parse(await readFile(currentPath, "utf8")) as Record<string, unknown>;
      const immutableManifestPath = join(sessionRoot, String(current.revisionPath), "manifest.json");
      const manifest = JSON.parse(await readFile(immutableManifestPath, "utf8")) as Record<string, unknown>;
      const invalidBytes = Buffer.from(`${JSON.stringify({ ...manifest, files: [] }, null, 2)}\n`);
      await writeFile(immutableManifestPath, invalidBytes);
      await writeFile(currentPath, `${JSON.stringify({ ...current, manifestSha256: createHash("sha256").update(invalidBytes).digest("hex") }, null, 2)}\n`);
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${fixture.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: fixture.root }))
        .rejects.toThrow("manifest files are invalid");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  test("rejects incomplete, unsafe, or open-shaped current pointer contracts", async () => {
    const mutations: Array<(current: Record<string, unknown>) => void> = [
      current => { delete current.sourceRevision; },
      current => { current.unexpected = true; },
      current => { current.invocationId = "../unsafe"; },
      current => { current.generatedAt = "not-a-timestamp"; },
    ];
    for (const mutate of mutations) {
      const fixture = await boardFixture();
      try {
        const sessionRoot = dirname(fileURLToPath(fixture.entrypoint));
        const currentPath = join(sessionRoot, "current.json");
        const current = JSON.parse(await readFile(currentPath, "utf8")) as Record<string, unknown>;
        mutate(current);
        await writeFile(currentPath, `${JSON.stringify(current, null, 2)}\n`);
        const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${fixture.entrypoint}\n` });
        await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: fixture.root }))
          .rejects.toThrow(/current pointer/u);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });

  test("rejects current metadata that disagrees with the immutable manifest", async () => {
    const mutations: Array<(current: Record<string, unknown>) => void> = [
      current => { current.sourceRevision = Number(current.sourceRevision) + 1; },

      current => { current.invocationId = "different-invocation"; },
      current => { current.generatedAt = "2026-08-19T00:00:01Z"; },
    ];
    for (const mutate of mutations) {
      const fixture = await boardFixture();
      try {
        const currentPath = join(dirname(fileURLToPath(fixture.entrypoint)), "current.json");
        const current = JSON.parse(await readFile(currentPath, "utf8")) as Record<string, unknown>;
        mutate(current);
        await writeFile(currentPath, `${JSON.stringify(current, null, 2)}\n`);
        const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${fixture.entrypoint}\n` });
        await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: fixture.root }))
          .rejects.toThrow("immutable manifest identity does not match current pointer");
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });
  test("rejects invalid manifest timestamps and a mismatched session host", async () => {
    const timestampFixture = await boardFixture();
    try {
      await replaceManifest(timestampFixture.entrypoint, manifest => { manifest.sourceUpdatedAt = "2026-02-31T12:00:00Z"; });
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${timestampFixture.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: timestampFixture.root }))
        .rejects.toThrow("manifest timestamps are invalid");
    } finally {
      await rm(timestampFixture.root, { recursive: true, force: true });
    }

    const hostFixture = await boardFixture();
    try {
      await replaceManifest(hostFixture.entrypoint, manifest => {
        manifest.generatedBy = { ...(manifest.generatedBy as Record<string, unknown>), sessionHost: "different-host" };
      });
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${hostFixture.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: hostFixture.root }))
        .rejects.toThrow("session host does not match");
    } finally {
      await rm(hostFixture.root, { recursive: true, force: true });
    }
  });

  test("rejects an integrity-consistent Board page that exposes the raw session ID", async () => {
    const fixture = await boardFixture();
    try {
      await replaceEntrypoint(fixture.entrypoint, "<!doctype html><p>session session-1</p>");
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${fixture.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: fixture.root }))
        .rejects.toThrow("page exposes the raw session ID");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("accepts a raw session ID only as part of a larger Unicode token", async () => {
    const fixture = await boardFixture();
    try {
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${fixture.entrypoint}\n` });
      for (const html of ["<!doctype html><p>\u{10400}session-1</p>", "<!doctype html><p>session-1\u{1D7D8}</p>"]) {
        await replaceEntrypoint(fixture.entrypoint, html);
        await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: fixture.root }))
          .resolves.toMatchObject({ status: "generated" });
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects an HTML-entity encoded raw session ID", async () => {
    const sessionId = "abcd&efgh";
    const fixture = await boardFixture({ sessionId });
    try {
      await replaceEntrypoint(fixture.entrypoint, "<!doctype html><p>abcd&amp;efgh</p>");
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${fixture.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, sessionId, stateDir: fixture.root }))
        .rejects.toThrow("page exposes the raw session ID");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a JSON-escaped raw session ID in immutable metadata", async () => {
    const sessionId = "abcd&efgh";
    const fixture = await boardFixture({ sessionId });
    try {
      await replaceManifest(
        fixture.entrypoint,
        manifest => { manifest.requestId = sessionId; },
        manifest => `${JSON.stringify(manifest, null, 2).replace(sessionId, "abcd\\u0026efgh")}\n`,
      );
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${fixture.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, sessionId, stateDir: fixture.root }))
        .rejects.toThrow("manifest exposes the raw session ID");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects duplicate declarations and undeclared revision files", async () => {
    const duplicate = await boardFixture();
    try {
      await replaceManifest(duplicate.entrypoint, manifest => { manifest.files.push({ ...manifest.files[1] }); });
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${duplicate.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: duplicate.root }))
        .rejects.toThrow("duplicate file declarations");
    } finally {
      await rm(duplicate.root, { recursive: true, force: true });
    }

    const wrongRole = await boardFixture();
    try {
      await replaceManifest(wrongRole.entrypoint, manifest => {
        const localized = manifest.files.find(file => file.path === "index.ko.html");
        if (localized !== undefined) localized.role = "screenshot-preview";
      });
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${wrongRole.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: wrongRole.root }))
        .rejects.toThrow("manifest role does not match path");
    } finally {
      await rm(wrongRole.root, { recursive: true, force: true });
    }

    const undeclared = await boardFixture();
    try {
      const sessionRoot = dirname(fileURLToPath(undeclared.entrypoint));
      const current = JSON.parse(await readFile(join(sessionRoot, "current.json"), "utf8")) as Record<string, unknown>;
      await writeFile(join(sessionRoot, String(current.revisionPath), "undeclared.txt"), "undeclared");
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${undeclared.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: undeclared.root }))
        .rejects.toThrow("revision inventory does not match");
    } finally {
      await rm(undeclared.root, { recursive: true, force: true });
    }
  });

  test("rejects a selected revision symlink that escapes the requested state root", async () => {
    const fixture = await boardFixture();
    const outsideRoot = await mkdtemp(join(tmpdir(), "traceknot-board-publisher-outside-"));
    try {
      const sessionRoot = dirname(fileURLToPath(fixture.entrypoint));
      const current = JSON.parse(await readFile(join(sessionRoot, "current.json"), "utf8")) as Record<string, unknown>;
      const revisionRoot = join(sessionRoot, String(current.revisionPath));
      const outsideRevision = join(outsideRoot, "revision");
      await rename(revisionRoot, outsideRevision);
      await symlink(outsideRevision, revisionRoot);
      const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "", stderr: `Traceknot Board: ${fixture.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish({ ...request, stateDir: fixture.root }))
        .rejects.toThrow(/selected revision.*escapes/u);
    } finally {
      await Promise.all([rm(fixture.root, { recursive: true, force: true }), rm(outsideRoot, { recursive: true, force: true })]);
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
