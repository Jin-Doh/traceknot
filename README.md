# Traceknot

<p align="center"><img src="assets/traceknot-mark.svg" alt="Traceknot mark" width="144"></p>

**Evidence-bound QA for coding agents.**

[Website](https://traceknot.kyungho.info) · [한국어 문서](README.ko.md) · [Brand system](BRAND.md)

Traceknot is an ISTQB-aligned, evidence-bound QA framework for coding-agent harnesses such as OMP, Codex, Claude Code, OpenCode, and GajaeCode. It separates portable test-process guidance from deterministic QA decisions and optional harness-level completion authority.

The framework does **not** manage subagents. Each harness owns its agents, models, task graph, concurrency, retries, worktrees, lifecycle, and final task completion. Traceknot defines what must be verified, what evidence is acceptable, how defects and residual risk are handled, and how the QA verdict is resolved.

> `QA PASS` means the declared test basis and mandatory verification obligations passed. It does not mean every harness task, agent, job, or delivery has completed.

## Why Traceknot

Coding-agent harnesses already orchestrate agents, tools, jobs, retries, and lifecycle events. Those signals establish that activity occurred; they do not establish that the declared change was sufficiently verified.

| Native signal | Missing QA guarantee |
|---|---|
| Turn, task, or subagent ended | Mandatory verification passed |
| Command exited successfully | Test basis and risk coverage are sufficient |
| Agent reported completion | Evidence is independent, current, and snapshot-bound |
| Observed jobs became idle | Global quiescence or absence of unobserved work |
| Hook or app-server event fired | Deterministic QA verdict or completion authority |

Traceknot supplies the missing test-process layer: traceability from basis through verdict, explicit evidence and independence requirements, defect and residual-risk handling, and deterministic verdict precedence. Each verdict remains linked to its declared evidence; lifecycle events are observations, not proof of verification.

## Status

| Surface | Status |
|---|---|
| Portable ISTQB-aligned Skill | Implemented |
| Canonical QA record schemas | Implemented and schema-validated |
| Host-neutral deterministic verdict core | Implemented and tested |
| Harness capability manifests | Implemented; runtime capabilities default to none |
| Completion-authority contracts and models | Preserved as an optional extension |
| Native OMP/Codex/Claude/OpenCode integration | Not implemented |
| Phase B completion enforcement | Not authorized; `phase1Authorized: false` |
| User-local installer and uninstaller | Implemented; registry release and public CLI are not implemented |

The portable Skill and host-neutral core are usable now. Authoritative harness completion remains an explicitly separate integration project.

## Published prose quality gate

The canonical gate audits configured Korean and English publication prose for repeated formulaic structures, inflated stock phrases, excessive transitions, and related readability risks. It evaluates prose quality, not whether a human or an AI authored the text. Markdown frontmatter, code, direct quotes, inline code, links, and URLs are excluded from style analysis.

```sh
bun run prose-quality
```

`prose-quality.config.json` selects publication paths, languages, minimum prose length, and advisory or blocking behavior. The repository starts in `advisory` mode: findings are reported without turning style heuristics into an authorship claim. A separate before/after mode verifies that rewrites preserve code, links, URLs, numbers, and normative terms; protected-content changes or a token change rate of 50% or more fail that check. A rewriting skill is remediation, not verification: its output must be checked again against a new snapshot.

The Korean rule categories and preservation model were informed by [epoko77-ai/im-not-ai](https://github.com/epoko77-ai/im-not-ai). Traceknot implements its own deterministic, bilingual audit boundary and does not treat an external skill's self-report as QA evidence by itself.

## Install

Install the current `main` revision without cloning the repository:

```sh
curl -fsSL https://raw.githubusercontent.com/Jin-Doh/traceknot/main/install.sh | sh
```

The script downloads the matching source archive over HTTPS, then installs without `sudo`. The default destination is `${XDG_DATA_HOME:-$HOME/.local/share}/traceknot`; the portable Skill is registered at `$HOME/.agents/skills/traceknot`, where OMP and Codex discover it.

To install a fixed tag or commit, use the same revision in the script URL and `TRACEKNOT_REF`:

```sh
TRACEKNOT_REF=<tag-or-commit>
curl -fsSL "https://raw.githubusercontent.com/Jin-Doh/traceknot/$TRACEKNOT_REF/install.sh" \
  | TRACEKNOT_REF="$TRACEKNOT_REF" sh
```

The installer copies the portable Skill, record schemas, capability manifests, host-neutral core, and MIT license. It registers the Skill for OMP and Codex through the shared Agent Skills directory. It does not install the optional completion-authority extension.

Use an absolute prefix to change the destination:

```sh
curl -fsSL https://raw.githubusercontent.com/Jin-Doh/traceknot/main/install.sh \
  | sh -s -- --prefix "$HOME/tools/traceknot"
```

Pass `--dry-run` the same way to preview writes. Re-running the installer updates files owned by Traceknot and leaves unrelated files untouched. Set `TRACEKNOT_SKILLS_ROOT` to an absolute directory only when the shared Agent Skills location must be overridden.

If you prefer to inspect the script before running it, download it first or install from a clone:

```sh
git clone https://github.com/Jin-Doh/traceknot.git
cd traceknot
./install.sh
```

## Uninstall

For the default destination:

```sh
curl -fsSL https://raw.githubusercontent.com/Jin-Doh/traceknot/main/uninstall.sh | sh
```

For a custom prefix:

```sh
curl -fsSL https://raw.githubusercontent.com/Jin-Doh/traceknot/main/uninstall.sh \
  | sh -s -- --prefix "$HOME/tools/traceknot"
```

The uninstaller reads the installation manifest, removes only files installed by Traceknot, and removes the shared Skill registration only when it still points to that installation. Pass `--dry-run` to preview removals; running uninstall again is harmless. Use the same `TRACEKNOT_SKILLS_ROOT` override used during installation. A cloned repository can use `./uninstall.sh` instead.

## Automatic updates

Automatic update checks are enabled by default. The updater considers only immutable GitHub releases whose signed provenance and SHA-256 digest verify, and delays eligibility until the exact artifact has been observed for more than seven complete days.

```sh
TRACEKNOT_UPDATE="${XDG_DATA_HOME:-$HOME/.local/share}/traceknot/bin/traceknot-update"

# Show policy, schedule, and installed release state
"$TRACEKNOT_UPDATE" status

# Check for an eligible release without changing files
"$TRACEKNOT_UPDATE" check

# Apply the newest eligible verified release
"$TRACEKNOT_UPDATE" apply

# Disable or re-enable the daily automatic check
"$TRACEKNOT_UPDATE" disable
"$TRACEKNOT_UPDATE" enable
# Restore the immediately previous managed release
"$TRACEKNOT_UPDATE" rollback
```

Pass `--prefix DIR` and set `TRACEKNOT_UPDATE="$DIR/bin/traceknot-update"` when Traceknot is not installed at the default prefix. Installation schedules checks but never applies an update immediately. Use `install.sh --disable-auto-update` to opt out during installation, or `"$TRACEKNOT_UPDATE" disable` afterward. Full policy, recovery behavior, release contract, and verification evidence are documented in [`docs/automatic-updates.md`](docs/automatic-updates.md).

## Architecture

```mermaid
flowchart LR
    U[User request and repository change] --> H[Harness]
    H --> S[Portable Skill]
    S --> B[Test basis and product risk]
    B --> P[Test conditions and verification plan]
    P --> X{Core available?}
    X -->|No| E[Evidence-only execution and report]
    X -->|Yes| C[Host-neutral QA core]
    C --> V[Deterministic QA verdict]
    V --> H

    H -. runtime handshake .-> A[Host capability adapter]
    A -. canonical records .-> C

    H -. optional native integration .-> Q[Completion-authority extension]
    Q -. lifecycle, quiescence, lease, receipt .-> H
```

### Responsibility boundary

```mermaid
flowchart TB
    subgraph Harness[Owned by each harness]
      HA[Agents and models]
      HT[Task graph and concurrency]
      HR[Retry and cancellation]
      HW[Worktrees, jobs, and deliveries]
      HC[Harness completion]
    end

    subgraph TK[Owned by Traceknot]
      QB[Test basis and risks]
      QP[Test conditions and obligations]
      QE[Evidence requirements]
      QD[Defects and accepted risk]
      QV[QA verdict and report]
    end

    Harness -->|produces evidence using its own policy| TK
    TK -->|returns QA verdict, never agent instructions| Harness
```

Traceknot specifies evidence requirements and minimum independence. It never instructs a harness to create a particular subagent, use a particular model, or apply a particular concurrency policy.

## QA process

```mermaid
flowchart LR
    A[Test basis] --> B[Product risk]
    B --> C[Test conditions]
    C --> D[Test techniques]
    D --> E[Mandatory obligations]
    E --> F[Entry criteria]
    F --> G[Execution and evidence]
    G --> H[Defects and regression]
    H --> I[Exit criteria]
    I --> J[Residual risk]
    J --> K[QA verdict]
```

The Skill applies seven foundational testing principles:

1. Testing shows the presence of defects, not their absence.
2. Exhaustive testing is impossible.
3. Early testing reduces cost and delay.
4. Defects cluster in specific surfaces.
5. Repeated tests lose defect-finding power.
6. Testing is context dependent.
7. A green technical suite is insufficient when user or business needs are unmet.

Traceability is bidirectional:

```text
test basis ↔ risk ↔ test condition ↔ obligation ↔ evidence ↔ defect
```

## Verdict model

| Verdict | Meaning |
|---|---|
| `PASS` | Every mandatory obligation and required coverage passed; no unaccepted material risk remains. |
| `PASS_WITH_ACCEPTED_RISK` | Mandatory obligations passed and every remaining material risk has valid, unexpired acceptance. |
| `FAIL` | A mandatory obligation failed or an unaccepted material defect remains. |
| `BLOCKED` | A mandatory prerequisite or required capability was unavailable. |
| `INCOMPLETE` | Mandatory evidence or required coverage has no terminal result. |

Precedence is deterministic:

```text
FAIL → BLOCKED → INCOMPLETE → PASS_WITH_ACCEPTED_RISK → PASS
```

The host-neutral core always emits `authoritative: false`. Only a separately integrated completion-authority extension could make a harness-level authority claim.

## Repository layout

```text
.
├── README.md
├── README.ko.md
├── install.sh
├── uninstall.sh
├── skill/
│   ├── SKILL.md
│   └── references/
├── contracts/
│   ├── capability.schema.json
│   ├── verification-request.schema.json
│   ├── verification-plan.schema.json
│   ├── evidence.schema.json
│   ├── defect.schema.json
│   └── verdict.schema.json
├── adapters/
│   ├── omp/
│   ├── codex/
│   ├── claude-code/
│   ├── opencode/
│   └── gajae-code/
└── system/
    ├── core/
    │   ├── qa-core.ts
    │   └── qa-core.test.ts
    └── extensions/
        └── harness-completion-authority/
            └── quality-contract/
```

### `skill/`

The portable, host-neutral workflow. It covers test basis, risk analysis, test design, entry and exit criteria, evidence, defect lifecycle, traceability, residual risk, and completion reporting.

Start with [skill/SKILL.md](skill/SKILL.md). Detailed guidance is in [skill/references](skill/references/).

### `contracts/`

Closed JSON Schema Draft 2020-12 records shared by a Skill, harness adapter, core validator, or external implementation:

- host capability;
- verification request;
- verification plan;
- evidence;
- defect;
- QA verdict.

Host names grant no capability. A runtime handshake must advertise and prove each capability.

### `adapters/`

Conservative capability manifests for supported harness names. All default capabilities are `false`; this prevents accidental trust escalation. A real adapter must provide current runtime capabilities and evidence without taking over the harness's agent policy.

### `system/core/`

A host-neutral TypeScript verdict resolver. It rejects duplicate obligation results, cross-snapshot evidence, insufficient producer independence, missing evidence identifiers, incomplete traceability coverage, open material defects, and expired risk acceptance.

### Completion-authority extension

[system/extensions/harness-completion-authority](system/extensions/harness-completion-authority/) preserves the existing lifecycle, quiescence, lease, receipt, terminal-pair, SQLite, schema, and generated-evidence contracts.

This extension is optional and disabled by policy. Lifecycle events such as task completion, subagent stop, turn completion, or agent end remain observations and cannot independently seal or verify completion.

## Using the portable Skill

Use `install.sh`, then point the harness's Skill loader at the installed `skill/` directory. The Skill itself has no runtime dependency on `system/`.

The expected workflow is:

1. identify the target snapshot and change scope;
2. collect explicit and derived test-basis items;
3. classify product risk;
4. derive observable test conditions and expected results;
5. select test techniques and mandatory obligations;
6. verify entry criteria;
7. let the harness execute checks under its own orchestration policy;
8. capture evidence and defects;
9. evaluate coverage, exit criteria, and residual risk;
10. issue a QA verdict separately from harness completion.

## Developing the core

Requirements:

- Bun 1.3.14

Install the exact reviewed toolchain without lifecycle scripts, then run the same blocking gate used by GitHub Actions:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run ci
```

The gate runs the portable installer lifecycle, JSON and Draft 2020-12 schema validation, capability validation, prompt-injection risk classification, core tests, strict type checking, and whitespace checks. `high` and `critical` prompt-risk findings block the gate. Narrow, expiring exceptions require an owner, reason, mitigation, and exact line fingerprint in `security/prompt-injection-exceptions.json`.

Run an individual core check while developing:

```bash
bun run test
bun run typecheck
```

## Verifying the completion-authority extension

Run from the extension root:

```bash
cd system/extensions/harness-completion-authority
bun quality-contract/scripts/verify-models.ts
bun quality-contract/scripts/verify-sqlite.ts
bun quality-contract/scripts/run-phase-b-verification.ts --intent
```

Strictly type-check the preserved models:

```bash
bun x tsc --ignoreConfig --noEmit --strict \
  --target ES2022 --module ESNext --moduleResolution Bundler \
  quality-contract/models/lifecycle-model.ts \
  quality-contract/models/storage-model.ts \
  quality-contract/models/quiescence-budget-model.ts
```

Current preserved verification evidence:

- model verifier: 570 passed, 0 failed;
- explored model states: 6,304;
- explored transitions: 27,152;
- SQLite verifier: 138 passed, 0 failed;
- Phase B intent: valid and `phase1Authorized: false`.

## Security and trust model

- Missing, cancelled, timed-out, or incomplete mandatory evidence is never PASS.
- Evidence must bind to the target snapshot and obligation.
- Required producer independence cannot be silently downgraded.
- Material risk acceptance requires an owner, reason, mitigation, and expiry.
- A host lifecycle notification is not QA evidence by itself.
- The core does not claim global quiescence or harness completion.
- The completion-authority extension must not be activated without an explicit native integration and approval process.

## Readiness assessment

**Ready with follow-ups** for portable Skill evaluation and host-neutral QA-core development.

Not yet ready for:

- package-manager or Skill-registry distribution;
- native OMP, Codex, Claude Code, OpenCode, or GajaeCode adapters;
- authoritative harness completion;
- production signing or receipt authority.

The next delivery milestone should add distribution metadata and one runtime adapter without weakening the evidence-only default.

## License

Traceknot is licensed under the [MIT License](LICENSE).
