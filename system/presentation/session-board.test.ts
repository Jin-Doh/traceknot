import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readlink, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionBoardUpdate, publishSessionBoardUpdate, sessionBoardKey, verifySessionBoardPublication, type SessionBoardUpdate } from "./qa-board-store";
import type { QaBoardView } from "./qa-board";

const view = (revision: number, sourceState: QaBoardView["sourceState"] = "TERMINAL"): QaBoardView => ({
  runId: "run-1",
  requestId: "request-1",
  rootIdentity: "root-1",
  snapshotId: "snapshot-1",
  revision,
  sourceState,
  sourceUpdatedAt: "2026-08-18T00:00:00Z",
  changeSummary: "session Board test",
  assurance: { context: "release", requiredIndependence: "separate-verification-context", releaseStatus: "satisfied" },
  verdict: "PASS",
  authoritative: false,
  rationale: "test",
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
});

const update = (revision: number, invocationId: string, sourceState: QaBoardView["sourceState"] = "TERMINAL"): SessionBoardUpdate => ({
  schemaVersion: "traceknot-session-board-update/v1",
  sessionId: "raw-session-id",
  sessionHost: "omp",
  generatedAt: `2026-08-18T00:00:0${revision}Z`,
  invocationId,
  view: view(revision, sourceState),
});

async function fixture(): Promise<{ stateDir: string; artifactReader: { readArtifact: (digest: string) => Promise<Uint8Array> } }> {
  const stateDir = await mkdtemp(join(tmpdir(), "traceknot-session-board-test-"));
  return { stateDir, artifactReader: { readArtifact: async () => new Uint8Array() } };
}

describe("session Board contract", () => {
  test("rejects malformed presentation input and authoritative views", () => {
    expect(() => parseSessionBoardUpdate({ ...update(1, "inv-1"), view: { ...view(1), authoritative: true } })).toThrow("authoritative");
    expect(() => parseSessionBoardUpdate({ ...update(1, "inv-1"), generatedAt: "not-a-timestamp" })).toThrow("timestamp");
    expect(() => parseSessionBoardUpdate({ ...update(1, "inv-1"), view: { ...view(1), counts: { mandatory: 1, passed: 0, failed: 0, blocked: 0, incomplete: 0 } } })).toThrow("inconsistent");
  });

  test("rejects malformed pin state before reclaiming revisions", async () => {
    for (const pins of ["{", "{}"]) {
      const fixtureValue = await fixture();
      const first = await publishSessionBoardUpdate({ update: parseSessionBoardUpdate(update(1, "inv-1")), ...fixtureValue });
      await writeFile(join(fixtureValue.stateDir, ".traceknot-pins.json"), pins);
      await expect(publishSessionBoardUpdate({ update: parseSessionBoardUpdate(update(2, "inv-2")), ...fixtureValue, retentionPolicy: { boardMaxPerSession: 0 } })).rejects.toThrow("pin file is malformed");
      expect(JSON.parse(await readFile(first.currentPath, "utf8"))).toMatchObject({ revisionPath: "boards/1-inv-1" });
    }
  });

  test("rejects a raw session ID embedded in the presentation view", async () => {
    for (const sessionId of ["raw-session-id", "quote\"id"]) {
      const fixtureValue = await fixture();
      const unsafe = { ...update(1, "inv-1"), sessionId, view: { ...view(1), changeSummary: sessionId } };
      await expect(publishSessionBoardUpdate({ update: parseSessionBoardUpdate(unsafe), ...fixtureValue })).rejects.toThrow("raw session ID");
      await expect(stat(join(fixtureValue.stateDir, "sessions"))).rejects.toThrow();
    }
  });

  test("publishes a stable URI bound to an immutable revision without raw session identity", async () => {
    const fixtureValue = await fixture();
    const publication = await publishSessionBoardUpdate({ update: parseSessionBoardUpdate(update(1, "inv-1")), ...fixtureValue });
    await verifySessionBoardPublication(fixtureValue.stateDir, publication);
    expect(publication.entrypointUri).toMatch(/\/sessions\/s-[0-9a-f]{64}\/index\.html$/);
    const sessionRoot = join(fixtureValue.stateDir, "sessions", publication.sessionKey);
    expect(await readlink(join(sessionRoot, "index.html"))).toBe("current/index.html");
    expect(await readlink(join(sessionRoot, "manifest.json"))).toBe("current/manifest.json");
    expect(await readlink(join(sessionRoot, "current.json"))).toBe("current/current.json");
    expect(await readlink(join(sessionRoot, "current"))).toBe("boards/1-inv-1");
    expect((await readFile(publication.currentPath, "utf8"))).not.toContain("raw-session-id");
    expect(await readFile(join(publication.directory, "manifest.json"), "utf8")).not.toContain("raw-session-id");
  });

  test("selects a new run even when its revision restarts lower", async () => {
    const fixtureValue = await fixture();
    const first = { ...update(9, "inv-1"), view: { ...view(9), runId: "run-a" } };
    const second = { ...update(1, "inv-2"), view: { ...view(1), runId: "run-b" } };
    await publishSessionBoardUpdate({ update: parseSessionBoardUpdate(first), ...fixtureValue });
    const publication = await publishSessionBoardUpdate({ update: parseSessionBoardUpdate(second), ...fixtureValue });
    expect(publication.current.revisionPath).toBe("boards/1-inv-2");
    expect(publication.manifest.runId).toBe("run-b");
  });

  test("replaces current while preserving immutable history and honoring session quota", async () => {
    const fixtureValue = await fixture();
    const first = await publishSessionBoardUpdate({ update: parseSessionBoardUpdate(update(1, "inv-1")), ...fixtureValue, retentionPolicy: { boardMaxPerSession: 2 } });
    const second = await publishSessionBoardUpdate({ update: parseSessionBoardUpdate(update(2, "inv-2")), ...fixtureValue, retentionPolicy: { boardMaxPerSession: 2 } });
    expect(second.current.revisionPath).toBe("boards/2-inv-2");
    expect(await stat(first.directory)).toBeDefined();
    const names = await readdir(join(fixtureValue.stateDir, "sessions", sessionBoardKey("omp", "raw-session-id"), "boards"));
    expect(names.sort()).toEqual(["1-inv-1", "2-inv-2"]);
  });

  test("keeps a stale revision while returning the actual selected current", async () => {
    const fixtureValue = await fixture();
    const selected = await publishSessionBoardUpdate({ update: parseSessionBoardUpdate(update(2, "inv-2")), ...fixtureValue, retentionPolicy: { boardMaxPerSession: 10 } });
    const stale = await publishSessionBoardUpdate({ update: parseSessionBoardUpdate(update(1, "inv-1")), ...fixtureValue, retentionPolicy: { boardMaxPerSession: 10 } });
    expect(stale.current.revisionPath).toBe(selected.current.revisionPath);
    expect(await stat(join(fixtureValue.stateDir, "sessions", selected.sessionKey, "boards", "1-inv-1"))).toBeDefined();
  });

  test("rotates active revisions by the session maximum without deleting current", async () => {
    const fixtureValue = await fixture();
    await publishSessionBoardUpdate({ update: parseSessionBoardUpdate(update(1, "inv-1", "EXECUTING")), ...fixtureValue, retentionPolicy: { boardMaxPerSession: 2 } });
    await publishSessionBoardUpdate({ update: parseSessionBoardUpdate(update(2, "inv-2", "EXECUTING")), ...fixtureValue, retentionPolicy: { boardMaxPerSession: 2 } });
    const current = await publishSessionBoardUpdate({ update: parseSessionBoardUpdate(update(3, "inv-3", "EXECUTING")), ...fixtureValue, retentionPolicy: { boardMaxPerSession: 2 } });
    const names = await readdir(join(fixtureValue.stateDir, "sessions", current.sessionKey, "boards"));
    expect(names.sort()).toEqual(["2-inv-2", "3-inv-3"]);
    expect(current.current.revisionPath).toBe("boards/3-inv-3");
  });

  test("fails quota publication without replacing the prior current pointer", async () => {
    const fixtureValue = await fixture();
    const first = await publishSessionBoardUpdate({ update: parseSessionBoardUpdate(update(1, "inv-1")), ...fixtureValue });
    await expect(publishSessionBoardUpdate({ update: parseSessionBoardUpdate(update(2, "inv-2", "EXECUTING")), ...fixtureValue, retentionPolicy: { boardMaxPerSession: 0 } })).rejects.toThrow("quota");
    const current = JSON.parse(await readFile(first.currentPath, "utf8")) as { revisionPath: string };
    expect(current.revisionPath).toBe("boards/1-inv-1");
    await expect(stat(join(fixtureValue.stateDir, "sessions", first.sessionKey, "boards", "2-inv-2"))).rejects.toThrow();
  });

  test("serializes concurrent updates and publishes one immutable revision per invocation", async () => {
    const fixtureValue = await fixture();
    const results = await Promise.all(["inv-a", "inv-b"].map(invocationId => publishSessionBoardUpdate({ update: parseSessionBoardUpdate(update(1, invocationId)), ...fixtureValue, retentionPolicy: { boardMaxPerSession: 10 } })));
    const current = JSON.parse(await readFile(join(fixtureValue.stateDir, "sessions", results[0]!.sessionKey, "current", "current.json"), "utf8")) as { invocationId: string };
    expect(current.invocationId).toBe("inv-b");
    expect(await readdir(join(fixtureValue.stateDir, "sessions", results[0]!.sessionKey, "boards"))).toHaveLength(2);
  });
});
