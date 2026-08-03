# Proof-carrying success

## Purpose and scope

Traceknot separates what happened during verification from what the verification means and from whether a host may deliver a change. This document defines the normative boundary for that separation. It applies to the portable Traceknot Skill and to integrations that produce `verification-plan/v1`, `verification-evidence/v1`, or `qa-verdict/v1` records.

The central rule is:

> **No mandatory obligation may receive `PASS` without accepted positive success evidence bound to that obligation and to the target snapshot.**

A successful process, a successful-looking summary, or a completed harness task is not a substitute for that evidence. This document defines semantics; it does not prescribe agents, models, storage, transport, retry policy, or a particular implementation of a verifier.

The repository's existing `verification-plan/v1` and `qa-verdict/v1` contracts remain compatible. This document does not silently add fields to either schema or change their deterministic meanings. The compatibility boundary is described in [v1 compatibility](#v1-compatibility).

## Normative vocabulary

The terms **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

- **Test basis** is the set of requirements, acceptance criteria, public contracts, architecture invariants, security rules, release policy, and defect context used to decide what must be checked. Each relevant basis item has a stable ID.
- A **risk** is a classified affected surface (`R0`, `R1`, `R2`, or `R3`) with impact, likelihood, linked basis IDs, and rationale. Unknown scope resolves upward.
- A **test condition** is an observable condition with an expected result and links to basis and risk IDs.
- An **obligation** is a required verification of one or more conditions. It declares an ID, evidence type, mandatory status, execution surface, minimum independence, entry criteria, and completion criteria.
- An **observation** is an externally inspectable fact about an execution, artifact, or target snapshot. It is not an interpretation.
- A **claim** is an interpretation that a set of observations establishes a property, such as “this condition passed” or “this triggered profile had no material findings.” A claim is not accepted merely because it is asserted.
- **Evaluation** is the comparison of claims and their supporting observations with the test basis, expected result, obligation, independence requirement, snapshot, freshness policy, defects, coverage, and residual risk.
- An **outcome** is the evaluator's bounded result for an obligation or aggregate QA run: `PASS`, `FAIL`, `BLOCKED`, `INCOMPLETE`, or, for an aggregate QA verdict with valid accepted risk, `PASS_WITH_ACCEPTED_RISK`.
- **Accepted positive success evidence** is evidence that the evaluator has inspected and accepted as establishing the required successful result for a mandatory obligation. An evidence identifier or a producer's assertion is only a reference to candidate evidence until this evaluation occurs.
- A **target snapshot** is the identified state against which the plan and evidence apply. `requestId` and `snapshotId` are the identity boundary in the v1 records.
- A **material defect** is an observed deviation from an established expected result with material product impact. A source candidate, policy question, coverage gap, or capability limitation is not automatically a confirmed defect.

## The proof-carrying model

Traceknot's traceability is bidirectional:

```text
test basis ↔ risk ↔ test condition ↔ obligation ↔ evidence ↔ defect
```

A plan turns basis items into conditions and obligations. An execution produces observations and candidate artifacts. An evaluator then determines whether those observations support each obligation. The final outcome records that determination; it does not create the supporting facts.

### Observation → Claim → Evaluation → Outcome

These four layers MUST remain distinguishable:

| Layer | What it records | What it MUST NOT do |
| --- | --- | --- |
| **Observation** | Target snapshot, command or scenario identity, timestamps, exit status, structured counts, output, artifacts, producer kind, capability facts, and other directly inspectable facts | Declare that a product is correct, infer independence from a host name, or turn a lifecycle event into proof |
| **Claim** | A bounded interpretation tied to one or more observation IDs, such as an expected result being met or a discovery profile having no material finding | Stand alone without supporting observations, widen the scope beyond those observations, or erase uncertainty and missing coverage |
| **Evaluation** | The rule-based decision that checks the claim against the condition, obligation, required independence, snapshot, freshness, defect state, coverage, and residual-risk policy | Treat an unsupported assertion, cached status, or prior outcome as new evidence |
| **Outcome** | The terminal status of an obligation or aggregate QA verdict, plus rationale and traceability | Prove its own premises, imply harness completion, or authorize delivery by itself |

An evaluator MUST be able to walk from every passing mandatory obligation to the accepted positive evidence and from that evidence back to the observations, condition, expected result, and target snapshot. A report that contains only claims or outcomes is not proof-carrying.

Observations MAY include negative, partial, or non-product facts. For example, a timeout is an observation about execution. It does not by itself say that the product failed, that the product passed, or that a reviewer was independent. Claims and outcomes MUST preserve the distinction.

## What makes success proof-carrying

For every mandatory obligation, the evaluator MUST establish all of the following before assigning `PASS`:

1. The obligation exists in the applicable verification plan and is linked to at least one condition.
2. The target `requestId` and `snapshotId` agree across plan, execution evidence, result, and evaluation. Evidence from another snapshot MUST NOT be reused.
3. The required entry criteria were met, and the completion criteria were actually observed.
4. The evidence type and execution surface are appropriate to the condition. A green check unrelated to the changed contract is not direct-path evidence.
5. The observed actual result satisfies the condition's expected result. A command exit status or count MAY be part of that observation, but is not sufficient when the observable contract requires more.
6. The evidence producer has at least the obligation's declared minimum independence (`self-check`, `separate-verification-context`, `independent-producer`, or `external-approval`). Host labels, model names, worktree names, and lifecycle events never imply independence.
7. The evidence artifact and its identity are available, intact, and linked to the obligation. A missing, unverifiable, partial, or incompatible artifact is not accepted positive evidence.
8. The evidence is current under the cache and freshness boundaries in [cache and freshness boundaries](#cache-and-freshness-boundaries).
9. No unaccepted material defect, unresolved material risk, or required coverage gap invalidates the conclusion.
10. The evidence is not being used to prove a broader claim than the observation establishes.

A `verification-evidence/v1` record provides the vocabulary for this proof: `evidenceId`, `requestId`, `snapshotId`, `obligationId`, explicit `producer.kind` and `producer.independence`, execution `kind` and `identity`, execution `exitStatus`, result verdict and summary, optional counts and artifacts, `observedAt`, and optional `contentHash`. The schema shape is necessary but not by itself sufficient; semantic evaluation MUST also check the relationships above.

A result with `result.verdict: PASS` but `execution.exitStatus: timed-out`, `cancelled`, `blocked`, or `failed` MUST NOT be accepted as positive success evidence. Likewise, a `PASS` result with missing output, an unavailable required artifact, an insufficient independence level, or a snapshot mismatch MUST NOT pass. The evaluator MUST classify the obligation under the outcome rules rather than repairing the record by inference.

A mandatory obligation with no accepted positive success evidence MUST NOT be counted as passed. In particular, an `evidenceId` stored in an obligation result is a link to inspect, not a waiver of inspection. Completion-report prose, a verifier's unsupported conclusion, and a green aggregate count cannot satisfy this rule.

`PASS_WITH_ACCEPTED_RISK` is proof-carrying success only after every mandatory obligation has accepted positive evidence and every remaining material risk has an explicit, valid, unexpired external acceptance. Accepted risk is not a replacement for evidence and does not convert a failed, blocked, or incomplete obligation into `PASS`.

## No-findings conditions

“No findings” is a bounded discovery conclusion, not a claim that defects do not exist. The universal cheap trigger scan MUST be performed for every portable QA run before finalizing product-risk classification, including an initially classified `R0` or `R1` change. The record MUST identify the observations that triggered profiles and the predicates `scopeUnknown`, `materialTrigger`, `syntheticBoundaryBypass`, and `recurringDefectClusterOverlap`.

A discovery run MAY conclude that a profile has no material finding only when all of these conditions hold:

1. The scan and, where required, the bounded challenge actually covered the profile's applicable scope and partitions.
2. The challenge reached `COMPLETED`; unavailable capability, blocked execution, incomplete output, and an unreported remainder MUST NOT be represented as `NO_FINDINGS`.
3. The report preserves structured, snapshot-bound evidence for the challenge and any required reviewer output, including negative or no-finding output. A lifecycle or completion status without that output contributes no evidence.
4. Every observed candidate in scope was classified using the finding taxonomy. Material `SOURCE_CANDIDATE` findings received a confirmation obligation or an explicit accepted-risk path; they are not silently absorbed into “none found.”
5. No material `CONFIRMED_DEFECT`, unresolved material `COVERAGE_GAP`, unresolved capability limit, or material unknown remains in the profile's covered scope.
6. The profile resolution agrees with aggregate findings, nested reviewer findings, linked obligation IDs, and the verification plan.

In the canonical discovery vocabulary, a completed triggered profile may resolve to:

- `NO_FINDINGS`: the bounded profile found no material finding. It MUST include resolution evidence and MUST NOT include an approval or an `obligationId`.
- `PROMOTED`: a material source candidate or other finding requires a verification obligation. It MUST carry the linked `obligationId`; promotion is not a defect confirmation and does not itself pass the new obligation.
- `ACCEPTED_RISK`: a material residual risk has a closed external approval with scope, mitigation, accountable authority, evidence integrity, and an unexpired expiry. It is not a no-findings result.

`NOT_REQUIRED` is a challenge outcome, not a `NO_FINDINGS` resolution. It is permitted only when the trigger scan establishes that no applicable material challenge is required; for the canonical report, every aggregate and nested finding must be nonmaterial. `BLOCKED` and `CAPABILITY_LIMITED` challenge outcomes MUST NOT receive a profile resolution. A capability limit is not evidence that the profile had no findings.

A no-findings observation may support a discovery obligation whose expected result is “the bounded profile has no material findings,” but it MUST NOT be promoted into evidence that the product behavior itself is correct. The absence of a finding is bounded by the executed partitions, test basis, target snapshot, and evidence retained. Testing demonstrates defects and confidence; it does not prove defect absence.

## Outcomes and defect classification

Every mandatory obligation MUST reach a terminal outcome. The outcome describes the evidence state, not the executor's intent.

| Outcome | Normative meaning | Product-defect meaning | Gate effect |
| --- | --- | --- | --- |
| `PASS` | The expected result was observed and accepted positive evidence satisfies every obligation requirement. | No unaccepted material defect or residual risk prevents the obligation or aggregate result. | Eligible for aggregate `PASS` only when all other mandatory obligations and coverage pass. |
| `PASS_WITH_ACCEPTED_RISK` | Aggregate-only outcome: all mandatory obligations passed, and every remaining material risk has explicit, valid, unexpired acceptance. | The accepted risk remains visible and traceable; approval does not deny the risk. | May be accepted only where the delivery policy allows accepted risk. |
| `FAIL` | A mandatory obligation observed a failed expected result, or an unaccepted material defect remains. | Requires evidence-backed deviation from an established expected result for a confirmed defect; an open material defect forces aggregate `FAIL`. | Rejecting. It MUST NOT be downgraded to `BLOCKED` or `INCOMPLETE` to avoid a product failure. |
| `BLOCKED` | A mandatory prerequisite, capability, dependency, target snapshot, test data set, required tool, or required independence was unavailable, so the obligation could not be validly executed. | The execution blockage is not itself a product defect. Do not claim a defect without observing the product deviation. | Rejecting. It MUST NOT be treated as no findings or as a pass. |
| `INCOMPLETE` | Mandatory work has not reached a terminal result, or required evidence, coverage, or material scope remains unresolved without a specific blocking prerequisite. | Absence of a result is not a product defect. A source candidate remains a candidate until its confirmation obligation executes or receives valid risk acceptance. | Rejecting. It MUST NOT be treated as a pass. |

Examples clarify the boundary:

- If a scenario executes against the target snapshot and observes an actual result that violates its expected result, the obligation is `FAIL` and the deviation may be recorded as a confirmed product defect.
- If the required browser, dependency, environment, target snapshot, or independent producer is unavailable before valid execution, the obligation is `BLOCKED`. The product has not thereby been shown defective.
- If a run is cancelled, times out, loses output, or ends before a mandatory condition has a terminal result, the obligation is normally `INCOMPLETE`. If the preserved observation specifically establishes that a required prerequisite or capability was unavailable, it is `BLOCKED` instead. Neither outcome is `PASS`.
- If source inspection identifies a concrete failure mechanism but runtime behavior has not been observed, record a `SOURCE_CANDIDATE` and promote a material candidate to a confirmation obligation. Do not call it a confirmed defect merely because a reviewer completed.
- If expected behavior is undefined, record a `POLICY_QUESTION` and resolve the basis before claiming product failure or success.

The aggregate precedence remains `FAIL` → `BLOCKED` → `INCOMPLETE` → `PASS_WITH_ACCEPTED_RISK` → `PASS`. Thus one observed mandatory failure dominates blocked or incomplete work; blocked work dominates otherwise incomplete work; accepted risk is considered only after mandatory obligations pass. A report MUST retain the individual obligation outcomes even when the aggregate precedence selects a different final verdict.

## QA verdict versus delivery gate

A QA verdict and a delivery decision are different contracts:

- The **QA verdict** evaluates the test basis, risks, conditions, obligations, evidence, defects, coverage, and residual risk for a target snapshot. `qa-verdict/v1` names the aggregate result in `qaVerdict`, reports obligation and coverage summaries, lists open defects and accepted risks, and gives a rationale.
- The **delivery gate** is host or repository policy that decides whether a change may be merged, published, deployed, or otherwise delivered. It MAY require a particular QA verdict, approvals, branch state, release provenance, or additional operational checks. Those requirements are not silently part of the QA verdict.

`qaVerdict: PASS` means the declared QA basis and mandatory obligations passed; it does not mean that every harness task, agent, job, receipt, lease, deployment, or delivery action completed. Conversely, a delivery gate may reject a QA `PASS` for an independent policy reason without changing the historical QA outcome to `FAIL`. A delivery gate MUST NOT accept delivery by treating missing positive evidence as a successful QA result.

The `authoritative` field in `qa-verdict/v1` and any host-level delivery authority are separate concerns. The deterministic v1 core's current result contract remains `authoritative: false`; this document does not redefine that field or grant authority to lifecycle events. An optional harness completion-authority integration MAY impose additional delivery rules, but ordinary Skill use does not require or activate that extension.

## Lifecycle and completion are non-evidence

Task, turn, agent, job, worktree, lease, receipt, retry, cancellation, timeout, quiescence, and terminal-completion events are observations about execution state only. They MUST NOT be used as evidence of:

- test coverage or condition satisfaction;
- producer independence;
- absence of a defect or risk;
- validity, freshness, or integrity of an artifact;
- successful delivery; or
- completion of an unfinished mandatory obligation.

A completion claim is therefore a claim that requires its own supporting observations. A lifecycle event MAY help explain why evidence is missing, partial, or stale, but it cannot upgrade that evidence. If no structured output is preserved, the event contributes no verification evidence. Partial output may support only the claims it actually establishes and MUST NOT be upgraded by a later completion, cancellation, timeout, retry, or summary.

Hosts MUST report lifecycle limitations and missing evidence in the completion report. The report MUST distinguish observed facts from inference and MUST disclose capability limits, material unknowns, unavailable evidence, exact commands or scenarios, target snapshot, timestamps, artifacts, producer kind, linked obligation IDs, and the final verdict.

## Cache and freshness boundaries

Caching is an optimization boundary, not a proof boundary. A cache hit is an observation that a stored object was retrieved; the stored object still requires normal evidence evaluation.

A cached evidence artifact MAY be reused for a current obligation only when the evaluator can establish all of the following:

1. It is bound to the same target `snapshotId`, request, condition, obligation, and applicable test basis. A path, branch name, worktree name, or cache key alone is insufficient.
2. Its bytes or content identity are intact and agree with the recorded artifact identity or `contentHash`, where supplied. A hash mismatch, missing artifact, or unverifiable retrieval invalidates the candidate.
3. Its execution time (`observedAt`) and any declared validity interval satisfy the current freshness policy. The age boundary MUST be explicit; a successful cache lookup never makes an unknown-age record fresh.
4. The procedure, environment assumptions, required independence, and expected result remain compatible with the current obligation. A cache entry from a weaker producer or a different execution surface cannot satisfy a stronger requirement.
5. No target-snapshot mutation, changed contract, stale dependency, invalidated approval, or other freshness boundary has occurred since the observation. The same identifier with changed bytes is a different state, not a fresh cache hit.

The evaluator MUST reject reuse across incompatible snapshots or conditions. If snapshot binding or freshness cannot be established, the evidence is unavailable for portable Skill compliance: classify the obligation as `BLOCKED` when the required freshness/binding capability is unavailable, or `INCOMPLETE` when the required evidence simply was not produced or retained. Never silently fall back to `PASS`.

Freshness is a semantic boundary before it is a clock boundary. `observedAt` records when an observation was made; it does not by itself establish that the target remains unchanged or that a cache entry is acceptable. Where time-based validity is used, the evaluator MUST use the declared trusted time and expiry policy, and MUST fail closed for malformed, expired, or ambiguous validity. Accepted-risk expiry is independent of evidence freshness and MUST remain visible in the aggregate verdict.

Cross-run reuse MAY occur only within the same request, target `snapshotId`, condition, obligation, and applicable test-basis identity boundary. Cross-request reuse MUST NOT occur until a versioned rebinding contract explicitly defines and validates the identity mapping and invalidation policy. A legacy v1 record without the portable snapshot, evidence, or discovery semantics needed to establish them MUST be disclosed as legacy behavior rather than silently treated as current proof.

## v1 compatibility

Compatibility is a version boundary, not a semantic exemption:

1. `verification-plan/v1` and `qa-verdict/v1` MUST retain their existing schema shapes, enum values, field meanings, and deterministic verdict precedence. Integrations MUST NOT reinterpret `PASS`, `BLOCKED`, `INCOMPLETE`, `FAIL`, or `PASS_WITH_ACCEPTED_RISK` to mean lifecycle or delivery status.
2. The `verification-plan/v1` obligation fields remain the source for mandatory status, evidence type, required independence, entry criteria, and completion criteria. The `qa-verdict/v1` record remains the aggregate QA result and coverage/defect summary; it is not a delivery receipt.
3. Native deterministic v1 callers MAY technically omit the universal discovery scan or a canonical discovery record because the existing v1 contracts do not enforce those fields. Such a run is outside portable Skill compliance and MUST disclose the omission; it MUST NOT represent discovery as completed or use the omission to claim that no findings existed.
4. Existing v1 compatibility MUST NOT be achieved by accepting a mandatory `PASS` without accepted positive evidence. Where a legacy caller cannot supply the evidence binding, independence, freshness, or discovery semantics required by this document, the caller may remain technically compatible with its v1 interface but is not portable Skill-compliant for that run.
5. Stronger proof-carrying enforcement MUST be introduced through a versioned semantic validator or integration boundary. It MUST NOT mutate the meaning of an already-issued v1 record, add unannounced aliases, or make a v1 caller appear to have performed a capability it did not advertise.
6. `verification-plan/v1`, `qa-verdict/v1`, and deterministic core behavior remain unchanged by this architecture document. New records or runtime enforcement belong to a later compatible integration; this PR defines the normative contract only.

The result is intentionally conservative: a v1 adapter can preserve old callers, but portability requires the evidence-bound behavior described here. Compatibility preserves interfaces; it does not weaken the proof required for a normative `PASS`.

## Invariants

An implementation or integration conforms to this architecture only if these statements remain true:

- A mandatory `PASS` always has accepted positive, snapshot-bound evidence.
- A claim never substitutes for its supporting observation.
- Evaluation checks scope, independence, freshness, and defects rather than trusting outcome text.
- `NO_FINDINGS` means bounded, evidence-backed discovery and never means universal defect absence.
- `FAIL`, `BLOCKED`, and `INCOMPLETE` remain distinct and all reject a passing delivery basis.
- Lifecycle and completion events explain execution state but never prove QA success.
- Cache reuse never crosses an incompatible snapshot or freshness boundary.
- A QA verdict is not a delivery gate, and a delivery decision is not QA evidence.
- Legacy v1 technical compatibility is disclosed when portable Skill semantics are absent.
