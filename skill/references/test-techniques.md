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

Expected results must be observable. Source-text assertions, mocks that bypass the changed contract, and checks of incidental implementation details do not satisfy a behavioral condition unless the basis explicitly requires that structure.
