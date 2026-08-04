# Traceknot trust model

Traceknot is evidence-bound, host-neutral, and non-authoritative by default. It makes a QA decision from declared inputs; it does not claim that every possible defect is absent or that the host has globally completed its work.

## Evidence rules

- Evidence binds to an identified target snapshot and verification obligation.
- Passing evidence identifies its producer and independence level.
- Required independence cannot be silently downgraded.
- Missing, cancelled, timed-out, or incomplete mandatory evidence is never PASS.
- A command exit code proves only the result of that command, not coverage sufficiency.
- Agent, task, queue, and lifecycle states remain observations rather than QA proof.
- Observations, Evidence Claims, Evidence Evaluations, and Obligation Outcomes remain distinct records.
- Only an accepted evaluation of positive, snapshot-bound evidence may satisfy a mandatory success criterion.
- Accepted material risk requires an accountable owner, scope, reason, mitigation, approval evidence, and expiry.

## Capability handshake

Runtime capability comes from an explicit handshake. A host name, model name, new session, worktree, or lifecycle event grants no capability by itself.

The host-neutral capability vocabulary includes command execution, browser execution, artifact capture, snapshot binding, independent evidence, evidence persistence, exception approval, isolated read-only review, and enforced structured output.

An evidence producer may create observations or candidate claims. It cannot accept its own claim merely by reporting PASS. Evaluation must still check expected results, scope, freshness, integrity, traceability, and required independence.

Static manifests under `adapters/` set every capability to `false`. They document a conservative baseline; they are not native integrations.

## Producer independence

Traceknot distinguishes four minimum levels:

1. `self-check`
2. `separate-verification-context`
3. `independent-producer`
4. `external-approval`

A new turn or model does not automatically become independent when it inherits the implementer's full history, mutable context, or worktree. Independence is a property of the evidence boundary, not the model label.

## Authority boundary

The portable Skill and host-neutral core can issue a QA verdict. The core always emits `authoritative: false` because it cannot prove global quiescence or harness completion.

The optional completion-authority extension is disabled by policy and records `phase1Authorized: false`. Enabling it requires a native host integration, authenticated lifecycle and receipt contracts, separate authorization, and evidence that satisfies those contracts. Installing the Skill or full toolkit never enables completion authority.

## Distribution boundary

Available today:

- direct GitHub installation through the Skills CLI;
- user-local full-toolkit installation and removal;
- immutable GitHub release assets;
- digest and build-provenance verification;
- delayed automatic-update eligibility and rollback.

Not currently available:

- an npm package;
- a dedicated Skill-registry listing;
- native OMP, Codex, Claude Code, OpenCode, or GajaeCode adapters;
- production signing or receipt authority for harness completion.

See [automatic updates](automatic-updates.md) for the release trust chain.

## Repository security gates

The canonical repository gate checks:

- exact locked dependencies and dependency audit;
- installer and updater lifecycle;
- JSON and JSON Schema contracts;
- prompt-injection risk in instruction-bearing repository surfaces;
- Korean and English publication-prose policy;
- tests and strict TypeScript;
- capability manifests;
- CodeQL policy and governed SARIF handling;
- whitespace integrity.

The prompt-risk scanner treats repository prose, fixtures, and downloaded content as evidence input rather than privileged instructions. High and critical findings block the gate unless a narrow, expiring exception records an owner, reason, mitigation, and exact line fingerprint.

The prose scanner reports observable style patterns. It never treats those patterns as proof that a person or AI authored the text. Chinese publication prose is not routed through the Korean or English rule sets.

For known security assumptions and residual risks, read the [security analysis](security-analysis.md).
