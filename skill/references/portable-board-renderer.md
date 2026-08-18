# Board renderer

This reference describes the renderer used by the canonical Traceknot Board publisher. It is a presentation layer, not a verification engine or evidence producer. The renderer consumes the existing `QaBoardView` projection and must preserve `authoritative: false`; it never changes a QA verdict or evidence record.

The surrounding publication contract is the single `traceknot-session-board-update/v1` input. Do not define, invent, or persist a second Board schema in renderer instructions. The update envelope is:

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

The `view` is presentation data copied from canonical records. It is not canonical evidence. Preserve observed snapshot, run, verdict, counts, obligations, findings, artifact references, and rationale; do not infer or recalculate them in the renderer. Missing values remain unavailable and must be disclosed. Reject unsafe strings and paths, malformed counts, statuses, digests, inconsistent totals, non-false authority values, and invalid timestamps before any write.

## Rendering requirements

Create the same deterministic static pages used by the CLI publisher:

- inline CSS only;
- no network requests, CDN, external fonts, remote images, or dynamic data loading;
- responsive and print-friendly layout;
- labels may be localized for English, Korean, and Simplified Chinese, while identifiers, commands, evidence, paths, and verdict rationale remain byte-for-byte faithful;
- HTML-escape every dynamic value;
- summary cards and coverage rows must display the observed verdict and counts without deriving a new result;
- sections must cover basis, risks, conditions, obligations, evidence, defects, residual risk, and capability limits;
- long command output and evidence details may use `<details>`;
- artifact previews must use the existing renderer limits and byte-level digest checks.

The Board is a projection of accepted records, never a second source of truth. A renderer failure is a Board publication failure only; it MUST NOT change the QA verdict.

## Publication hand-off

The renderer is invoked by:
Use `$HOME/.agents/skills/traceknot/bin/traceknot` after a global Skills CLI install, or `.agents/skills/traceknot/bin/traceknot` from the project root after a project-local install:

```sh
$HOME/.agents/skills/traceknot/bin/traceknot board update \
  --input UPDATE.json \
  --state-dir DIR \
  [--artifact-dir DIR] \
  [--open-board] \
  [--no-notify]
```

The publisher creates an immutable revision at:

```text
sessions/<session-key>/boards/<sourceRevision>-<invocationId>/
```

Fixed stable `index.html`, `manifest.json`, and `current.json` links resolve through one `current` selector. A single fsynced rename atomically switches that selector to the immutable revision. The publisher reads all three stable paths back and validates their recorded digests before printing exactly `Traceknot Board: file://.../sessions/<session-key>/index.html`. The canonical derivation is `session-key = s-<sha256(sessionHost + NUL + sessionId)>`; never persist the raw session ID in a path, manifest, or page.

The stable manifest is the one Board manifest for the publication. The renderer MUST NOT create an alternate manifest, status namespace, location field set, or authority field set. The manifest declares `authoritative: false` and records only the validated publication and observed view data required by the shared Board contract.

If session identity, a writable durable state directory, or required persistence/read-back capability is absent, report `Board status: unavailable` with the missing prerequisite. Do not emit an inline or second-format replacement, guess a URI, or fabricate run identity. The verification exit code and QA verdict remain unchanged.

Retention uses the canonical `boardMaxPerSession` policy. Protect the revision selected by `current`, explicitly pinned run-linked revisions, and the newest terminal Board checkpoint. Reclaim superseded active and other unprotected revisions; never delete the selected revision to satisfy quota. If the new revision cannot fit after reclaimable pruning, fail publication with a quota reason and preserve the previous current selector and QA verdict.
