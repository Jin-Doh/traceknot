# QA Board publication

A Traceknot QA Board is a static, non-authoritative presentation artifact. The canonical verification run, verdict, and evidence remain authoritative. Board publication MUST NOT upgrade a verdict or turn an unaccepted claim into evidence.

## When to publish

Publish a Board when the user requests one, the repository policy requires one, or the selected verification entrypoint explicitly enables Board output. Do not create a Board for every Skill-only QA run by default when the host has no Board publisher.

Before publication, establish all of the following:

- the target snapshot and run identity are bound to the report;
- the source QA record has a terminal verdict and structured obligation counts;
- the host exposes the command and file-persistence capabilities required by the selected publisher;
- the publisher and its output location are trusted for the current run;
- no Board field needs to be invented or inferred from an agent completion claim.

A missing prerequisite is `unavailable` or `BLOCKED`, never a successful Board publication.

## Publisher selection

Use the first available path:

1. **Canonical CLI publisher:** run the repository or installed Traceknot verification entrypoint with Board generation enabled. Preserve its exact exit status, `Traceknot Board: file://...` output, run ID, and manifest path.
2. **Host-provided publisher:** use a host-integrated publisher only when its capability handshake advertises command execution, snapshot binding, and evidence persistence for this run.
3. **No publisher:** report `not-requested` when no Board was requested; otherwise report `unavailable` with the missing capability or command. Do not hand-author a canonical Board manifest or fabricate a `file://` URI.

`--no-board` is an explicit publication decision. Record `disabled` when it was selected, even if verification otherwise passed.

## Completion report fields

When Board publication is in scope, report these fields separately from the QA verdict:

```text
Board requested: yes | no
Board status: generated | unavailable | disabled | not-requested
Board URI: file://... | unavailable
Board manifest: path | unavailable
Board run ID: identifier | unavailable
Board publisher: canonical-cli | host-integrated | none
Board limitation: reason | none
```

A generated Board MUST be checked for an existing entrypoint and manifest before its URI is reported. The report MUST preserve the observed URI and paths exactly; a guessed or normalized path is not evidence.

## Failure and independence

Board generation, notification, and opening are presentation operations. A Board publisher failure MUST NOT change a completed verification verdict. Report the failure and keep the QA verdict separate.

A portable Skill or host-generated Board is non-authoritative unless the canonical run and evidence contracts say otherwise. Visual review of the Board itself does not establish coverage of the product under test. The Board is a projection of accepted records, not a replacement for them.
