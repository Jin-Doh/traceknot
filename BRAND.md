# Traceknot brand system

> **Evidence-bound QA for coding agents.**

Traceknot is an ISTQB-aligned QA framework for coding-agent harnesses. It turns a completion claim into a deterministic, evidence-bound verdict by tying together test basis, product risk, test conditions, mandatory obligations, snapshot-bound evidence, defects, and residual risk.

[한국어 브랜드 가이드](BRAND.ko.md)

## Name and story

**Pronunciation:** TRACE-not.

**One-line story:** Every verdict is linked to its declared basis, obligations, and evidence.

`Trace` names the framework's spine: bidirectional traceability from basis to verdict. `Knot` names the binding: evidence must match the declared obligation and snapshot. A knot can be missing, loose, or broken, so the name does not claim proof, defect absence, or completion authority.

**Category:** an evidence-bound QA framework for coding-agent harnesses.

**Promise:** the same declared basis, obligations, evidence, and defects produce the same verdict.

**Boundary:** Traceknot does not own agents, models, task graphs, concurrency, retries, worktrees, lifecycle, or harness completion. The portable core remains non-authoritative. Completion authority is a separate, disabled-by-default host integration.

## Why the project exists

Native coding-agent harnesses orchestrate agents, tools, jobs, retries, and lifecycle events. Those capabilities do not answer the QA question: *is the declared change sufficiently verified against its risks and acceptance criteria?*

| Native harness signal | What it establishes | What it does not establish |
| --- | --- | --- |
| Turn, task, or subagent ended | A lifecycle transition occurred | Mandatory verification passed |
| Command exited successfully | That command returned an allowed status | Test basis and risk coverage are sufficient |
| Agent says "done" | A completion claim exists | Evidence is independent, current, or snapshot-bound |
| Observed jobs are idle | The observed queue is quiet | Global quiescence or absence of unobserved work |
| Hook or app-server event fired | The host emitted an observation | A deterministic QA verdict or completion authority |

Traceknot supplies the missing test-process layer: traceability, evidence requirements, defect and residual-risk handling, deterministic verdict precedence, and an explicit boundary between QA verdict and harness completion.

## Naming rationale

The naming review compared Traceknot with Sigstore and in-toto to check whether the name described its mechanism without claiming an outcome.

**Quality Contract** was long in CLI contexts and difficult to distinguish in search. Traceknot keeps the evidence-binding idea in a shorter public name.

## Message hierarchy

1. **Headline:** Evidence-bound QA for coding agents.
2. **Proof structure:** Basis → risk → condition → obligation → evidence → defect → verdict.
3. **Brand story:** Every verdict is linked to its declared evidence.
4. **Differentiator:** Lifecycle events are observations, not proof.
5. **Trust statement:** Deterministic, host-neutral, and non-authoritative by default.
6. **Extension statement:** Harness completion authority requires an explicit, separately authorized integration.

## Product architecture

| Name | Role |
| --- | --- |
| **Traceknot Skill** | Portable ISTQB-aligned workflow and repository discovery guidance |
| **Traceknot Records** | Closed JSON Schema contracts for requests, plans, evidence, defects, verdicts, and capabilities |
| **Traceknot Core** | Host-neutral deterministic coverage and verdict resolution |
| **Traceknot Protocol** | Canonical host-to-QA observation and verification boundary |
| **Traceknot Adapter — _Host_** | Host-owned capability declaration and protocol mapping |
| **Traceknot Completion-Authority Extension** | Optional lifecycle, quiescence, lease, receipt, and completion authority; disabled by default |

Use `traceknot` for CLI and package surfaces. Spell out **Traceknot** in headlines and first references. Do not abbreviate the public brand to `TK`; an optional shell alias is local operator preference, not a product name. Do not call the portable core a gate, seal, authority, or orchestrator.

## Voice

- Precise, calm, and falsifiable.
- State what evidence establishes and what it cannot establish.
- Prefer *verdict*, *obligation*, *basis*, *risk*, *trace*, and *evidence* over hype such as *trustless*, *unbreakable*, or *AI judge*.
- Say **PASS** only for the declared test basis and mandatory obligations. Never imply that PASS means every harness task or delivery has completed.
- Mark inference as inference. Name residual risk rather than hiding it.

## Visual identity

![Traceknot mark](assets/traceknot-mark.svg)

The mark tightens two continuous traces into a knot around a vermillion verdict point. Six visible nodes represent basis, risk, condition, obligation, evidence, and defect. The central verdict is a result of the chain, not a claim of global authority.

### Palette

| Token | Hex | Use |
| --- | --- | --- |
| Ink | `#1A1917` | Primary text and trace structure |
| Parchment | `#F4F1EA` | Warm background |
| Paper | `#FFFEFA` | Record surfaces and node fill |
| Vermillion | `#B33A2B` | Brand anchor and FAIL |
| Verdigris | `#3E7C6F` | PASS |
| Ochre | `#C08A2E` | BLOCKED |
| Graphite | `#5A5750` | INCOMPLETE and secondary trace |

Use flat color, strong contrast, geometric paths, and generous whitespace. Avoid gradients, glass effects, neon AI motifs, robot heads, shields, and generic document/checkmark-only logos.

### Typography

- **Prose:** a restrained serif or humanist sans with excellent long-form readability.
- **Records and identifiers:** a monospace face with tabular numerals.
- **Hierarchy:** sentence case. Reserve all caps for literal verdicts such as `PASS`, `FAIL`, `BLOCKED`, and `INCOMPLETE`.

## Naming usage

### Do

- `Traceknot`
- `Traceknot Core`
- `Traceknot Adapter — Codex`
- `traceknot verdict`
- `Evidence-bound QA for coding agents`
- `QA PASS does not mean harness completion`

### Do not

- `TraceKnot`, `Trace Knot`, or `The Traceknot`
- Treat `TK` as the public project name
- Claim that the Skill manages agents or proves global quiescence
- Present the portable verdict as authoritative
- Use *proof* to imply defect absence

## Name decision and collision review

The naming review compared descriptive, metaphorical, and coined alternatives, then checked direct collisions with existing software.

A preliminary exact-name search of GitHub, npm, and PyPI found no direct collision. This is not legal clearance; commercial users must perform the relevant trademark and domain checks.

The frozen completion-authority extension retains its existing `quality-contract` v1 wire identifiers and paths. Those identifiers are protocol compatibility surfaces, not the public masterbrand; changing them requires a separately versioned migration and regenerated signed evidence.
