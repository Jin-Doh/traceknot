import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BOARD_EXIT_CODES, runBoardUpdate } from "./board";

const sessionId = "raw-board-session-id";

function update(invocationId: string): Record<string, unknown> {
  return {
    schemaVersion: "traceknot-session-board-update/v1",
    sessionId,
    sessionHost: "omp",
    generatedAt: "2026-08-18T00:00:00Z",
    invocationId,
    view: {
      runId: "run-board-test",
      requestId: "request-board-test",
      rootIdentity: "root-board-test",
      snapshotId: "snapshot-board-test",
      revision: 1,
      sourceState: "TERMINAL",
      sourceUpdatedAt: "2026-08-18T00:00:00Z",
      changeSummary: "Board CLI test",
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
    },
  };
}

async function fixture(invocationId: string): Promise<{ stateDir: string; inputPath: string; cleanup: () => Promise<void> }> {
  const stateDir = await mkdtemp(join(tmpdir(), "traceknot-board-cli-test-"));
  const inputPath = join(stateDir, "update.json");
  await writeFile(inputPath, `${JSON.stringify(update(invocationId))}\n`, { mode: 0o600 });
  return { stateDir, inputPath, cleanup: () => rm(stateDir, { recursive: true, force: true }) };
}

async function persistedFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await persistedFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const runtime = (notify: () => void) => ({
  notifyBoard: async ({ boardUri }: { boardUri: string }) => {
    expect(boardUri).toMatch(/\/sessions\/s-[0-9a-f]{64}\/index\.html$/);
    notify();
    return "sent" as const;
  },
  openBoard: async () => "unavailable" as const,
  markProjectSupportSeen: async () => undefined,
});

describe("traceknot board CLI", () => {
  test("notifies once by default and emits one stable session URI without raw session identity", async () => {
    const fixtureValue = await fixture("board-default");
    try {
      let notifications = 0;
      const stderr: string[] = [];
      const status = await runBoardUpdate(
        ["update", "--input", fixtureValue.inputPath, "--state-dir", fixtureValue.stateDir],
        () => undefined,
        text => stderr.push(text),
        runtime(() => { notifications += 1; }),
      );
      expect(status).toBe(BOARD_EXIT_CODES.OK);
      expect(notifications).toBe(1);
      const output = stderr.join("");
      const sessionEntries = await readdir(join(fixtureValue.stateDir, "sessions"));
      expect(sessionEntries).toHaveLength(1);
      const stableUri = pathToFileURL(join(await realpath(fixtureValue.stateDir), "sessions", sessionEntries[0]!, "index.html")).href;
      expect(output).toBe(`Traceknot Board: ${stableUri}\n`);
      expect(await stat(join(fixtureValue.stateDir, "runs")).catch(() => undefined)).toBeUndefined();
      const files = await persistedFiles(join(fixtureValue.stateDir, "sessions"));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expect(await readFile(file, "utf8")).not.toContain(sessionId);
    } finally {
      await fixtureValue.cleanup();
    }
  });

  test("suppresses the default notification only with --no-notify", async () => {
    const fixtureValue = await fixture("board-no-notify");
    try {
      let notifications = 0;
      const status = await runBoardUpdate(
        ["update", "--input", fixtureValue.inputPath, "--state-dir", fixtureValue.stateDir, "--no-notify"],
        () => undefined,
        () => undefined,
        runtime(() => { notifications += 1; }),
      );
      expect(status).toBe(BOARD_EXIT_CODES.OK);
      expect(notifications).toBe(0);
    } finally {
      await fixtureValue.cleanup();
    }
  });

  test("maps malformed input to the usage exit code", async () => {
    const fixtureValue = await fixture("board-malformed");
    try {
      await writeFile(fixtureValue.inputPath, "{ malformed", { mode: 0o600 });
      const stderr: string[] = [];
      const status = await runBoardUpdate(
        ["update", "--input", fixtureValue.inputPath, "--state-dir", fixtureValue.stateDir],
        () => undefined,
        text => stderr.push(text),
      );
      expect(status).toBe(BOARD_EXIT_CODES.USAGE);
      expect(stderr.join("")).toContain("Board update input is not valid JSON");
    } finally {
      await fixtureValue.cleanup();
    }
  });
});
