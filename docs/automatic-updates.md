# Automatic update plan

## Decision summary

The canonical Skill lifecycle is managed by the Skills CLI:

```sh
# Global installation
npx skills add Jin-Doh/traceknot --skill traceknot --global
npx skills update traceknot --global --yes
# Project-local installation, from the project root
npx skills add Jin-Doh/traceknot --skill traceknot --yes
npx skills update traceknot --yes
```

The complete `skill/` payload includes `skill/bin/traceknot`, references, schemas, capability manifests, and the Board renderer. Bun 1.3.14 or later on macOS or Linux is required for the generated Verify and Board CLI; native Windows is unsupported by the artifact store and command collector. `npx skills update` is the canonical update operation and replaces the same complete payload; it is not a documentation-only or runtime-less update.
After a global Skills CLI install, invoke `$HOME/.agents/skills/traceknot/bin/traceknot`; after a project-local install, invoke `.agents/skills/traceknot/bin/traceknot` from the project root. Run `$HOME/.agents/skills/traceknot/bin/traceknot self-check` after a global installation or update and `.agents/skills/traceknot/bin/traceknot self-check` after a project-local installation or update. Never substitute an unrelated global executable for a project-local command.

The legacy curl installer remains an optional prefix launcher/updater for environments that need it. Its release updater may apply only an immutable, tagged release whose exact artifact has been observed for more than seven complete days and whose signed provenance and digest verify successfully. It never creates, replaces, retargets, updates, or removes a Skills CLI-owned registration. This optional launcher policy never creates a second Skill payload, Board contract, schema, or product tier.

The seven-day delay is a safety buffer, not a trust mechanism. Release immutability, artifact provenance, digest verification, atomic activation, and rollback remain mandatory for the optional launcher.

## Current-state review

The optional prefix installer and updater:

- installs and updates the complete `skill/` tree;
- preserves executable mode for `skill/bin/traceknot`;
- uses Bun as the explicit runtime prerequisite for the generated CLI; and
- keeps Board publication on the shared session-scoped contract.

The optional legacy launcher and updater:
- install into a user-local prefix and record only prefix-owned paths;
- leave every Skills CLI-owned registration untouched and remove only a legacy symlink pointing into the same prefix;
- enable one daily verified update check by default;
- support `--disable-auto-update` during installation and `traceknot-update disable` afterward;
- stage immutable releases, verify provenance and digest, activate atomically, retain one rollback target, serialize update and uninstall operations, and recover interrupted transactions.

## Running the updater

Select the active-layout executable with the legacy-layout fallback, then run the required operation:

<!-- operational-command:updater -->
```sh
TRACEKNOT_PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/traceknot"
if [ -x "$TRACEKNOT_PREFIX/current/bin/traceknot-update" ]; then
  TRACEKNOT_UPDATE="$TRACEKNOT_PREFIX/current/bin/traceknot-update"
else
  TRACEKNOT_UPDATE="$TRACEKNOT_PREFIX/bin/traceknot-update"
fi

"$TRACEKNOT_UPDATE" status --prefix "$TRACEKNOT_PREFIX"
"$TRACEKNOT_UPDATE" check --prefix "$TRACEKNOT_PREFIX"
"$TRACEKNOT_UPDATE" apply --prefix "$TRACEKNOT_PREFIX"
"$TRACEKNOT_UPDATE" disable --prefix "$TRACEKNOT_PREFIX"
"$TRACEKNOT_UPDATE" enable --prefix "$TRACEKNOT_PREFIX"
"$TRACEKNOT_UPDATE" rollback --prefix "$TRACEKNOT_PREFIX"
```

For a custom installation, set `TRACEKNOT_PREFIX` to that absolute prefix before selecting the executable. Every invocation passes it explicitly because the updater does not read this shell variable as configuration. `check` does not change installed files; `apply` activates the newest eligible verified release; `rollback` restores the immediately previous managed release.

## Test basis and acceptance criteria

| ID | Source | Basis or observable acceptance criterion |
|---|---|---|
| BASIS-001 | Explicit | Plan an automatic update facility for Traceknot. |
| BASIS-002 | Explicit | Automatic installation is allowed only after the candidate has exceeded seven days of freshness. |
| BASIS-003 | Derived from the shared proposal's security goal | A mutable or unverifiable release must never become eligible merely because its timestamp is old. |
| BASIS-004 | Current installer contract | Existing user-local prefixes, dry-run behavior, owned-file protections, untouched Skills CLI registrations, and removal of legacy prefix-owned registration symlinks must remain supported during migration. |
| BASIS-005 | Repository contract | The canonical `sh scripts/ci` gate remains the release precondition. |
| BASIS-006 | Derived operational criterion | Interrupted or failed updates leave either the old complete version active or the new complete version active, never a mixed tree. |
| BASIS-007 | Explicit product decision | Automatic update is enabled by default, can be disabled during or after installation, and never requires `sudo`. |
| BASIS-008 | Derived compatibility criterion | Custom-prefix, pinned initial source, dry-run, reinstall, and uninstall workflows remain functional; an explicit opt-out persists. |
| BASIS-009 | Explicit deployment decision | Release promotion requires an approved immutable source identity rather than implicitly deploying every `main` merge. |
| BASIS-010 | Derived operational criterion | Publication succeeds only when the assets downloaded from the public Release API retain the expected identity, digest, provenance, installability, and delayed-observation behavior. |

### Freshness definition

A candidate becomes eligible only when:

```text
trustedNow > max(release.publishedAt, localObservation.firstSeenAt) + 604800 seconds
```

Both clocks are required:

- `publishedAt` enforces the public release age;
- `firstSeenAt` prevents a newly discovered, backdated release from bypassing the waiting period.

`trustedNow` and `firstSeenAt` come from the authenticated GitHub API response `Date` header, not the local wall clock. Automatic application requires an online time observation from the approved GitHub origin. A missing, malformed, stale, or locally inconsistent server time blocks application. The stored `firstSeenAt` is append-only for a manifest digest; it can never move earlier. The updater also records local monotonic elapsed time while a boot session remains available, but never uses local time alone to grant eligibility.

The boundary is strict: 604800 elapsed seconds remains ineligible; the first later representable instant is eligible. All persisted instants use canonical UTC RFC 3339. The updater must calendar-parse them and reject impossible dates even when the schema's lexical pattern matches.

Prereleases, drafts, deleted releases, mutable releases, and releases without valid provenance are ineligible. The initial implementation should follow the latest eligible stable release, not simply GitHub's `latest` pointer.

## Product risk

| ID | Level | Impact | Likelihood | Basis | Rationale and mitigation |
|---|---:|---:|---:|---|---|
| RISK-001 | R3 | 4 | 3 | BASIS-001, BASIS-003 | Supply-chain compromise can execute attacker-controlled content. Require immutable releases, signed provenance, digest verification, and independent release-gate evidence. |
| RISK-002 | R3 | 4 | 3 | BASIS-002, BASIS-003 | Timestamp manipulation or asset replacement could bypass the delay. Use authenticated GitHub server time, `max(publishedAt, firstSeenAt)`, immutable releases, and provenance bound to the artifact digest and source commit. |
| RISK-003 | R2 | 3 | 3 | BASIS-004, BASIS-006 | In-place copying can create partial or mixed installs. Stage into a version directory and atomically switch an activation pointer. |
| RISK-004 | R2 | 3 | 3 | BASIS-004, BASIS-008 | Migration or the default-policy change can break existing workflows. Preserve v1 manifest import and persist explicit opt-out state. |
| RISK-005 | R2 | 3 | 2 | BASIS-006 | Concurrent invocations can race. Use a per-prefix lock with stale-lock recovery that never guesses ownership. |
| RISK-006 | R2 | 3 | 3 | BASIS-007 | Default-on checks can surprise users or hide failures. Provide installation-time and runtime opt-out, structured status, check-only controls, the seven-day delay, and no privilege escalation. |
| RISK-007 | R3 | 4 | 3 | BASIS-009, BASIS-010 | A stale approval, mistargeted tag, partially visible release, or public-asset mismatch can distribute unverified executable content. Bind approval to the full current `main` SHA and require post-publication verification against re-downloaded assets. |

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

The optional launcher at `${prefix}/bin/traceknot` follows `${prefix}/current/skill/bin/traceknot` while its release updater is active. Activation uses a write-ahead transaction record, durable staged files, and same-directory symlink rename. Required ordering is: persist the prepared transaction and staged payload; persist the rollback target; atomically replace `current`; run the structural and installed-runtime self-checks; persist active state; then mark committed. Startup recovery reconciles the transaction record, `current`, rollback target, and active manifest before any new check. It removes a legacy registration symlink only when that symlink points to `${prefix}/skill` or `${prefix}/current/skill`; it never creates or retargets a registration. A crash at any boundary deterministically completes the new activation or restores the prior activation. Retain the active and one prior version; remove older versions only after a successful subsequent invocation.

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

1. Automatic checks are enabled by default. `--disable-auto-update` records installation-time opt-out; `traceknot-update disable` removes the schedule and persists that decision.
2. `TRACEKNOT_REF` pins the initially installed revision; use `--disable-auto-update` when that installation must remain pinned.
3. Network failure, GitHub rate limiting, malformed metadata, missing attestation, clock anomaly, or verification failure preserves the active version.
4. The updater accepts asset API URLs only from the configured Traceknot GitHub repository and permits only HTTPS transport for GitHub-controlled download redirects.
5. Archive extraction rejects absolute paths, `..`, device files, and links escaping the staging root.
6. A version is never downgraded automatically. Reinstalling the same digest is a no-op; the same version with a different digest is a security failure.
7. Update state and activation targets must be regular owned paths beneath the canonical prefix, with the installer's existing symlink checks retained.
8. Logs must not contain tokens. GitHub authentication, if supported later, is read from the environment and never persisted.
9. The optional legacy launcher must leave an existing unowned Skill path untouched, must never create or retarget the canonical Skills CLI registration, and may remove only a legacy symlink that points into its own prefix. Users update the canonical registration with `npx skills update traceknot --global --yes`.

## Release promotion and operations

`.github/workflows/promote-release.yml` is the approval and promotion boundary; `.github/workflows/release.yml` is the trusted publication boundary. Promotion requires the intended `X.Y.Z` version and the full current `main` commit SHA, rejects a moving or reused target, reruns `sh scripts/ci`, and creates the version tag only after that gate passes. The tag is pushed with the dedicated `traceknot-release-tag-promotion` deploy key, so the protected tag-push event runs the trusted workflow in `refs/tags/vX.Y.Z` context as required by updater provenance verification. A resumed promotion with an existing exact tag uses an explicit tag-ref dispatch only when no queued, running, or successful publisher run exists. The release workflow repeats the canonical gate, packages and attests the tagged source, publishes it, and verifies assets downloaded again through the public GitHub Release API.

For a new version, promotion checks the approved SHA against `origin/main` both before the canonical gate and again immediately before creating the protected tag. If `main` advances while the gate runs, promotion fails without creating the tag and requires a fresh approval.

Repository administrators must configure the `release` GitHub Environment with required reviewers and the `RELEASE_TAG_DEPLOY_KEY` Environment secret. The active `Protect automatic-update release tags` repository ruleset applies creation, update, and deletion restrictions to `refs/tags/v*.*.*`; deploy keys are its only bypass actor, and the repository owns one write-enabled key named `traceknot-release-tag-promotion`. Promotion's `GITHUB_TOKEN` has only `contents: read` and `actions: write`; it cannot create the protected tag. Administrators can disable the ruleset for audited emergency recovery but cannot bypass it during ordinary tag creation. The workflow declares the Environment, but repository policy owns reviewers, the deploy key, and the ruleset. Do not treat a promotion as authorized until the Environment deployment records an approval.

If a publisher run fails after tag creation, rerun the same promotion inputs. The workflow accepts an existing tag only when it still resolves to the approved SHA and no release exists, skips ref creation, and dispatches the trusted workflow unless a queued, running, or successful run for that tag and SHA already exists. A conflicting tag or existing release remains a hard failure.

To promote a release:

```sh
commit=$(gh api repos/Jin-Doh/traceknot/commits/main --jq .sha)
gh workflow run promote-release.yml \
  --ref main \
  -f version=X.Y.Z \
  -f sourceCommit="$commit"
```

The run must reach all of these terminal results:

1. a new promotion's approved SHA still equals current `main`, or a resumed promotion's existing tag resolves exactly to that approved SHA;
2. canonical CI passes against that SHA;
3. the deterministic archive and manifest validate;
4. provenance is issued by `.github/workflows/release.yml`;
5. the release is stable and immutable;
6. the tag, manifest, archive digest, and source commit agree;
7. a clean installation from the downloaded public archive succeeds;
8. the installed updater observes the new release but does not bypass the strict seven-day delay.

The verification job writes a workflow summary and retains `verification-status.json`, `verifier.log`, public release and tag metadata, the published manifest when available, updater output when reached, and the successful `release-evidence.json` for 90 days. The upload runs even when post-publication verification fails, so incident evidence survives a failed immutable publication. A successful evidence record includes the release URL, source commit, archive and manifest SHA-256 values, verification time, expected first eligible instant, and the completed public-surface checks.

### Failed or compromised release

Published immutable assets are never replaced and an existing version tag is never retargeted. If verification fails after publication, treat that version as unavailable for promotion, preserve the failed run and evidence, diagnose the public release state, and publish a higher patch version only after correction. Deleting or revoking a compromised release prevents future discovery but cannot undo an already activated installation; affected users must run `traceknot-update rollback`, and maintainers must publish a fixed version. Never recreate the deleted tag or reuse its semantic version.

The updater's seven-day observation delay limits immediate adoption but is not an incident-response control. Until a server-side release exclusion mechanism exists, maintainers must remove a known-bad release from the GitHub Releases API before it becomes eligible and record the incident, affected digest, disposition, and replacement release. A failed publication or public verification is a release-blocking defect, not a warning that may be ignored.

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
- Import a v1 manifest as a legacy state while preserving the configured default or explicit opt-out. Before first managed activation, copy the owned flat payload into a verified `releases/legacy-<digest>` rollback snapshot without changing the live files. The first activation transaction persists that snapshot, atomically activates `current`, updates only the prefix launcher, and removes a legacy prefix-owned registration symlink if present. Startup recovery restores the legacy payload target without creating or retargeting a Skill registration.

**Exit:** strict boundary, backdating, forward and backward local-clock jumps, invalid calendar dates, mutation, prerelease, malformed metadata, race, and offline scenarios return the expected decision without changing installed files.

### Phase 2 — transactional application

- Add verified download, safe extraction, versioned staging, atomic activation, smoke check, and rollback.
- Keep the optional launcher at `${prefix}/bin/traceknot` bound to the active `${prefix}/current/skill/bin/traceknot`; never create or retarget a Skill registration.
- Preserve custom-prefix, explicit opt-out, and dry-run workflows.

**Exit:** fault injection at every filesystem boundary leaves a complete old or new prefix install, the Skills CLI registration remains byte-for-byte unchanged, and any legacy prefix-owned registration symlink is absent after successful migration.

### Phase 3 — default-on controlled adoption

- Enable one automatic check per day by default; installation and runtime opt-out remain first-class.
- Publish structured status and user-facing remediation.
- Monitor failure and rollback rates, and retain the ability to disable without removing Traceknot.

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
| COND-008 end-to-end default and opt-out flow | BASIS-001, BASIS-002, BASIS-007 | RISK-001, RISK-002, RISK-003, RISK-006 | End-to-end scenario | Fresh install schedules checks by default; installation-time and runtime opt-out persist; delayed application, status, and rollback work without privilege escalation. |
| COND-009 release promotion identity | BASIS-005, BASIS-009 | RISK-001, RISK-007 | Decision table, stale-operation test | Dispatch accepts only an unused semantic version and the full current `main` SHA; tag-triggered releases must identify a commit contained in `main`. |
| COND-010 public release verification | BASIS-003, BASIS-010 | RISK-001, RISK-002, RISK-007 | End-to-end scenario, negative identity test | Public API metadata, tag, manifest, archive, provenance, clean install, and first observation agree; any mismatch fails the release run. |

### Mandatory obligations

| Obligation | Conditions | Basis / risk | Evidence | Surface / independence | Completion criteria |
|---|---|---|---|---|---|
| OBL-001 | COND-001 | BASIS-002, BASIS-003 / RISK-002 | Test result | Policy engine / independent-producer | 604800 seconds is ineligible; a later instant is eligible; local forward/backward jumps and invalid server time block. |
| OBL-002 | COND-002 | BASIS-003, BASIS-005 / RISK-001, RISK-002 | Scenario result | Verifier / independent-producer | Mutable, unattested, wrong-repository, wrong-workflow, missing-gate, wrong-commit, inconsistent-version, invalid-date, and digest-mismatched candidates are rejected. |
| OBL-003 | COND-003 | BASIS-006, BASIS-007 / RISK-003, RISK-006 | Test result | State engine / independent-producer | Every allowed transition works; every invalid transition fails closed and preserves active state. |
| OBL-004 | COND-004 | BASIS-006 / RISK-003 | Experiment | Filesystem transaction / independent-producer | Process-kill and power-loss simulation at every journal boundary prove old-or-new atomicity, restart reconciliation, and rollback. |
| OBL-005 | COND-005 | BASIS-006 / RISK-005 | Scenario result | Concurrent processes / independent-producer | Concurrent check/apply attempts serialize; stale lock handling never permits two writers. |
| OBL-006 | COND-006 | BASIS-004, BASIS-008 / RISK-004 | Scenario result | Installer lifecycle / independent-producer | Default/custom prefixes, v1 manifests, legacy rollback snapshots, dry-run, pinned refs, install, update, rollback, and uninstall retain their contracts while Skills CLI registrations remain untouched and legacy prefix-owned symlinks are removed. |
| OBL-007 | COND-007 | BASIS-003, BASIS-005 / RISK-001 | Build result | Release candidate / independent-producer | Canonical CI, deterministic package, schema validation, trusted-workflow attestation verification, immutable publication gate, and offline verification pass. |
| OBL-008 | COND-008 | BASIS-001, BASIS-002, BASIS-007 / RISK-001, RISK-002, RISK-003, RISK-006 | Scenario result | Installed product / independent-producer | A fresh installation schedules one daily check, observes for more than seven days using controlled trusted time, applies, smoke-checks, reports status, rolls back under injected failure, and both opt-out paths disable cleanly. |
| OBL-009 | COND-009 | BASIS-005, BASIS-009 / RISK-001, RISK-007 | Scenario result and Environment approval | Release promotion / external-approval | The approved full SHA still equals current `main`, the version and tag are unused, required reviewers approve the `release` Environment, and the canonical gate passes before publication. |
| OBL-010 | COND-010 | BASIS-003, BASIS-010 / RISK-001, RISK-002, RISK-007 | Public scenario result and retained evidence | Published release / independent-producer | Re-downloaded assets pass identity, schema, size, digest, trusted-workflow attestation, safe extraction, clean installation, and updater-observation checks, with an immutable evidence record retained by CI. |

Every evidence record must bind the obligation ID, basis and risk IDs, target commit, release-candidate digest, environment, command or scenario, start and end timestamps, exit status, structured counts, immutable artifact URI, and producer identity plus independence level. Missing binding makes the obligation incomplete, not passed.

Conditions use boundary values, equivalence partitions, negative testing, decision tables, state transitions, concurrency, recovery, compatibility, and end-to-end scenarios. R3 obligations require an independent producer; release authorization must also explicitly accept any unresolved material risk.

## Entry and exit criteria

Implementation entry requires an approved release identity model, protected tag policy, immutable-release capability, artifact attestation support, test clock injection, fault-injectable filesystem operations, and fixtures for v1 installs and signed releases. Missing prerequisites block the corresponding obligation.

A production verdict cannot be `PASS` until all mandatory obligations above pass against an identified commit and release candidate, with no unaccepted material defect. A green unit suite alone is insufficient.

## Implemented foundation

- Default-on daily checks with installation-time and runtime opt-out.
- Strict signed-manifest schema, deterministic release packaging, and artifact attestation.
- Transactional activation, rollback, stale-lock recovery, migration, and adversarial verification obligations.

Automatic checks are enabled by default. Users can opt out during installation with `--disable-auto-update` or afterward with `traceknot-update disable`.
