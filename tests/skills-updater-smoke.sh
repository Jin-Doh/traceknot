#!/bin/sh
# Skills CLI update bridge: scope, delay boundary, verification, and delegation smoke scenarios.

set -eu

ROOT=$(CDPATH='' cd -P "$(dirname "$0")/.." && pwd)
UPDATER=$ROOT/bin/traceknot-skills-update
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-skills-updater.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

REAL_HOME=$TMP_DIR/home
FAKE_BIN=$TMP_DIR/bin
FIXTURE=$TMP_DIR/fixture
SOURCE_SKILL=$TMP_DIR/source-skill
CRONTAB_FILE=$TMP_DIR/crontab
NPX_LOG=$TMP_DIR/npx.log
NPX_COUNT=$TMP_DIR/npx-count
mkdir -p "$REAL_HOME" "$FAKE_BIN" "$FIXTURE" "$SOURCE_SKILL/bin"
: > "$NPX_LOG"
printf '%s\n' 0 > "$NPX_COUNT"

VERSION=1.2.3
TAG=v$VERSION
SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567
FAKE_NOW=$(date -u '+%s')
ARCHIVE_NAME=traceknot-v$VERSION.tar.gz

cat > "$SOURCE_SKILL/SKILL.md" <<'EOF_SKILL'
---
name: traceknot
---
# Traceknot fixture
EOF_SKILL
cat > "$SOURCE_SKILL/bin/traceknot" <<'EOF_RUNTIME'
#!/bin/sh
case "${1:-}" in
    self-check) exit 0 ;;
    *) exit 64 ;;
esac
EOF_RUNTIME
cp "$UPDATER" "$SOURCE_SKILL/bin/traceknot-skills-update"
chmod +x "$SOURCE_SKILL/bin/traceknot" "$SOURCE_SKILL/bin/traceknot-skills-update"

STAGE=$TMP_DIR/stage/traceknot-v$VERSION
mkdir -p "$STAGE"
cp -R "$SOURCE_SKILL" "$STAGE/skill"
tar -czf "$FIXTURE/$ARCHIVE_NAME" -C "$TMP_DIR/stage" "traceknot-v$VERSION"
if command -v sha256sum >/dev/null 2>&1; then
    ARTIFACT_SHA=$(sha256sum "$FIXTURE/$ARCHIVE_NAME" | cut -d ' ' -f 1)
else
    ARTIFACT_SHA=$(shasum -a 256 "$FIXTURE/$ARCHIVE_NAME" | cut -d ' ' -f 1)
fi
ARTIFACT_SIZE=$(wc -c < "$FIXTURE/$ARCHIVE_NAME" | tr -d ' ')
PUBLISHED_AT=$(jq -nr --argjson epoch "$((FAKE_NOW - 1209600))" '$epoch | todateiso8601')
jq -n \
    --arg version "$VERSION" \
    --arg tag "$TAG" \
    --arg commit "$SOURCE_COMMIT" \
    --arg published "$PUBLISHED_AT" \
    --arg name "$ARCHIVE_NAME" \
    --arg sha "$ARTIFACT_SHA" \
    --argjson size "$ARTIFACT_SIZE" \
    '{schemaVersion:"traceknot-update-manifest/v1",version:$version,releaseTag:$tag,sourceRepository:"Jin-Doh/traceknot",sourceCommit:$commit,publishedAt:$published,artifact:{name:$name,size:$size,sha256:$sha}}' \
    > "$FIXTURE/manifest.json"
cat > "$FIXTURE/releases.json" <<EOF_RELEASES
[
  {
    "tag_name": "$TAG",
    "published_at": "$PUBLISHED_AT",
    "draft": false,
    "prerelease": false,
    "immutable": true,
    "assets": [
      {"name": "traceknot-update-manifest.json", "url": "https://api.github.com/repos/Jin-Doh/traceknot/releases/assets/manifest"},
      {"name": "$ARCHIVE_NAME", "url": "https://api.github.com/repos/Jin-Doh/traceknot/releases/assets/artifact"}
    ]
  }
]
EOF_RELEASES

cat > "$FAKE_BIN/curl" <<'EOF_CURL'
#!/bin/sh
set -eu
headers=
output=
url=
while [ "$#" -gt 0 ]; do
    case "$1" in
        -D) headers=$2; shift 2 ;;
        -o) output=$2; shift 2 ;;
        -H) shift 2 ;;
        --proto|--proto-redir) shift 2 ;;
        --tlsv1.2|--fail|--silent|--show-error|--location) shift ;;
        *) url=$1; shift ;;
    esac
done
if [ -n "$headers" ]; then
    printf 'HTTP/2 200\r\ndate: %s\r\n\r\n' "$FAKE_HTTP_DATE" > "$headers"
fi
case "$url" in
    */releases\?*) cp "$FAKE_FIXTURE/releases.json" "$output" ;;
    */assets/manifest) cp "$FAKE_FIXTURE/manifest.json" "$output" ;;
    */assets/artifact) cp "$FAKE_FIXTURE/$FAKE_ARCHIVE_NAME" "$output" ;;
    *) printf 'unexpected URL: %s\n' "$url" >&2; exit 2 ;;
esac
EOF_CURL
chmod +x "$FAKE_BIN/curl"

cat > "$FAKE_BIN/gh" <<'EOF_GH'
#!/bin/sh
set -eu
[ "$1" = attestation ]
[ "$2" = verify ]
case " $* " in *" --repo Jin-Doh/traceknot "*) ;; *) exit 2 ;; esac
case " $* " in *" --signer-workflow Jin-Doh/traceknot/.github/workflows/release.yml "*) ;; *) exit 2 ;; esac
case " $* " in *" --source-ref refs/tags/v1.2.3 "*) ;; *) exit 2 ;; esac
case " $* " in *" --source-digest 0123456789abcdef0123456789abcdef01234567 "*) ;; *) exit 2 ;; esac
case " $* " in *" --deny-self-hosted-runners "*) ;; *) exit 2 ;; esac
exit 0
EOF_GH
chmod +x "$FAKE_BIN/gh"

cat > "$FAKE_BIN/crontab" <<'EOF_CRONTAB'
#!/bin/sh
set -eu
case "${1:-}" in
    -l) [ -f "$CRONTAB_FILE" ] && cat "$CRONTAB_FILE" || { printf '%s\n' 'no crontab for traceknot-smoke' >&2; exit 1; } ;;
    -) cat > "$CRONTAB_FILE" ;;
    *) exit 2 ;;
esac
EOF_CRONTAB
chmod +x "$FAKE_BIN/crontab"

cat > "$FAKE_BIN/npx" <<'EOF_NPX'
#!/bin/sh
set -eu
count=$(cat "$NPX_COUNT")
count=$((count + 1))
printf '%s\n' "$count" > "$NPX_COUNT"
printf '%s\t%s\t%s\n' "$count" "$PWD" "$*" >> "$NPX_LOG"

[ "$1" = --yes ]
[ "$2" = "skills@$EXPECTED_SKILLS_CLI_VERSION" ]
[ "$3" = add ]
[ "$4" = "Jin-Doh/traceknot#$EXPECTED_SOURCE_COMMIT" ]
case " $* " in *" --skill traceknot "*) ;; *) exit 2 ;; esac
case " $* " in *" --agent codex "*) ;; *) exit 2 ;; esac
case " $* " in *" --yes "*) ;; *) exit 2 ;; esac

is_global=0
case " $* " in *" --global "*) is_global=1 ;; esac
if [ "$is_global" -eq 1 ]; then
    target=$HOME/.agents/skills/traceknot
    state_home=${XDG_STATE_HOME:-$HOME/.agents}
    if [ -n "${XDG_STATE_HOME:-}" ]; then
        lock=$state_home/skills/.skill-lock.json
    else
        lock=$HOME/.agents/.skill-lock.json
    fi
else
    target=$PWD/.agents/skills/traceknot
    lock=$PWD/skills-lock.json
fi

rm -rf "$target"
mkdir -p "$(dirname "$target")"
cp -R "$FAKE_SOURCE_SKILL" "$target"
if [ "${FAKE_TAMPER_PREFLIGHT:-0}" -eq 1 ] && [ "$HOME" != "$REAL_HOME" ]; then
    printf '%s\n' '# tampered preflight payload' >> "$target/SKILL.md"
fi
mkdir -p "$(dirname "$lock")"
if [ "$is_global" -eq 1 ]; then
    jq -n --arg commit "$EXPECTED_SOURCE_COMMIT" '{version:3,skills:{traceknot:{source:"Jin-Doh/traceknot",sourceType:"github",sourceUrl:"https://github.com/Jin-Doh/traceknot.git",ref:$commit,skillPath:"skill/SKILL.md",skillFolderHash:"fixture",installedAt:"2026-08-21T00:00:00.000Z",updatedAt:"2026-08-21T00:00:00.000Z"}}}' > "$lock"
else
    jq -n --arg commit "$EXPECTED_SOURCE_COMMIT" '{version:1,skills:{traceknot:{source:"Jin-Doh/traceknot",sourceType:"github",ref:$commit,skillPath:"skill/SKILL.md",computedHash:"fixture"}}}' > "$lock"
fi
EOF_NPX
chmod +x "$FAKE_BIN/npx"

install_initial_skill() {
    destination=$1
    mkdir -p "$destination/bin"
    cp "$UPDATER" "$destination/bin/traceknot-skills-update"
    cp "$SOURCE_SKILL/bin/traceknot" "$destination/bin/traceknot"
    printf '%s\n' '# initial Traceknot fixture' > "$destination/SKILL.md"
    chmod +x "$destination/bin/traceknot" "$destination/bin/traceknot-skills-update"
}

write_initial_lock() {
    lock=$1
    mkdir -p "$(dirname "$lock")"
    jq -n '{version:1,skills:{traceknot:{source:"Jin-Doh/traceknot",sourceType:"github",ref:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",skillPath:"skill/SKILL.md",computedHash:"initial"}}}' > "$lock"
}

manifest_sha() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$FIXTURE/manifest.json" | cut -d ' ' -f 1
    else
        shasum -a 256 "$FIXTURE/manifest.json" | cut -d ' ' -f 1
    fi
}

set_http_time() {
    FAKE_HTTP_DATE=$(jq -nr --argjson epoch "$FAKE_NOW" '$epoch | strftime("%a, %d %b %Y %H:%M:%S GMT")')
    export FAKE_HTTP_DATE
}

FAKE_FIXTURE=$FIXTURE
FAKE_ARCHIVE_NAME=$ARCHIVE_NAME
FAKE_SOURCE_SKILL=$SOURCE_SKILL
EXPECTED_SOURCE_COMMIT=$SOURCE_COMMIT
EXPECTED_SKILLS_CLI_VERSION=$(sed -n 's/^SKILLS_CLI_VERSION=//p' "$UPDATER")
PATH=$FAKE_BIN:$PATH
export REAL_HOME FAKE_FIXTURE FAKE_ARCHIVE_NAME FAKE_SOURCE_SKILL EXPECTED_SOURCE_COMMIT
export EXPECTED_SKILLS_CLI_VERSION CRONTAB_FILE NPX_LOG NPX_COUNT PATH HOME
HOME=$REAL_HOME
set_http_time

# The pinned runtime package must stay aligned with the repository dependency.
if [ -f "$ROOT/package.json" ]; then
    test "$EXPECTED_SKILLS_CLI_VERSION" = "$(jq -r '.devDependencies.skills' "$ROOT/package.json")"
fi

# Global registration: opt-in scheduling, strict seven-day boundary, exact-commit apply.
GLOBAL_SKILL=$HOME/.agents/skills/traceknot
install_initial_skill "$GLOBAL_SKILL"
write_initial_lock "$HOME/.agents/.skill-lock.json"
"$GLOBAL_SKILL/bin/traceknot-skills-update" enable --global >/dev/null
grep -F "# traceknot-skills-auto-update:global:$GLOBAL_SKILL" "$CRONTAB_FILE" >/dev/null
grep -F -- "--global --auto" "$CRONTAB_FILE" >/dev/null

first_output=$("$GLOBAL_SKILL/bin/traceknot-skills-update" check --global)
printf '%s\n' "$first_output" | grep -F 'No release has exceeded' >/dev/null
GLOBAL_STATE=$HOME/.local/state/traceknot/skills-update-global
MANIFEST_SHA=$(manifest_sha)
printf '%s\t%s\t%s\t%s\n' "$MANIFEST_SHA" "$((FAKE_NOW - 604800))" "$TAG" "$ARTIFACT_SHA" > "$GLOBAL_STATE/observations.tsv"
boundary_output=$("$GLOBAL_SKILL/bin/traceknot-skills-update" check --global)
printf '%s\n' "$boundary_output" | grep -F 'No release has exceeded' >/dev/null

FAKE_NOW=$((FAKE_NOW + 1))
set_http_time
eligible_output=$("$GLOBAL_SKILL/bin/traceknot-skills-update" check --global)
printf '%s\n' "$eligible_output" | grep -F "Eligible update: $TAG" >/dev/null
"$GLOBAL_SKILL/bin/traceknot-skills-update" apply --global >/dev/null
test "$(cat "$NPX_COUNT")" -eq 2
test "$(grep -c "Jin-Doh/traceknot#$SOURCE_COMMIT" "$NPX_LOG")" -eq 2
grep -F 'Traceknot fixture' "$GLOBAL_SKILL/SKILL.md" >/dev/null
jq -e --arg commit "$SOURCE_COMMIT" '.skills.traceknot.ref == $commit' "$HOME/.agents/.skill-lock.json" >/dev/null
jq -e --arg commit "$SOURCE_COMMIT" '.sourceCommit == $commit and .scope == "global"' "$GLOBAL_STATE/active.json" >/dev/null
"$GLOBAL_SKILL/bin/traceknot-skills-update" status --global | grep -F "sourceCommit=$SOURCE_COMMIT" >/dev/null
before_auto=$(cat "$NPX_COUNT")
"$GLOBAL_SKILL/bin/traceknot-skills-update" --global --auto >/dev/null
test "$(cat "$NPX_COUNT")" -eq "$before_auto"

# A manual Skills CLI ref change invalidates managed state and blocks overwrite.
GLOBAL_LOCK=$HOME/.agents/.skill-lock.json
cp "$GLOBAL_LOCK" "$TMP_DIR/global-lock.saved"
jq '.skills.traceknot.ref = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' "$GLOBAL_LOCK" > "$GLOBAL_LOCK.tmp"
mv "$GLOBAL_LOCK.tmp" "$GLOBAL_LOCK"
if "$GLOBAL_SKILL/bin/traceknot-skills-update" check --global >/dev/null 2>&1; then
    printf '%s\n' 'externally changed Skills lock was not rejected' >&2
    exit 1
fi
test "$(cat "$NPX_COUNT")" -eq "$before_auto"
mv "$TMP_DIR/global-lock.saved" "$GLOBAL_LOCK"

# Project registration uses project-owned state and lock while preserving the same policy.
PROJECT="$TMP_DIR/project with space"
PROJECT_SKILL=$PROJECT/.agents/skills/traceknot
mkdir -p "$PROJECT"
install_initial_skill "$PROJECT_SKILL"
write_initial_lock "$PROJECT/skills-lock.json"
"$PROJECT_SKILL/bin/traceknot-skills-update" enable --project "$PROJECT" >/dev/null
grep -F "# traceknot-skills-auto-update:project:$PROJECT" "$CRONTAB_FILE" >/dev/null
grep -F -- "--project '$PROJECT' --auto" "$CRONTAB_FILE" >/dev/null
"$PROJECT_SKILL/bin/traceknot-skills-update" check --project "$PROJECT" >/dev/null
PROJECT_STATE=$PROJECT/.agents/.traceknot-update
printf '%s\t%s\t%s\t%s\n' "$MANIFEST_SHA" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" > "$PROJECT_STATE/observations.tsv"
"$PROJECT_SKILL/bin/traceknot-skills-update" apply --project "$PROJECT" >/dev/null
test "$(cat "$NPX_COUNT")" -eq 4
jq -e --arg commit "$SOURCE_COMMIT" '.skills.traceknot.ref == $commit' "$PROJECT/skills-lock.json" >/dev/null
jq -e --arg root "$PROJECT_SKILL" '.scope == "project" and .registration == $root' "$PROJECT_STATE/active.json" >/dev/null

# A preflight mismatch fails before the canonical Skills registration is changed.
TAMPER_PROJECT="$TMP_DIR/tamper project"
TAMPER_SKILL=$TAMPER_PROJECT/.agents/skills/traceknot
mkdir -p "$TAMPER_PROJECT"
install_initial_skill "$TAMPER_SKILL"
write_initial_lock "$TAMPER_PROJECT/skills-lock.json"
"$TAMPER_SKILL/bin/traceknot-skills-update" check --project "$TAMPER_PROJECT" >/dev/null
TAMPER_STATE=$TAMPER_PROJECT/.agents/.traceknot-update
printf '%s\t%s\t%s\t%s\n' "$MANIFEST_SHA" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" > "$TAMPER_STATE/observations.tsv"
before_tamper=$(cat "$NPX_COUNT")
FAKE_TAMPER_PREFLIGHT=1
export FAKE_TAMPER_PREFLIGHT
if "$TAMPER_SKILL/bin/traceknot-skills-update" apply --project "$TAMPER_PROJECT" >/dev/null 2>&1; then
    printf '%s\n' 'tampered preflight unexpectedly applied' >&2
    exit 1
fi
unset FAKE_TAMPER_PREFLIGHT
test "$(cat "$NPX_COUNT")" -eq $((before_tamper + 1))
grep -F 'initial Traceknot fixture' "$TAMPER_SKILL/SKILL.md" >/dev/null
jq -e '.skills.traceknot.ref == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' "$TAMPER_PROJECT/skills-lock.json" >/dev/null

# Disable removes only this updater's schedules and persists opt-out.
"$GLOBAL_SKILL/bin/traceknot-skills-update" disable --global >/dev/null
if grep -F "# traceknot-skills-auto-update:global:$GLOBAL_SKILL" "$CRONTAB_FILE" >/dev/null 2>&1; then
    printf '%s\n' 'global automatic-update schedule remained after disable' >&2
    exit 1
fi
test "$(sed -n 's/^automatic=//p' "$GLOBAL_STATE/config")" = 0

printf '%s\n' 'Skills updater smoke test: PASS'
