import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "bun:test";
import { RunUsageTelemetry, type UsageSample } from "./usage-telemetry";

const identity = {
  runId: "run-usage",
  requestId: "request-usage",
  snapshotId: "snapshot-usage",
} as const;

const sample = (overrides: Partial<UsageSample> = {}): UsageSample => ({
  sampleId: "sample-1",
  inputTokens: 100,
  cachedInputTokens: 60,
  cacheWriteTokens: 10,
  outputTokens: 20,
  reasoningTokens: 5,
  cost: { status: "estimated", currency: "USD", amount: 0.25 },
  ...overrides,
});

describe("run usage telemetry", () => {
  test("aggregates token, cache, model-call, and cost usage", () => {
    const telemetry = new RunUsageTelemetry(identity);
    telemetry.record(sample());
    telemetry.record(sample({
      sampleId: "sample-2",
      inputTokens: 50,
      cachedInputTokens: 15,
      cacheWriteTokens: 5,
      outputTokens: 10,
      reasoningTokens: 3,
      cost: { status: "actual", currency: "USD", amount: 0.1 },
    }));
    expect(telemetry.report()).toEqual({
      schemaVersion: "usage-report/v1",
      ...identity,
      inputTokens: 150,
      cachedInputTokens: 75,
      cacheWriteTokens: 15,
      outputTokens: 30,
      reasoningTokens: 8,
      modelCalls: 2,
      cacheHitRate: 0.5,
      estimatedCost: { status: "estimated", currency: "USD", amount: 0.35 },
    });
  });

  test("distinguishes explicit zero from unavailable provider usage", () => {
    const zero = new RunUsageTelemetry(identity);
    zero.record(sample({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cost: { status: "actual", currency: "USD", amount: 0 },
    }));
    expect(zero.report()).toMatchObject({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheHitRate: 0,
      estimatedCost: { status: "actual", currency: "USD", amount: 0 },
    });

    const unavailable = new RunUsageTelemetry(identity);
    unavailable.record({ sampleId: "unavailable" });
    expect(unavailable.report()).toMatchObject({
      inputTokens: "unavailable",
      cachedInputTokens: "unavailable",
      cacheWriteTokens: "unavailable",
      outputTokens: "unavailable",
      reasoningTokens: "unavailable",
      modelCalls: 1,
      cacheHitRate: "unavailable",
      estimatedCost: { status: "unavailable" },
    });
  });

  test("does not undercount a partially unavailable total", () => {
    const telemetry = new RunUsageTelemetry(identity);
    telemetry.record(sample());
    telemetry.record({ sampleId: "sample-2", outputTokens: 5 });
    expect(telemetry.report()).toMatchObject({
      inputTokens: "unavailable",
      cachedInputTokens: "unavailable",
      outputTokens: 25,
      cacheHitRate: "unavailable",
      estimatedCost: { status: "unavailable" },
    });
  });

  test("deduplicates an identical sample and rejects a conflicting replay", () => {
    const telemetry = new RunUsageTelemetry(identity);
    telemetry.record(sample());
    telemetry.record(sample());
    expect(telemetry.report().modelCalls).toBe(1);
    expect(() => telemetry.record(sample({ inputTokens: 101 }))).toThrow("usage sample conflict");
  });

  test("matches the published usage-report schema", () => {
    const schema = JSON.parse(readFileSync(resolve("contracts/usage-report.schema.json"), "utf8"));
    const validate = new Ajv2020({ strict: true }).compile(schema);
    const telemetry = new RunUsageTelemetry(identity);
    telemetry.record(sample());
    expect(validate(telemetry.report())).toBe(true);
    expect(validate({ ...telemetry.report(), inputTokens: -1 })).toBe(false);
    expect(validate({ ...telemetry.report(), extra: true })).toBe(false);
  });
});
