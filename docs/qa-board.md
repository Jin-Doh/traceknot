# Traceknot QA Board

Traceknot projects accepted QA records into a static, non-authoritative Board. The canonical verification run, QA verdict, and evidence remain authoritative; Board publication never upgrades a verdict or turns presentation data into evidence.

## Canonical Skill installation

The Skills CLI is the canonical installation and update path. It copies the complete `skill/` tree, including the runnable `skill/bin/traceknot`, references, schemas, host capability manifests, and Board renderer. Node.js 22.20 or later is required for `npx`; Bun 1.3.14 or later is required to run the generated CLI.

```sh
npx skills add Jin-Doh/traceknot --skill traceknot --global
npx skills update traceknot --global --yes
# Global installation
$HOME/.agents/skills/traceknot/bin/traceknot self-check
# Project-local installation
.agents/skills/traceknot/bin/traceknot self-check
```

For a global Skills CLI install, invoke `$HOME/.agents/skills/traceknot/bin/traceknot`; for a project-local install, run `.agents/skills/traceknot/bin/traceknot` from the project root. `traceknot self-check` fails closed unless the generated executable, required schemas, host capability manifests, semantic update parser, and static renderer are available from the same installed Skill root.

The legacy curl installer installs only an optional prefix launcher and updater. It does not create, replace, retarget, update, or remove a Skills CLI-owned registration and does not define a second payload, Board contract, or feature tier. Reinstall or update removes only a legacy symlink that points into that same prefix.

## Board update interface

Build an update document from the existing `QaBoardView` projection and publish it through the executable from the same installation scope:

```sh
# Global installation
$HOME/.agents/skills/traceknot/bin/traceknot board update \
  --input UPDATE.json \
  --state-dir DIR \
  [--artifact-dir DIR] \
  [--open-board] \
  [--no-notify]
# Project-local installation
.agents/skills/traceknot/bin/traceknot board update \
  --input UPDATE.json \
  --state-dir DIR \
  [--artifact-dir DIR] \
  [--open-board] \
  [--no-notify]
```

`UPDATE.json` uses the single `traceknot-session-board-update/v1` envelope:

```json
{
  "schemaVersion": "traceknot-session-board-update/v1",
  "sessionId": "observed session identifier",
  "sessionHost": "observed host identifier",
  "generatedAt": "canonical UTC RFC 3339 timestamp",
  "invocationId": "optional safe invocation identifier",
  "view": "existing QaBoardView projection"
}
```

`invocationId` is optional; when omitted, the publisher uses a fresh random UUID, so retries publish distinct immutable revisions. Callers that need idempotent publication must provide a stable invocation ID. `view` is presentation data only. It must be copied from validated canonical records and cannot establish evidence, alter counts, or change the QA verdict.

The CLI validates the entire envelope before writing. It rejects unsafe strings and paths, malformed counts, statuses, or digests, inconsistent totals, an `authoritative` value other than `false`, and invalid timestamps. The renderer escapes dynamic values, uses no network resources or user-provided scripts, and reuses the existing artifact preview limits and byte-level digest checks.

The published JSON Schemas are closed structural contracts. Cross-field arithmetic and aggregate-to-finding consistency are enforced by the same runtime parser used by `board update`; schema validation alone is not acceptance. `parseSessionBoardUpdate` is the canonical semantic validator.

## Session-scoped publication

The publisher derives a privacy-preserving session key:

```text
session-key = s-<sha256(sessionHost + NUL + sessionId)>
```

The raw session ID is never stored in paths, manifests, HTML, or logs. A successful publication creates an immutable revision at:

```text
sessions/<session-key>/boards/<sourceRevision>-<invocationId>/
├── index.html
├── index.en.html
├── index.ko.html
├── index.zh-CN.html
├── manifest.json
├── current.json
└── evidence/
    └── <sha256>.png
```

The publisher creates fixed stable links under `sessions/<session-key>/` that resolve through one `current` selector:

```text
sessions/<session-key>/index.html
sessions/<session-key>/manifest.json
sessions/<session-key>/current.json
```

Each immutable revision contains the three target files. A single fsynced rename atomically switches `current` to `boards/<sourceRevision>-<invocationId>`, so all stable paths select the same revision.

It reads the published files back and validates the recorded digests before printing the stable URI:

```text
Traceknot Board: file://.../sessions/<session-key>/index.html
```

No URI is printed for a failed or unvalidated publication. The stable `manifest.json` is the one Board manifest; no second manifest or status namespace exists. It declares `authoritative: false` and records the validated publication and observed view data required by the shared Board contract.

## Verification integration and unavailable behavior

Every Traceknot QA run attempts Board publication by default. Existing verification invocations that provide `--session-id` and `--session-host` publish through this same session store. The raw session ID is never persisted. The Board remains a presentation operation and the verification exit code is preserved.

If session identity, durable state, writable storage, artifact persistence, read-back validation, or another required prerequisite is unavailable, report `Board status: unavailable` with the missing prerequisite. Do not fabricate a session key, URI, manifest, run identity, counts, or evidence. The unavailable Board status does not change the QA verdict or evidence. A publication failure MUST NOT change the QA verdict. An explicit `--no-board` policy opt-out may report `Board status: disabled`; missing prerequisites are not `not-requested`.

A host adapter may advertise command execution, snapshot binding, and persistence only through a current capability handshake bound to this session and target snapshot. Host names, lifecycle hooks, and agent completion claims never grant those capabilities. The same publication states and validation rules apply across OMP, Codex, Claude Code, OpenCode, and GajaeCode.

## Retention

Retention is session-scoped and uses the clean-cutover `boardMaxPerSession` field. Protect:

- the revision selected by `current`;
- explicitly pinned run-linked revisions; and
- the newest terminal Board checkpoint.

Only unprotected revisions, including superseded active revisions, are reclaimable. Never delete the selected revision to satisfy the quota. If the new revision cannot fit after reclaimable pruning, fail Board publication with a quota reason, preserve the previous `current` selector and stable links, and leave the QA verdict unchanged.

A retention failure is reported as Board unavailability or publication failure with its reason. It is never evidence and never converts a completed verification verdict into an internal error.

## Visual presentation

Each localized page is a static projection of the persisted `QaBoardView`:

- verification health displays observed mandatory passed checks and status distribution;
- verification flow connects persisted coverage, obligations, accepted evidence, and verdict without recalculating the verdict;
- coverage rows label zero-total areas as `Not applicable`, `해당 없음`, or `不适用`;
- finding lists preserve scan order with status-colored rails;
- interface labels may be localized to English, Korean, and Simplified Chinese, while summaries, identifiers, evidence, commands, paths, and verdict rationale remain unchanged.

The bundle is responsive at desktop and mobile widths, contains no network requests or remote assets, and does not require JavaScript. HTML escapes every untrusted value and uses a restrictive default-deny content policy.

`--open-board` may hand the validated local `file://` URI to the platform opener. `--no-notify` suppresses desktop notifications; notification and opening failures are warnings and never alter the Board, evidence, or QA verdict. Only local `file://` URIs are eligible for opener handoff.

## GitHub Action and host integrations

A GitHub Action or host integration that publishes a Board must construct the same `traceknot-session-board-update/v1` envelope, provide `sessionHost` and `sessionId`, and retain the session state needed for read-back validation. It must select the immutable published revision after publication, never a private temporary tree. Action artifact retention is independent of session Board retention; it does not replace `boardMaxPerSession` protection or local cleanup.

With Board publication disabled by explicit policy, no Board upload is attempted. With a missing session or persistence prerequisite, the Action reports unavailable and retains the canonical verification result. Canonical evidence upload must not treat Board HTML or its manifest as evidence.

## Storage inspection

Storage inspection and cleanup must preserve the stable current pointer and all protected revisions. Operators should inspect explicit durable directories before applying maintenance. Canonical verification verdicts are never changed by storage maintenance.

The Board contract is covered by the repository's focused presentation, runtime, storage-retention, and Action contract tests. The canonical repository gate remains `sh scripts/ci`.
