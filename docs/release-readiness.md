# Release-readiness benchmark

Traceknot's `traceknot-1.0/v1` benchmark is a deterministic conformance gate. It answers whether the versioned decision, cache, and usage-accounting contracts still behave exactly as reviewed. It does not measure elapsed time, throughput, memory, model quality, provider cache effectiveness, token reduction, or cost savings.

Run the benchmark with Bun 1.3.14:

```sh
bun run benchmark:release
```

The command writes one canonical `traceknot-benchmark-report/v1` JSON document to stdout. Use an absolute report path when a retained file is needed:

```sh
bun scripts/check-release-readiness.ts --report /tmp/traceknot-benchmark.json
```

The report is validated by `contracts/benchmark-report.schema.json`. It contains no timestamps, durations, temporary paths, host names, random identifiers, providers, or model names, so two clean runs emit byte-identical output.

## Quality gate

Nine fixed proof-carrying QA graphs cover:

- a complete proof chain;
- demonstrated failure and non-executable blocking;
- missing and cross-snapshot evidence;
- uncovered test basis;
- duplicate record rejection;
- `FAIL > BLOCKED > INCOMPLETE` verdict precedence.

The gate requires all nine expected outcomes to match and allows zero false passes. The benchmark tests deterministic resolver conformance; it is not evidence that an agent produced a good answer.

## Cache gate

The cache benchmark uses a fresh external root and production `ContextCacheKeyInput`, `LocalContextCache`, and relevant-context digest code. It requires:

- cold miss, one store, and integrity-checked warm hit;
- canonical payload equality and idempotent payload digest;
- invalidation of all nine digest boundaries and the private repository namespace;
- stable relevant-context order and invalidation after content change;
- rejection of a tampered cache object.

These checks prove keying, persistence, integrity, and replay equality. They do not claim a production hit rate or prove that a warm entry avoids provider or verifier work.

## Token-accounting gate

The benchmark constructs an empty `RunUsageTelemetry` report through production code. Because no provider executes, every token field, cache-hit rate, and cost remains `"unavailable"` while `modelCalls` remains `0`.

The gate rejects numeric zero as a substitute for an unavailable observation and emits:

```json
{
  "providerEfficiencyClaim": "NOT_EVALUATED"
}
```

Traceknot 1.0 therefore hard-gates honest accounting, not an unsupported efficiency claim. A future provider-efficiency benchmark needs paired real traces bound to the same workload, snapshot, provider, model, tokenizer or accounting revision, and sampling policy. That evidence requires a new report schema.

## Required gates

All eight records must appear once, in canonical order, with `required: true` and `status: "PASS"`:

1. `1.0-quality-all-cases-match`
2. `1.0-quality-zero-false-pass`
3. `1.0-cache-cold-warm-parity`
4. `1.0-cache-all-key-boundaries-invalidate`
5. `1.0-cache-relevance-semantics`
6. `1.0-cache-integrity-rejection`
7. `1.0-token-unavailable-preserved`
8. `1.0-token-no-unsubstantiated-efficiency-claim`

`scripts/ci` runs and schema-validates this benchmark before canonical self-hosting. The same hard gate therefore applies to local CI, pull requests, governed verification, promotion, and release workflows.
