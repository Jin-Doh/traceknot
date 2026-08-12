# Test techniques

Select techniques from the condition, not from implementation convenience.

| Condition | Minimum techniques |
|---|---|
| Input domain or validation | equivalence partitions, boundary values, invalid partitions |
| Business rules or combinations | decision tables, negative combinations |
| Stateful lifecycle | state transitions, invalid transitions, restart/recovery |
| User workflow | scenario/use-case, alternative and interrupted paths |
| Public API or protocol | positive, negative, compatibility, idempotency, malformed input |
| Persistence | transaction, rollback, durability, recovery, concurrent writers |
| Concurrency | races, ordering, duplicate/stale events, cancellation, timeout boundaries |
| Security | authorization boundary, abuse case, input validation, secret handling |
| UI | real-browser scenario, keyboard/accessibility where material, responsive states, visual result |
| Defect fix | original reproduction, confirmation, focused and enclosing regression |
| Release or migration | preflight, forward path, rollback/recovery, post-deploy read-back |

For a material UI change, treat composition-level visual quality as a distinct condition family, not as an implied result of route reachability or accessibility checks. Derive conditions from the basis and record them as:

```text
basis → condition → obligation → evidence
```

At minimum, decide whether the affected surface requires:

- section-to-section separation and explicit ownership of vertical or horizontal gaps;
- nested card or panel hierarchy and internal density;
- both whole-page context and focused-region inspection;
- populated, empty, loading, and error states when their composition differs materially;
- desktop and mobile inspection at affected breakpoints;
- measured geometry or a documented visual oracle with an expected relation or threshold.

For each executed composition condition, preserve the viewport, state, region, expected relation or threshold, actual geometry or observation, screenshot artifact, and producer identity. R2/R3 visual acceptance requires `independent-producer` evidence; if that is unavailable, report the independence limitation and use the existing non-PASS or explicit accepted-risk rules.

Expected results must be observable. Source-text assertions, mocks that bypass the changed contract, and checks of incidental implementation details do not satisfy a behavioral condition unless the basis explicitly requires that structure.
