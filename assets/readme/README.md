# README artwork

`traceknot-hero.webp` is the shared, language-neutral hero artwork used by the English, Korean, and Simplified Chinese READMEs.

## Generation record

- Generated: 2026-08-04
- Tool: OpenAI image generation
- Reference: [`../traceknot-mark.svg`](../traceknot-mark.svg)
- Source output: 1983 × 793 PNG
- Repository asset: 1600 × 640 WebP, quality 90
- Embedded text: none

The source PNG remains in the generating session's artifact store. The optimized WebP is the canonical repository asset.

## Prompt

> Create a wide 5:2 GitHub README hero banner by outpainting the provided Traceknot mark horizontally. Preserve the exact central knot mark, its six white nodes, vermillion center, black and graphite loops, proportions, and flat geometric character. Place the mark at the visual center at a confident but not oversized scale. Extend precise evidence traces from both sides: sparse geometric record cards, small nodes, brackets, and thin pathways converging toward the central verdict knot, suggesting test basis, product risk, conditions, obligations, evidence, and defects without using any literal text or icons that imply generic approval. Use only Traceknot's brand palette: ink `#1A1917`, parchment `#F4F1EA`, paper `#FFFEFA`, vermillion `#B33A2B`, verdigris `#3E7C6F`, ochre `#C08A2E`, graphite `#5A5750`. Flat editorial vector style, strong contrast, generous whitespace, rigorous technical-publication aesthetic, balanced asymmetry, crisp shapes. The background must be a full rectangular warm parchment field with subtle paper grain, no rounded outer corners. No text, no letters, no numbers, no words, no robot, no shield, no checkmark, no neon, no gradient, no glass effect, no 3D, no photorealism. Compose for a 1600 × 640 banner and keep important content away from the extreme edges.

## `traceknot-verify.gif`

`traceknot-verify.gif` is the shared, language-neutral Verify CLI demo used by the Quick start section of all three READMEs. It records a real run: a two-obligation explicit command manifest (runtime version, clean snapshot check) is collected, the verdict resolves to PASS, and the session QA Board is published.

### Generation record

- Generated: 2026-08-22
- Tool: VHS 0.11.0
- Script: [`tapes/verify.tape`](tapes/verify.tape)
- Sandbox: [`tapes/verify-setup.sh`](tapes/verify-setup.sh) rebuilds `/tmp/traceknot-demo` deterministically
- Repository asset: 1120 × 560 GIF, 24 fps, ~150 KB
- Embedded text: live terminal output only; no captions or overlays

### Regeneration

```sh
sh assets/readme/tapes/verify-setup.sh
cd "$(cat /tmp/traceknot-demo/.path 2>/dev/null || echo /tmp/traceknot-demo)" && vhs "$OLDPWD/assets/readme/tapes/verify.tape"
mv traceknot-verify.gif "$OLDPWD/assets/readme/"
```

## Usage

Reuse the same artwork across translations. Keep language-specific copy in Markdown so it remains selectable, accessible, and independently maintainable. Do not add translated text to the image.
