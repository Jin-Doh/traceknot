import { isAbsolute, relative, resolve } from "node:path";
import {
  canonicalJson,
  computeContextCacheKey,
  sha256Digest,
  type JsonValue,
  type Sha256Digest,
} from "./context-plan";
import { LocalContextCache } from "./local-context-cache";
import {
  runSelfHostingVerification,
  type SelfHostingCommand,
} from "./self-hosting-verification";
import {
  RunUsageTelemetry,
  type UsageReport,
} from "./usage-telemetry";

export type SelfHostingParityReport = Readonly<{
  schemaVersion: "self-hosting-parity-report/v1";
  runId: string;
  requestId: string;
  snapshotId: string;
  verification: Readonly<{
    state: "TERMINAL";
    qaVerdict: "PASS";
    runDigest: Sha256Digest;
    verdictDigest: Sha256Digest;
  }>;
  cache: Readonly<{
    key: Sha256Digest;
    payloadDigest: Sha256Digest;
    cold: "MISS";
    warm: "HIT";
    equal: true;
  }>;
  usage: UsageReport;
}>;

function jsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw Error("self-hosting cache payload is not JSON");
  return JSON.parse(serialized) as JsonValue;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) throw Error(`self-hosting ${key} must be a nonempty string`);
  return field;
}

function cacheKey(command: SelfHostingCommand, run: Readonly<Record<string, unknown>>): Sha256Digest {
  const rootIdentity = requiredString(run, "rootIdentity");
  const snapshotId = requiredString(run, "snapshotId");
  return computeContextCacheKey({
    namespace: { visibility: "private", repositoryId: sha256Digest(rootIdentity) },
    protocolDigest: sha256Digest("traceknot-self-hosting-parity/v1"),
    schemaDigest: sha256Digest("self-hosting-parity-report/v1"),
    policyDigest: sha256Digest(canonicalJson(jsonValue({
      executable: command.executable,
      argv: command.argv,
    }))),
    profileDigest: sha256Digest("canonical-self-hosting"),
    relevantBasisDigest: sha256Digest(requiredString(run, "requestId")),
    relevantSourceDigest: sha256Digest(snapshotId),
    capabilityDigest: sha256Digest("local-shell-collector"),
    toolchainDigest: sha256Digest(`bun-${Bun.version}`),
    environmentDigest: sha256Digest(`${process.platform}:${process.arch}`),
  });
}

function assertExternalCacheRoot(rootDir: string, cacheRoot: string): void {
  const root = resolve(rootDir);
  const cache = resolve(cacheRoot);
  const fromRoot = relative(root, cache);
  if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) {
    throw Error("self-hosting cache root must be outside the verified repository");
  }
}

export async function runSelfHostingCacheParity(
  command: SelfHostingCommand,
  cacheRoot: string,
): Promise<SelfHostingParityReport> {
  assertExternalCacheRoot(command.rootDir, cacheRoot);
  const result = await runSelfHostingVerification(command);
  const run = record(result.reportOnly.run, "self-hosting run");
  const verdict = record(result.reportOnly.verdict, "self-hosting verdict");
  const runId = requiredString(run, "runId");
  const requestId = requiredString(run, "requestId");
  const snapshotId = requiredString(run, "snapshotId");
  if (requiredString(run, "state") !== "TERMINAL") throw Error("self-hosting run must be TERMINAL");
  if (requiredString(verdict, "qaVerdict") !== "PASS") throw Error("self-hosting verdict must be PASS");

  const key = cacheKey(command, run);
  const cache = new LocalContextCache(cacheRoot);
  if (await cache.get(key) !== undefined) throw Error("self-hosting parity requires a cold cache");
  const payload = jsonValue({
    schemaVersion: "self-hosting-cache-payload/v1",
    run: result.reportOnly.run,
    verdict: result.reportOnly.verdict,
    snapshot: result.reportOnly.snapshot,
  });
  const stored = await cache.put(key, payload);
  const warm = await cache.get(key);
  if (warm === undefined) throw Error("self-hosting warm cache entry is missing");
  if (canonicalJson(payload) !== canonicalJson(warm)) throw Error("self-hosting cold and warm cache payloads differ");

  const usage = new RunUsageTelemetry({ runId, requestId, snapshotId }).report();
  return Object.freeze({
    schemaVersion: "self-hosting-parity-report/v1",
    runId,
    requestId,
    snapshotId,
    verification: Object.freeze({
      state: "TERMINAL",
      qaVerdict: "PASS",
      runDigest: sha256Digest(canonicalJson(jsonValue(result.reportOnly.run))),
      verdictDigest: sha256Digest(canonicalJson(jsonValue(result.reportOnly.verdict))),
    }),
    cache: Object.freeze({
      key,
      payloadDigest: stored.payloadDigest,
      cold: "MISS",
      warm: "HIT",
      equal: true,
    }),
    usage,
  });
}
