import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "bun:test";
import type { UsageReport } from "../runtime/usage-telemetry";
import {
  assertReleaseReadiness,
  canonicalReleaseReadinessReport,
  evaluateTokenAccountingBenchmark,
  runReleaseReadinessBenchmark,
} from "./release-readiness";

const QUALITY_CASES: [string, string][] = [
  ["blocked-precedes-incomplete", "BLOCKED"],
  ["complete-proof-chain", "PASS"],
  ["cross-snapshot-evidence", "INCOMPLETE"],
  ["duplicate-claim-rejected", "REJECTED"],
  ["fail-precedes-blocked-and-incomplete", "FAIL"],
  ["missing-evaluation", "INCOMPLETE"],
  ["observed-criterion-contradiction", "FAIL"],
  ["required-execution-blocked", "BLOCKED"],
  ["uncovered-basis", "INCOMPLETE"],
];

const GATE_IDS: string[] = [
  "1.0-quality-all-cases-match",
  "1.0-quality-zero-false-pass",
  "1.0-cache-cold-warm-parity",
  "1.0-cache-all-key-boundaries-invalidate",
  "1.0-cache-relevance-semantics",
  "1.0-cache-integrity-rejection",
  "1.0-token-unavailable-preserved",
  "1.0-token-no-unsubstantiated-efficiency-claim",
];

async function withReport<T>(
  run: (report: Awaited<ReturnType<typeof runReleaseReadinessBenchmark>>) => T | Promise<T>,
): Promise<T> {
  const cacheRoot = await mkdtemp(join(tmpdir(), "traceknot-benchmark-"));
  try {
    return await run(await runReleaseReadinessBenchmark(cacheRoot));
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

describe("Traceknot 1.0 release-readiness benchmark", () => {
  test("hard-gates the fixed proof-carrying quality corpus", async () => {
    await withReport(report => {
      expect(report.quality).toMatchObject({
        status: "PASS",
        total: 9,
        matched: 9,
        falsePasses: 0,
      });
      expect(report.quality.cases.map(item => [item.id, item.actual])).toEqual(
        QUALITY_CASES,
      );
    });
  });

  test("proves cache boundaries, parity, relevance, and integrity", async () => {
    await withReport(report => {
      expect(report.cache).toEqual({
        status: "PASS",
        coldMiss: true,
        warmHit: true,
        payloadEqual: true,
        idempotentPayloadDigest: true,
        keyInvalidations: { expected: 10, observed: 10 },
        relevantOrderStable: true,
        relevantChangeInvalidated: true,
        tamperRejected: true,
      });
    });
  });

  test("preserves unavailable provider token and cost observations", async () => {
    await withReport(report => {
      expect(report.tokens).toEqual({
        status: "PASS",
        sourceSchemaVersion: "usage-report/v1",
        modelCalls: 0,
        inputTokens: "unavailable",
        cachedInputTokens: "unavailable",
        cacheWriteTokens: "unavailable",
        outputTokens: "unavailable",
        reasoningTokens: "unavailable",
        cacheHitRate: "unavailable",
        costStatus: "unavailable",
        providerEfficiencyClaim: "NOT_EVALUATED",
      });
    });

    const unavailableUsage: UsageReport = {
      schemaVersion: "usage-report/v1",
      runId: "benchmark-run",
      requestId: "benchmark-request",
      snapshotId: "benchmark-snapshot",
      inputTokens: "unavailable",
      cachedInputTokens: "unavailable",
      cacheWriteTokens: "unavailable",
      outputTokens: "unavailable",
      reasoningTokens: "unavailable",
      modelCalls: 0,
      cacheHitRate: "unavailable",
      estimatedCost: { status: "unavailable" },
    };
    for (const field of [
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteTokens",
      "outputTokens",
      "reasoningTokens",
      "cacheHitRate",
    ] as const) {
      expect(evaluateTokenAccountingBenchmark({
        ...unavailableUsage,
        [field]: 0,
      }).status).toBe("FAIL");
    }
    expect(evaluateTokenAccountingBenchmark({
      ...unavailableUsage,
      modelCalls: 1,
    }).status).toBe("FAIL");
  });

  test("emits one deterministic closed report and rejects gate drift", async () => {
    const first = await withReport(report => report);
    const second = await withReport(report => report);
    expect(canonicalReleaseReadinessReport(first)).toBe(
      canonicalReleaseReadinessReport(second),
    );
    expect(first).toMatchObject({
      schemaVersion: "traceknot-benchmark-report/v1",
      suiteVersion: "traceknot-1.0/v1",
      status: "PASS",
    });
    expect(first.gates.map(gate => gate.id)).toEqual(GATE_IDS);
    expect(first.gates.every(gate => gate.required && gate.status === "PASS")).toBe(true);
    expect(() => assertReleaseReadiness(first)).not.toThrow();
    for (const forged of [
      { ...first, quality: { ...first.quality, matched: 0 } },
      {
        ...first,
        quality: {
          ...first.quality,
          cases: first.quality.cases.map((item, index) => index === 0
            ? { ...item, id: "unknown-case" }
            : item),
        },
      },
      { ...first, quality: { ...first.quality, cases: [] } },
      {
        ...first,
        quality: {
          ...first.quality,
          cases: new Array(first.quality.cases.length) as typeof first.quality.cases,
        },
      },
      { ...first, cache: { ...first.cache, coldMiss: "false" as unknown as boolean } },
      { ...first, cache: { ...first.cache, payloadEqual: [] as unknown as boolean } },
      { ...first, cache: { ...first.cache, relevantOrderStable: "false" as unknown as boolean } },
      { ...first, tokens: { ...first.tokens, inputTokens: 0 as const } },
      { ...first, schemaVersion: "evil/v1" as typeof first.schemaVersion },
      { ...first, unexpected: true },
      { ...first, cache: { ...first.cache, keyInvalidations: { expected: 999 as 10, observed: 10 } } },
      { ...first, tokens: { ...first.tokens, sourceSchemaVersion: "evil/v1" as typeof first.tokens.sourceSchemaVersion } },
    ]) {
      expect(() => assertReleaseReadiness(forged)).toThrow(/benchmark (gate values|report contract)/);
    }
    expect(() => assertReleaseReadiness({
      ...first,
      gates: [...first.gates].reverse(),
    })).toThrow("benchmark gate order");
    for (const gates of [
      first.gates.slice(1),
      [...first.gates, first.gates[0]!],
      first.gates.map((gate, index) => index === 0
        ? { ...gate, id: "1.0-unknown-gate" }
        : gate),
    ]) {
      expect(() => assertReleaseReadiness({ ...first, gates })).toThrow(
        /benchmark (gate order|report contract)/,
      );
    }
    expect(canonicalReleaseReadinessReport(first)).not.toMatch(
      /duration|timestamp|hostname|providerName|modelName|temporary/i,
    );
  });

  test("validates the report against its closed published schema", async () => {
    const report = await withReport(value => value);
    const schema = JSON.parse(
      readFileSync("contracts/benchmark-report.schema.json", "utf8"),
    ) as object;
    const validate = new Ajv2020({ strict: true }).compile(schema);
    expect(validate(report)).toBe(true);
    expect(validate({ ...report, unexpected: true })).toBe(false);
    expect(validate({
      ...report,
      cache: { ...report.cache, unexpected: true },
    })).toBe(false);
    for (const forged of [
      { ...report, quality: { ...report.quality, matched: 0 } },
      {
        ...report,
        quality: {
          ...report.quality,
          cases: report.quality.cases.map((item, index) => index === 0
            ? { ...item, actual: "PASS" }
            : item),
        },
      },
      { ...report, cache: { ...report.cache, coldMiss: false } },
      { ...report, tokens: { ...report.tokens, inputTokens: 0 } },
      {
        ...report,
        quality: {
          ...report.quality,
          cases: report.quality.cases.map(() => report.quality.cases[0]),
        },
      },
      { ...report, gates: report.gates.map(() => report.gates[0]) },
      { ...report, gates: [...report.gates].reverse() },
    ]) {
      expect(validate(forged)).toBe(false);
    }
  });

  test("publishes a bounded CLI help and rejects bad arguments", async () => {
    expect(statSync("scripts/ci").mode & 0o111).not.toBe(0);
    const help = Bun.spawn([process.execPath, "scripts/check-release-readiness.ts", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await help.exited).toBe(0);
    expect(await new Response(help.stdout).text()).toContain("benchmark:release");

    const bad = Bun.spawn([process.execPath, "scripts/check-release-readiness.ts", "--unknown"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await bad.exited).toBe(64);
    expect(await new Response(bad.stderr).text()).toContain("usage:");
  });
});
