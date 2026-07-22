# Risk classification

Assess product risk per affected surface using impact and likelihood.

## Impact

- `1`: cosmetic or inert; no runtime or user contract effect.
- `2`: localized behavior with simple recovery.
- `3`: user-visible runtime, shared API, persistence, or compatibility effect.
- `4`: security, irreversible data, release, production infrastructure, safety, or broad outage potential.

## Likelihood

- `1`: trivial, isolated, strongly covered change.
- `2`: familiar pattern with limited branching.
- `3`: complex state, integration, concurrency, migration, or weak coverage.
- `4`: unknown behavior, novel technology, repeated defects, or missing test basis.

## Mapping

- `R0`: impact 1 and likelihood 1, documentation or provably inert metadata only.
- `R1`: maximum score 2 and no security, persistence, public-contract, migration, concurrency, or release surface.
- `R2`: impact or likelihood 3, or any runtime/UI/persistence/concurrency/security/compatibility/public-contract change.
- `R3`: impact or likelihood 4, destructive operation, production release/infrastructure, migration without proven rollback, or materially unknown scope.

Risk can only be lowered with observed evidence. Record the original classification, rationale, affected basis IDs, mitigations, and any post-test residual classification.
