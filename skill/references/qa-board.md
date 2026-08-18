# QA Board publication

A Traceknot QA Board is a static, non-authoritative presentation artifact. The canonical verification run, verdict, and evidence remain authoritative. Board publication MUST NOT upgrade a verdict or turn an unaccepted claim into evidence.

## When to publish

Every Traceknot QA run attempts Board publication by default. Use the same policy across OMP, Codex, Claude Code, OpenCode, and GajaeCode; host names and lifecycle hooks never imply publisher authority. The required prerequisites are a session identity, a target snapshot bound to the report, a writable durable state directory, and a read-back-capable publisher. A current host capability handshake may advertise execution and persistence, but it cannot change the shared contract.

The installed Skill bundle includes the executable `skill/bin/traceknot` and this reference. Bun 1.3.14 or later is required to run the generated executable. The canonical installation and update path is:

```sh
npx skills add Jin-Doh/traceknot --skill traceknot --global
npx skills update traceknot --global --yes
```

Invoke the global executable at `$HOME/.agents/skills/traceknot/bin/traceknot`; for a project-local install, use `.agents/skills/traceknot/bin/traceknot` from the project root. The legacy curl installer is only an optional launcher/bootstrap for environments that need it; it is not a second product or a richer Board mode.

## Board update interface

Build an update JSON document from the existing `QaBoardView` projection and publish it with:

```sh
$HOME/.agents/skills/traceknot/bin/traceknot board update \
  --input UPDATE.json \
  --state-dir DIR \
  [--artifact-dir DIR] \
  [--open-board] \
  [--no-notify]
```

The input is the `traceknot-session-board-update/v1` envelope:

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

`view` is presentation data, not canonical evidence. Validation MUST reject unsafe strings and paths, malformed counts, statuses, or digests, inconsistent totals, any `authoritative` value other than `false`, and invalid timestamps before writing. Reuse the existing Board renderer and artifact preview limits; do not introduce a second schema, manifest, or status namespace.

The published JSON Schemas are closed structural contracts. Cross-field arithmetic and aggregate-to-finding consistency MUST be checked by the same runtime parser used by `board update`; schema validation alone is not acceptance. `parseSessionBoardUpdate` is the canonical semantic validator.

Publication derives:

```text
session-key = s-<sha256(sessionHost + NUL + sessionId)>
```

The raw session ID MUST NOT appear in a path, manifest, page, or log. Each publication creates an immutable revision at:

```text
sessions/<session-key>/boards/<sourceRevision>-<invocationId>/
```

Fixed stable `index.html`, `manifest.json`, and `current.json` links under `sessions/<session-key>/` resolve through one `current` selector. A single fsynced rename atomically switches that selector to the immutable revision, then the publisher reads all three paths back and validates their recorded digests. Only after that validation does it print:

```text
Traceknot Board: file://.../sessions/<session-key>/index.html
```

The stable manifest is the one Board manifest. It records the validated publication and observed view data and declares `authoritative: false`. A Board URI or manifest MUST never be guessed or hand-authored.

Existing `verify --session-id ... --session-host ...` publication uses this same session store. When either session identity value is absent, or durable persistence/read-back prerequisites are unavailable, report `Board status: unavailable` with the missing prerequisite. The CLI preserves the verification exit code and QA verdict; unavailable Board publication never changes evidence or verdict. An explicit Board opt-out may report `disabled`, but absence of required identity is `unavailable`, not `not-requested`.

## Retention and failure

Retention uses the clean-cutover `boardMaxPerSession` policy. Protect the revision selected by `current`, explicitly pinned run-linked revisions, and the newest terminal Board checkpoint. Reclaim superseded active and other unprotected revisions; never delete the selected revision to satisfy quota. If the new publication cannot fit after reclaimable pruning, fail Board publication with a quota reason, preserve the prior current selector, and leave the QA verdict unchanged.

Board generation, notification, opening, and retention are presentation/storage operations. A failure MUST be reported with its missing prerequisite or quota reason and MUST NOT become evidence, upgrade a verdict, or alter a completed verification result. It MUST NOT change the QA verdict.

## Renderer and trust boundary

The renderer may copy only fields already present in the validated `QaBoardView` and canonical QA records: target snapshot, source run and revision, terminal verdict, structured counts, basis, risks, conditions, obligations, evidence references, defects, residual risk, capability limits, exact commands, and observed outputs. Preserve values exactly where displayed; missing values remain unavailable. Escape every dynamic value, use no network resources or scripts, and keep localization limited to interface labels.

See [`portable-board-renderer.md`](portable-board-renderer.md) for the shared renderer requirements. The filename is retained for reference compatibility; it does not define a separate installation mode, fallback product, manifest, schema, or report field set.
