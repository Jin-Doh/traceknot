import {
  type BenchmarkOutcome,
  type QualityCase,
} from "../../benchmarks/release-readiness-suite";
import { resolveProofCarryingQaVerdict } from "../core/qa-core";
import type { BenchmarkStatus } from "./release-readiness";

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
