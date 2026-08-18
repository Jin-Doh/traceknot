# Portable Board renderer

This reference defines the Skills-only fallback projection. It is a presentation renderer, not a verification engine, evidence producer, or canonical Board publisher.

## Selection

Use this renderer only after the canonical CLI and host-integrated publisher paths have been checked and reported unavailable. Do not use it to hide a missing publisher. The final report MUST keep:

```text
Board status: unavailable
Board publisher: none
Board limitation: canonical publisher or required capability unavailable
```

Then add the separate portable fields defined below.

## Trust boundary

The renderer may copy only fields already present in the completion report and preserved QA records:

- target snapshot and run identity;
- terminal QA verdict and structured obligation counts;
- test basis, risks, conditions, and coverage counts;
- evidence identifiers and observed artifact paths;
- defects, accepted exceptions, capability limits, and residual risk;
- exact commands, scenarios, exit statuses, and observed outputs.

Do not invent a digest, URI, run ID, timestamp, verdict, obligation result, evidence claim, approval, or defect. Missing values remain `unknown` or `unavailable` and MUST be disclosed.

A portable Board is always:

```text
authoritative: false
publisher: portable-skill
presentation-only: true
```

A portable Board MUST NOT satisfy an evidence obligation, upgrade a QA verdict, or replace an accepted canonical record.

## Output selection

Use the strongest output the host can actually support:

1. **Persisted HTML bundle:** when the host exposes a trusted file-write and read-back path, create `index.html` and `manifest.json` in that path. Read both files back before reporting their locations.
2. **Inline projection:** when a trusted persistent path is unavailable, render the same sections inline in the completion report. Do not guess a path or emit a `file://` URI.
3. **Unavailable:** when the report is not terminal or the required source fields are missing, report `Portable Board status: unavailable` with the limitation.

A persisted portable bundle is not canonical storage. Use a host-provided cache or artifact path when one is advertised. Do not silently add generated files to the product's Git change set.

## Persisted bundle

Use this layout only after the host has supplied the output directory:

```text
<portable-board-directory>/
├── index.html
└── manifest.json
```

The manifest is a portable projection record and MUST use this shape:

```json
{
  "schemaVersion": "traceknot-portable-board/v1",
  "runId": "observed run identifier",
  "snapshotId": "observed snapshot identifier",
  "sourceState": "TERMINAL",
  "verdict": "observed QA verdict",
  "counts": {
    "mandatory": 0,
    "passed": 0,
    "failed": 0,
    "blocked": 0,
    "incomplete": 0
  },
  "entrypoint": "index.html",
  "authoritative": false,
  "generatedBy": {
    "publisher": "portable-skill"
  }
}
```

Copy observed values only. Do not add `sha256` fields unless the host independently calculates and the renderer reads back the same digest. The portable manifest is not `traceknot-qa-board/v1` and MUST NOT be presented as a canonical manifest.

## HTML requirements

Create a self-contained static document:

- inline CSS only;
- no network requests, CDN, external fonts, or remote images;
- no scripts or dynamic data loading;
- responsive and print-friendly layout;
- visible `Portable Board · authoritative: false` banner;
- summary cards for verdict and obligation counts;
- sections for basis, risks, conditions, obligations, evidence, defects, residual risk, and capability limits;
- `<details>` for long command output and evidence details;
- exact identifiers, paths, commands, and observed values preserved byte-for-byte where they are displayed;
- HTML-escape every dynamic value before inserting it into markup;
- localized interface labels MAY be provided for English, Korean, and Simplified Chinese, but evidence, identifiers, commands, and verdict rationale remain unchanged.

The HTML is a projection of the report. It is not a second source of truth.

## Inline fallback

When no persistent path is available, include a Markdown projection with the same order:

1. Portable Board banner and authority;
2. target snapshot and run ID;
3. QA verdict and counts;
4. obligations and coverage;
5. evidence and artifacts;
6. defects and residual risk;
7. capability limits and unavailable fields;
8. exact commands and observed output.

Use:

```text
Portable Board status: generated
Portable Board location: inline
Portable Board publisher: portable-skill
Portable Board authority: false
```

Inline output does not imply file persistence.

## Completion report fields

Every run that attempts the fallback MUST include:

```text
Portable Board status: generated | unavailable
Portable Board location: file://... | inline | unavailable
Portable Board manifest: path | unavailable
Portable Board publisher: portable-skill | none
Portable Board authority: false
Portable Board limitation: reason | none
```

`generated` with a file location requires successful write, read-back, and exact observed paths. `generated` with `inline` requires the complete projection to be present in the completion report. A portable Board failure MUST NOT change the canonical QA verdict.
