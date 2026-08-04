# Traceknot QA process

Traceknot applies one portable QA workflow across supported coding-agent harnesses. The host may provide different execution capabilities, but the meaning of evidence, defects, risk, and verdicts remains host-neutral.

## 1. Establish the test basis

Collect stable inputs before choosing checks:

- user requirements and observable acceptance criteria;
- repository instructions and canonical gates;
- public API, schema, and compatibility contracts;
- architecture, persistence, security, and operational invariants;
- issue, incident, or defect reproduction;
- approved exceptions and release policy.

Assign a stable ID to every basis item. Mark derived criteria as derived and record the observation that supports them. Do not invent product behavior to fill an undefined policy.

## 2. Challenge the declared risk universe

Risk classification is a hypothesis. A change can appear low-risk while a modified contract, boundary, or synthetic fixture hides a material partition.

Every run performs a cheap trigger scan after assembling the test basis and before final product-risk classification. The scan checks only relevant signals, including identity, authentication, authorization, state recovery, persistence, idempotency, protocols, concurrency, interaction, performance, deployment, observability, and data realism.

A bounded adversarial challenge runs when at least one of these conditions applies:

- the affected surface is `R2` or `R3`;
- a material security, persistence, concurrency, irreversible-write, public-contract, compatibility, or deployment trigger is present;
- material scope remains unknown;
- evidence bypasses the changed contract through mocks or synthetic fixtures;
- the change overlaps a recurring defect cluster.

A trigger-free `R0` or `R1` run can stop after recording the scan. Bounded discovery is not exhaustive testing and does not require Traceknot to create agents.

### Finding meanings

| Finding | Meaning |
|---|---|
| `COVERAGE_GAP` | A scoped partition lacks adequate evidence; this is not itself a defect |
| `SOURCE_CANDIDATE` | Source establishes a concrete failure mechanism that still needs runtime confirmation |
| `CONFIRMED_DEFECT` | Execution observed a deviation from an established expected result |
| `POLICY_QUESTION` | Expected behavior is undefined and needs a product decision |
| `NOT_APPLICABLE` | The profile does not apply, with evidence-bound rationale |
| `CAPABILITY_LIMITED` | The required verification surface is unavailable |
| `DUPLICATE_CLUSTER` | The candidate shares a root cause with an existing finding |

Material source candidates become confirmation obligations. They are not relabeled as confirmed defects until execution observes the deviation.

## 3. Classify product risk

| Level | Typical scope |
|---|---|
| `R0` | Documentation or provably inert metadata |
| `R1` | Localized, low-impact implementation with simple recovery |
| `R2` | Runtime behavior, UI, persistence, concurrency, security, compatibility, or public contract |
| `R3` | Release, migration, destructive operation, production infrastructure, or materially unknown scope |

Unknown material scope resolves upward. Record impact, likelihood, affected basis IDs, triggers, mitigations, and residual classification.

## 4. Derive conditions and obligations

Every material basis or risk item needs an observable test condition with an expected result. Select techniques that fit the change: equivalence partitioning, boundary values, decision tables, state transitions, scenarios, negative tests, error guessing, compatibility, recovery, concurrency, or regression.

Each verification obligation declares:

- a stable ID and linked condition IDs;
- expected result and evidence type;
- mandatory or optional status;
- required execution surface;
- minimum producer independence;
- entry and completion criteria.

Traceability remains bidirectional:

```text
test basis ↔ risk ↔ test condition ↔ obligation ↔ evidence ↔ defect
```

The evidence path is proof-carrying: an Observation records inspectable facts, an Evidence Claim explains how those facts support an obligation, an Evidence Evaluation accepts or rejects that claim against the expected result, and an Obligation Outcome records the bounded result. These layers must not be collapsed.

## 5. Check entry criteria

Before execution, confirm the target snapshot, environment, dependencies, test data, expected results, required tools, and producer independence. A missing mandatory prerequisite makes the obligation `BLOCKED`, not PASS.

## 6. Execute and preserve evidence

Start with the direct changed path, then broaden when the change affects shared contracts, public APIs, persistence, concurrency, security, builds, or releases.

Evidence records include the command or scenario, target snapshot, timestamps, exit status, structured counts, relevant output, artifacts, producer identity, independence, and linked obligation. A lifecycle event or self-reported completion state cannot upgrade weak evidence.

A mandatory criterion passes only when its accepted evaluation points to positive, current, snapshot-bound evidence that demonstrates the expected result. An exit code, claim, or outcome cannot prove its own premises.

Typical expectations include:

- reproduce a bug before confirming its fix;
- exercise UI behavior in a real browser and inspect the rendered result;
- test transaction boundaries, rollback, recovery, and races for stateful changes;
- run the repository's canonical release or deployment gate for release surfaces;
- compare published prose against the configured readability and preservation policy.

## 7. Record defects and residual risk

A material anomaly records expected and actual results, reproduction, severity, priority, environment, evidence, affected basis IDs, owner, status, and disposition.

Risk acceptance is explicit and expires. It includes an accountable owner, reason, scope, mitigation, approval evidence, and future expiry. An open material defect without valid acceptance prevents PASS.

## 8. Evaluate exit criteria

Exit requires:

- every mandatory obligation has a terminal result;
- material basis and risk coverage is complete;
- failed obligations and defects are resolved or validly accepted;
- required regression passed;
- deviations and unavailable evidence are recorded;
- residual risk is stated;
- the completion report is internally consistent.

## Verdict model

| Verdict | Meaning |
|---|---|
| `PASS` | Every mandatory obligation and required coverage passed; no unaccepted material risk remains |
| `PASS_WITH_ACCEPTED_RISK` | Mandatory obligations passed and every remaining material risk has valid acceptance |
| `FAIL` | A mandatory obligation failed or an unaccepted material defect remains |
| `BLOCKED` | A mandatory prerequisite or required capability was unavailable |
| `INCOMPLETE` | Mandatory evidence or coverage lacks a terminal result |

Precedence is deterministic:

```text
FAIL → BLOCKED → INCOMPLETE → PASS_WITH_ACCEPTED_RISK → PASS
```

The host-neutral core always emits `authoritative: false`. A QA verdict and harness completion remain separate decisions.

## Completion report

The report states the target snapshot, scope, basis, risks, discovery mode, conditions, obligations, exact checks, evidence, defects, deviations, coverage, unavailable evidence, accepted risk, and final verdict. It also discloses capability limits and distinguishes observed facts from inference.

The executable workflow lives in [`skill/SKILL.md`](../skill/SKILL.md). Its references provide the canonical detail for [proof-carrying success](../skill/references/proof-carrying-success.md), [risk discovery](../skill/references/adversarial-risk-discovery.md), [test techniques](../skill/references/test-techniques.md), [defect lifecycle](../skill/references/defect-lifecycle.md), [traceability](../skill/references/traceability.md), and the [completion report](../skill/references/completion-report.md).
