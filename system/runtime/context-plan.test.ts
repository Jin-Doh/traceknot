import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "bun:test";
import {
  buildContextPlan,
  computeContextCacheKey,
  computeRelevantContextDigest,
  type ContextCacheKeyInput,
  type ContextSegment,
} from "./context-plan";

const digest = (value: string): `sha256:${string}` =>
  `sha256:${value.padEnd(64, value).slice(0, 64)}`;

const segments = [
  { id: "prior-evidence", stability: "run-bound", digest: digest("7"), cachePolicy: "none", sensitivity: "repository-private" },
  { id: "repository-basis", stability: "snapshot-bound", digest: digest("4"), cachePolicy: "local-content-addressed", sensitivity: "repository-private" },
  { id: "traceknot-protocol", stability: "immutable", digest: digest("1"), cachePolicy: "provider-prefix", sensitivity: "public" },
  { id: "current-obligation", stability: "run-bound", digest: digest("6"), cachePolicy: "none", sensitivity: "repository-private" },
  { id: "schemas", stability: "version-bound", digest: digest("2"), cachePolicy: "provider-prefix", sensitivity: "public" },
  { id: "current-change", stability: "run-bound", digest: digest("5"), cachePolicy: "none", sensitivity: "repository-private" },
  { id: "verification-profile", stability: "version-bound", digest: digest("3"), cachePolicy: "provider-prefix", sensitivity: "public" },
] satisfies ContextSegment[];

const keyInput = {
  namespace: { visibility: "private", repositoryId: "repo-A" },
  protocolDigest: digest("a"),
  schemaDigest: digest("b"),
  policyDigest: digest("c"),
  profileDigest: digest("d"),
  relevantBasisDigest: digest("e"),
  relevantSourceDigest: digest("f"),
  capabilityDigest: digest("1"),
  toolchainDigest: digest("2"),
  environmentDigest: digest("3"),
} satisfies ContextCacheKeyInput;

describe("context plan", () => {
  test("emits the fixed prompt segment order", () => {
    const plan = buildContextPlan(segments);
    expect(plan.schemaVersion).toBe("context-plan/v1");
    expect(plan.segments.map(segment => segment.id)).toEqual([
      "traceknot-protocol",
      "schemas",
      "verification-profile",
      "repository-basis",
      "current-change",
      "current-obligation",
      "prior-evidence",
    ]);
  });

  test.each([
    ["secret provider prefix", { ...segments[0]!, cachePolicy: "provider-prefix", sensitivity: "secret" }],
    ["secret local cache", { ...segments[0]!, cachePolicy: "local-content-addressed", sensitivity: "secret" }],
    ["run-bound provider prefix", { ...segments[0]!, cachePolicy: "provider-prefix" }],
    ["duplicate segment", segments[0]!],
  ] as const)("rejects invalid cache boundaries: %s", (_name, invalid) => {
    const candidate = _name === "duplicate segment" ? [...segments, invalid] : segments.map((segment, index) => index === 0 ? invalid : segment);
    expect(() => buildContextPlan(candidate as ContextSegment[])).toThrow();
  });

  test("matches the context-plan schema and rejects extra fields", () => {
    const schema = JSON.parse(readFileSync(resolve("contracts/context-plan.schema.json"), "utf8"));
    const validate = new Ajv2020({ strict: true }).compile(schema);
    const plan = buildContextPlan(segments);
    expect(validate(plan)).toBe(true);
    expect(validate({ ...plan, timestamp: "2026-08-09T00:00:00Z" })).toBe(false);
  });

  test("rebuilds segments without caller-owned extra fields", () => {
    const injected = { ...segments[0]!, injected: "not-in-contract" };
    const input = [injected, ...segments.slice(1)] as ContextSegment[];
    const plan = buildContextPlan(input);
    const rebuilt = plan.segments.find(segment => segment.id === injected.id);
    if (!rebuilt) throw new Error("missing rebuilt segment");
    expect(Object.hasOwn(rebuilt, "injected")).toBe(false);
  });
});

describe("context cache key", () => {
  test.each([
    "protocolDigest",
    "schemaDigest",
    "policyDigest",
    "profileDigest",
    "relevantBasisDigest",
    "relevantSourceDigest",
    "capabilityDigest",
    "toolchainDigest",
    "environmentDigest",
  ] as const)("invalidates when %s changes", field => {
    const baseline = computeContextCacheKey(keyInput);
    const changed = computeContextCacheKey({ ...keyInput, [field]: digest("9") });
    expect(changed).not.toBe(baseline);
  });

  test("isolates private repositories while sharing public context", () => {
    const privateA = computeContextCacheKey(keyInput);
    const privateB = computeContextCacheKey({ ...keyInput, namespace: { visibility: "private", repositoryId: "repo-B" } });
    const publicA = computeContextCacheKey({ ...keyInput, namespace: { visibility: "public" } });
    const publicB = computeContextCacheKey({ ...keyInput, namespace: { visibility: "public" } });
    expect(privateB).not.toBe(privateA);
    expect(publicB).toBe(publicA);
  });

  test("ignores unrelated sources while deterministically invalidating relevant sources", () => {
    const relevant = [
      { id: "system/runtime/context-plan.ts", digest: digest("a") },
      { id: "contracts/context-plan.schema.json", digest: digest("b") },
    ];
    const reordered = [...relevant].reverse();
    const changed = [{ ...relevant[0]!, digest: digest("c") }, relevant[1]!];
    expect(computeRelevantContextDigest(reordered)).toBe(computeRelevantContextDigest(relevant));
    expect(computeRelevantContextDigest(changed)).not.toBe(computeRelevantContextDigest(relevant));
  });
});
