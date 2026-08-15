import { mkdtemp, mkdir, readFile, readlink, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { QaBoardView } from "./qa-board";
import { sha256 } from "./qa-board";
import { writeQaBoardBundle } from "./qa-board-store";

const SCREENSHOT_BYTES = new TextEncoder().encode("screenshot-bytes");
const SCREENSHOT_DIGEST = sha256(SCREENSHOT_BYTES);

function viewWithScreenshot(): QaBoardView {
  return {
    runId: "run-1",
    requestId: "request-1",
    rootIdentity: "root-1",
    snapshotId: "snapshot-1",
    revision: 9,
    sourceState: "TERMINAL",
    sourceUpdatedAt: "2026-08-15T00:00:03Z",
    changeSummary: "Board store fixture",
    verdict: "PASS",
    authoritative: false,
    rationale: "The fixture passed.",
    counts: { mandatory: 1, passed: 1, failed: 0, blocked: 0, incomplete: 0 },
    findings: [{ obligationId: "obligation:one", mandatory: true, status: "PASS", expectedResults: ["The fixture passes."], summary: "The fixture passed.", producer: { kind: "ci", identity: "fixture-ci", independence: "independent-producer" }, screenshots: [{ digest: SCREENSHOT_DIGEST, observationId: "observation:one" }], artifacts: [{ type: "screenshot", digest: SCREENSHOT_DIGEST }] }],
    coverage: { basis: { total: 1, covered: 1, uncoveredIds: [] }, risks: { total: 0, covered: 0, uncoveredIds: [] }, conditions: { total: 1, covered: 1, uncoveredIds: [] }, mandatoryObligations: { total: 1, covered: 1, uncoveredIds: [] } },
    openDefectIds: [],
    acceptedRiskIds: [],
    residualRisks: [],
  };
}

async function stateFixture(): Promise<{ root: string; run: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "traceknot-board-store-"));
  const run = join(root, "runs", "run-1");
  await mkdir(run, { recursive: true, mode: 0o700 });
  return { root, run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("writes an immutable Board bundle and verifies screenshot bytes", async () => {
  const fixture = await stateFixture();
  try {
    const result = await writeQaBoardBundle({ view: viewWithScreenshot(), stateDir: fixture.root, invocationId: "invocation-1", sessionHost: "omp", sessionId: "raw-session", generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async digest => { expect(digest).toBe(SCREENSHOT_DIGEST); return SCREENSHOT_BYTES; } } });
    expect(result.entrypoint).toContain("/boards/9-invocation-1/index.html");
    expect(result.manifest.generatedBy.sessionRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(result.manifest)).not.toContain("raw-session");
    expect(result.manifest.files).toHaveLength(2);
    expect(await readFile(join(result.directory, "evidence", `${SCREENSHOT_DIGEST}.png`))).toEqual(SCREENSHOT_BYTES);
    expect(await readFile(join(result.directory, "manifest.json"), "utf8")).toContain("traceknot-qa-board/v1");
    expect((await stat(join(result.directory, "index.html"))).mode & 0o777).toBe(0o600);
  } finally {
    await fixture.cleanup();
  }
});

test("creates a separate immutable directory for each invocation", async () => {
  const fixture = await stateFixture();
  try {
    const input = { view: viewWithScreenshot(), stateDir: fixture.root, sessionHost: "omp", generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async () => SCREENSHOT_BYTES } };
    const first = await writeQaBoardBundle({ ...input, invocationId: "invocation-a" });
    const second = await writeQaBoardBundle({ ...input, invocationId: "invocation-b" });
    expect(first.directory).not.toBe(second.directory);
    expect(first.entrypoint).toContain("9-invocation-a");
    expect(second.entrypoint).toContain("9-invocation-b");
  } finally {
    await fixture.cleanup();
  }
});

test("rejects an existing run symlink", async () => {
  const fixture = await stateFixture();
  const attacker = await mkdtemp(join(tmpdir(), "traceknot-board-attacker-"));
  try {
    await rm(fixture.run, { recursive: true, force: true });
    await symlink(attacker, fixture.run);
    await expect(writeQaBoardBundle({ view: viewWithScreenshot(), stateDir: fixture.root, invocationId: "invocation-1", generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async () => SCREENSHOT_BYTES } })).rejects.toThrow();
    expect(await readlink(fixture.run)).toBe(attacker);
  } finally {
    await fixture.cleanup();
    await rm(attacker, { recursive: true, force: true });
  }
});

test("rejects a mismatched screenshot digest before publishing a Board", async () => {
  const fixture = await stateFixture();
  try {
    const wrongBytes = new TextEncoder().encode("wrong-bytes");
    await expect(writeQaBoardBundle({ view: viewWithScreenshot(), stateDir: fixture.root, invocationId: "invocation-1", generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async () => wrongBytes } })).rejects.toThrow("screenshot artifact digest mismatch");
    expect(await stat(join(fixture.root, "runs", "run-1", "boards", "9-invocation-1", "manifest.json")).catch(() => undefined)).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});
