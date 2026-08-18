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

`Board` generation is enabled by default for CLI verification. Use `--no-board` to disable it; `--board` remains accepted as an explicit enable flag. `--open-board` implies Board generation and asks the platform opener to open the generated `file://` URI. `--board-locale auto|en|ko|zh-CN` selects the language of `index.html`; `auto` is the default and resolves `LC_ALL`, then `LC_MESSAGES`, then `LANG`, with English as the fallback. `--session-id` is never written raw; the manifest stores a SHA-256 session reference. `--invocation-id` is optional and must be a safe identifier; CI uses it to make the Board directory deterministic for that action invocation.

The CLI preserves the verification verdict exit code. Board generation, notification, and opening are isolated: failures emit a `Traceknot Board unavailable:` or platform warning on stderr and do not convert a completed verification verdict into an internal error.

Every bundle includes English, Korean, and Simplified Chinese views. The language switcher moves between those local static pages without scripts or network access. Only interface labels are localized; persisted summaries, evidence, identifiers, and verdict rationale remain byte-for-byte faithful to the canonical run.

## Portable Skill publication

Every Traceknot QA run has Board publication enabled by default. The portable Skill attempts the canonical or host-integrated publisher without waiting for a separate user request.

- use the canonical CLI publisher when it is available and the host advertises the required command and persistence capabilities;
- report `unavailable` with the missing prerequisite when a publisher cannot be used;
- reserve `disabled` for an explicit `--no-board` or equivalent policy opt-out;
- never fabricate a Board manifest, `file://` URI, run identity, or evidence from a chat completion.

Portable Skill guidance is presentation-only. A Board remains `authoritative: false`; its status is reported separately from the QA verdict. See `skill/references/qa-board.md` and `skill/references/completion-report.md`.

## Assurance context

The CLI defaults to `release` assurance and accepts `--assurance local|release`. The selected context is persisted in the request, CLI report, Board view, and Board manifest:

- `local` records a development verification path. UI composition and resilience obligations require a `separate-verification-context`; the report marks release assurance as `not-evaluated`.
- `release` is the publication gate. UI composition and resilience obligations require an `independent-producer`; a release report is `satisfied` only for `PASS` or `PASS_WITH_ACCEPTED_RISK`.

The CLI rejects a request whose persisted `assuranceContext` disagrees with `--assurance`. Assurance metadata does not upgrade a QA verdict, complete harness work, or replace signed external execution evidence.

## Visual presentation

Each localized page is a static projection of persisted verification data:

- **Verification health** shows mandatory passed checks over the mandatory total, with a status distribution for passed, failed, blocked, and incomplete obligations.
- **Verification flow** connects the persisted coverage areas, mandatory checks, accepted evidence, and final verdict into one readable path. It is explanatory only; it does not infer or recalculate the canonical verdict.
- Coverage rows use proportional bars and explicitly label zero-total areas as `Not applicable`, `해당 없음`, or `不适用`; finding lists use status-colored rails to preserve scan order.

The layout is responsive at desktop and mobile widths, supports the three bundled locales, and does not require JavaScript, network access, or remote assets.

### Optional project support

The first locally opened Board may include a separate, non-authoritative project-support panel with a fixed link to the Traceknot GitHub repository. It is not a verification finding, does not enter attention lists, counts, coverage, verdicts, manifests, or exit codes, and does not query GitHub, `gh`, authentication, or star status.

When the Board is opened successfully with `--open-board`, the CLI creates an empty `presentation/star-cta-v1.seen` marker below `--state-dir`. Future Board bundles omit the panel. Board generation without `--open-board`, headless environments, opener failure, and marker-write failure do not affect the verification result. Marker access is descriptor-relative, symlink-resistant, idempotent, and stores no user or account data.

## Bundle layout

Boards are immutable invocation directories below the durable run state:

```text
runs/<run-id>/boards/<revision>-<invocation-id>/
├── index.html
├── index.en.html
├── index.ko.html
├── index.zh-CN.html
├── manifest.json
└── evidence/
    └── <sha256>.png
```

The writer uses descriptor-pinned secure filesystem primitives, rejects unsafe IDs and symlink traversal, and requires the state root itself to have no group or world write access. Canonical ancestors must be owned by the current user or root; a writable ancestor is accepted only with the sticky bit, as with `/tmp`. The writer checks the project-support marker without opening the entry, writes files through temporary files plus rename, fsyncs file and directory updates, and never overwrites a published Board revision. Screenshot previews are copied from the canonical artifact store only after byte-level SHA-256 verification and bounded by the Board preview limits.

`manifest.json` records source run identity, snapshot identity, revision, verdict, counts, generated-by metadata, and file digests. It declares `authoritative: false`. HTML escapes untrusted text and uses a restrictive default-deny CSP; the Board does not fetch remote resources or execute user-provided scripts.

## Desktop integration

Desktop notifications are opt-in with `--notify`; `--no-notify` remains an explicit suppression flag. Board generation and browser opening do not imply a notification:

- macOS: `osascript` with user values passed as arguments, not interpolated into AppleScript source.
- Linux: `notify-send` when a desktop display is available.
- CI, SSH, non-desktop, unsupported, or unavailable command environments: suppressed or reported as unavailable.

`--open-board` uses `open` on macOS and `xdg-open` on Linux. It accepts only local `file://` URIs. Immediately before a desktop notification or opener handoff, the CLI reopens the private state root and checks every published Board file against the byte count and SHA-256 digest in `manifest.json`; a mismatch suppresses desktop exposure and leaves the canonical verdict unchanged.

## GitHub Action

The composite Action exposes `board: true|false` (default `true`). Set `board: false` to pass `--no-board` and disable Board generation. In manifest mode, `board: true` passes `--board`, `--no-notify`, a bounded invocation ID, and `--session-host github-actions`. The generated Board remains immutable below the retained run state, and the Board artifact selects only the published `<revision>-<invocation-id>` bundle, never a private pending tree. With `board: false`, no Board upload is attempted. Canonical evidence upload excludes only the Board directories while retaining canonical run-state metadata.

The canonical artifact name is `${artifact-name}-${invocation-id}` and the Board artifact name is `${artifact-name}-board-${invocation-id}`. Both names are invocation-unique. `artifact-retention-days` defaults to `30`, and `board-retention-days` defaults to `14`; both must be integers from `1` through `90`. Validation occurs before verification starts.

Summary publication runs first, followed by canonical evidence upload, Board upload (when enabled and generated), optional SARIF upload, and finally optional local cleanup. Board upload is skipped unless input preparation succeeded, so it never consumes missing invocation-scoped paths. Set `cleanup-local-after-upload: true` to remove the private evidence directory after all publication steps succeed; if any required upload fails, local evidence remains available for recovery. The default is `false`, so `report-path`, `evidence-path`, and `board-path` remain valid on the runner after the Action finishes.

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

Every prune emits a `traceknot-storage-maintenance/v1` report conforming to `contracts/storage-maintenance-report.schema.json`. The report includes inventory totals, policy values, candidates, actual deletions, protected entries, and warnings. Active, pinned, malformed, future-dated, and newest terminal runs are protected. Canonical objects referenced by retained runs remain protected; newly unreferenced objects receive a fresh grace interval before deletion. Exact crash-left artifact publication temporaries (`.objects/.tmp-<digest>-<uuid>`) are reclaimed as staging after the same grace interval; unknown `.objects` files remain malformed and protected. Symlinks are never followed or deleted.
Applied maintenance coordinates with repository readers/writers, canonical artifact publication, Board publication, and invocation-scoped collector lifetime leases through advisory locks. Contended in-process readers and writers retry without blocking the JavaScript event loop. Board publication holds its lease from temporary-directory creation through atomic rename, and collector teardown releases its lifetime lease even when content deletion fails so a later maintenance pass can recover the residual tree.

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
