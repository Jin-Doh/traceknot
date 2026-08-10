import {
  QUALITY_CASES,
  type BenchmarkOutcome,
  type QualityCase,
} from "../../benchmarks/release-readiness-suite";
import { resolveProofCarryingQaVerdict } from "../core/qa-core";
import { canonicalJson, type JsonValue } from "../runtime/context-plan";
import { RunUsageTelemetry, type UsageReport } from "../runtime/usage-telemetry";
import { evaluateCacheBenchmark, type CacheBenchmarkResult } from "./cache-readiness";

export type BenchmarkStatus = "PASS" | "FAIL";
export type QualityBenchmarkResult = Readonly<{
  status: BenchmarkStatus;
  total: number;
  matched: number;
  falsePasses: number;
  cases: readonly Readonly<{
    id: string;
    expected: BenchmarkOutcome;
    actual: BenchmarkOutcome;
    status: BenchmarkStatus;
  }>[];
}>;
export type TokenBenchmarkResult = Readonly<{
  status: BenchmarkStatus;
  sourceSchemaVersion: "usage-report/v1";
  modelCalls: number;
  inputTokens: UsageReport["inputTokens"];
  cachedInputTokens: UsageReport["cachedInputTokens"];
  cacheWriteTokens: UsageReport["cacheWriteTokens"];
  outputTokens: UsageReport["outputTokens"];
  reasoningTokens: UsageReport["reasoningTokens"];
  cacheHitRate: UsageReport["cacheHitRate"];
  costStatus: UsageReport["estimatedCost"]["status"];
  providerEfficiencyClaim: "NOT_EVALUATED";
}>;
export type BenchmarkGate = Readonly<{
  id: string;
  required: true;
  expected: string;
  actual: string;
  status: BenchmarkStatus;
}>;
export type ReleaseReadinessReport = Readonly<{
  schemaVersion: "traceknot-benchmark-report/v1";
  suiteVersion: "traceknot-1.0/v1";
  status: BenchmarkStatus;
  quality: QualityBenchmarkResult;
  cache: CacheBenchmarkResult;
  tokens: TokenBenchmarkResult;
  gates: readonly BenchmarkGate[];
}>;

const GATE_IDS = [
  "1.0-quality-all-cases-match",
  "1.0-quality-zero-false-pass",
  "1.0-cache-cold-warm-parity",
  "1.0-cache-all-key-boundaries-invalidate",
  "1.0-cache-relevance-semantics",
  "1.0-cache-integrity-rejection",
  "1.0-token-unavailable-preserved",
  "1.0-token-no-unsubstantiated-efficiency-claim",
] as const;

export function evaluateQualityBenchmark(cases: readonly QualityCase[]): QualityBenchmarkResult {
  const results = [...cases]
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .map(item => {
    let actual: BenchmarkOutcome;
    try {
      actual = resolveProofCarryingQaVerdict(item.input).qaVerdict;
    } catch (error) {
      if (
        item.expected !== "REJECTED"
        || !(error instanceof Error)
        || !error.message.startsWith("duplicate claim ")
      ) {
        throw error;
      }
      actual = "REJECTED";
    }
    return Object.freeze({
      id: item.id,
      expected: item.expected,
      actual,
      status: actual === item.expected ? "PASS" as const : "FAIL" as const,
    });
    });
  const matched = results.filter(item => item.status === "PASS").length;
  const falsePasses = results.filter(
    item => item.expected !== "PASS" && item.actual === "PASS",
  ).length;
  return Object.freeze({
    status: matched === results.length && falsePasses === 0 ? "PASS" : "FAIL",
    total: results.length,
    matched,
    falsePasses,
    cases: Object.freeze(results),
  });
}

export function evaluateTokenAccountingBenchmark(
  usage: UsageReport,
): TokenBenchmarkResult {
  const unavailable = [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.cacheHitRate,
  ].every(value => value === "unavailable");
  const status = usage.modelCalls === 0
    && unavailable
    && usage.estimatedCost.status === "unavailable"
    ? "PASS"
    : "FAIL";
  return Object.freeze({
    status,
    sourceSchemaVersion: usage.schemaVersion,
    modelCalls: usage.modelCalls,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheHitRate: usage.cacheHitRate,
    costStatus: usage.estimatedCost.status,
    providerEfficiencyClaim: "NOT_EVALUATED",
  });
}

function gate(id: string, passed: boolean, expected: string, actual: string): BenchmarkGate {
  return Object.freeze({
    id,
    required: true,
    expected,
    actual,
    status: passed ? "PASS" : "FAIL",
  });
}

function qualityMatchesSuite(quality: QualityBenchmarkResult): boolean {
  if (quality.total !== QUALITY_CASES.length
    || quality.matched !== QUALITY_CASES.length
    || quality.falsePasses !== 0
    || quality.cases.length !== QUALITY_CASES.length) return false;
  for (let index = 0; index < QUALITY_CASES.length; index += 1) {
    const item = quality.cases[index];
    const expected = QUALITY_CASES[index];
    if (item === undefined || expected === undefined
      || item.id !== expected.id || item.expected !== expected.expected
      || item.actual !== expected.expected || item.status !== "PASS") return false;
  }
  return true;
}

function cacheParityPasses(cache: CacheBenchmarkResult): boolean {
  return cache.coldMiss
    && cache.warmHit
    && cache.payloadEqual
    && cache.idempotentPayloadDigest;
}

function tokenAccountingPasses(tokens: TokenBenchmarkResult): boolean {
  return tokens.modelCalls === 0
    && tokens.inputTokens === "unavailable"
    && tokens.cachedInputTokens === "unavailable"
    && tokens.cacheWriteTokens === "unavailable"
    && tokens.outputTokens === "unavailable"
    && tokens.reasoningTokens === "unavailable"
    && tokens.cacheHitRate === "unavailable"
    && tokens.costStatus === "unavailable";
}

function buildGates(quality: QualityBenchmarkResult, cache: CacheBenchmarkResult, tokens: TokenBenchmarkResult): readonly BenchmarkGate[] {
  return Object.freeze([
    gate(
      GATE_IDS[0],
      qualityMatchesSuite(quality),
      "9/9",
      `${quality.matched}/${quality.total}`,
    ),
    gate(GATE_IDS[1], quality.falsePasses === 0, "0", String(quality.falsePasses)),
    gate(GATE_IDS[2], cacheParityPasses(cache), "true", String(cacheParityPasses(cache))),
    gate(GATE_IDS[3], cache.keyInvalidations.observed === 10, "10", String(cache.keyInvalidations.observed)),
    gate(GATE_IDS[4], cache.relevantOrderStable && cache.relevantChangeInvalidated, "true", String(cache.relevantOrderStable && cache.relevantChangeInvalidated)),
    gate(GATE_IDS[5], cache.tamperRejected, "true", String(cache.tamperRejected)),
    gate(GATE_IDS[6], tokenAccountingPasses(tokens), "unavailable", tokenAccountingPasses(tokens) ? "unavailable" : "invalid"),
    gate(GATE_IDS[7], tokens.providerEfficiencyClaim === "NOT_EVALUATED", "NOT_EVALUATED", tokens.providerEfficiencyClaim),
  ]);
}

export async function runReleaseReadinessBenchmark(cacheRoot: string): Promise<ReleaseReadinessReport> {
  const quality = evaluateQualityBenchmark(QUALITY_CASES);
  const cache = await evaluateCacheBenchmark(cacheRoot);
  const telemetry = new RunUsageTelemetry({
    runId: "benchmark-run",
    requestId: "benchmark-request",
    snapshotId: "benchmark-snapshot-v1",
  });
  const tokens = evaluateTokenAccountingBenchmark(telemetry.report());
  const gates = buildGates(quality, cache, tokens);
  const status = quality.status === "PASS"
    && cache.status === "PASS"
    && tokens.status === "PASS"
    && gates.every(item => item.status === "PASS")
    ? "PASS"
    : "FAIL";
  const report = Object.freeze({
    schemaVersion: "traceknot-benchmark-report/v1" as const,
    suiteVersion: "traceknot-1.0/v1" as const,
    status,
    quality,
    cache,
    tokens,
    gates,
  });
  return report;
}

export function assertReleaseReadiness(report: ReleaseReadinessReport): void {
  const ids = report.gates.map(item => item.id);
  if (JSON.stringify(ids) !== JSON.stringify(GATE_IDS)) {
    throw new Error("benchmark gate order or identity changed");
  }
  if (canonicalJson(report.gates as unknown as JsonValue) !== canonicalJson(
    buildGates(report.quality, report.cache, report.tokens) as unknown as JsonValue,
  )) {
    throw new Error("benchmark gate values do not match measured results");
  }
  if (
    report.status !== "PASS"
    || report.quality.status !== "PASS"
    || report.cache.status !== "PASS"
    || report.tokens.status !== "PASS"
    || report.gates.some(item => !item.required || item.status !== "PASS")
  ) {
    throw new Error("release-readiness benchmark gate failed");
  }
}

export function canonicalReleaseReadinessReport(
  report: ReleaseReadinessReport,
): string {
  return `${canonicalJson(report as unknown as JsonValue)}\n`;
}
