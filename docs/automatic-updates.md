# Automatic update plan

## Decision summary

Traceknot should introduce automatic updates as an opt-in, invocation-triggered feature. It must not update directly from `main`. The updater may install only an immutable, tagged release whose exact artifact has been observed for at least seven complete days and whose signed provenance and digest verify successfully.

The seven-day delay is a safety buffer, not a trust mechanism. Release immutability, artifact provenance, digest verification, atomic activation, and rollback remain mandatory.

## Current-state review

The current `install.sh`:

- downloads a GitHub source archive from `TRACEKNOT_REF`, defaulting to `main`;
- copies files directly into one installation prefix;
- records owned paths in `.traceknot-install-manifest` (`traceknot-install/v1`);
- safely refuses unrelated files and symlinked destinations;
- supports repeat installation, but has no installed release identity, update policy, locking, staged verification, atomic activation, or rollback.

This makes reinstallation useful but unsuitable as an automatic updater. Updating in place can leave a mixed version after interruption, and `main` is not a release boundary.

## Test basis and acceptance criteria

| ID | Source | Basis or observable acceptance criterion |
|---|---|---|
| BASIS-001 | Explicit | Plan an automatic update facility for Traceknot. |
| BASIS-002 | Explicit | Automatic installation is allowed only after the candidate has exceeded seven days of freshness. |
| BASIS-003 | Derived from the shared proposal's security goal | A mutable or unverifiable release must never become eligible merely because its timestamp is old. |
| BASIS-004 | Current installer contract | Existing user-local prefixes, Skill registration, dry-run behavior, and owned-file protections must remain supported during migration. |
| BASIS-005 | Repository contract | The canonical `sh scripts/ci` gate remains the release precondition. |
| BASIS-006 | Derived operational criterion | Interrupted or failed updates leave either the old complete version active or the new complete version active, never a mixed tree. |
| BASIS-007 | Derived security criterion | Automatic update is opt-in, can be disabled, and never requires `sudo`. |
| BASIS-008 | Derived compatibility criterion | Pinned `TRACEKNOT_REF` installation remains deterministic and does not silently opt into updates. |

### Freshness definition

A candidate becomes eligible only when:

```text
trustedNow > max(release.publishedAt, localObservation.firstSeenAt) + 604800 seconds
```

Both clocks are required:

- `publishedAt` enforces the public release age;
- `firstSeenAt` prevents a newly discovered, backdated release from bypassing the waiting period.

`trustedNow` and `firstSeenAt` come from the authenticated GitHub API response `Date` header, not the local wall clock. Automatic application requires an online time observation from the approved GitHub origin. A missing, malformed, stale, or locally inconsistent server time blocks application. The stored `firstSeenAt` is append-only for a manifest digest; it can never move earlier. The updater also records local monotonic elapsed time while a boot session remains available, but never uses local time alone to grant eligibility.

The boundary is strict: 604800 elapsed seconds remains ineligible; the first later representable instant is eligible. All persisted instants use canonical UTC RFC 3339. The updater must calendar-parse them and reject impossible dates even when the schema's portable lexical pattern matches.

Prereleases, drafts, deleted releases, mutable releases, and releases without valid provenance are ineligible. The initial implementation should follow the latest eligible stable release, not simply GitHub's `latest` pointer.

## Product risk

| ID | Level | Impact | Likelihood | Basis | Rationale and mitigation |
|---|---:|---:|---:|---|---|
| RISK-001 | R3 | 4 | 3 | BASIS-001, BASIS-003 | Supply-chain compromise can execute attacker-controlled content. Require immutable releases, signed provenance, digest verification, and independent release-gate evidence. |
| RISK-002 | R3 | 4 | 3 | BASIS-002, BASIS-003 | Timestamp manipulation or asset replacement could bypass the delay. Use authenticated GitHub server time, `max(publishedAt, firstSeenAt)`, immutable releases, and provenance bound to the artifact digest and source commit. |
| RISK-003 | R2 | 3 | 3 | BASIS-004, BASIS-006 | In-place copying can create partial or mixed installs. Stage into a version directory and atomically switch an activation pointer. |
| RISK-004 | R2 | 3 | 3 | BASIS-004, BASIS-008 | Migration can break existing installs or pinned workflows. Preserve v1 manifest import and keep pinned installs update-disabled. |
| RISK-005 | R2 | 3 | 2 | BASIS-006 | Concurrent invocations can race. Use a per-prefix lock with stale-lock recovery that never guesses ownership. |
| RISK-006 | R2 | 3 | 2 | BASIS-007 | Silent updates can surprise users or hide failures. Require explicit opt-in, structured status, disable/check-only controls, and no privilege escalation. |

Residual risk remains R3 until the release pipeline, updater, migration, rollback, and independent security verification are implemented and exercised.

## Target architecture

### Release contract

Each GitHub Release must be immutable and contain:

1. a versioned Traceknot archive;
2. `traceknot-update-manifest.json`, conforming to `contracts/update-manifest.schema.json`;
3. GitHub artifact attestation (or equivalent Sigstore provenance) binding the archive digest to the repository and source commit.

The release workflow must build from a protected tag after `sh scripts/ci`, generate the manifest from build outputs, attest the archive, publish all assets, then make the release immutable. Provenance must identify the exact protected release workflow and include the canonical gate result, source commit, and artifact digest. The updater must verify that workflow identity and reject mutable releases even if all other checks pass.

### Local layout

```text
${prefix}/
  releases/<version>/...       # immutable installed payloads
  current -> releases/<version> # atomically replaced activation symlink
  state/update-state.json      # policy, observations, last result
  state/update.lock/           # exclusive updater lock
  state/install-manifest.json  # active release identity and owned paths
  rollback -> releases/<prior> # previous known-good activation target
```

The shared Skill registration points to `${prefix}/current/skill`. Activation uses a write-ahead transaction record, durable staged files, and same-directory symlink rename. Required ordering is: persist the prepared transaction and staged payload; persist the rollback target; atomically replace `current`; persist active state; run the smoke check; then mark committed. Startup recovery reconciles the transaction record, `current`, rollback target, and active manifest before any new check. A crash at any boundary deterministically completes the new activation or restores the prior activation. Retain the active and one prior version; remove older versions only after a successful subsequent invocation.

### Components

- **Release resolver:** lists stable releases and obtains immutable-release status and metadata from GitHub.
- **Observation store:** records each candidate's version, tag, manifest digest, artifact digest, `publishedAt`, authenticated server-time `firstSeenAt`, and observation receipt.
- **Policy engine:** pure decision logic returning `ineligible`, `observing`, `eligible`, or `blocked`, with a machine-readable reason.
- **Verifier:** validates schema, calendar-valid canonical timestamps, repository identity, equality of `version`, `releaseTag`, and the artifact-name version, source commit, artifact size and SHA-256, protected workflow identity, canonical gate result, and provenance before extraction.
- **Transaction manager:** locks, writes and durably orders a recovery journal, stages, validates archive paths, activates atomically, reconciles after restart, performs a post-activation smoke check, and rolls back on failure.
- **Status surface:** supports `check`, `apply`, `enable`, `disable`, and `status`; no background daemon in the first release.

### State transitions

```text
disabled -> checking -> no-candidate
                    -> observing -> eligible -> downloading -> verified
                    -> blocked                  -> staged -> active
                                                    |         |
                                                    +-> failed +-> rollback
```

Invalid transitions fail closed. Cancellation before activation removes staging. Cancellation after activation runs the smoke check and either commits state or restores `rollback`.

## Policy and security invariants

1. Automatic mode is disabled by default. `--enable-auto-update` records explicit consent; it does not force an immediate update.
2. `TRACEKNOT_REF` other than an updater-managed stable tag implies pinned mode and disables automatic application.
3. Network failure, GitHub rate limiting, malformed metadata, missing attestation, clock anomaly, or verification failure preserves the active version.
4. The updater accepts assets only from the configured Traceknot GitHub repository and rejects redirects to unapproved origins.
5. Archive extraction rejects absolute paths, `..`, device files, and links escaping the staging root.
6. A version is never downgraded automatically. Reinstalling the same digest is a no-op; the same version with a different digest is a security failure.
7. Update state and activation targets must be regular owned paths beneath the canonical prefix, with the installer's existing symlink checks retained.
8. Logs must not contain tokens. GitHub authentication, if supported later, is read from the environment and never persisted.

## Delivery plan

### Phase 0 — trusted release foundation

- Adopt semantic release tags and immutable GitHub Releases.
- Add deterministic archive creation, update manifest generation, SHA-256 digesting, and artifact attestation.
- Require the canonical CI gate before publication.
- Document incident response: revoke or delete a compromised release, publish a fixed version, and explain that deletion blocks future installs but cannot undo an already activated version.

**Exit:** a release asset can be verified offline against its manifest and provenance, and rerunning the build produces the same payload digest or a documented deterministic exception.

### Phase 1 — check-only updater

- Add the schema-backed resolver, observation store, policy engine, status output, and locking.
- Ship `check`, `status`, `enable`, and `disable`; do not apply updates.
- Import a v1 manifest as an update-disabled legacy state. Before first managed activation, copy the owned flat payload into a verified `releases/legacy-<digest>` rollback snapshot without changing the live files. The first activation transaction must persist that snapshot and original Skill-registration target, then atomically activate `current` and replace the registration through the same recovery journal. Startup recovery restores both the legacy payload target and original registration if the transaction does not commit.

**Exit:** strict boundary, backdating, forward and backward local-clock jumps, invalid calendar dates, mutation, prerelease, malformed metadata, race, and offline scenarios return the expected decision without changing installed files.

### Phase 2 — transactional opt-in application

- Add verified download, safe extraction, versioned staging, atomic activation, smoke check, and rollback.
- Move Skill registration to `${prefix}/current/skill` only after the active release exists.
- Preserve pinned and dry-run workflows.

**Exit:** fault injection at every filesystem boundary leaves a complete old or new install, and the original registration remains usable after rollback.

### Phase 3 — controlled adoption

- Enable opt-in automatic checks on normal Traceknot invocation, rate-limited to once per 24 hours.
- Publish structured status and user-facing remediation.
- Observe failure and rollback rates before considering any default change. Default-on requires a separate decision and risk acceptance.

## Verification plan

### Test conditions

| Condition | Basis | Risk | Technique | Expected result |
|---|---|---|---|---|
| COND-001 freshness boundary | BASIS-002, BASIS-003 | RISK-002 | Boundary values, invalid partitions | Only a candidate with authenticated age and observation age strictly greater than seven days is eligible. |
| COND-002 release trust | BASIS-003, BASIS-005 | RISK-001, RISK-002 | Decision table, negative tests | Every required identity, workflow, gate, immutability, digest, timestamp, and provenance check must pass together. |
| COND-003 state lifecycle | BASIS-006, BASIS-007 | RISK-003, RISK-006 | State transitions | Allowed transitions preserve invariants; invalid transitions fail closed. |
| COND-004 transaction recovery | BASIS-006 | RISK-003 | Recovery, fault injection | Every crash boundary recovers to one complete active payload and consistent state. |
| COND-005 concurrency | BASIS-006 | RISK-005 | Race, stale operation, cancellation | At most one writer can stage or activate a prefix. |
| COND-006 migration compatibility | BASIS-004, BASIS-008 | RISK-004 | Compatibility scenarios | v1, custom-prefix, pinned, dry-run, install, and uninstall contracts remain usable. |
| COND-007 release pipeline | BASIS-003, BASIS-005 | RISK-001 | Build, negative provenance | Only the protected workflow after the canonical gate can produce accepted release provenance. |
| COND-008 end-to-end opt-in flow | BASIS-001, BASIS-002, BASIS-007 | RISK-001, RISK-002, RISK-003, RISK-006 | End-to-end scenario | Opt-in observation, delayed application, status, rollback, and disable work without privilege escalation. |

### Mandatory obligations

| Obligation | Conditions | Basis / risk | Evidence | Surface / independence | Completion criteria |
|---|---|---|---|---|---|
| OBL-001 | COND-001 | BASIS-002, BASIS-003 / RISK-002 | Test result | Policy engine / independent-producer | 604800 seconds is ineligible; a later instant is eligible; local forward/backward jumps and invalid server time block. |
| OBL-002 | COND-002 | BASIS-003, BASIS-005 / RISK-001, RISK-002 | Scenario result | Verifier / independent-producer | Mutable, unattested, wrong-repository, wrong-workflow, missing-gate, wrong-commit, inconsistent-version, invalid-date, and digest-mismatched candidates are rejected. |
| OBL-003 | COND-003 | BASIS-006, BASIS-007 / RISK-003, RISK-006 | Test result | State engine / independent-producer | Every allowed transition works; every invalid transition fails closed and preserves active state. |
| OBL-004 | COND-004 | BASIS-006 / RISK-003 | Experiment | Filesystem transaction / independent-producer | Process-kill and power-loss simulation at every journal boundary prove old-or-new atomicity, restart reconciliation, and rollback. |
| OBL-005 | COND-005 | BASIS-006 / RISK-005 | Scenario result | Concurrent processes / independent-producer | Concurrent check/apply attempts serialize; stale lock handling never permits two writers. |
| OBL-006 | COND-006 | BASIS-004, BASIS-008 / RISK-004 | Scenario result | Installer lifecycle / independent-producer | Default/custom prefixes, v1 manifests, legacy rollback snapshots, original Skill registration, dry-run, pinned refs, install, and uninstall retain their contracts. |
| OBL-007 | COND-007 | BASIS-003, BASIS-005 / RISK-001 | Build result | Release candidate / independent-producer | Canonical CI, deterministic package, schema validation, trusted-workflow attestation verification, immutable publication gate, and offline verification pass. |
| OBL-008 | COND-008 | BASIS-001, BASIS-002, BASIS-007 / RISK-001, RISK-002, RISK-003, RISK-006 | Scenario result | Installed product / independent-producer | A fresh installation opts in, observes for more than seven days using controlled trusted time, applies, smoke-checks, reports status, rolls back under injected failure, and disables cleanly. |

Every evidence record must bind the obligation ID, basis and risk IDs, target commit, release-candidate digest, environment, command or scenario, start and end timestamps, exit status, structured counts, immutable artifact URI, and producer identity plus independence level. Missing binding makes the obligation incomplete, not passed.

Conditions use boundary values, equivalence partitions, negative testing, decision tables, state transitions, concurrency, recovery, compatibility, and end-to-end scenarios. R3 obligations require an independent producer; release authorization must also explicitly accept any unresolved material risk.

## Entry and exit criteria

Implementation entry requires an approved release identity model, protected tag policy, immutable-release capability, artifact attestation support, test clock injection, fault-injectable filesystem operations, and fixtures for v1 installs and signed releases. Missing prerequisites block the corresponding obligation.

A production verdict cannot be `PASS` until all mandatory obligations above pass against an identified commit and release candidate, with no unaccepted material defect. A green unit suite alone is insufficient.

## Foundation prepared in this change

- This architecture and phased delivery plan.
- A strict JSON Schema for the signed update manifest.
- Explicit basis, risk, conditions, obligations, independence, and exit criteria for future implementation.

No updater is enabled by this planning change. Existing installation behavior remains unchanged.
