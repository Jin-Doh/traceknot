# Test completion report

Report the QA decision independently from harness task completion.

## Required sections

1. Target snapshot and change scope.
2. Test basis and derived acceptance criteria.
3. Risk-discovery execution profile (`single-context`, `omp`, or `codex`), capability handshake and independence basis, universal trigger scan, and triggered profiles.
4. Discovery findings by taxonomy, material unknowns, and capability limits.
5. Initial and residual product risks.
6. Test conditions and selected techniques.
7. Mandatory and optional obligations, including promoted confirmation obligations.
8. Entry-criteria deviations.
9. Exact commands and scenarios executed.
10. Evidence counts, preserved structured reviewer or bounded-slice artifacts, and producer independence; report lifecycle and timeout events separately as non-evidence.
11. Basis, risk, condition, and obligation coverage with uncovered IDs.
12. Defects by severity and status.
13. Accepted exceptions with owner and expiry.
14. Untested scope, unavailable evidence, and residual risk.
15. Final QA verdict and rationale.
16. Separate harness completion status when the host supplies it.
17. Board publication status for every Traceknot QA run.

For every Traceknot QA run, include this single Board subsection separately from the QA verdict:

```text
Board requested: yes
Board status: generated | unavailable | disabled
Board URI: file://... | unavailable
Board manifest: path | unavailable
Board session key: s-<sha256(sessionHost + NUL + sessionId)> | unavailable
Board source revision: identifier | unavailable
Board invocation ID: identifier | unavailable
Board publisher: canonical-cli | host-integrated | none
Board limitation: reason | none
```

`Board status: generated` requires an observed stable entrypoint and manifest read back from the canonical session store. Publication uses `traceknot-session-board-update/v1`; the input `view` is presentation data and never canonical evidence. Preserve exact observed paths and URIs; never guess a location or store a raw session ID. `unavailable` is required when session identity, durable persistence, or another required prerequisite is absent. A Board publication failure MUST NOT change the QA verdict or evidence. There is no second Board field set or separate renderer status.

For a significant UI change, include a separate **Visual-composition coverage** subsection in the conditions, evidence, and coverage portions of the report. It MUST state:

- whether composition-level obligations were in scope for each affected surface and the basis for that decision;
- the section separation, gap ownership, nested hierarchy, and density conditions exercised;
- whole-page and focused-region evidence, with viewport and affected desktop/mobile breakpoints;
- representative populated, empty, loading, and error states inspected, plus state limitations;
- each expected relation or threshold, actual geometry or observation, screenshot artifact, and producer identity;
- whether R2/R3 visual evidence came from an `independent-producer`; any independence limitation MUST be disclosed and must not be reported as `PASS` unless the existing accepted-risk rule applies.

Functional, accessibility, overflow, interaction, and route-reachability coverage MUST be reported separately. Those checks alone do not establish visual-composition coverage.

For a significant UI change, also include a separate **UI content-resilience coverage** subsection. It MUST state:

- the affected surface capability inventory and resulting profile applicability decisions;
- required, unknown, and approved not-applicable profiles, with approval artifact digests;
- the surface, state, viewport, profile, fixture, and region overflow policy for each required run;
- geometry, clipping-ancestor, paint-feature, screenshot, and full-text-access evidence;
- any human visual review outcome, producer, and independently authenticated approval-receipt artifact;
- missing runs or artifacts and the resulting non-PASS disposition.

Visual composition, content resilience, functional behavior, accessibility, interaction, and route reachability are separate coverage families. Passing one MUST NOT imply another.

## Verdict precedence

1. `FAIL`: failed mandatory obligation or unaccepted material defect.
2. `BLOCKED`: mandatory prerequisite or capability unavailable.
3. `INCOMPLETE`: mandatory obligation lacks a terminal result.
4. `PASS_WITH_ACCEPTED_RISK`: all mandatory obligations pass and every remaining material risk has valid acceptance.
5. `PASS`: all mandatory obligations pass with no remaining unaccepted material risk.

Do not summarize a mixed result as PASS. Mark claims not established by direct evidence as inference.
