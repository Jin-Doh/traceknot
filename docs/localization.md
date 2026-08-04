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

Every README contains stable `readme-section` markers and `shared-command` markers. Only parsed Markdown HTML-comment nodes count as structural markers; marker-shaped examples in code do not. `scripts/check-readme-contract.ts` verifies that:

- all three files exist;
- required sections are present exactly once;
- shared command blocks are byte-identical;
- every README exposes rendered links with usable visible or accessible labels to all three languages; empty anchors and anchors in standard HTML `hidden` subtrees do not satisfy navigation parity;
- translated documentation parity uses the same visible-anchor tree, so hidden anchors cannot preserve a removed reader-facing link;
- critical authority-boundary literals remain present in text derived by `hast-util-to-text`, with fenced examples removed first;
- the public Skill install literal remains in the parsed `skill-install` shared command block rather than arbitrary source text;
- installer, uninstaller, and updater literals remain in their marked parsed command blocks rather than comments or unrelated examples;
- local Markdown and HTML links resolve to repository files.

Inline-link validation delegates Markdown grammar to the maintained unified stack: `remark-parse` and `remark-gfm` produce the CommonMark/GFM syntax tree, while `remark-rehype` and `rehype-raw` parse rendered HTML nodes and their URL-bearing attributes. Traceknot traverses that tree to enforce only repository policy: shared and operational commands must be closed fenced-code nodes, local targets must exist without escaping the repository, translated documentation links must remain visibly present, and complete `srcset` and `ping` target lists use the same boundary checks. Code spans, nested containers, Setext headings, reference links, comments, and raw HTML are therefore classified by the external parsers rather than a repository-owned Markdown state machine.

Run the check directly with:

```sh
bun scripts/check-readme-contract.ts
```

The canonical CI gate runs the same contract check.

`prose-quality.config.json` is the single publication-prose inventory. Its `**/*.md` include keeps every repository Markdown surface in scope automatically; locale detection and explicit overrides decide whether a document is checked or reported as skipped. The scanner default reads this file instead of carrying a second path list.

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
