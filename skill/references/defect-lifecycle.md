# Defect lifecycle

## Required record

- stable defect ID and concise summary;
- affected basis, condition, obligation, and evidence IDs;
- expected and actual results;
- deterministic reproduction or the observed non-deterministic frequency;
- environment and target snapshot;
- severity, priority, status, owner, and timestamps;
- attachments or logs;
- root cause when established;
- disposition and approval for accepted or deferred defects;
- fix confirmation and regression evidence.

## Status

```text
NEW → TRIAGED → IN_PROGRESS → FIXED → CONFIRMED → CLOSED
                    ↘ REJECTED
                    ↘ DEFERRED/ACCEPTED_RISK
                    ↘ REOPENED
```

`REJECTED`, `DEFERRED`, and `ACCEPTED_RISK` require a reason. Accepted material risk requires owner, scope, mitigation, and expiry. Expired acceptance does not satisfy exit criteria.

## Severity

- `S1`: catastrophic/security/data-loss/safety or release-stopping.
- `S2`: major required behavior unavailable or unreliable without acceptable workaround.
- `S3`: localized incorrect behavior with workaround.
- `S4`: minor cosmetic or low-impact discrepancy.

Priority is a delivery decision and remains separate from severity.
