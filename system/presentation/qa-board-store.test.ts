import { chmod, mkdtemp, mkdir, readFile, readlink, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { QaBoardView } from "./qa-board";
import { sha256 } from "./qa-board";
import { markProjectSupportSeen, verifyQaBoardBundleForOpen, writeQaBoardBundle } from "./qa-board-store";
import { pruneStorage } from "../runtime/storage-retention";

const SCREENSHOT_BYTES = new TextEncoder().encode("screenshot-bytes");
const SCREENSHOT_DIGEST = sha256(SCREENSHOT_BYTES);
const SECOND_SCREENSHOT_BYTES = new TextEncoder().encode("second-screenshot-bytes");
const SECOND_SCREENSHOT_DIGEST = sha256(SECOND_SCREENSHOT_BYTES);

function viewWithTwoScreenshots(): QaBoardView {
  const view = viewWithScreenshot();
  const finding = view.findings[0]!;
  return {
    ...view,
    findings: [{
      ...finding,
      screenshots: [...finding.screenshots, { digest: SECOND_SCREENSHOT_DIGEST, observationId: "observation:two" }],
    }],
  };
}

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
    assurance: { context: "release", requiredIndependence: "independent-producer", releaseStatus: "satisfied" },
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
async function boardNames(root: string): Promise<string[]> {
  return readdir(join(root, "runs", "run-1", "boards")).catch(() => []);
}

test("writes an immutable Board bundle and verifies screenshot bytes", async () => {
  const fixture = await stateFixture();
  try {
    const result = await writeQaBoardBundle({ view: viewWithScreenshot(), stateDir: fixture.root, invocationId: "invocation-1", sessionHost: "omp", sessionId: "raw-session", locale: "ko", generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async digest => { expect(digest).toBe(SCREENSHOT_DIGEST); return SCREENSHOT_BYTES; } } });
    expect(result.entrypoint).toContain("/boards/9-invocation-1/index.html");
    expect(result.manifest.generatedBy.sessionRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.manifest.generatedAt).toBe("2026-08-15T00:01:00Z");
    expect(result.manifest.sourceUpdatedAt).toBe("2026-08-15T00:00:03Z");
    expect(JSON.stringify(result.manifest)).not.toContain("raw-session");
    expect(result.manifest.files).toHaveLength(5);
    expect(result.manifest.files.filter(file => file.role === "localized-view").map(file => file.path)).toEqual(["index.en.html", "index.ko.html", "index.zh-CN.html"]);
    expect(result.manifest.files.find(file => file.path === `evidence/${SCREENSHOT_DIGEST}.png`)?.bytes).toBe(SCREENSHOT_BYTES.byteLength);
    expect(result.manifest.files.find(file => file.path === "index.html")?.bytes).toBe((await stat(join(result.directory, "index.html"))).size);
    expect(await readFile(join(result.directory, "index.html"), "utf8")).toContain('<html lang="ko">');
    expect(await readFile(join(result.directory, "index.en.html"), "utf8")).toContain('<html lang="en">');
    expect(await readFile(join(result.directory, "index.ko.html"), "utf8")).toContain("필수 검증을 모두 통과했습니다");
    expect(await readFile(join(result.directory, "index.zh-CN.html"), "utf8")).toContain("所有必需检查均已通过");
    expect(await readFile(join(result.directory, "evidence", `${SCREENSHOT_DIGEST}.png`))).toEqual(Buffer.from(SCREENSHOT_BYTES));
    expect(await readFile(join(result.directory, "manifest.json"), "utf8")).toContain("traceknot-qa-board/v1");
    expect((await stat(join(result.directory, "index.html"))).mode & 0o777).toBe(0o600);
    expect(await boardNames(fixture.root)).toEqual(["9-invocation-1"]);
  } finally {
    await fixture.cleanup();
  }
});
test("shows project support once and records only a local marker", async () => {
  const fixture = await stateFixture();
  try {
    const input = { view: viewWithScreenshot(), stateDir: fixture.root, locale: "en" as const, generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async () => SCREENSHOT_BYTES } };
    const first = await writeQaBoardBundle({ ...input, invocationId: "support-first" });
    expect(first.projectSupportIncluded).toBe(true);
    expect(await readFile(join(first.directory, "index.html"), "utf8")).toContain("Project support");
    await markProjectSupportSeen(fixture.root);
    await markProjectSupportSeen(fixture.root);
    expect(await readFile(join(fixture.root, "presentation", "star-cta-v1.seen"), "utf8")).toBe("");
    const second = await writeQaBoardBundle({ ...input, invocationId: "support-second" });
    expect(second.projectSupportIncluded).toBe(false);
    expect(await readFile(join(second.directory, "index.html"), "utf8")).not.toContain("Project support");
  } finally {
    await fixture.cleanup();
  }
});

test("fails closed when the support marker is a symlink", async () => {
  const fixture = await stateFixture();
  const attacker = await mkdtemp(join(tmpdir(), "traceknot-support-attacker-"));
  try {
    await mkdir(join(fixture.root, "presentation"), { mode: 0o700 });
    await symlink(join(attacker, "marker"), join(fixture.root, "presentation", "star-cta-v1.seen"));
    const result = await writeQaBoardBundle({ view: viewWithScreenshot(), stateDir: fixture.root, invocationId: "support-symlink", generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async () => SCREENSHOT_BYTES } });
    expect(result.projectSupportIncluded).toBe(false);
    expect(await stat(join(attacker, "marker")).catch(() => undefined)).toBeUndefined();
  } finally {
    await fixture.cleanup();
    await rm(attacker, { recursive: true, force: true });
  }
});
test("fails closed without blocking when the support marker is a FIFO", async () => {
  const fixture = await stateFixture();
  try {
    await mkdir(join(fixture.root, "presentation"), { mode: 0o700 });
    const marker = join(fixture.root, "presentation", "star-cta-v1.seen");
    const created = spawnSync("mkfifo", [marker]);
    expect(created.status).toBe(0);
    const result = await writeQaBoardBundle({ view: viewWithScreenshot(), stateDir: fixture.root, invocationId: "support-fifo", generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async () => SCREENSHOT_BYTES } });
    expect(result.projectSupportIncluded).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});
test("fails closed when the support marker is a directory", async () => {
  const fixture = await stateFixture();
  try {
    await mkdir(join(fixture.root, "presentation", "star-cta-v1.seen"), { recursive: true, mode: 0o700 });
    const result = await writeQaBoardBundle({ view: viewWithScreenshot(), stateDir: fixture.root, invocationId: "support-directory", generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async () => SCREENSHOT_BYTES } });
    expect(result.projectSupportIncluded).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});


test("rejects a writable state root even when it has the sticky bit", async () => {
  const fixture = await stateFixture();
  try {
    for (const mode of [0o777, 0o1777]) {
      await chmod(fixture.root, mode);
      await expect(writeQaBoardBundle({ view: viewWithScreenshot(), stateDir: fixture.root, invocationId: `support-untrusted-root-${mode}`, generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async () => SCREENSHOT_BYTES } })).rejects.toThrow("Board state root must not be group- or world-writable");
    }
  } finally {
    await fixture.cleanup();
  }
});
test("rejects a private state root below an untrusted ancestor", async () => {
  const parent = await mkdtemp(join(tmpdir(), "traceknot-board-parent-"));
  const root = join(parent, "state");
  try {
    await mkdir(join(root, "runs", "run-1"), { recursive: true, mode: 0o700 });
    await chmod(parent, 0o777);
    await expect(writeQaBoardBundle({ view: viewWithScreenshot(), stateDir: root, invocationId: "support-untrusted-parent", generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async () => SCREENSHOT_BYTES } })).rejects.toThrow("Board state path must not contain group- or world-writable directories without the sticky bit");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
test("accepts the maximum invocation ID length", async () => {
  const fixture = await stateFixture();
  const invocationId = "a".repeat(128);
  try {
    const result = await writeQaBoardBundle({ view: viewWithScreenshot(), stateDir: fixture.root, invocationId, generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async () => SCREENSHOT_BYTES } });
    expect(result.entrypoint).toContain(`/boards/9-${invocationId}/index.html`);
  } finally {
    await fixture.cleanup();
  }
});
test("revalidates every published Board file before desktop exposure", async () => {
  const fixture = await stateFixture();
  try {
    const result = await writeQaBoardBundle({ view: viewWithScreenshot(), stateDir: fixture.root, invocationId: "open-validation", generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async () => SCREENSHOT_BYTES } });
    await verifyQaBoardBundleForOpen(fixture.root, result);
    await chmod(result.entrypoint, 0o600);
    await writeFile(result.entrypoint, "replaced");
    await expect(verifyQaBoardBundleForOpen(fixture.root, result)).rejects.toThrow("Board file changed before open: index.html");
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

test("explains duplicate invocation IDs without replacing the published Board", async () => {
  const fixture = await stateFixture();
  try {
    const input = { view: viewWithScreenshot(), stateDir: fixture.root, invocationId: "invocation-duplicate", generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async () => SCREENSHOT_BYTES } };
    const first = await writeQaBoardBundle(input);
    await expect(writeQaBoardBundle(input)).rejects.toThrow("Board invocation already exists (9-invocation-duplicate); choose a new --invocation-id");
    expect(await readFile(join(first.directory, "index.html"), "utf8")).toContain("Board store fixture");
    expect(await boardNames(fixture.root)).toEqual(["9-invocation-duplicate"]);
  } finally {
    await fixture.cleanup();
  }
});
test("publishes exactly one Board for concurrent duplicate invocation IDs", async () => {
  const fixture = await stateFixture();
  try {
    const input = { view: viewWithScreenshot(), stateDir: fixture.root, invocationId: "invocation-race", generatedAt: "2026-08-15T00:01:00Z", artifactReader: { readArtifact: async () => SCREENSHOT_BYTES } };
    const results = await Promise.allSettled([writeQaBoardBundle(input), writeQaBoardBundle(input)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await boardNames(fixture.root)).toEqual(["9-invocation-race"]);
    expect(await readFile(join(fixture.run, "boards", "9-invocation-race", "manifest.json"), "utf8")).toContain("traceknot-qa-board/v1");
  } finally {
    await fixture.cleanup();
  }
});

test("removes a partially copied pending bundle when artifact reading fails", async () => {
  const fixture = await stateFixture();
  let reads = 0;
  try {
    await expect(writeQaBoardBundle({
      view: viewWithTwoScreenshots(),
      stateDir: fixture.root,
      invocationId: "invocation-read-failure",
      generatedAt: "2026-08-15T00:01:00Z",
      artifactReader: {
        readArtifact: async digest => {
          reads += 1;
          if (reads === 1) {
            expect(digest).toBe(SCREENSHOT_DIGEST);
            return SCREENSHOT_BYTES;
          }
          expect(digest).toBe(SECOND_SCREENSHOT_DIGEST);
          throw new Error("simulated artifact read failure");
        },
      },
    })).rejects.toThrow("simulated artifact read failure");
    expect(await boardNames(fixture.root)).toEqual([]);
    expect(reads).toBe(2);
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
    expect(await boardNames(fixture.root)).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

test("leases pending Board publication against zero-grace maintenance", async () => {
  const fixture = await stateFixture();
  const artifacts = await mkdtemp(join(tmpdir(), "traceknot-board-artifacts-"));
  await mkdir(join(artifacts, ".objects"), { recursive: true });
  let resumeRead!: () => void;
  let signalRead!: () => void;
  const readStarted = new Promise<void>(resolvePromise => { signalRead = resolvePromise; });
  const resume = new Promise<void>(resolvePromise => { resumeRead = resolvePromise; });
  try {
    const publication = writeQaBoardBundle({
      view: viewWithScreenshot(),
      stateDir: fixture.root,
      invocationId: "leased-publication",
      generatedAt: "2026-08-15T00:01:00Z",
      artifactReader: {
        readArtifact: async () => {
          signalRead();
          await resume;
          return SCREENSHOT_BYTES;
        },
      },
    });
    await readStarted;
    await expect(pruneStorage({
      stateDir: fixture.root,
      artifactDir: artifacts,
      now: new Date(Date.now() + 1000),
      policy: { boardTtlMs: 0, boardMaxPerRun: 0, boardQuotaBytes: 0, canonicalRunTtlMs: 0, canonicalQuotaBytes: 0, graceMs: 0 },
      apply: true,
    })).rejects.toThrow();
    resumeRead();
    const result = await publication;
    expect(await stat(result.entrypoint)).toBeDefined();
  } finally {
    resumeRead();
    await Promise.all([fixture.cleanup(), rm(artifacts, { recursive: true, force: true })]);
  }
});
