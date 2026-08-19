#!/bin/sh
# Compatibility coverage for installing Traceknot through the Skills CLI.

set -eu

ROOT=$(CDPATH='' cd -P "$(dirname "$0")/.." && pwd)
SKILLS_CLI=$ROOT/node_modules/.bin/skills
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-skills-cli.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

[ -x "$SKILLS_CLI" ] || {
    printf '%s\n' 'skills-cli smoke: run bun install first' >&2
    exit 2
}

HOME=$TMP_DIR/home
PROJECT=$TMP_DIR/project
FIXTURE_REPO=$TMP_DIR/source
UPDATE_FIXTURE_REF=v0.2.0
mkdir -p "$HOME" "$PROJECT" "$FIXTURE_REPO"
cp -R "$ROOT/skill" "$FIXTURE_REPO/skill"
git -C "$FIXTURE_REPO" init -q
git -C "$FIXTURE_REPO" add skill
git -C "$FIXTURE_REPO" -c user.name=Traceknot -c user.email=ci@traceknot.invalid \
    commit -qm 'Skills CLI fixture'
git -C "$FIXTURE_REPO" tag "$UPDATE_FIXTURE_REF"

# Exercise the GitHub shorthand, source metadata, and update path against an
# immutable public ref. Git rewrites bind the initial clone to this test snapshot.
GIT_CONFIG_COUNT=2
GIT_CONFIG_KEY_0="url.file://$FIXTURE_REPO/.insteadOf"
GIT_CONFIG_VALUE_0=https://github.com/Jin-Doh/traceknot.git
GIT_CONFIG_KEY_1="url.file://$FIXTURE_REPO/.insteadOf"
GIT_CONFIG_VALUE_1=https://fixture.invalid/Jin-Doh/traceknot.git
export HOME UPDATE_FIXTURE_REF GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
export GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_1

# The public recommendation installs one self-contained global Skill for Codex.
"$SKILLS_CLI" add "Jin-Doh/traceknot#$UPDATE_FIXTURE_REF" \
    --skill traceknot \
    --agent codex \
    --global \
    --yes >/dev/null

GLOBAL_SKILL=$HOME/.agents/skills/traceknot
test -f "$GLOBAL_SKILL/SKILL.md"
for reference in \
    adversarial-risk-discovery.md \
    completion-report.md \
    defect-lifecycle.md \
    istqb-principles.md \
    qa-board.md \
    prose-quality.md \
    proof-carrying-success.md \
    risk-classification.md \
    test-process.md \
    test-techniques.md \
    traceability.md
do
    test -f "$GLOBAL_SKILL/references/$reference"
done
grep -F '[Proof-carrying success](references/proof-carrying-success.md)' \
    "$GLOBAL_SKILL/SKILL.md" >/dev/null
test -f "$GLOBAL_SKILL/references/proof-carrying-success.md"

# Skills CLI installs the complete self-contained Skill payload.
test -x "$GLOBAL_SKILL/bin/traceknot"
"$GLOBAL_SKILL/bin/traceknot" verify --help >/dev/null
"$GLOBAL_SKILL/bin/traceknot" board update --help >/dev/null
"$GLOBAL_SKILL/bin/traceknot" storage --help >/dev/null
"$GLOBAL_SKILL/bin/traceknot" self-check >/dev/null
for contract in "$ROOT"/contracts/*.schema.json
do
    test -f "$GLOBAL_SKILL/contracts/$(basename "$contract")"
done
for capability in "$ROOT"/adapters/*/capability.json
do
    host=$(basename "$(dirname "$capability")")
    test -f "$GLOBAL_SKILL/adapters/$host/capability.json"
done

# Exercise the globally installed runtime through two real agent-session updates.
BOARD_STATE=$TMP_DIR/board-state
BOARD_INPUT_1=$TMP_DIR/board-update-1.json
BOARD_INPUT_2=$TMP_DIR/board-update-2.json
mkdir -p "$BOARD_STATE"
export BOARD_STATE BOARD_INPUT_1 BOARD_INPUT_2
bun -e '
  const makeUpdate = revision => ({
    schemaVersion: "traceknot-session-board-update/v1",
    sessionId: "raw-session-id",
    sessionHost: "omp",
    generatedAt: `2026-08-18T00:00:0${revision}Z`,
    invocationId: `inv-${revision}`,
    view: {
      runId: "run-1",
      requestId: "request-1",
      rootIdentity: "root-1",
      snapshotId: "snapshot-1",
      revision,
      sourceState: "TERMINAL",
      sourceUpdatedAt: `2026-08-18T00:00:0${revision}Z`,
      changeSummary: `installed Skill session update ${revision}`,
      assurance: {
        context: "release",
        requiredIndependence: "separate-verification-context",
        releaseStatus: "satisfied",
      },
      verdict: "PASS",
      authoritative: false,
      rationale: "installed Skill E2E",
      counts: { mandatory: 0, passed: 0, failed: 0, blocked: 0, incomplete: 0 },
      findings: [],
      coverage: {
        basis: { total: 0, covered: 0, uncoveredIds: [] },
        risks: { total: 0, covered: 0, uncoveredIds: [] },
        conditions: { total: 0, covered: 0, uncoveredIds: [] },
        mandatoryObligations: { total: 0, covered: 0, uncoveredIds: [] },
      },
      openDefectIds: [],
      acceptedRiskIds: [],
      residualRisks: [],
    },
  });
  await Bun.write(process.env.BOARD_INPUT_1, `${JSON.stringify(makeUpdate(1))}\n`);
  await Bun.write(process.env.BOARD_INPUT_2, `${JSON.stringify(makeUpdate(2))}\n`);
'
BOARD_OUTPUT_1=$("$GLOBAL_SKILL/bin/traceknot" board update \
    --input "$BOARD_INPUT_1" --state-dir "$BOARD_STATE" --no-notify 2>&1)
BOARD_OUTPUT_2=$("$GLOBAL_SKILL/bin/traceknot" board update \
    --input "$BOARD_INPUT_2" --state-dir "$BOARD_STATE" --no-notify 2>&1)
case "$BOARD_OUTPUT_1" in
    "Traceknot Board: file://"*) ;;
    *) printf '%s\n' "unexpected first Board output: $BOARD_OUTPUT_1" >&2; exit 1 ;;
esac
case "$BOARD_OUTPUT_2" in
    "Traceknot Board: file://"*) ;;
    *) printf '%s\n' "unexpected second Board output: $BOARD_OUTPUT_2" >&2; exit 1 ;;
esac
BOARD_URI_1=${BOARD_OUTPUT_1#Traceknot Board: }
BOARD_URI_2=${BOARD_OUTPUT_2#Traceknot Board: }
test "$BOARD_URI_1" = "$BOARD_URI_2"
BOARD_URI=$BOARD_URI_2
export BOARD_URI
bun -e '
  import { lstat, readdir, readFile } from "node:fs/promises";
  import { dirname, join } from "node:path";
  import { fileURLToPath } from "node:url";
  const entrypoint = fileURLToPath(process.env.BOARD_URI);
  const sessionRoot = dirname(entrypoint);
  const current = JSON.parse(await readFile(join(sessionRoot, "current.json"), "utf8"));
  if (current.sourceRevision !== 2) process.exit(1);
  if ((await readdir(join(sessionRoot, "boards"))).length !== 2) process.exit(1);
  const pending = [process.env.BOARD_STATE];
  while (pending.length > 0) {
    const path = pending.pop();
    const info = await lstat(path);
    if (info.isDirectory()) {
      for (const name of await readdir(path)) pending.push(join(path, name));
    } else if (info.isFile() && (await readFile(path, "utf8")).includes("raw-session-id")) {
      process.exit(1);
    }
  }
'

LOCK_FILE=$HOME/.agents/.skill-lock.json
export LOCK_FILE
bun -e '
  const lock = JSON.parse(await Bun.file(process.env.LOCK_FILE).text());
  const skill = lock.skills?.traceknot;
  if (skill?.source !== "Jin-Doh/traceknot" ||
      skill?.sourceType !== "github" ||
      skill?.ref !== process.env.UPDATE_FIXTURE_REF ||
      skill?.skillPath !== "skill/SKILL.md" ||
      typeof skill?.skillFolderHash !== "string" ||
      skill.skillFolderHash.length === 0) {
    process.exit(1);
  }
'

GLOBAL_LIST=$("$SKILLS_CLI" list --global)
printf '%s\n' "$GLOBAL_LIST" | grep -F traceknot >/dev/null
"$SKILLS_CLI" update traceknot --global --yes >/dev/null
test -x "$GLOBAL_SKILL/bin/traceknot"
"$GLOBAL_SKILL/bin/traceknot" verify --help >/dev/null
"$GLOBAL_SKILL/bin/traceknot" board update --help >/dev/null
"$GLOBAL_SKILL/bin/traceknot" storage --help >/dev/null
"$GLOBAL_SKILL/bin/traceknot" self-check >/dev/null
for contract in "$ROOT"/contracts/*.schema.json
do
    test -f "$GLOBAL_SKILL/contracts/$(basename "$contract")"
done
for capability in "$ROOT"/adapters/*/capability.json
do
    host=$(basename "$(dirname "$capability")")
    test -f "$GLOBAL_SKILL/adapters/$host/capability.json"
done
"$SKILLS_CLI" remove traceknot --global --yes >/dev/null
test ! -e "$GLOBAL_SKILL"

# A custom-host Git source exercises replacement after its Skill folder changes.
GH_HOST=fixture.invalid
export GH_HOST
"$SKILLS_CLI" add "$GIT_CONFIG_VALUE_1" \
    --skill traceknot \
    --agent codex \
    --global \
    --yes >/dev/null
printf '\n// skills-update-fixture-v2\n' >> "$FIXTURE_REPO/skill/bin/traceknot"
git -C "$FIXTURE_REPO" add skill/bin/traceknot
git -C "$FIXTURE_REPO" -c user.name=Traceknot -c user.email=ci@traceknot.invalid \
    commit -qm 'Update bundled runtime fixture'
"$SKILLS_CLI" update traceknot --global --yes >/dev/null
grep -F 'skills-update-fixture-v2' "$GLOBAL_SKILL/bin/traceknot" >/dev/null
"$GLOBAL_SKILL/bin/traceknot" verify --help >/dev/null
"$GLOBAL_SKILL/bin/traceknot" board update --help >/dev/null
"$GLOBAL_SKILL/bin/traceknot" storage --help >/dev/null
"$GLOBAL_SKILL/bin/traceknot" self-check >/dev/null
"$SKILLS_CLI" remove traceknot --global --yes >/dev/null
test ! -e "$GLOBAL_SKILL"

# Omitting --global keeps the same Skill inside the current project.
(
    cd "$PROJECT"
    "$SKILLS_CLI" add "$ROOT" \
        --skill traceknot \
        --agent codex \
        --yes >/dev/null
    "$SKILLS_CLI" update traceknot --yes >/dev/null
    test -f "$PROJECT/.agents/skills/traceknot/SKILL.md"
    grep -F '[Proof-carrying success](references/proof-carrying-success.md)' \
        "$PROJECT/.agents/skills/traceknot/SKILL.md" >/dev/null
    test -f "$PROJECT/.agents/skills/traceknot/references/proof-carrying-success.md"
    test -x "$PROJECT/.agents/skills/traceknot/bin/traceknot"
    "$PROJECT/.agents/skills/traceknot/bin/traceknot" verify --help >/dev/null
    "$PROJECT/.agents/skills/traceknot/bin/traceknot" board update --help >/dev/null
    "$PROJECT/.agents/skills/traceknot/bin/traceknot" storage --help >/dev/null
    "$PROJECT/.agents/skills/traceknot/bin/traceknot" self-check >/dev/null
    for contract in "$ROOT"/contracts/*.schema.json
    do
        test -f "$PROJECT/.agents/skills/traceknot/contracts/$(basename "$contract")"
    done
    for capability in "$ROOT"/adapters/*/capability.json
    do
        host=$(basename "$(dirname "$capability")")
        test -f "$PROJECT/.agents/skills/traceknot/adapters/$host/capability.json"
    done
    "$SKILLS_CLI" remove traceknot --yes >/dev/null
)
test ! -e "$PROJECT/.agents/skills/traceknot"

printf '%s\n' 'Skills CLI smoke test: PASS'
