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

For a significant UI change, include a separate **Visual-composition coverage** subsection in the conditions, evidence, and coverage portions of the report. It MUST state:

- whether composition-level obligations were in scope for each affected surface and the basis for that decision;
- the section separation, gap ownership, nested hierarchy, and density conditions exercised;
- whole-page and focused-region evidence, with viewport and affected desktop/mobile breakpoints;
- representative populated, empty, loading, and error states inspected, plus state limitations;
- each expected relation or threshold, actual geometry or observation, screenshot artifact, and producer identity;
- whether R2/R3 visual evidence came from an `independent-producer`; any independence limitation MUST be disclosed and must not be reported as `PASS` unless the existing accepted-risk rule applies.

Functional, accessibility, overflow, interaction, and route-reachability coverage MUST be reported separately. Those checks alone do not establish visual-composition coverage.

## Verdict precedence

1. `FAIL`: failed mandatory obligation or unaccepted material defect.
2. `BLOCKED`: mandatory prerequisite or capability unavailable.
3. `INCOMPLETE`: mandatory obligation lacks a terminal result.
4. `PASS_WITH_ACCEPTED_RISK`: all mandatory obligations pass and every remaining material risk has valid acceptance.
5. `PASS`: all mandatory obligations pass with no remaining unaccepted material risk.

Do not summarize a mixed result as PASS. Mark claims not established by direct evidence as inference.
