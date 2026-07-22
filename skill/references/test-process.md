# Test process

## Test basis

Collect stable, relevant inputs before selecting checks:

- user request and observable acceptance criteria;
- issue, incident, or defect reproduction;
- requirements and public API contracts;
- architecture, persistence, security, compatibility, and operational invariants;
- repository instructions and canonical quality gates;
- approved exceptions and release policy.

Assign IDs such as `BASIS-001`. Mark each item `explicit` or `derived`. A derived item must quote the observation it is based on and must not invent product policy.

## Activities

1. Plan scope, objectives, risks, independence, entry criteria, and exit criteria.
2. Analyze basis items into observable test conditions.
3. Design techniques, expected results, data, environment, and obligations.
4. Implement executable checks or scenarios without duplicating an existing canonical path.
5. Execute against an identified target snapshot and capture evidence.
6. Compare actual results with the oracle and record defects.
7. Evaluate traceability, coverage, open defects, deviations, and residual risk.
8. Issue a completion report and verdict.

## Traceability

Every material basis item and risk must link to one or more conditions. Every condition must link to a mandatory or explicitly optional obligation. Every executed obligation links to evidence or a terminal blocked/incomplete reason. Every defect links back to evidence and affected basis IDs.

## Entry criteria

Confirm target snapshot, testable build, environment, dependencies, data, tools, expected results, and producer independence. Missing mandatory prerequisites produce `BLOCKED`.

## Exit criteria

- every mandatory obligation is terminal;
- required basis and risk coverage is complete;
- failed obligations and material defects are resolved or explicitly accepted;
- required regression passed;
- deviations and unavailable evidence are recorded;
- residual risk is stated;
- the completion report is internally consistent.
