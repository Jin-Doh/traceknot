# Security analysis contract

Traceknot treats `.github/workflows/ci.yml` and `sh scripts/ci` as the enforced security gate. The workflow runs CodeQL for JavaScript and TypeScript on pull requests, pushes to `main`, merge queues, manual dispatches, and the weekly scheduled baseline.

## Rules

| Rule | Requirement | Enforcement | Mode |
| --- | --- | --- | --- |
| `SEC-P0-001` | CodeQL alerts with `security-severity >= 7.0` must have zero unexcepted results. | `bun scripts/check-codeql-sarif.ts --policy codeql-policy.json <sarif-path>` | Blocking |
| `SEC-P0-004` | The portable Skill must contain only the approved Markdown tree and no symlinks, special files, or executable entries. | `bun scripts/check-skill-egress.ts` | Blocking |
| `SEC-P0-005` | Skill content must not direct unrequested repository, environment, credential, conversation, artifact, or log data to an external destination. | `bun scripts/audit-prompt-injection.ts --threshold high` | Blocking |
| `SEC-P0-006` | A Skill-origin outbound request must be denied before transmission and resolve the affected mandatory obligation to `FAIL`. | Host egress mediator; no static adapter may claim support by default. | Blocking |
| `SEC-P1-002` | JavaScript and TypeScript must run the CodeQL `security-extended` suite. | `codeql` job in `.github/workflows/ci.yml` | Blocking |
| `SEC-P1-003` | Known package vulnerabilities must be absent from the locked dependency graph. | `bun audit` through `sh scripts/ci` | Blocking |
| `GOV-P1-001` | Every security exception must identify an owner, reason, mitigation, fingerprint, and expiry date. | `codeql-policy.json` schema and SARIF gate | Blocking |

`SEC-P0-004` and `SEC-P0-006` have no exceptions. `SEC-P0-005` may use only the existing expiring prompt-risk exception contract for a demonstrated false positive; an exception cannot authorize a new Skill-origin network capability. The updater's GitHub traffic is a separate trust boundary and is not a Skill-origin request.

## Exceptions

An exception is allowed only when immediate remediation is unavailable. Add the CodeQL `ruleId` and stable SARIF fingerprint with:

- an accountable `owner`;
- a concrete `reason`;
- an active `mitigation`;
- an ISO date in `expiresOn`.

Expired or malformed exceptions fail closed. Remove an exception with the fixing change. Review the ledger at least every 90 days; the weekly CodeQL run continues to test it against current query packs.

## Failure runbook

1. Open the `codeql` job and record the rule ID, security severity, fingerprint, path, and line.
2. Reproduce with the uploaded SARIF and the policy command above.
3. Fix the source and rerun `sh scripts/ci`; then rerun the CodeQL job because local CI does not produce a CodeQL database.
4. If remediation is blocked, add a bounded exception with owner, mitigation, and expiry. Never lower `failAtOrAbove` or raise `maxUnexceptedAlerts` to absorb a finding.
5. Merge only after the aggregate `required` job observes `codeql=success`.

The repository maintainers own this contract. CodeQL findings and exceptions are reviewed during security-sensitive dependency updates and at the quarterly policy review.
