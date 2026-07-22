# Traceability and coverage

Maintain bidirectional links:

```text
basis ↔ risk ↔ condition ↔ obligation ↔ evidence ↔ defect
```

## Required checks

- every material basis ID has at least one condition;
- every R2/R3 risk has at least one mandatory obligation;
- every mandatory condition has exactly one terminal obligation result;
- every passing obligation has evidence bound to the target snapshot;
- every failed observation is linked to a defect or documented non-defect disposition;
- every accepted defect or residual risk has an unexpired approval;
- no evidence is reused across incompatible snapshots or conditions.

## Coverage report

Report counts and uncovered IDs for:

- basis coverage;
- risk coverage;
- condition execution coverage;
- mandatory obligation completion;
- supported platform/profile coverage when applicable;
- regression scope;
- optional code or branch coverage when the repository uses it.

A percentage without the uncovered identifiers is insufficient. Code coverage never substitutes for basis, risk, or condition coverage.
