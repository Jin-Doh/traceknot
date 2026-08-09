import { canonicalJson, type JsonValue } from "./context-plan";

export type UsageCost = Readonly<{
  status: "actual" | "estimated";
  currency: string;
  amount: number;
}>;
export type UsageSample = Readonly<{
  sampleId: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cost?: UsageCost;
}>;
export type UsageMetric = number | "unavailable";
export type UsageReport = Readonly<{
  schemaVersion: "usage-report/v1";
  runId: string;
  requestId: string;
  snapshotId: string;
  inputTokens: UsageMetric;
  cachedInputTokens: UsageMetric;
  cacheWriteTokens: UsageMetric;
  outputTokens: UsageMetric;
  reasoningTokens: UsageMetric;
  modelCalls: number;
  cacheHitRate: UsageMetric;
  estimatedCost: UsageCost | Readonly<{ status: "unavailable" }>;
}>;
export type UsageIdentity = Readonly<{ runId: string; requestId: string; snapshotId: string }>;

const SAMPLE_KEYS = ["sampleId", "inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "cost"] as const;
const TOKEN_FIELDS = ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens"] as const;
type TokenField = typeof TOKEN_FIELDS[number];

function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw Error(`${name} must be a nonnegative safe integer`);
  return value as number;
}

function normalizeCost(value: UsageCost): UsageCost {
  if (!["actual", "estimated"].includes(value.status)) throw Error("invalid usage cost status");
  if (!/^[A-Z]{3}$/.test(value.currency)) throw Error("usage cost currency must be a three-letter uppercase code");
  if (!Number.isFinite(value.amount) || value.amount < 0) throw Error("usage cost amount must be nonnegative and finite");
  return Object.freeze({ status: value.status, currency: value.currency, amount: value.amount });
}

function normalizeSample(input: UsageSample): UsageSample {
  if (!input || typeof input !== "object" || input.sampleId.trim().length === 0) throw Error("usage sample id is required");
  const extras = Object.keys(input).filter(key => !SAMPLE_KEYS.includes(key as typeof SAMPLE_KEYS[number]));
  if (extras.length > 0) throw Error(`unknown usage sample field: ${extras[0]}`);
  const sample: {
    sampleId: string;
    inputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cost?: UsageCost;
  } = { sampleId: input.sampleId };
  for (const field of TOKEN_FIELDS) if (input[field] !== undefined) sample[field] = nonnegativeInteger(input[field], field);
  if (sample.inputTokens !== undefined && sample.cachedInputTokens !== undefined && sample.cachedInputTokens > sample.inputTokens) {
    throw Error("cached input tokens cannot exceed input tokens");
  }
  if (input.cost !== undefined) sample.cost = normalizeCost(input.cost);
  return Object.freeze(sample);
}

export class RunUsageTelemetry {
  private readonly samples = new Map<string, UsageSample>();
  private readonly identity: UsageIdentity;

  constructor(identity: UsageIdentity) {
    if ([identity.runId, identity.requestId, identity.snapshotId].some(value => value.trim().length === 0)) throw Error("usage identity fields are required");
    this.identity = Object.freeze({ ...identity });
  }

  record(input: UsageSample): void {
    const sample = normalizeSample(input);
    const existing = this.samples.get(sample.sampleId);
    if (existing) {
      if (canonicalJson(existing as unknown as JsonValue) !== canonicalJson(sample as unknown as JsonValue)) throw Error(`usage sample conflict: ${sample.sampleId}`);
      return;
    }
    this.samples.set(sample.sampleId, sample);
  }

  report(): UsageReport {
    const inputTokens = this.total("inputTokens");
    const cachedInputTokens = this.total("cachedInputTokens");
    const cacheHitRate = typeof inputTokens === "number" && typeof cachedInputTokens === "number"
      ? inputTokens === 0 ? 0 : cachedInputTokens / inputTokens
      : "unavailable";
    return Object.freeze({
      schemaVersion: "usage-report/v1",
      ...this.identity,
      inputTokens,
      cachedInputTokens,
      cacheWriteTokens: this.total("cacheWriteTokens"),
      outputTokens: this.total("outputTokens"),
      reasoningTokens: this.total("reasoningTokens"),
      modelCalls: this.samples.size,
      cacheHitRate,
      estimatedCost: this.totalCost(),
    });
  }

  private total(field: TokenField): UsageMetric {
    if (this.samples.size === 0) return "unavailable";
    let total = 0;
    for (const sample of this.samples.values()) {
      const value = sample[field];
      if (value === undefined) return "unavailable";
      total += value;
      if (!Number.isSafeInteger(total)) throw Error(`${field} total exceeds safe integer range`);
    }
    return total;
  }

  private totalCost(): UsageReport["estimatedCost"] {
    if (this.samples.size === 0) return Object.freeze({ status: "unavailable" });
    const costs = [...this.samples.values()].map(sample => sample.cost);
    if (costs.some(cost => cost === undefined)) return Object.freeze({ status: "unavailable" });
    const available = costs as UsageCost[];
    const currency = available[0]!.currency;
    if (available.some(cost => cost.currency !== currency)) return Object.freeze({ status: "unavailable" });
    const amount = Number(available.reduce((total, cost) => total + cost.amount, 0).toFixed(12));
    const status = available.every(cost => cost.status === "actual") ? "actual" : "estimated";
    return Object.freeze({ status, currency, amount });
  }
}
