# Traceknot QA Board

Traceknot can project a completed verification run into a static, non-authoritative QA Board. The Board is a presentation artifact; the canonical verification run, verdict, and evidence remain authoritative.

## CLI

Generate a Board during verification:

```sh
traceknot verify \
  --request REQUEST.json \
  --manifest MANIFEST.json \
  --state-dir /secure/state \
  --artifact-dir /secure/artifacts \
  --board \
  --no-notify
```

Regenerate a Board from a persisted terminal run without executing obligations:

```sh
traceknot verify \
  --run-id RUN_ID \
  --report-only \
  --board \
  --no-notify
```

`--open-board` implies `--board` and asks the platform opener to open the generated `file://` URI. `--session-id` is never written raw; the manifest stores a SHA-256 session reference. `--invocation-id` is optional and must be a safe identifier; CI uses it to make the Board directory deterministic for that action invocation.

The CLI preserves the verification verdict exit code. Board generation, notification, and opening are isolated: failures emit a `Traceknot Board unavailable:` or platform warning on stderr and do not convert a completed verification verdict into an internal error.

## Bundle layout

Boards are immutable invocation directories below the durable run state:

```text
runs/<run-id>/boards/<revision>-<invocation-id>/
├── index.html
├── manifest.json
└── evidence/
    └── <sha256>.png
```

The writer uses descriptor-pinned secure filesystem primitives, rejects unsafe IDs and symlink traversal, writes files through temporary files plus rename, fsyncs file and directory updates, and never overwrites a published Board revision. Screenshot previews are copied from the canonical artifact store only after byte-level SHA-256 verification and bounded by the Board preview limits.

`manifest.json` records source run identity, snapshot identity, revision, verdict, counts, generated-by metadata, and file digests. It declares `authoritative: false`. HTML escapes untrusted text and uses a restrictive default-deny CSP; the Board does not fetch remote resources or execute user-provided scripts.

## Desktop integration

Notifications are opt-in by omission of `--no-notify` and are best-effort:

- macOS: `osascript` with user values passed as arguments, not interpolated into AppleScript source.
- Linux: `notify-send` when a desktop display is available.
- CI, SSH, non-desktop, unsupported, or unavailable command environments: suppressed or reported as unavailable.

`--open-board` uses `open` on macOS and `xdg-open` on Linux. It accepts only local `file://` URIs.

## GitHub Action

The composite Action exposes `board: true|false` (default `false`). In manifest mode, `board: true` passes `--board`, `--no-notify`, a bounded invocation ID, and `--session-host github-actions`. The generated Board remains immutable below the retained run state, and the Board artifact selects only the published `<revision>-<invocation-id>` bundle, never a private pending tree. With `board: false`, no Board upload is attempted. Canonical evidence upload excludes only the Board directories while retaining canonical run-state metadata.

The canonical artifact name is `${artifact-name}-${invocation-id}` and the Board artifact name is `${artifact-name}-board-${invocation-id}`. Both names are invocation-unique. `artifact-retention-days` defaults to `30`, and `board-retention-days` defaults to `14`; both must be integers from `1` through `90`. Validation occurs before verification starts.

Summary publication runs first, followed by canonical evidence upload, Board upload (when enabled and generated), optional SARIF upload, and finally optional local cleanup. Set `cleanup-local-after-upload: true` to remove the private evidence directory after all publication steps succeed; if any required upload fails, local evidence remains available for recovery. The default is `false`, so `report-path`, `evidence-path`, and `board-path` remain valid on the runner after the Action finishes.

On persistent self-hosted runners, provide a private, writable `RUNNER_TEMP` on the runner volume and restrict access to the runner service account. The default keeps each invocation's local evidence for post-step inspection; use `cleanup-local-after-upload: true` when local inspection is not needed, and separately schedule host-level cleanup for abandoned directories after interrupted jobs. Artifact retention controls GitHub-hosted copies and does not replace local runner cleanup.

Self-hosting mode keeps the existing canonical CI gate and does not enable desktop presentation behavior.

## Local storage lifecycle

Verification applies maintenance automatically only when both storage paths are omitted and a Board is generated in the standard per-repository `~/.cache/traceknot` location. It prunes once before publication and again after atomic publication so count and quota rules include the new Board. Failures are warnings and never change the verification verdict. Explicit durable state/artifact paths are never pruned implicitly; inspect them first:

```sh
traceknot storage status \
  --state-dir /secure/state \
  --artifact-dir /secure/artifacts
```

`traceknot storage prune` is a dry run unless `--apply` is present. The default cache policy retains Boards for 30 days and at most 10 Boards per run, canonical run state for 90 days, and newly unreferenced objects for a 24-hour grace period. It also applies 1 GiB Board and 5 GiB canonical quotas. These defaults are intended for the standard `~/.cache/traceknot` layout; explicitly managed durable directories remain observe-only until an operator invokes prune.

```sh
traceknot storage prune \
  --state-dir /secure/state \
  --artifact-dir /secure/artifacts

traceknot storage prune \
  --state-dir /secure/state \
  --artifact-dir /secure/artifacts \
  --apply
```

Every prune emits a `traceknot-storage-maintenance/v1` report conforming to `contracts/storage-maintenance-report.schema.json`. The report includes inventory totals, policy values, candidates, actual deletions, protected entries, and warnings. Active, pinned, malformed, future-dated, and newest terminal runs are protected. Canonical objects referenced by retained runs remain protected; unreferenced objects are eligible only after the grace period. Symlinks are never followed or deleted.
Applied maintenance coordinates with repository readers/writers, canonical artifact publication, and invocation-scoped collector lifetime leases through advisory locks. A run currently being projected into a Board is protected across both automatic maintenance passes.

Pinning is explicit and durable:

```sh
traceknot storage pin RUN_ID --state-dir /secure/state --artifact-dir /secure/artifacts
traceknot storage unpin RUN_ID --state-dir /secure/state --artifact-dir /secure/artifacts
```

Run `status` before and after applied maintenance. A partial deletion or concurrent replacement is reported rather than treated as success; canonical verification verdicts are never changed by storage maintenance.

## Verification

The Board contract is covered by:

```sh
bun test system/presentation/qa-board.test.ts \
  system/presentation/qa-board-store.test.ts \
  system/presentation/user-notifier.test.ts \
  system/presentation/board-opener.test.ts \
  system/runtime/verify-cli.test.ts \
  system/runtime/storage-retention.test.ts \
  tests/github-action-contract.test.ts
```

The canonical repository gate remains `sh scripts/ci`.
