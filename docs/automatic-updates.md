# Automatic updates

Traceknot has two update backends because its two installation paths have different owners.

| Installation | Owner | Update backend |
|---|---|---|
| `npx skills add Jin-Doh/traceknot --skill traceknot` | Skills CLI | bundled `traceknot update` bridge |
| optional `curl .../install.sh | sh` prefix launcher | Traceknot prefix installer | `traceknot-update --prefix ...` |

Both backends use the same release policy: a candidate must be a stable immutable GitHub Release, carry the canonical update manifest, remain observed for strictly more than seven complete days, and pass digest and GitHub artifact-attestation verification before application. The backends do not write each other's paths.

## Canonical Skills CLI installation

The Skills CLI installation is the canonical distribution path. The installed Skill now contains:

```text
.agents/skills/traceknot/
  SKILL.md
  bin/traceknot
  bin/traceknot-skills-update
  ...
```

`traceknot-skills-update` is the sibling updater distributed with the canonical Skill runtime. The updater never copies files directly into the canonical registration during normal application. It asks a pinned Skills CLI version to install the exact release source commit through the universal Codex target, which updates the canonical `.agents/skills/traceknot` directory without fanning out writes to every detected agent path.

A plain unattended `npx skills update traceknot` is intentionally not used. That command follows the installation's recorded source and ref; an installation that tracks the default branch could resolve a revision newer than the release that completed Traceknot's seven-day verification window. Instead, the bridge resolves the eligible release, verifies its artifact, then delegates this exact source identity:

```text
Jin-Doh/traceknot#<verified-source-commit>
```

Before changing the real registration, the updater installs the same commit into an isolated temporary scope, runs `traceknot self-check`, and compares the complete installed Skill payload with the verified release artifact. The real installation proceeds only when those bytes agree.

### Global installation

Use the executable from the global Skill registration:

```sh
TRACEKNOT_UPDATE="$HOME/.agents/skills/traceknot/bin/traceknot-skills-update"

"$TRACEKNOT_UPDATE" status --global
"$TRACEKNOT_UPDATE" check --global
"$TRACEKNOT_UPDATE" apply --global
"$TRACEKNOT_UPDATE" enable --global
"$TRACEKNOT_UPDATE" disable --global
```

`enable` is an explicit opt-in. It installs one daily cron entry. The scheduled invocation checks at most once per 24 hours and automatically applies only an eligible verified release.

State is stored outside the Skills CLI-owned registration:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/traceknot/skills-update-global/
  config
  observations.tsv
  active.json
```

The Skills CLI lock remains in its normal location:

```text
${XDG_STATE_HOME:+$XDG_STATE_HOME/skills/.skill-lock.json}
${XDG_STATE_HOME:-$HOME/.agents}/.skill-lock.json
```

When `XDG_STATE_HOME` is unset, the effective lock path is `$HOME/.agents/.skill-lock.json`.

### Project installation

Run the project-local executable and pass the project root explicitly:

```sh
PROJECT_ROOT=$(pwd)
TRACEKNOT_UPDATE="$PROJECT_ROOT/.agents/skills/traceknot/bin/traceknot-skills-update"

"$TRACEKNOT_UPDATE" status --project "$PROJECT_ROOT"
"$TRACEKNOT_UPDATE" check --project "$PROJECT_ROOT"
"$TRACEKNOT_UPDATE" apply --project "$PROJECT_ROOT"
"$TRACEKNOT_UPDATE" enable --project "$PROJECT_ROOT"
"$TRACEKNOT_UPDATE" disable --project "$PROJECT_ROOT"
```

Project state is kept under `.agents` while the Skills CLI continues to own `skills-lock.json`:

```text
<project>/.agents/.traceknot-update/
  config
  observations.tsv
  active.json

<project>/skills-lock.json
```

The updater rejects a scope that does not match the executable's installed Skill root. A global updater cannot update an arbitrary project installation, and a project-local updater cannot update another project. It also requires the Skills CLI lock entry to identify `Jin-Doh/traceknot`, the GitHub source type, and `skill/SKILL.md`. After the first managed application, a lock ref that no longer matches the recorded source commit is treated as an external/manual change and blocks further managed updates rather than overwriting that choice.

## Eligibility policy

For each immutable stable release, the updater records the manifest digest and the authenticated GitHub server time when that exact manifest was first observed.

A release becomes eligible only when:

```text
trustedNow > max(release.publishedAt, localObservation.firstSeenAt) + 604800 seconds
```

The boundary is strict. Exactly 604800 elapsed seconds remains ineligible; the first later second is eligible.

The updater obtains `trustedNow` and `firstSeenAt` from the GitHub API response `Date` header. Local wall-clock time is used only for a bounded skew check. A missing or malformed server date, a local clock differing by more than 24 hours, malformed release metadata, an unverifiable artifact, or a network failure blocks application and preserves the active registration.

Candidates must satisfy all of these conditions:

1. `draft == false`;
2. `prerelease == false`;
3. `immutable == true`;
4. `traceknot-update-manifest.json` is present;
5. repository, semantic version, tag, source commit, artifact name, size, and digest satisfy the closed manifest contract;
6. the release artifact URL belongs to the approved GitHub Release API origin;
7. the artifact size and SHA-256 match the manifest;
8. GitHub attestation verification binds the artifact to `Jin-Doh/traceknot/.github/workflows/release.yml`, the protected release tag, and the exact source commit;
9. the archive contains no absolute path, traversal path, symlink, or special filesystem entry;
10. the archive includes both `skill/bin/traceknot` and `skill/bin/traceknot-skills-update` as executable files.

When multiple releases are eligible, the highest semantic version is selected. Automatic downgrade is rejected. Reusing an installed semantic version with a different artifact digest is treated as a security failure.

## Application sequence for Skills CLI installations

`apply` performs these stages:

1. resolve the highest eligible release;
2. download and verify its deterministic archive;
3. verify GitHub artifact provenance;
4. safely extract the archive into temporary storage;
5. invoke `skills@1.5.22` in an isolated temporary global or project scope with the exact source commit;
6. run the temporary runtime self-check;
7. compare the complete temporary Skill with the verified `skill/` payload;
8. invoke the same pinned Skills CLI against the real scope;
9. run the installed runtime self-check;
10. compare the real registration with the verified payload;
11. verify that the Skills CLI lock binds `Jin-Doh/traceknot`, `skill/SKILL.md`, and the exact source commit;
12. persist the active release record.

The temporary preflight substantially reduces the chance that a clone, discovery, packaging, runtime, or payload mismatch damages the active installation. The final filesystem replacement is still performed by the upstream Skills CLI and therefore inherits its replacement semantics. Traceknot does not claim atomic rollback for this backend. Automatic application is consequently opt-in rather than silently enabled by installation.

## Schedule ownership

`enable` writes one marked cron entry per scope:

```text
# traceknot-skills-auto-update:global:<registration>
# traceknot-skills-auto-update:project:<project-root>
```

`disable` removes only the matching marked entry and persists `automatic=0`. Existing unrelated cron entries are retained. Scheduled output is redirected because failures are fail-closed and do not modify the active release record.

The initial implementation supports cron on macOS and glibc-based Linux. Native Windows remains outside the supported runtime boundary.

## Dependencies

Release checks require:

```text
curl jq
```

Application additionally requires:

```text
gh tar diff npx sync sha256sum-or-shasum
```

Automatic scheduling also requires:

```text
crontab
```

`gh attestation verify` must be available. Authentication may be supplied through `GH_TOKEN`; tokens are read from the environment and are never written to updater state.

## Optional prefix launcher

The optional curl installer retains its existing prefix-owned updater:

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
"$TRACEKNOT_UPDATE" enable --prefix "$TRACEKNOT_PREFIX"
"$TRACEKNOT_UPDATE" disable --prefix "$TRACEKNOT_PREFIX"
"$TRACEKNOT_UPDATE" rollback --prefix "$TRACEKNOT_PREFIX"
```

That backend stages immutable release directories, atomically moves its `current` activation pointer, retains one rollback target, and manages only prefix-owned files. It never creates, replaces, retargets, updates, or removes a Skills CLI-owned registration.

## Operational guidance

Use `check` when only observation and eligibility reporting are wanted. It updates the trusted observation and last-check state but does not modify the Skill registration.

Use `apply --dry-run` to show the selected release without invoking Skills CLI:

```sh
"$HOME/.agents/skills/traceknot/bin/traceknot-skills-update" apply --global --dry-run
```

Use `status` to inspect scope, schedule policy, last trusted check, and the last release successfully applied by this updater. `version=unmanaged` means the current registration predates the Skills update bridge or was installed outside its active-state history; it does not mean the Skill is invalid.

A source intentionally pinned for reproducibility should leave automatic updates disabled. Explicit manual installation of another ref remains a Skills CLI operation and is not overridden until this updater is enabled or `apply` is invoked.
