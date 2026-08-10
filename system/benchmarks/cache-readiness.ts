import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CACHE_KEY_INPUT,
  CACHE_PAYLOAD,
  RELEVANT_CONTEXT,
} from "../../benchmarks/release-readiness-suite";
import {
  canonicalJson,
  computeContextCacheKey,
  computeRelevantContextDigest,
  sha256Digest,
  type ContextCacheKeyInput,
  type JsonValue,
} from "../runtime/context-plan";
import {
  ContextCacheIntegrityError,
  LocalContextCache,
} from "../runtime/local-context-cache";
import type { BenchmarkStatus } from "./release-readiness";

export type CacheBenchmarkResult = Readonly<{
  status: BenchmarkStatus;
  coldMiss: boolean;
  warmHit: boolean;
  payloadEqual: boolean;
  idempotentPayloadDigest: boolean;
  keyInvalidations: Readonly<{ expected: 10; observed: number }>;
  relevantOrderStable: boolean;
  relevantChangeInvalidated: boolean;
  tamperRejected: boolean;
}>;

const CACHE_DIGEST_FIELDS = [
  "protocolDigest",
  "schemaDigest",
  "policyDigest",
  "profileDigest",
  "relevantBasisDigest",
  "relevantSourceDigest",
  "capabilityDigest",
  "toolchainDigest",
  "environmentDigest",
] as const satisfies readonly (keyof ContextCacheKeyInput)[];

export async function evaluateCacheBenchmark(
  cacheRoot: string,
): Promise<CacheBenchmarkResult> {
  const cache = new LocalContextCache(cacheRoot);
  const key = computeContextCacheKey(CACHE_KEY_INPUT);
  const coldMiss = await cache.get(key) === undefined;
  const stored = await cache.put(key, CACHE_PAYLOAD);
  const warm = await cache.get(key);
  const warmHit = warm !== undefined;
  const payloadEqual = warm !== undefined
    && canonicalJson(warm) === canonicalJson(CACHE_PAYLOAD);
  const reorderedPayload: JsonValue = {
    obligations: 9,
    verdict: "PASS",
    schemaVersion: "release-benchmark-cache-payload/v1",
  };
  const repeated = await cache.put(key, reorderedPayload);
  const idempotentPayloadDigest = stored.payloadDigest === repeated.payloadDigest;

  let observed = 0;
  for (const field of CACHE_DIGEST_FIELDS) {
    const changed = {
      ...CACHE_KEY_INPUT,
      [field]: sha256Digest(`changed:${field}`),
    };
    if (computeContextCacheKey(changed) !== key) observed += 1;
  }
  const changedNamespace = {
    ...CACHE_KEY_INPUT,
    namespace: { visibility: "private" as const, repositoryId: "other-repository" },
  };
  if (computeContextCacheKey(changedNamespace) !== key) observed += 1;

  const relevant = computeRelevantContextDigest(RELEVANT_CONTEXT);
  const relevantOrderStable = relevant === computeRelevantContextDigest(
    [...RELEVANT_CONTEXT].reverse(),
  );
  const relevantChangeInvalidated = relevant !== computeRelevantContextDigest([
    RELEVANT_CONTEXT[0]!,
    { id: RELEVANT_CONTEXT[1]!.id, digest: sha256Digest("changed:relevant-source") },
  ]);

  await writeFile(
    join(cacheRoot, "sha256", key.slice("sha256:".length)),
    `${canonicalJson({
      schemaVersion: "context-cache-object/v1",
      key,
      payloadDigest: stored.payloadDigest,
      payload: { tampered: true },
    })}\n`,
  );
  let tamperRejected = false;
  try {
    await cache.get(key);
  } catch (error) {
    tamperRejected = error instanceof ContextCacheIntegrityError;
  }
  const status = coldMiss
    && warmHit
    && payloadEqual
    && idempotentPayloadDigest
    && observed === 10
    && relevantOrderStable
    && relevantChangeInvalidated
    && tamperRejected
    ? "PASS"
    : "FAIL";
  return Object.freeze({
    status,
    coldMiss,
    warmHit,
    payloadEqual,
    idempotentPayloadDigest,
    keyInvalidations: Object.freeze({ expected: 10 as const, observed }),
    relevantOrderStable,
    relevantChangeInvalidated,
    tamperRejected,
  });
}
