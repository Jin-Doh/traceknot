---
name: traceknot
description: Apply Traceknot's ISTQB-aligned, evidence-bound QA process to repository changes across OMP, Codex, GajaeCode, Claude Code, and OpenCode. Use for implementation verification, bug fixes, release checks, repository audits, defect confirmation, and residual-risk decisions without treating an agent's own completion claim as proof.
---

# Traceknot

**Evidence-bound QA for coding agents.**

Run a host-neutral QA process. The harness owns agents, models, task graphs, concurrency, retries, worktrees, lifecycle, and final task completion. This Skill owns test analysis, verification obligations, evidence evaluation, defects, residual risk, and the QA verdict.
Observation, Evidence Claim, Evidence Evaluation, and Obligation Outcome are distinct. An Observation records what was observed; an Evidence Claim states how an observation or artifact may support an obligation; an Evidence Evaluation determines whether that claim is accepted for the obligation; and an Obligation Outcome records the obligation's result. These concepts MUST NOT be conflated.

Only evidence accepted by Evidence Evaluation for the applicable obligation may satisfy a mandatory criterion. An unaccepted, missing, or merely asserted claim MUST NOT establish PASS.
The normative proof-carrying contract is [Proof-carrying success](references/proof-carrying-success.md).

Gate mapping is separate from the QA verdict. A gate's accept or reject decision MUST NOT substitute for evidence evaluation or alter verdict precedence.

`QA PASS` means the declared test basis and mandatory obligations passed. It never means every harness task, agent, job, or delivery has completed.

## Test principles

Apply these guardrails throughout the workflow:

- Testing demonstrates defects and confidence; it does not prove defect absence.
- Exhaustive testing is infeasible; select tests from product risk and test basis.
- Analyze testability early, before implementation choices hide defects.
- Expand regression around defect clusters and repeatedly changed surfaces.
- Refresh tests and techniques when repeated checks stop revealing new information.
- Select techniques for the product, change, and operational context.
- A technically green build is not PASS when user or business acceptance criteria remain unmet.

## Workflow

### 1. Establish the test basis

Read repository instructions, build metadata, requirements, acceptance criteria, issue or defect context, public contracts, architecture invariants, security rules, and release policy. Assign a stable ID to every relevant basis item.

If no explicit acceptance criteria exist, derive observable criteria from the request and mark them as derived. Do not silently invent product behavior.

See `references/test-process.md`.

### 2. Challenge the declared risk universe

Perform the universal cheap trigger scan in `references/adversarial-risk-discovery.md` before finalizing product-risk classification. Every QA run records the scan, including an initially classified `R0` or `R1` change. A lower initial classification never exempts a material trigger.

Escalate to a bounded adversarial challenge for `R2` or `R3`, a material trigger, unknown scope, synthetic evidence that bypasses the changed contract, or an affected defect cluster. Use only runtime-advertised capabilities and select `single-context`, `omp`, or `codex` execution guidance only from the capability handshake; see `references/adversarial-risk-discovery.md`. Multi-agent execution is optional; a separate or current-context challenge remains valid when its independence limit is reported.

Distinguish coverage gaps, source candidates, confirmed defects, policy questions, non-applicable profiles, capability limits, and duplicate clusters. Promote material source candidates to confirmation obligations rather than calling unexecuted source reasoning a confirmed defect.

### 3. Analyze product risk

Classify each affected surface:

- `R0`: documentation or inert metadata.
- `R1`: localized low-impact implementation.
- `R2`: runtime behavior, persistence, UI, concurrency, security, compatibility, or public contract.
- `R3`: release, migration, destructive operation, production infrastructure, or unknown material scope.

Unknown scope resolves upward. Record impact, likelihood, affected basis IDs, trigger-scan findings, and rationale. Use `references/risk-classification.md` for repeatable decisions.

### 4. Derive test conditions and techniques

For every material basis or risk item, create at least one observable test condition with an expected result. Select techniques appropriate to the surface: equivalence partitions, boundary values, decision tables, state transitions, scenarios, negative tests, error guessing, compatibility, recovery, concurrency, or regression.

Use `references/test-techniques.md`. Maintain bidirectional traceability:

```text
test basis ↔ risk ↔ test condition ↔ obligation ↔ evidence ↔ defect
```

### 5. Build mandatory verification obligations

Each obligation declares:

- stable ID and linked condition IDs;
- evidence type and expected result;
- mandatory or optional status;
- required execution surface;
- minimum independence level;
- entry criteria;
- completion criteria.

The Skill declares evidence requirements, not how the harness creates agents. The harness MAY satisfy independent evidence with a reviewer, isolated context, deterministic verifier, CI job, external approval, or another mechanism.

Minimum independence levels:

- `self-check`
- `separate-verification-context`
- `independent-producer`
- `external-approval`

Default minimums: R0=`self-check`, R1=`separate-verification-context`, R2=`independent-producer`, R3=`independent-producer` plus explicit risk acceptance for unresolved material risk.

### 6. Check entry criteria

Before execution confirm the target snapshot, environment, dependencies, test data, expected results, and required tools are available. A missing mandatory prerequisite makes the obligation `BLOCKED`, not PASS.

### 7. Execute and capture evidence

- Investigation: run the experiment and preserve its observed output.
- **Material UI change:** exercise the changed flow in a real browser and inspect the rendered result. Explicitly decide whether each affected surface needs composition-level visual obligations. When composition is in scope, derive at least one observable condition from the test basis and keep these obligations separate from reachability, overflow, accessibility, and interaction checks:
  - top-level section separation and ownership of vertical or horizontal gaps;
  - nested card or panel hierarchy and internal density;
  - full-page context and focused-region inspection;
  - representative populated, empty, loading, and error states when materially different;
  - desktop and mobile composition at each affected breakpoint;
  - measured geometry or a documented visual oracle when objective thresholds are appropriate.
  Record the viewport, state, region, expected relation or threshold, actual geometry or observation, screenshot artifact, and evidence producer. For R2/R3 visual acceptance, require `independent-producer` evidence, or disclose the independence limitation and resolve the result as `INCOMPLETE`, `BLOCKED`, or accepted risk under the existing verdict rules. Passing reachability, overflow, accessibility, and interaction checks alone MUST NOT establish visual-composition coverage or `PASS`.
- Bug fix: reproduce the defect first, then rerun the same reproduction after the fix.
- Feature or API: execute tests covering the observable contract; add a test only for a new contract not already covered.
- Persistence or concurrency: test transaction boundaries, rollback, recovery, races, and stale operations as applicable.
- Release or infrastructure: run the repository's canonical release or deployment gate.
- Published Korean, English, or explicitly mapped Simplified Chinese prose: apply the configured language-specific audit, and if remediation occurred, independently verify protected content and change boundaries. See `references/prose-quality.md`.

Start with the direct changed path, then broaden to package or repository gates when shared contracts, public APIs, persistence, concurrency, security, build, or release behavior changed.

Record command or scenario identity, target snapshot, timestamps, exit status, structured counts, relevant output, artifacts, producer kind, and linked obligation ID. A timeout, cancellation, unavailable dependency, missing output, or unfinished mandatory obligation is not a pass.
Lifecycle events and agent completion claims MAY trigger observation or further verification, but they are never evidence by themselves.

### 8. Record and manage defects

Record every material anomaly using `references/defect-lifecycle.md`. Include expected and actual results, reproduction, severity, priority, environment, evidence links, owner, status, and disposition. Confirm fixes with the original reproduction and appropriate regression.

### 9. Evaluate exit criteria and residual risk

All mandatory obligations must reach a terminal state. Evaluate open defects, accepted exceptions, untested risks, coverage gaps, unavailable evidence, deviations, and regression scope.

Verdicts:

- `PASS`: every mandatory obligation passed and no unaccepted material defect or residual risk remains.
- `PASS_WITH_ACCEPTED_RISK`: mandatory obligations passed and every remaining material risk has explicit, unexpired acceptance.
- `FAIL`: a mandatory obligation failed or an unaccepted material defect remains.
- `BLOCKED`: a mandatory prerequisite or capability was unavailable.
- `INCOMPLETE`: mandatory work has not reached a terminal result.

Precedence is `FAIL` → `BLOCKED` → `INCOMPLETE` → `PASS_WITH_ACCEPTED_RISK` → `PASS`.

### 10. Produce the completion report

Follow `references/completion-report.md`. Report scope, basis, discovery mode and triggered profiles, risks, conditions, obligations, evidence, defects, deviations, coverage, material unknowns, capability limits, residual risk, exact commands or scenarios, observed counts, unavailable evidence, and final verdict. Separate observed facts from inference.

## Host capability rule

Default to `evidence-only`. A runtime handshake MAY advertise command execution, browser execution, artifact capture, snapshot binding, independent evidence, evidence persistence, or exception approval. The host name or model name never implies a capability or producer independence.

The Skill never:

- creates, selects, retries, stops, or coordinates subagents;
- chooses models or concurrency limits;
- owns task, job, mailbox, worktree, or delivery policy;
- infers global completion from task, turn, agent, or subagent terminal events;
- fabricates receipts, signatures, hashes, evidence, defects, or approvals;
- enables harness completion enforcement.

## Optional system integration

The sibling `../system/core/` validates canonical QA records and resolves deterministic QA verdicts. `../system/extensions/harness-completion-authority/` contains optional lifecycle, quiescence, lease, receipt, and terminal-authority contracts for hosts that explicitly integrate them. Ordinary Skill use does not require or activate that extension. Technical compatibility with legacy `verification-plan/v1` and `qa-verdict/v1` callers does not imply portable Skill compliance; existing deterministic v1 callers can technically omit discovery because the v1 contracts do not enforce it, and such runs are outside portable Skill compliance and must disclose the omission rather than claim discovery completed. This does not change `verification-plan/v1`, `qa-verdict/v1`, or deterministic core semantics.
