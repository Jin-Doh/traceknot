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

The composite Action exposes `board: true|false` (default `false`). In manifest mode, `board: true` passes `--board`, `--no-notify`, a bounded invocation ID, and `--session-host github-actions`. The generated Board remains inside the retained evidence directory. The `board-path` output points to the generated run-state root containing Board revisions.

Self-hosting mode keeps the existing canonical CI gate and does not enable desktop presentation behavior.

## Verification

The Board contract is covered by:

```sh
bun test system/presentation/qa-board.test.ts \
  system/presentation/qa-board-store.test.ts \
  system/presentation/user-notifier.test.ts \
  system/presentation/board-opener.test.ts \
  system/runtime/verify-cli.test.ts \
  tests/github-action-contract.test.ts
```

The canonical repository gate remains `sh scripts/ci`.
