# Quality Contract brand system

> **Evidence-bound QA for coding agents.**

Quality Contract is the descriptive project name and product category. It turns a coding agent's completion claim into an evidence-bound QA verdict: test basis, product risk, test conditions, mandatory obligations, snapshot-bound evidence, defects, and residual risk resolved deterministically.

[한국어 브랜드 가이드](BRAND.ko.md)

## Position

**Category:** an ISTQB-aligned QA framework for coding-agent harnesses.

**One-sentence pitch:** Quality Contract turns a coding agent's completion claim into an evidence-bound verdict and never treats a lifecycle event as proof.

**Promise:** the same declared basis, obligations, evidence, and defects produce the same verdict.

**Boundary:** Quality Contract does not own agents, models, task graphs, concurrency, retries, worktrees, lifecycle, or harness completion. The portable core remains non-authoritative. Completion authority is a separate, disabled-by-default host integration.

## Why the project exists

Native coding-agent harnesses are strong at orchestration. They can create agents, run tools, coordinate jobs, retry work, and emit lifecycle events. Those capabilities do not by themselves answer the QA question: *is the declared change sufficiently verified against its risks and acceptance criteria?*

| Native harness signal | What it establishes | What it does not establish |
| --- | --- | --- |
| Turn, task, or subagent ended | A lifecycle transition occurred | Mandatory verification passed |
| Command exited successfully | That command returned an allowed status | The test basis and risk coverage are sufficient |
| Agent says "done" | A completion claim exists | Evidence is independent, current, or snapshot-bound |
| All observed jobs are idle | The observed queue is quiet | Global quiescence or absence of unobserved work |
| Hook or app-server event fired | The host emitted an observation | A deterministic QA verdict or completion authority |

Quality Contract supplies the missing test-process layer: traceability, evidence requirements, defect and residual-risk handling, deterministic verdict precedence, and an explicit boundary between QA verdict and harness completion.

## Message hierarchy

1. **Headline:** Evidence-bound QA for coding agents.
2. **Proof:** Test basis → risk → condition → obligation → evidence → defect → verdict.
3. **Differentiator:** Lifecycle events are observations, not proof.
4. **Trust statement:** Deterministic, host-neutral, and non-authoritative by default.
5. **Extension statement:** Harness completion authority requires an explicit, separately authorized integration.

## Product architecture

Use these names consistently:

| Name | Role |
| --- | --- |
| **Quality Contract Skill** | Portable ISTQB-aligned workflow and repository discovery guidance |
| **Quality Contract Records** | Closed JSON Schema contracts for requests, plans, evidence, defects, verdicts, and capabilities |
| **Quality Contract Core** | Host-neutral deterministic coverage and verdict resolution |
| **Quality Contract Protocol** | Canonical host-to-QA observation and verification boundary |
| **Quality Contract Adapter — _Host_** | Host-owned capability declaration and protocol mapping |
| **Quality Contract Completion-Authority Extension** | Optional lifecycle, quiescence, lease, receipt, and completion authority; disabled by default |

`QC` may be used in code, CLI examples, and compact labels. Spell out **Quality Contract** in headlines and first references because `QC` commonly means quality control and can blur the QA positioning. Do not call the portable core a gate, seal, authority, or orchestrator.

## Voice

- Precise, calm, and falsifiable.
- State what evidence establishes and what it cannot establish.
- Prefer *verdict*, *obligation*, *basis*, *risk*, and *evidence* over hype words such as *trustless*, *unbreakable*, or *AI judge*.
- Say **PASS** only for the declared test basis and mandatory obligations. Never imply that PASS means every harness task or delivery has completed.
- Mark inference as inference. Name residual risk rather than hiding it.

## Visual identity

![Quality Contract mark](assets/quality-contract-mark.svg)

The mark combines three literal objects: a contract page, a six-node traceability chain, and a verdict seal. The seal belongs to the visual mark and the optional completion-authority story; it does not imply that portable verdicts are authoritative.

### Palette

| Token | Hex | Use |
| --- | --- | --- |
| Ink | `#1A1917` | Primary text and structure |
| Parchment | `#F4F1EA` | Warm background |
| Paper | `#FFFEFA` | Record surfaces |
| Vermillion | `#B33A2B` | Brand accent and FAIL |
| Verdigris | `#3E7C6F` | PASS |
| Ochre | `#C08A2E` | BLOCKED |
| Graphite | `#5A5750` | INCOMPLETE and secondary text |

Use flat color, strong contrast, ruled structure, and generous whitespace. Avoid gradients, glass effects, neon AI motifs, robot heads, shields, and generic checkmark-only logos.

### Typography

- **Prose:** a restrained serif or humanist sans with excellent long-form readability.
- **Records and identifiers:** a monospace face with tabular numerals.
- **Hierarchy:** sentence case. Avoid all-caps except literal verdict values such as `PASS`, `FAIL`, `BLOCKED`, and `INCOMPLETE`.

## Naming and usage

### Do

- `Quality Contract`
- `Quality Contract Core`
- `Quality Contract Adapter — Codex`
- `Evidence-bound QA for coding agents`
- `QA PASS does not mean harness completion`

### Do not

- `QualityContract`, `Quality Contracts`, or `The Quality Contract`
- Use `QC` as the public-facing project name
- Claim that the Skill manages agents or proves global quiescence
- Present the portable verdict as authoritative
- Use `Seal` as a core component name

## Name decision

The existing name remains intentionally descriptive. A Qwen 3.8 Max Preview design review initially proposed coined names, but collision research found direct conflicts in AI testing, evidence, and verdict tooling. A descriptive name paired with a specific tagline is more honest and discoverable for this open-source framework than an occupied or authority-heavy coined mark.

This is a product-positioning decision, not legal clearance. Before commercial use, perform trademark and domain review in the relevant jurisdictions and classes.
