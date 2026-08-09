import { createHash } from "node:crypto";

export type Sha256Digest = `sha256:${string}`;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type ContextSegmentId =
  | "traceknot-protocol"
  | "schemas"
  | "verification-profile"
  | "repository-basis"
  | "current-change"
  | "current-obligation"
  | "prior-evidence";
export type ContextSegment = Readonly<{
  id: ContextSegmentId;
  stability: "immutable" | "version-bound" | "snapshot-bound" | "run-bound";
  digest: Sha256Digest;
  cachePolicy: "provider-prefix" | "local-content-addressed" | "none";
  sensitivity: "public" | "repository-private" | "secret";
}>;
export type ContextPlan = Readonly<{
  schemaVersion: "context-plan/v1";
  segments: readonly ContextSegment[];
}>;
export type ContextCacheKeyInput = Readonly<{
  namespace: Readonly<{ visibility: "public" } | { visibility: "private"; repositoryId: string }>;
  protocolDigest: Sha256Digest;
  schemaDigest: Sha256Digest;
  policyDigest: Sha256Digest;
  profileDigest: Sha256Digest;
  relevantBasisDigest: Sha256Digest;
  relevantSourceDigest: Sha256Digest;
  capabilityDigest: Sha256Digest;
  toolchainDigest: Sha256Digest;
  environmentDigest: Sha256Digest;
}>;
export type RelevantContextEntry = Readonly<{ id: string; digest: Sha256Digest }>;

const SEGMENT_ORDER = [
  "traceknot-protocol",
  "schemas",
  "verification-profile",
  "repository-basis",
  "current-change",
  "current-obligation",
  "prior-evidence",
] as const satisfies readonly ContextSegmentId[];
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && DIGEST.test(value);
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw Error("canonical JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}

export function sha256Digest(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertSegment(segment: ContextSegment): void {
  if (!SEGMENT_ORDER.includes(segment.id)) throw Error(`unknown context segment: ${segment.id}`);
  if (!isSha256Digest(segment.digest)) throw Error(`invalid context segment digest: ${segment.id}`);
  if (segment.sensitivity === "secret" && segment.cachePolicy !== "none") throw Error(`secret context segment cannot be cached: ${segment.id}`);
  if (segment.stability === "run-bound" && segment.cachePolicy !== "none") throw Error(`run-bound context segment cannot be cached: ${segment.id}`);
  if (segment.cachePolicy === "provider-prefix" && (segment.sensitivity !== "public" || !["immutable", "version-bound"].includes(segment.stability))) {
    throw Error(`provider-prefix context segment must be stable and public: ${segment.id}`);
  }
}

export function buildContextPlan(input: readonly ContextSegment[]): ContextPlan {
  if (input.length !== SEGMENT_ORDER.length) throw Error("context plan must contain every canonical segment exactly once");
  const byId = new Map<ContextSegmentId, ContextSegment>();
  for (const segment of input) {
    assertSegment(segment);
    if (byId.has(segment.id)) throw Error(`duplicate context segment: ${segment.id}`);
    byId.set(segment.id, segment);
  }
  const segments = SEGMENT_ORDER.map(id => {
    const segment = byId.get(id);
    if (!segment) throw Error(`missing context segment: ${id}`);
    return Object.freeze({
      id: segment.id,
      stability: segment.stability,
      digest: segment.digest,
      cachePolicy: segment.cachePolicy,
      sensitivity: segment.sensitivity,
    });
  });
  return Object.freeze({ schemaVersion: "context-plan/v1", segments: Object.freeze(segments) });
}

export function computeContextCacheKey(input: ContextCacheKeyInput): Sha256Digest {
  const digests = [
    input.protocolDigest,
    input.schemaDigest,
    input.policyDigest,
    input.profileDigest,
    input.relevantBasisDigest,
    input.relevantSourceDigest,
    input.capabilityDigest,
    input.toolchainDigest,
    input.environmentDigest,
  ];
  if (!digests.every(isSha256Digest)) throw Error("invalid context cache key digest");
  if (input.namespace.visibility === "private" && input.namespace.repositoryId.trim().length === 0) throw Error("private context cache namespace requires a repository id");
  const namespace: JsonValue = input.namespace.visibility === "public"
    ? { visibility: "public" }
    : { visibility: "private", repositoryId: input.namespace.repositoryId };
  return sha256Digest(canonicalJson({
    namespace,
    protocolDigest: input.protocolDigest,
    schemaDigest: input.schemaDigest,
    policyDigest: input.policyDigest,
    profileDigest: input.profileDigest,
    relevantBasisDigest: input.relevantBasisDigest,
    relevantSourceDigest: input.relevantSourceDigest,
    capabilityDigest: input.capabilityDigest,
    toolchainDigest: input.toolchainDigest,
    environmentDigest: input.environmentDigest,
  }));
}

export function computeRelevantContextDigest(entries: readonly RelevantContextEntry[]): Sha256Digest {
  const byId = new Map<string, Sha256Digest>();
  for (const entry of entries) {
    if (entry.id.trim().length === 0 || !isSha256Digest(entry.digest)) throw Error("invalid relevant context entry");
    if (byId.has(entry.id)) throw Error(`duplicate relevant context entry: ${entry.id}`);
    byId.set(entry.id, entry.digest);
  }
  const canonicalEntries: JsonValue = [...byId].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([id, entryDigest]) => ({ id, digest: entryDigest }));
  return sha256Digest(canonicalJson(canonicalEntries));
}
