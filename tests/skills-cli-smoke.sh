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
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0="url.file://$FIXTURE_REPO/.insteadOf"
GIT_CONFIG_VALUE_0=https://github.com/Jin-Doh/traceknot.git
export HOME UPDATE_FIXTURE_REF GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0

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
    prose-quality.md \
    proof-carrying-success.md \
    qa-board.md \
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

# Skills CLI installation is intentionally Skill-only, not the full toolkit.
test ! -e "$GLOBAL_SKILL/contracts"
test ! -e "$GLOBAL_SKILL/adapters"
test ! -e "$GLOBAL_SKILL/system"
test ! -e "$GLOBAL_SKILL/bin"

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
"$SKILLS_CLI" remove traceknot --global --yes >/dev/null
test ! -e "$GLOBAL_SKILL"

# Omitting --global keeps the same Skill inside the current project.
(
    cd "$PROJECT"
    "$SKILLS_CLI" add "$ROOT" \
        --skill traceknot \
        --agent codex \
        --yes >/dev/null
    test -f "$PROJECT/.agents/skills/traceknot/SKILL.md"
    grep -F '[Proof-carrying success](references/proof-carrying-success.md)' \
        "$PROJECT/.agents/skills/traceknot/SKILL.md" >/dev/null
    test -f "$PROJECT/.agents/skills/traceknot/references/proof-carrying-success.md"
    "$SKILLS_CLI" remove traceknot --yes >/dev/null
)
test ! -e "$PROJECT/.agents/skills/traceknot"

printf '%s\n' 'Skills CLI smoke test: PASS'
