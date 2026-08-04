# README localization

Traceknot maintains three public README entry points:

- `README.md` — English and canonical technical meaning;
- `README.ko.md` — Korean;
- `README.zh.md` — Simplified Chinese.

The translations share the same public feature boundary, commands, links, and section order. They do not need to mirror English sentence structure.

## Canonical and translated content

English owns the canonical technical meaning for:

- feature availability and implementation status;
- installation and development commands;
- record, schema, capability, and verdict identifiers;
- security and authority boundaries;
- links to source-of-truth documentation.

Korean and Simplified Chinese should use natural prose while preserving those facts. Do not translate literal identifiers such as `PASS`, `BLOCKED`, `COVERAGE_GAP`, `authoritative`, schema versions, file paths, or command-line flags.

## Synchronization contract

Every README contains stable `readme-section` markers and `shared-command` markers. `scripts/check-readme-contract.ts` verifies that:

- all three files exist;
- required sections are present exactly once;
- shared command blocks are byte-identical;
- every README links to all three languages;
- critical authority-boundary literals remain present;
- local Markdown and HTML links resolve to repository files.

Run the check directly with:

```sh
bun scripts/check-readme-contract.ts
```

The canonical CI gate runs the same contract check.

## Language-specific quality

The repository's deterministic prose scanner supports Korean and English. It does not apply either rule set to Simplified Chinese. Chinese prose requires semantic review plus the shared command, link, and boundary checks above until a dedicated Chinese rule set exists.

The common Hero artwork contains no language. Translate its alternative text and surrounding caption in Markdown instead of creating language-specific image variants.

## Updating the READMEs

1. Change canonical technical meaning in `README.md`.
2. Update the Korean and Simplified Chinese documents in the same branch or pull request.
3. Preserve shared command blocks exactly.
4. Run the README contract, prompt-risk scanner, prose scanner, and canonical gate.
5. Review the rendered Markdown at desktop and narrow widths.

Do not claim that translations are synchronized only because files were edited together. The contract check establishes structural parity; a human review still establishes language quality and semantic fidelity.
