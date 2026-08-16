import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalArtifactStore, secureFlock } from "./local-artifact-store";
import { inspectStorage, pinRun, pruneStorage, unpinRun, type StorageRetentionPolicy } from "./storage-retention";
import Ajv2020 from "ajv/dist/2020";

const NOW = "2026-08-15T00:00:00.000Z";
const OLD = "2025-01-01T00:00:00.000Z";
const digest = "a".repeat(64);
const policy: StorageRetentionPolicy = { boardTtlMs: 1, boardMaxPerRun: 1, boardQuotaBytes: 1, canonicalRunTtlMs: 1, canonicalQuotaBytes: 1, graceMs: 1 };
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; state: string; artifacts: string }> {
  const root = await mkdtemp(join(tmpdir(), "traceknot-retention-"));
  fixtureRoots.push(root);
  const state = join(root, "state");
  const artifacts = join(root, "artifacts");
  await mkdir(join(state, "runs"), { recursive: true });
  await mkdir(join(artifacts, ".objects"), { recursive: true });
  return { root, state, artifacts };
}
async function run(state: string, runId: string, value: { state: string; updatedAt: string | number; digest?: string }): Promise<void> {
  const path = join(state, "runs", runId);
  await mkdir(path, { recursive: true });
  const stateValue = { schemaVersion: "traceknot-state/v1", run: { schemaVersion: "verification-run/v1", runId, requestId: `request-${runId}`, rootIdentity: "root", snapshotId: "snapshot", state: value.state, observationIds: [], claimIds: [], evaluationIds: [], revision: 1, createdAt: value.updatedAt, updatedAt: value.updatedAt }, documents: value.digest ? { evidence: { artifacts: [{ digest: value.digest }] } } : {}, dispatch: {} };
  await writeFile(join(path, "state.json"), `${JSON.stringify(stateValue)}\n`);
  await utimes(path, new Date(OLD), new Date(OLD));
}

async function board(state: string, runId: string, boardId: string, generatedAt = OLD): Promise<void> {
  const path = join(state, "runs", runId, "boards", boardId);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "index.html"), "<html></html>");
  await writeFile(join(path, "manifest.json"), JSON.stringify({ schemaVersion: "traceknot-qa-board/v1", runId, requestId: "request", rootIdentity: "root", snapshotId: "snapshot", sourceRevision: 1, sourceState: "TERMINAL", sourceUpdatedAt: generatedAt, generatedAt, entrypoint: "index.html", authoritative: false, assurance: { context: "release", requiredIndependence: "separate-verification-context", releaseStatus: "satisfied" }, verdict: "PASS", counts: { mandatory: 0, passed: 0, failed: 0, blocked: 0, incomplete: 0 }, generatedBy: { invocationId: boardId, sessionHost: "test", sessionRef: "test" }, files: [{ path: "index.html", role: "entrypoint", sha256: digest, bytes: 13 }] }));
  await utimes(path, new Date(OLD), new Date(OLD));
}
function storageCli(args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../bin/traceknot"), "storage", ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout?.toString() ?? "", stderr: result.stderr?.toString() ?? "" };
}


describe("storage retention", () => {
  test("inventory is deterministic and does not follow symlinks", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "terminal", { state: "TERMINAL", updatedAt: NOW });
    await symlink("/tmp", join(state, "runs", "external"));
    await writeFile(join(artifacts, ".objects", digest), "object");
    const report = await inspectStorage({ stateDir: state, artifactDir: artifacts, now: NOW });
    expect(report.counts.runs).toBe(1);
    expect(report.counts.symlinks).toBe(1);
    expect(report.objects[0]?.relativePath).toBe(`.objects/${digest}`);
  });
  test("emits maintenance reports conforming to the public schema", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "terminal", { state: "TERMINAL", updatedAt: NOW });
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy });
    const schema = JSON.parse(await Bun.file(join(import.meta.dir, "../../contracts/storage-maintenance-report.schema.json")).text()) as object;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    expect(validate(report), validate.errors ? JSON.stringify(validate.errors) : undefined).toBe(true);
    expect(validate({ ...report, unexpected: true })).toBe(false);
  });


  test("shared digests survive run pruning and dry-run candidates match apply", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "old", { state: "TERMINAL", updatedAt: OLD, digest });
    await run(state, "new", { state: "TERMINAL", updatedAt: NOW, digest });
    await writeFile(join(artifacts, ".objects", digest), "object");
    await utimes(join(artifacts, ".objects", digest), new Date(OLD), new Date(OLD));
    const dry = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy });
    const applied = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true });
    expect(dry.candidates).toEqual({ ...applied.candidates, collector: dry.candidates.collector, staging: dry.candidates.staging });
    expect(dry.candidates.runs).toContain("runs/old/state.json");
    expect(dry.candidates.objects).not.toContain(`.objects/${digest}`);
    expect(applied.deleted.objects).not.toContain(`.objects/${digest}`);
  });
  test("canonical quota includes deduplicated referenced object bytes", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "old", { state: "TERMINAL", updatedAt: NOW, digest });
    await run(state, "new", { state: "TERMINAL", updatedAt: NOW, digest });
    await writeFile(join(artifacts, ".objects", digest), "0123456789");
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy: { ...policy, canonicalRunTtlMs: 365 * 24 * 60 * 60 * 1000, canonicalQuotaBytes: 1 } });
    expect(report.candidates.runs).toContain("runs/old/state.json");
    expect(report.candidates.runs).not.toContain("runs/new/state.json");
  });

  test("pins are durable and protect an old terminal run", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "pinned", { state: "TERMINAL", updatedAt: OLD });
    await run(state, "newest", { state: "TERMINAL", updatedAt: NOW });
    await pinRun(state, "pinned");
    const protectedReport = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy });
    expect(protectedReport.candidates.runs).not.toContain("runs/pinned/state.json");
    await unpinRun(state, "pinned");
    const unpinnedReport = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy });
    expect(unpinnedReport.candidates.runs).toContain("runs/pinned/state.json");
  });

  test("board count and TTL retain the newest immutable publication", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "active", { state: "EXECUTING", updatedAt: NOW });
    await board(state, "active", "1-old", OLD);
    await board(state, "active", "2-new", NOW);
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy: { ...policy, boardQuotaBytes: 1024 * 1024 } });
    expect(report.candidates.boards).toEqual(["runs/active/boards/1-old"]);
    expect(report.candidates.boards).not.toContain("runs/active/boards/2-new");
  });

  test("Board TTL and global quota apply independently of per-run count", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "old-run", { state: "EXECUTING", updatedAt: NOW });
    await run(state, "fresh-run", { state: "EXECUTING", updatedAt: NOW });
    await board(state, "old-run", "only-old", OLD);
    await board(state, "fresh-run", "only-fresh", NOW);
    const ttl = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy: { ...policy, boardMaxPerRun: 10, boardQuotaBytes: 1024 * 1024 } });
    expect(ttl.candidates.boards).toEqual(["runs/old-run/boards/only-old"]);
    const quota = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy: { ...policy, boardTtlMs: 365 * 24 * 60 * 60 * 1000, boardMaxPerRun: 10, boardQuotaBytes: 1 } });
    expect(quota.candidates.boards).toEqual(["runs/fresh-run/boards/only-fresh", "runs/old-run/boards/only-old"]);
  });

  test("malformed Board manifests remain protected from automatic deletion", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "active", { state: "EXECUTING", updatedAt: NOW });
    await board(state, "active", "damaged", OLD);
    const manifestPath = join(state, "runs", "active", "boards", "damaged", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<Record<string, unknown>> };
    delete manifest.files[0]!.bytes;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy });
    expect(report.candidates.boards).toEqual([]);
    expect(report.protected.malformed).toContain("runs/active/boards/damaged");
  });
  test("Board manifests without assurance remain protected from automatic deletion", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "active", { state: "EXECUTING", updatedAt: NOW });
    await board(state, "active", "missing-assurance", OLD);
    const manifestPath = join(state, "runs", "active", "boards", "missing-assurance", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.assurance;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy });
    expect(report.candidates.boards).toEqual([]);
    expect(report.protected.malformed).toContain("runs/active/boards/missing-assurance");
  });

  test("board max zero does not retain any publication", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "active", { state: "EXECUTING", updatedAt: NOW });
    await board(state, "active", "only", OLD);
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy: { ...policy, boardMaxPerRun: 0 } });
    expect(report.candidates.boards).toEqual(["runs/active/boards/only"]);
  });

  test("last object reference receives a full grace interval", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "old", { state: "TERMINAL", updatedAt: OLD, digest });
    await run(state, "new", { state: "TERMINAL", updatedAt: NOW });
    await writeFile(join(artifacts, ".objects", digest), "object");
    await utimes(join(artifacts, ".objects", digest), new Date(OLD), new Date(OLD));
    const first = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy: { ...policy, graceMs: 1000 }, apply: true });
    expect(first.deleted.objects).not.toContain(`.objects/${digest}`);
    const second = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: "2026-08-15T00:00:01.002Z", policy: { ...policy, graceMs: 1000 }, apply: true });
    expect(second.deleted.objects).toContain(`.objects/${digest}`);
  });
  test("stale GC marks reset when pruning the last referencing run", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "old", { state: "TERMINAL", updatedAt: OLD, digest });
    await run(state, "new", { state: "TERMINAL", updatedAt: NOW });
    const objectPath = join(artifacts, ".objects", digest);
    await writeFile(objectPath, "object");
    await utimes(objectPath, new Date(OLD), new Date(OLD));
    await writeFile(join(artifacts, ".traceknot-gc-marks.json"), `${JSON.stringify({ schemaVersion: "traceknot-gc-marks/v1", marks: { [digest]: Date.parse(OLD) } })}\n`);
    const first = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy: { ...policy, graceMs: 1000 }, apply: true });
    expect(first.deleted.runs).toContain("runs/old/state.json");
    expect(first.deleted.objects).not.toContain(`.objects/${digest}`);
    const gcState = JSON.parse(await readFile(join(artifacts, ".traceknot-gc-marks.json"), "utf8")) as { marks: Record<string, number> };
    expect(gcState.marks[digest]).toBe(Date.parse(NOW));
    const second = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: "2026-08-15T00:00:01.002Z", policy: { ...policy, graceMs: 1000 }, apply: true });
    expect(second.deleted.objects).toContain(`.objects/${digest}`);
  });


  test("refreshing an unreferenced object restarts its GC grace interval", async () => {
    const { state, artifacts } = await fixture();
    const objectPath = join(artifacts, ".objects", digest);
    await writeFile(objectPath, "object");
    await utimes(objectPath, new Date(OLD), new Date(OLD));
    await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy: { ...policy, graceMs: 1000 }, apply: true });
    await utimes(objectPath, new Date("2026-08-15T00:00:00.500Z"), new Date("2026-08-15T00:00:00.500Z"));
    const refreshed = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: "2026-08-15T00:00:02.000Z", policy: { ...policy, graceMs: 1000 }, apply: true });
    expect(refreshed.deleted.objects).not.toContain(`.objects/${digest}`);
    const expired = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: "2026-08-15T00:00:03.002Z", policy: { ...policy, graceMs: 1000 }, apply: true });
    expect(expired.deleted.objects).toContain(`.objects/${digest}`);
  });

  test("malformed run state disables canonical object deletion", async () => {
    const { state, artifacts } = await fixture();
    const malformed = join(state, "runs", "malformed");
    await mkdir(malformed, { recursive: true });
    await writeFile(join(malformed, "state.json"), "not json");
    await writeFile(join(artifacts, ".objects", digest), "object");
    await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy: { ...policy, graceMs: 1000 }, apply: true });
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: "2026-08-15T00:00:02.000Z", policy: { ...policy, graceMs: 1000 }, apply: true });
    expect(report.deleted.objects).toEqual([]);
    expect(report.warnings).toContain("malformed run state disables canonical object deletion");
  });

  test("reclaims exact crash-left artifact temporaries but preserves unknown files", async () => {
    const { state, artifacts } = await fixture();
    const temporaryName = `.tmp-${digest}-${randomUUID()}`;
    const temporaryPath = join(artifacts, ".objects", temporaryName);
    const unknownPath = join(artifacts, ".objects", "unexpected");
    await writeFile(temporaryPath, "temporary");
    await writeFile(unknownPath, "unknown");
    await utimes(temporaryPath, new Date(OLD), new Date(OLD));
    await utimes(unknownPath, new Date(OLD), new Date(OLD));
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy: { ...policy, graceMs: 0 }, apply: true });
    expect(report.deleted.staging).toContain(`.objects/${temporaryName}`);
    expect(await stat(temporaryPath).catch(() => undefined)).toBeUndefined();
    expect((await stat(unknownPath)).isFile()).toBe(true);
    expect(report.inventory.objects).toEqual(expect.arrayContaining([expect.objectContaining({ relativePath: ".objects/unexpected", malformed: true })]));
  });

  test("explicitly protected source runs survive a maintenance pass", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "source", { state: "TERMINAL", updatedAt: OLD });
    await run(state, "newest", { state: "TERMINAL", updatedAt: NOW });
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, protectedRunIds: ["source"], apply: true });
    expect(report.deleted.runs).not.toContain("runs/source/state.json");
    expect(report.protected.requestedRuns).toEqual(["runs/source"]);
    expect(await readFile(join(state, "runs", "source", "state.json"), "utf8")).toContain("traceknot-state/v1");
  });

  test("expired canonical state does not remove retained Boards", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "old", { state: "TERMINAL", updatedAt: OLD });
    await writeFile(join(state, "runs", "old", "metadata.json"), "{\"schemaVersion\":\"traceknot-cli-state/v1\"}\n");
    await run(state, "new", { state: "TERMINAL", updatedAt: NOW });
    await board(state, "old", "retained", NOW);
    const applied = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy: { ...policy, boardQuotaBytes: 1024 * 1024 }, apply: true });
    expect(applied.deleted.runs).toContain("runs/old/state.json");
    const after = await inspectStorage({ stateDir: state, artifactDir: artifacts, now: NOW });
    expect(after.boards.map(item => item.relativePath)).toContain("runs/old/boards/retained");
    expect(await stat(join(state, "runs", "old", "metadata.json")).catch(() => undefined)).toBeUndefined();
    expect(after.runs.map(item => item.relativePath)).not.toContain("runs/old");
  });
  test("removes empty Board and run containers after combined expiry", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "old", { state: "TERMINAL", updatedAt: OLD });
    await board(state, "old", "expired", OLD);
    await run(state, "new", { state: "TERMINAL", updatedAt: NOW });
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true });
    expect(report.deleted.boards).toContain("runs/old/boards/expired");
    expect(report.deleted.runs).toContain("runs/old/state.json");
    expect(await stat(join(state, "runs", "old")).catch(() => undefined)).toBeUndefined();
  });


  test("malformed pins fail closed", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "old", { state: "TERMINAL", updatedAt: OLD });
    await writeFile(join(state, ".traceknot-pins.json"), "{malformed");
    const dry = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy });
    expect(dry.inventory.counts.pinFileMalformed).toBe(true);
    expect(dry.candidates.runs).toEqual([]);
    await expect(pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true })).rejects.toThrow("pin file is malformed");
  });

  test("does not prune a canonical run while its repository lock exists", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "old", { state: "TERMINAL", updatedAt: OLD });
    await run(state, "new", { state: "TERMINAL", updatedAt: NOW });
    const lockPath = join(state, "runs", "old", ".state.lock");
    const descriptor = openSync(lockPath, "a+");
    secureFlock(descriptor, 2);
    try {
      const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true });
      expect(report.deleted.runs).not.toContain("runs/old/state.json");
      expect(await readFile(join(state, "runs", "old", "state.json"), "utf8")).toContain("traceknot-state/v1");
    } finally {
      secureFlock(descriptor, 8);
      closeSync(descriptor);
    }
  });

  test("reuses an abandoned persistent repository lock when pruning", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "old", { state: "TERMINAL", updatedAt: OLD });
    await run(state, "new", { state: "TERMINAL", updatedAt: NOW });
    const lockPath = join(state, "runs", "old", ".state.lock");
    await writeFile(lockPath, "crashed-writer");
    await utimes(lockPath, new Date(OLD), new Date(OLD));
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true });
    expect(report.deleted.runs).toContain("runs/old/state.json");
    expect(await stat(lockPath).catch(() => undefined)).toBeUndefined();
  });
  test("removes crash-left atomic write files with an expired run", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "old", { state: "TERMINAL", updatedAt: OLD });
    await run(state, "new", { state: "TERMINAL", updatedAt: NOW });
    const temporary = join(state, "runs", "old", ".00000000-0000-4000-8000-000000000000.tmp");
    await writeFile(temporary, "partial");
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true });
    expect(report.deleted.runs).toContain("runs/old/state.json");
    expect(await stat(temporary).catch(() => undefined)).toBeUndefined();
  });

  test("reports canonical cleanup incomplete when unknown remnants exist", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "old", { state: "TERMINAL", updatedAt: OLD });
    await run(state, "new", { state: "TERMINAL", updatedAt: NOW });
    await writeFile(join(state, "runs", "old", "unknown"), "preserve");
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true });
    expect(report.deleted.runs).not.toContain("runs/old/state.json");
    expect(await readFile(join(state, "runs", "old", "state.json"), "utf8")).toContain("traceknot-state/v1");
  });


  test("serializes applied maintenance with a stable advisory lock", async () => {
    const { state, artifacts } = await fixture();
    const lockPath = join(state, ".traceknot-storage.lock");
    const descriptor = openSync(lockPath, "a+");
    secureFlock(descriptor, 2);
    try {
      await expect(pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true })).rejects.toThrow();
    } finally {
      secureFlock(descriptor, 8);
      closeSync(descriptor);
    }
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true });
    expect(report.applied).toBe(true);
  });

  test("coordinates maintenance with canonical artifact publication", async () => {
    const { state, artifacts } = await fixture();
    const lockPath = join(artifacts, ".artifact.lock");
    const descriptor = openSync(lockPath, "a+");
    secureFlock(descriptor, 2);
    try {
      await expect(pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true })).rejects.toThrow();
    } finally {
      secureFlock(descriptor, 8);
      closeSync(descriptor);
    }
    expect((await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true })).applied).toBe(true);
  });

  test("does not traverse or remove symlinks inside stale collector trees", async () => {
    const { root, state, artifacts } = await fixture();
    const external = join(root, "external.txt");
    const collector = join(artifacts, ".collector-stale");
    await writeFile(external, "protected");
    await mkdir(join(collector, ".objects"), { recursive: true });
    await writeFile(join(collector, ".objects", digest), "temporary");
    await utimes(join(collector, ".objects", digest), new Date(OLD), new Date(OLD));
    await utimes(join(collector, ".objects"), new Date(OLD), new Date(OLD));
    await symlink(external, join(collector, "escape"));
    await utimes(collector, new Date(OLD), new Date(OLD));
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true });
    expect(report.deleted.collector).not.toContain(".collector-stale");
    expect(await readFile(external, "utf8")).toBe("protected");
  });

  test("removes complete stale invocation collector roots", async () => {
    const { state, artifacts } = await fixture();
    const collector = join(artifacts, ".collector-complete");
    await mkdir(join(collector, ".objects"), { recursive: true });
    await writeFile(join(collector, ".objects", digest), "temporary");
    await writeFile(join(collector, ".artifact.lock"), "");
    await utimes(join(collector, ".objects", digest), new Date(OLD), new Date(OLD));
    await utimes(join(collector, ".objects"), new Date(OLD), new Date(OLD));
    await utimes(join(collector, ".artifact.lock"), new Date(OLD), new Date(OLD));
    await utimes(collector, new Date(OLD), new Date(OLD));
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true });
    expect(report.deleted.collector).toContain(".collector-complete");
    expect(await stat(collector).catch(() => undefined)).toBeUndefined();
  });

  test("does not prune collector roots with recent descendants", async () => {
    const { state, artifacts } = await fixture();
    const collector = join(artifacts, ".collector-active");
    await mkdir(join(collector, ".objects"), { recursive: true });
    await writeFile(join(collector, ".objects", digest), "active");
    await utimes(collector, new Date(OLD), new Date(OLD));
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy });
    expect(report.candidates.collector).not.toContain(".collector-active");
  });

  test("does not delete a live collector even with zero grace", async () => {
    const { state, artifacts } = await fixture();
    const collector = join(artifacts, ".collector-live");
    const store = new LocalArtifactStore({ rootDir: collector, ephemeral: true });
    try {
      const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: new Date(Date.now() + 1000), policy: { ...policy, graceMs: 0 }, apply: true });
      expect(report.deleted.collector).not.toContain(".collector-live");
      expect((await stat(collector)).isDirectory()).toBe(true);
    } finally {
      await store.destroyContents();
    }
  });

  test("inventories and removes empty stale invocation collector roots", async () => {
    const { state, artifacts } = await fixture();
    const collector = join(artifacts, ".collector-empty");
    await mkdir(collector);
    await utimes(collector, new Date(OLD), new Date(OLD));
    const inventory = await inspectStorage({ stateDir: state, artifactDir: artifacts, now: NOW });
    expect(inventory.collector.map(entry => entry.relativePath)).toContain(".collector-empty");
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true });
    expect(report.deleted.collector).toContain(".collector-empty");
    expect(await stat(collector).catch(() => undefined)).toBeUndefined();
  });

  test("storage CLI reports policy units and rejects ignored options", async () => {
    const { state, artifacts } = await fixture();
    const status = storageCli(["status", "--state-dir", state, "--artifact-dir", artifacts, "--now", NOW]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual(expect.objectContaining({ schemaVersion: "traceknot-storage-inventory/v1" }));
    const prune = storageCli(["prune", "--state-dir", state, "--artifact-dir", artifacts, "--now", NOW, "--board-ttl-days", "0.0000001"]);
    expect(prune.exitCode).toBe(0);
    expect(JSON.parse(prune.stdout)).toEqual(expect.objectContaining({ policy: expect.objectContaining({ boardTtlMs: 8 }) }));
    expect(storageCli(["status", "--state-dir", state, "--artifact-dir", artifacts, "--run-id", "ignored"]).exitCode).toBe(64);
    expect(storageCli(["pin", "../unsafe", "--state-dir", state, "--artifact-dir", artifacts]).exitCode).toBe(64);
    expect(storageCli(["prune", "--help"]).exitCode).toBe(0);
  });

  test("malformed state and future timestamps remain protected", async () => {
    const { state, artifacts } = await fixture();
    const malformed = join(state, "runs", "malformed");
    await mkdir(malformed, { recursive: true });
    await writeFile(join(malformed, "state.json"), "not json");
    await run(state, "future", { state: "TERMINAL", updatedAt: "2027-01-01T00:00:00.000Z" });
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy });
    expect(report.protected.malformed).toContain("runs/malformed");
    expect(report.protected.future).toContain("runs/future");
  });
  test("noncanonical run fields remain malformed and protected", async () => {
    const { state, artifacts } = await fixture();
    await run(state, "noncanonical", { state: "TERMINAL", updatedAt: 0 });
    await run(state, "newest", { state: "TERMINAL", updatedAt: NOW });
    const report = await pruneStorage({ stateDir: state, artifactDir: artifacts, now: NOW, policy, apply: true });
    expect(report.protected.malformed).toContain("runs/noncanonical");
    expect(report.deleted.runs).not.toContain("runs/noncanonical/state.json");
    expect(await stat(join(state, "runs", "noncanonical", "state.json"))).toBeDefined();
  });

});

