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
LOWER_VERSION=1.1.9
LOWER_TAG=v$LOWER_VERSION
LOWER_SOURCE_COMMIT=abcdefabcdefabcdefabcdefabcdefabcdefabcd
LOWER_ARCHIVE_NAME=traceknot-v$LOWER_VERSION.tar.gz

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
jq -n \
    --arg version "$LOWER_VERSION" \
    --arg tag "$LOWER_TAG" \
    --arg commit "$LOWER_SOURCE_COMMIT" \
    --arg published "$PUBLISHED_AT" \
    --arg name "$LOWER_ARCHIVE_NAME" \
    --arg sha "$ARTIFACT_SHA" \
    --argjson size "$ARTIFACT_SIZE" \
    '{schemaVersion:"traceknot-update-manifest/v1",version:$version,releaseTag:$tag,sourceRepository:"Jin-Doh/traceknot",sourceCommit:$commit,publishedAt:$published,artifact:{name:$name,size:$size,sha256:$sha}}' \
    > "$FIXTURE/manifest-lower.json"
cat > "$FIXTURE/releases.json" <<EOF_RELEASES
[
  {
    "tag_name": "$LOWER_TAG",
    "published_at": "$PUBLISHED_AT",
    "draft": false,
    "prerelease": false,
    "immutable": true,
    "assets": [
      {"name": "traceknot-update-manifest.json", "url": "https://api.github.com/repos/Jin-Doh/traceknot/releases/assets/manifest-lower"},
      {"name": "$LOWER_ARCHIVE_NAME", "url": "https://api.github.com/repos/Jin-Doh/traceknot/releases/assets/artifact-lower"}
    ]
  },
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
        --proto|--proto-redir|--connect-timeout|--max-time) shift 2 ;;
        --tlsv1.2|--fail|--silent|--show-error|--location) shift ;;
        *) url=$1; shift ;;
    esac
done
if [ -n "${FAKE_CURL_SLEEP:-}" ]; then
    sleep "$FAKE_CURL_SLEEP"
fi
if [ -n "$headers" ]; then
    printf 'HTTP/2 200\r\ndate: %s\r\n\r\n' "$FAKE_HTTP_DATE" > "$headers"
fi
case "$url" in
    */releases\?*) cp "$FAKE_FIXTURE/releases.json" "$output" ;;
    */assets/manifest-lower) cp "$FAKE_FIXTURE/manifest-lower.json" "$output" ;;
    */assets/artifact-lower) cp "$FAKE_FIXTURE/$FAKE_ARCHIVE_NAME" "$output" ;;
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
case " $* " in *" --agent universal "*) ;; *) exit 2 ;; esac
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
if [ "${FAKE_TAMPER_APPLY:-0}" -eq 1 ] && [ "$HOME" = "$REAL_HOME" ]; then
    printf '%s\n' '# tampered canonical payload' >> "$target/SKILL.md"
fi
if [ "${FAKE_SYMLINK_APPLY:-0}" -eq 1 ] && [ "$HOME" = "$REAL_HOME" ]; then
    rm -f "$target/SKILL.md"
    ln -s "$FAKE_SYMLINK_TARGET" "$target/SKILL.md"
fi
if [ "${FAKE_INTERRUPT_BEFORE_LOCK:-0}" -eq 1 ] && [ "$HOME" = "$REAL_HOME" ]; then
    kill -TERM "$PPID"
    exit 143
fi
mkdir -p "$(dirname "$lock")"
if [ "$is_global" -eq 1 ]; then
    jq -n --arg commit "$EXPECTED_SOURCE_COMMIT" '{version:3,skills:{traceknot:{source:"Jin-Doh/traceknot",sourceType:"github",sourceUrl:"https://github.com/Jin-Doh/traceknot.git",ref:$commit,skillPath:"skill/SKILL.md",skillFolderHash:"fixture",installedAt:"2026-08-21T00:00:00.000Z",updatedAt:"2026-08-21T00:00:00.000Z"}}}' > "$lock"
else
    jq -n --arg commit "$EXPECTED_SOURCE_COMMIT" '{version:1,skills:{traceknot:{source:"Jin-Doh/traceknot",sourceType:"github",ref:$commit,skillPath:"skill/SKILL.md",computedHash:"fixture"}}}' > "$lock"
fi
if [ "${FAKE_INTERRUPT_AFTER_INSTALL:-0}" -eq 1 ] && [ "$HOME" = "$REAL_HOME" ]; then
    kill -TERM "$PPID"
    exit 143
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
write_unmanaged_lock() {
    lock=$1
    source=$2
    ref=${3-}
    mkdir -p "$(dirname "$lock")"
    if [ -n "$ref" ]; then
        jq -n --arg source "$source" --arg ref "$ref" '{version:1,skills:{traceknot:{source:$source,sourceType:"github",ref:$ref,skillPath:"skill/SKILL.md",computedHash:"initial"}}}' > "$lock"
    else
        jq -n --arg source "$source" '{version:1,skills:{traceknot:{source:$source,sourceType:"github",skillPath:"skill/SKILL.md",computedHash:"initial"}}}' > "$lock"
    fi
}

manifest_sha() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$FIXTURE/manifest.json" | cut -d ' ' -f 1
    else
        shasum -a 256 "$FIXTURE/manifest.json" | cut -d ' ' -f 1
    fi
}

lock_entry_sha() {
    lock=$1
    if command -v sha256sum >/dev/null 2>&1; then
        jq -cS '.skills.traceknot' "$lock" | sha256sum | cut -d ' ' -f 1
    else
        jq -cS '.skills.traceknot' "$lock" | shasum -a 256 | cut -d ' ' -f 1
    fi
}

seed_adoption() {
    state=$1
    lock=$2
    automatic=$3
    adopted_at=$4
    mkdir -p "$state"
    adopted_sha=$(lock_entry_sha "$lock")
    if [ "$state" = "$HOME"/.local/state/traceknot/skills-update-global ]; then
        seed_scope=global
        seed_project_root=
    else
        seed_scope=project
        seed_project_root=${state%/.agents/.traceknot-update}
    fi
    cat > "$state/config" <<EOF_CONFIG
traceknot-skills-update-config/v1
automatic=$automatic
lastCheck=0
scope=$seed_scope
projectRoot=$seed_project_root
adoptedAt=$adopted_at
adoptedLockSha256=$adopted_sha
EOF_CONFIG
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

# Canonical Skills locks may omit ref, retain a symbolic ref, and preserve source casing.
for lock_ref in '' main; do
    COMPAT_PROJECT="$TMP_DIR/compat-${lock_ref:-none}"
    mkdir -p "$COMPAT_PROJECT"
    COMPAT_SKILL=$COMPAT_PROJECT/.agents/skills/traceknot
    install_initial_skill "$COMPAT_SKILL"
    write_unmanaged_lock "$COMPAT_PROJECT/skills-lock.json" 'jin-doh/traceknot' "$lock_ref"
    "$COMPAT_SKILL/bin/traceknot-skills-update" status --project "$COMPAT_PROJECT" >/dev/null
    "$COMPAT_SKILL/bin/traceknot-skills-update" check --project "$COMPAT_PROJECT" >/dev/null
done

# A fresh unmanaged registration adopts its current lock as a no-downgrade baseline.
BASELINE_PROJECT="$TMP_DIR/baseline project"
BASELINE_SKILL=$BASELINE_PROJECT/.agents/skills/traceknot
mkdir -p "$BASELINE_PROJECT"
install_initial_skill "$BASELINE_SKILL"
write_initial_lock "$BASELINE_PROJECT/skills-lock.json"
baseline_output=$("$BASELINE_SKILL/bin/traceknot-skills-update" check --project "$BASELINE_PROJECT")
printf '%s\n' "$baseline_output" | grep -F 'Recorded unmanaged installation baseline' >/dev/null
BASELINE_STATE=$BASELINE_PROJECT/.agents/.traceknot-update
test "$(sed -n 's/^adoptedAt=//p' "$BASELINE_STATE/config")" = "$FAKE_NOW"
test "$(sed -n 's/^adoptedLockSha256=//p' "$BASELINE_STATE/config")" = "$(lock_entry_sha "$BASELINE_PROJECT/skills-lock.json")"
test "$(cat "$NPX_COUNT")" -eq 0
second_baseline_output=$("$BASELINE_SKILL/bin/traceknot-skills-update" check --project "$BASELINE_PROJECT")
printf '%s\n' "$second_baseline_output" | grep -F 'No release published after the unmanaged installation baseline' >/dev/null
test "$(cat "$NPX_COUNT")" -eq 0
sleep 30 &
STALE_PID=$!
printf '%s\n%s\n' "$STALE_PID" stale-process-identity > "$BASELINE_STATE/update.lock"
"$BASELINE_SKILL/bin/traceknot-skills-update" status --project "$BASELINE_PROJECT" >/dev/null
kill "$STALE_PID" 2>/dev/null || true
test ! -e "$BASELINE_STATE/update.lock"
FLOCK_BIN=$TMP_DIR/flock-bin
mkdir -p "$FLOCK_BIN"
cat > "$FLOCK_BIN/flock" <<'EOF_FLOCK'
#!/bin/sh
case "${1:-}" in
    -n) exit 0 ;;
    *) exit 2 ;;
esac
EOF_FLOCK
chmod +x "$FLOCK_BIN/flock"
sleep 30 &
FLOCK_STALE_PID=$!
printf '%s\n%s\n' "$FLOCK_STALE_PID" stale-process-identity > "$BASELINE_STATE/update.lock"
: > "$BASELINE_STATE/update.lock-recovery"
PATH=$FLOCK_BIN:$PATH "$BASELINE_SKILL/bin/traceknot-skills-update" status --project "$BASELINE_PROJECT" >/dev/null
kill "$FLOCK_STALE_PID" 2>/dev/null || true
test ! -e "$BASELINE_STATE/update.lock-recovery"
mkdir "$BASELINE_STATE/pending-payload"
"$BASELINE_SKILL/bin/traceknot-skills-update" status --project "$BASELINE_PROJECT" >/dev/null
test ! -e "$BASELINE_STATE/pending-payload"
cp "$BASELINE_PROJECT/skills-lock.json" "$TMP_DIR/baseline-lock.saved"
jq '.skills.traceknot.computedHash = "external-change"' "$BASELINE_PROJECT/skills-lock.json" > "$BASELINE_PROJECT/skills-lock.json.tmp"
mv "$BASELINE_PROJECT/skills-lock.json.tmp" "$BASELINE_PROJECT/skills-lock.json"
if "$BASELINE_SKILL/bin/traceknot-skills-update" check --project "$BASELINE_PROJECT" >/dev/null 2>&1; then
    printf '%s\n' 'changed unmanaged baseline lock was not rejected' >&2
    exit 1
fi
mv "$TMP_DIR/baseline-lock.saved" "$BASELINE_PROJECT/skills-lock.json"

# Unmanaged scheduled execution may observe, but only explicit apply may adopt a pre-baseline release.
ADOPTION_PROJECT="$TMP_DIR/manual adoption project"
mkdir -p "$ADOPTION_PROJECT"
ADOPTION_SKILL=$ADOPTION_PROJECT/.agents/skills/traceknot
install_initial_skill "$ADOPTION_SKILL"
write_unmanaged_lock "$ADOPTION_PROJECT/skills-lock.json" 'jin-doh/traceknot'
ADOPTION_STATE=$ADOPTION_PROJECT/.agents/.traceknot-update
seed_adoption "$ADOPTION_STATE" "$ADOPTION_PROJECT/skills-lock.json" 1 "$FAKE_NOW"
printf '%s\t%s\t%s\t%s\n' "$(manifest_sha)" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" > "$ADOPTION_STATE/observations.tsv"
before_adoption=$(cat "$NPX_COUNT")
auto_adoption_output=$("$ADOPTION_SKILL/bin/traceknot-skills-update" --project "$ADOPTION_PROJECT" --auto)
printf '%s\n' "$auto_adoption_output" | grep -F 'waiting for one-time manual adoption' >/dev/null
test "$(cat "$NPX_COUNT")" -eq "$before_adoption"
"$ADOPTION_SKILL/bin/traceknot-skills-update" apply --project "$ADOPTION_PROJECT" >/dev/null
test "$(cat "$NPX_COUNT")" -eq $((before_adoption + 2))
jq -e '.version == "1.2.3"' "$ADOPTION_STATE/active.json" >/dev/null
# Isolate the existing global lifecycle assertions from this focused adoption scenario.
printf '%s
' 0 > "$NPX_COUNT"
: > "$NPX_LOG"

# The scheduled path has a finite end-to-end operation deadline.
TIMEOUT_PROJECT="$TMP_DIR/timeout project"
mkdir -p "$TIMEOUT_PROJECT"
TIMEOUT_SKILL=$TIMEOUT_PROJECT/.agents/skills/traceknot
install_initial_skill "$TIMEOUT_SKILL"
write_unmanaged_lock "$TIMEOUT_PROJECT/skills-lock.json" 'jin-doh/traceknot' main
TIMEOUT_STATE=$TIMEOUT_PROJECT/.agents/.traceknot-update
seed_adoption "$TIMEOUT_STATE" "$TIMEOUT_PROJECT/skills-lock.json" 1 "$((FAKE_NOW - 1814400))"
START_TIMEOUT=$(date -u '+%s')
if FAKE_CURL_SLEEP=10 TRACEKNOT_UPDATE_OPERATION_TIMEOUT=2     "$TIMEOUT_SKILL/bin/traceknot-skills-update" --project "$TIMEOUT_PROJECT" --auto >/dev/null 2>&1; then
    printf '%s\n' 'bounded automatic check unexpectedly succeeded' >&2
    exit 1
fi
END_TIMEOUT=$(date -u '+%s')
[ "$((END_TIMEOUT - START_TIMEOUT))" -lt 6 ]
test ! -e "$TIMEOUT_STATE/update.lock"

# Global registration: opt-in scheduling, strict seven-day boundary, exact-commit apply.
GLOBAL_SKILL=$HOME/.agents/skills/traceknot
install_initial_skill "$GLOBAL_SKILL"
write_initial_lock "$HOME/.agents/.skill-lock.json"
"$GLOBAL_SKILL/bin/traceknot-skills-update" enable --global >/dev/null
grep -F "# traceknot-skills-auto-update:global:$GLOBAL_SKILL" "$CRONTAB_FILE" >/dev/null
grep -F -- "--global --auto" "$CRONTAB_FILE" >/dev/null
grep -F 'TRACEKNOT_UPDATE_OPERATION_TIMEOUT=900' "$CRONTAB_FILE" >/dev/null
GLOBAL_STATE=$HOME/.local/state/traceknot/skills-update-global
seed_adoption "$GLOBAL_STATE" "$HOME/.agents/.skill-lock.json" 1 "$((FAKE_NOW - 1814400))"

first_output=$("$GLOBAL_SKILL/bin/traceknot-skills-update" check --global)
printf '%s\n' "$first_output" | grep -F 'No release has exceeded' >/dev/null
MANIFEST_SHA=$(manifest_sha)
printf '%s\t%s\t%s\t%s\n' "$MANIFEST_SHA" "$((FAKE_NOW - 604800))" "$TAG" "$ARTIFACT_SHA" > "$GLOBAL_STATE/observations.tsv"
boundary_output=$("$GLOBAL_SKILL/bin/traceknot-skills-update" check --global)
printf '%s\n' "$boundary_output" | grep -F 'No release has exceeded' >/dev/null

FAKE_NOW=$((FAKE_NOW + 1))

# An unmanaged lock matching a newer release must not select an older eligible release.
DOWNGRADE_PROJECT="$TMP_DIR/downgrade project"
mkdir -p "$DOWNGRADE_PROJECT"
DOWNGRADE_PROJECT=$(CDPATH='' cd -P "$DOWNGRADE_PROJECT" && pwd)
DOWNGRADE_SKILL=$DOWNGRADE_PROJECT/.agents/skills/traceknot
install_initial_skill "$DOWNGRADE_SKILL"
write_initial_lock "$DOWNGRADE_PROJECT/skills-lock.json"
jq --arg commit "$SOURCE_COMMIT" '.skills.traceknot.ref = $commit' \
    "$DOWNGRADE_PROJECT/skills-lock.json" > "$DOWNGRADE_PROJECT/skills-lock.json.tmp"
mv "$DOWNGRADE_PROJECT/skills-lock.json.tmp" "$DOWNGRADE_PROJECT/skills-lock.json"
"$DOWNGRADE_SKILL/bin/traceknot-skills-update" status --project "$DOWNGRADE_PROJECT" >/dev/null
DOWNGRADE_STATE=$DOWNGRADE_PROJECT/.agents/.traceknot-update
seed_adoption "$DOWNGRADE_STATE" "$DOWNGRADE_PROJECT/skills-lock.json" 0 "$((FAKE_NOW - 1814400))"
DOWNGRADE_HIGH_SHA=$(manifest_sha)
DOWNGRADE_LOW_SHA=$(sha256sum "$FIXTURE/manifest-lower.json" | cut -d ' ' -f 1)
{
    printf '%s\t%s\t%s\t%s\n' "$DOWNGRADE_LOW_SHA" "$((FAKE_NOW - 1209600))" "$LOWER_TAG" "$ARTIFACT_SHA"
    printf '%s\t%s\t%s\t%s\n' "$DOWNGRADE_HIGH_SHA" "$FAKE_NOW" "$TAG" "$ARTIFACT_SHA"
} > "$DOWNGRADE_STATE/observations.tsv"
downgrade_output=$("$DOWNGRADE_SKILL/bin/traceknot-skills-update" check --project "$DOWNGRADE_PROJECT")
printf '%s\n' "$downgrade_output" | grep -F 'already installed' >/dev/null
if printf '%s\n' "$downgrade_output" | grep -F 'Eligible update:' >/dev/null; then
    printf '%s\n' 'unmanaged matching release allowed a downgrade' >&2
    exit 1
fi
{
    printf '%s\t%s\t%s\t%s\n' "$DOWNGRADE_LOW_SHA" "$((FAKE_NOW - 1209600))" "$LOWER_TAG" "$ARTIFACT_SHA"
    printf '%s\t%s\t%s\t%s\n' "$DOWNGRADE_HIGH_SHA" "$((FAKE_NOW - 1209600))" "$TAG" "$ARTIFACT_SHA"
} > "$DOWNGRADE_STATE/observations.tsv"
downgrade_output=$("$DOWNGRADE_SKILL/bin/traceknot-skills-update" check --project "$DOWNGRADE_PROJECT")
printf '%s\n' "$downgrade_output" | grep -F 'already installed' >/dev/null
if printf '%s\n' "$downgrade_output" | grep -F 'Eligible update:' >/dev/null; then
    printf '%s\n' 'unmanaged matching eligible release allowed a downgrade' >&2
    exit 1
fi
PRE_ADOPTION_PROJECT="$TMP_DIR/pre-adoption project"
mkdir -p "$PRE_ADOPTION_PROJECT"
PRE_ADOPTION_PROJECT=$(CDPATH='' cd -P "$PRE_ADOPTION_PROJECT" && pwd)
PRE_ADOPTION_SKILL=$PRE_ADOPTION_PROJECT/.agents/skills/traceknot
install_initial_skill "$PRE_ADOPTION_SKILL"
write_initial_lock "$PRE_ADOPTION_PROJECT/skills-lock.json"
jq --arg commit "$SOURCE_COMMIT" '.skills.traceknot.ref = $commit' \
    "$PRE_ADOPTION_PROJECT/skills-lock.json" > "$PRE_ADOPTION_PROJECT/skills-lock.json.tmp"
mv "$PRE_ADOPTION_PROJECT/skills-lock.json.tmp" "$PRE_ADOPTION_PROJECT/skills-lock.json"
"$PRE_ADOPTION_SKILL/bin/traceknot-skills-update" status --project "$PRE_ADOPTION_PROJECT" >/dev/null
PRE_ADOPTION_STATE=$PRE_ADOPTION_PROJECT/.agents/.traceknot-update
PRE_ADOPTION_AT=$((FAKE_NOW - 1209600))
seed_adoption "$PRE_ADOPTION_STATE" "$PRE_ADOPTION_PROJECT/skills-lock.json" 0 "$PRE_ADOPTION_AT"
PRE_ADOPTION_LOW_SHA=$(sha256sum "$FIXTURE/manifest-lower.json" | cut -d ' ' -f 1)
cp "$FIXTURE/releases.json" "$TMP_DIR/pre-adoption-releases.saved"
PRE_ADOPTION_RELEASE_AT=$(jq -nr --argjson epoch "$((FAKE_NOW - 1))" '$epoch | todateiso8601')
jq --arg published "$PRE_ADOPTION_RELEASE_AT" '.[0].published_at = $published' \
    "$FIXTURE/releases.json" > "$FIXTURE/releases.json.tmp"
mv "$FIXTURE/releases.json.tmp" "$FIXTURE/releases.json"
printf '%s\t%s\t%s\t%s\n' "$PRE_ADOPTION_LOW_SHA" "$PRE_ADOPTION_AT" "$LOWER_TAG" "$ARTIFACT_SHA" \
    > "$PRE_ADOPTION_STATE/observations.tsv"
set_http_time
pre_adoption_output=$("$PRE_ADOPTION_SKILL/bin/traceknot-skills-update" check --project "$PRE_ADOPTION_PROJECT")
printf '%s\n' "$pre_adoption_output" | grep -F 'already installed' >/dev/null
if printf '%s\n' "$pre_adoption_output" | grep -F 'Eligible update:' >/dev/null; then
    printf '%s\n' 'pre-adoption matching release allowed a downgrade' >&2
    exit 1
fi
mv "$TMP_DIR/pre-adoption-releases.saved" "$FIXTURE/releases.json"
set_http_time
eligible_output=$("$GLOBAL_SKILL/bin/traceknot-skills-update" check --global)
printf '%s\n' "$eligible_output" | grep -F "Eligible update: $TAG" >/dev/null
"$GLOBAL_SKILL/bin/traceknot-skills-update" apply --global >/dev/null
test "$(cat "$NPX_COUNT")" -eq 2
test "$(grep -c "Jin-Doh/traceknot#$SOURCE_COMMIT" "$NPX_LOG")" -eq 2
grep -F 'Traceknot fixture' "$GLOBAL_SKILL/SKILL.md" >/dev/null
jq -e --arg commit "$SOURCE_COMMIT" '.skills.traceknot.ref == $commit' "$HOME/.agents/.skill-lock.json" >/dev/null
jq -e --arg commit "$SOURCE_COMMIT" '.sourceCommit == $commit and .scope == "global" and (.lockEntrySha256 | test("^[0-9a-f]{64}$"))' "$GLOBAL_STATE/active.json" >/dev/null
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
mkdir -p "$PROJECT"
PROJECT=$(CDPATH='' cd -P "$PROJECT" && pwd)
PROJECT_SKILL=$PROJECT/.agents/skills/traceknot
install_initial_skill "$PROJECT_SKILL"
write_initial_lock "$PROJECT/skills-lock.json"
"$PROJECT_SKILL/bin/traceknot-skills-update" enable --project "$PROJECT" >/dev/null
grep -F "# traceknot-skills-auto-update:project:$PROJECT" "$CRONTAB_FILE" >/dev/null
grep -F -- "--project '$PROJECT' --auto" "$CRONTAB_FILE" >/dev/null
PROJECT_STATE=$PROJECT/.agents/.traceknot-update
seed_adoption "$PROJECT_STATE" "$PROJECT/skills-lock.json" 1 "$((FAKE_NOW - 1814400))"
"$PROJECT_SKILL/bin/traceknot-skills-update" check --project "$PROJECT" >/dev/null
printf '%s\t%s\t%s\t%s\n' "$MANIFEST_SHA" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" > "$PROJECT_STATE/observations.tsv"
"$PROJECT_SKILL/bin/traceknot-skills-update" apply --project "$PROJECT" >/dev/null
test "$(cat "$NPX_COUNT")" -eq 4
jq -e --arg commit "$SOURCE_COMMIT" '.skills.traceknot.ref == $commit' "$PROJECT/skills-lock.json" >/dev/null
jq -e --arg root "$PROJECT_SKILL" '.scope == "project" and .registration == $root' "$PROJECT_STATE/active.json" >/dev/null

# A preflight mismatch fails before the canonical Skills registration is changed.
TAMPER_PROJECT="$TMP_DIR/tamper project"
mkdir -p "$TAMPER_PROJECT"
TAMPER_PROJECT=$(CDPATH='' cd -P "$TAMPER_PROJECT" && pwd)
TAMPER_SKILL=$TAMPER_PROJECT/.agents/skills/traceknot
install_initial_skill "$TAMPER_SKILL"
write_initial_lock "$TAMPER_PROJECT/skills-lock.json"
"$TAMPER_SKILL/bin/traceknot-skills-update" status --project "$TAMPER_PROJECT" >/dev/null
TAMPER_STATE=$TAMPER_PROJECT/.agents/.traceknot-update
seed_adoption "$TAMPER_STATE" "$TAMPER_PROJECT/skills-lock.json" 0 "$((FAKE_NOW - 1814400))"
"$TAMPER_SKILL/bin/traceknot-skills-update" check --project "$TAMPER_PROJECT" >/dev/null
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


# A process interruption after Skills CLI mutation is reconciled on the next run.
INTERRUPT_PROJECT="$TMP_DIR/interrupted project"
mkdir -p "$INTERRUPT_PROJECT"
INTERRUPT_PROJECT=$(CDPATH='' cd -P "$INTERRUPT_PROJECT" && pwd)
INTERRUPT_SKILL=$INTERRUPT_PROJECT/.agents/skills/traceknot
install_initial_skill "$INTERRUPT_SKILL"
write_initial_lock "$INTERRUPT_PROJECT/skills-lock.json"
"$INTERRUPT_SKILL/bin/traceknot-skills-update" status --project "$INTERRUPT_PROJECT" >/dev/null
INTERRUPT_STATE=$INTERRUPT_PROJECT/.agents/.traceknot-update
seed_adoption "$INTERRUPT_STATE" "$INTERRUPT_PROJECT/skills-lock.json" 0 "$((FAKE_NOW - 1814400))"
INTERRUPT_LOCK_SHA=$(lock_entry_sha "$INTERRUPT_PROJECT/skills-lock.json")
jq -n --arg scope project --arg registration "$INTERRUPT_SKILL" \
    --arg lockSha "$INTERRUPT_LOCK_SHA" --argjson appliedAt "$((FAKE_NOW - 1814400))" \
    '{schemaVersion:"traceknot-skills-active-release/v1",version:"1.0.0",releaseTag:"v1.0.0",sourceCommit:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",artifactSha256:"0000000000000000000000000000000000000000000000000000000000000000",lockEntrySha256:$lockSha,appliedAt:$appliedAt,scope:$scope,registration:$registration}' \
    > "$INTERRUPT_STATE/active.json"
printf '%s\t%s\t%s\t%s\n' "$MANIFEST_SHA" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" > "$INTERRUPT_STATE/observations.tsv"
before_interrupt=$(cat "$NPX_COUNT")
FAKE_INTERRUPT_AFTER_INSTALL=1
export FAKE_INTERRUPT_AFTER_INSTALL
if "$INTERRUPT_SKILL/bin/traceknot-skills-update" apply --project "$INTERRUPT_PROJECT" >/dev/null 2>&1; then
    printf '%s\n' 'interrupted Skills CLI update unexpectedly succeeded' >&2
    exit 1
fi
unset FAKE_INTERRUPT_AFTER_INSTALL
test "$(cat "$NPX_COUNT")" -eq $((before_interrupt + 2))
test -f "$INTERRUPT_STATE/pending.json"
test -f "$INTERRUPT_STATE/active.json"
jq -e '.version == "1.0.0"' "$INTERRUPT_STATE/active.json" >/dev/null
jq -e --arg commit "$SOURCE_COMMIT" '.skills.traceknot.ref == $commit' \
    "$INTERRUPT_PROJECT/skills-lock.json" >/dev/null
before_reconcile=$(cat "$NPX_COUNT")
"$INTERRUPT_SKILL/bin/traceknot-skills-update" check --project "$INTERRUPT_PROJECT" >/dev/null
test "$(cat "$NPX_COUNT")" -eq "$before_reconcile"
test -f "$INTERRUPT_STATE/active.json"
jq -e --arg commit "$SOURCE_COMMIT" '.sourceCommit == $commit' "$INTERRUPT_STATE/active.json" >/dev/null
test ! -e "$INTERRUPT_STATE/pending.json"

# A rejected canonical payload must never be promoted by pending reconciliation.
PAYLOAD_PROJECT="$TMP_DIR/tampered canonical project"
mkdir -p "$PAYLOAD_PROJECT"
PAYLOAD_PROJECT=$(CDPATH='' cd -P "$PAYLOAD_PROJECT" && pwd)
PAYLOAD_SKILL=$PAYLOAD_PROJECT/.agents/skills/traceknot
install_initial_skill "$PAYLOAD_SKILL"
write_initial_lock "$PAYLOAD_PROJECT/skills-lock.json"
"$PAYLOAD_SKILL/bin/traceknot-skills-update" status --project "$PAYLOAD_PROJECT" >/dev/null
PAYLOAD_STATE=$PAYLOAD_PROJECT/.agents/.traceknot-update
seed_adoption "$PAYLOAD_STATE" "$PAYLOAD_PROJECT/skills-lock.json" 0 "$((FAKE_NOW - 1814400))"
PAYLOAD_LOCK_SHA=$(lock_entry_sha "$PAYLOAD_PROJECT/skills-lock.json")
jq -n --arg scope project --arg registration "$PAYLOAD_SKILL" \
    --arg lockSha "$PAYLOAD_LOCK_SHA" --argjson appliedAt "$((FAKE_NOW - 1814400))" \
    '{schemaVersion:"traceknot-skills-active-release/v1",version:"1.0.0",releaseTag:"v1.0.0",sourceCommit:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",artifactSha256:"0000000000000000000000000000000000000000000000000000000000000000",lockEntrySha256:$lockSha,appliedAt:$appliedAt,scope:$scope,registration:$registration}' \
    > "$PAYLOAD_STATE/active.json"
printf '%s\t%s\t%s\t%s\n' "$MANIFEST_SHA" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" > "$PAYLOAD_STATE/observations.tsv"
before_payload=$(cat "$NPX_COUNT")
FAKE_TAMPER_APPLY=1
export FAKE_TAMPER_APPLY
if "$PAYLOAD_SKILL/bin/traceknot-skills-update" apply --project "$PAYLOAD_PROJECT" >/dev/null 2>&1; then
    printf '%s\n' 'tampered canonical payload unexpectedly applied' >&2
    exit 1
fi
unset FAKE_TAMPER_APPLY
test "$(cat "$NPX_COUNT")" -eq $((before_payload + 2))
test -f "$PAYLOAD_STATE/pending.json"
test -d "$PAYLOAD_STATE/pending-payload"
if "$PAYLOAD_SKILL/bin/traceknot-skills-update" check --project "$PAYLOAD_PROJECT" >/dev/null 2>&1; then
    printf '%s\n' 'rejected canonical payload was promoted' >&2
    exit 1
fi
jq -e '.version == "1.0.0"' "$PAYLOAD_STATE/active.json" >/dev/null
test -f "$PAYLOAD_STATE/pending.json"
# Nested registration symlinks must fail before active-state promotion.
SYMLINK_PAYLOAD_PROJECT="$TMP_DIR/symlink payload project"
mkdir -p "$SYMLINK_PAYLOAD_PROJECT"
SYMLINK_PAYLOAD_PROJECT=$(CDPATH='' cd -P "$SYMLINK_PAYLOAD_PROJECT" && pwd)
SYMLINK_PAYLOAD_SKILL=$SYMLINK_PAYLOAD_PROJECT/.agents/skills/traceknot
install_initial_skill "$SYMLINK_PAYLOAD_SKILL"
write_initial_lock "$SYMLINK_PAYLOAD_PROJECT/skills-lock.json"
"$SYMLINK_PAYLOAD_SKILL/bin/traceknot-skills-update" status --project "$SYMLINK_PAYLOAD_PROJECT" >/dev/null
SYMLINK_PAYLOAD_STATE=$SYMLINK_PAYLOAD_PROJECT/.agents/.traceknot-update
seed_adoption "$SYMLINK_PAYLOAD_STATE" "$SYMLINK_PAYLOAD_PROJECT/skills-lock.json" 0 "$((FAKE_NOW - 1814400))"
SYMLINK_TARGET=$TMP_DIR/external-skill.md
cp "$SOURCE_SKILL/SKILL.md" "$SYMLINK_TARGET"
printf '%s\t%s\t%s\t%s\n' "$MANIFEST_SHA" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" \
    > "$SYMLINK_PAYLOAD_STATE/observations.tsv"
FAKE_SYMLINK_APPLY=1
export FAKE_SYMLINK_APPLY FAKE_SYMLINK_TARGET="$SYMLINK_TARGET"
if "$SYMLINK_PAYLOAD_SKILL/bin/traceknot-skills-update" apply --project "$SYMLINK_PAYLOAD_PROJECT" >/dev/null 2>&1; then
    printf '%s\n' 'symlinked canonical payload unexpectedly applied' >&2
    exit 1
fi
unset FAKE_SYMLINK_APPLY FAKE_SYMLINK_TARGET
test -f "$SYMLINK_PAYLOAD_STATE/pending.json"
test ! -f "$SYMLINK_PAYLOAD_STATE/active.json"
PRELOCK_PROJECT="$TMP_DIR/pre-lock project"
mkdir -p "$PRELOCK_PROJECT"
PRELOCK_PROJECT=$(CDPATH='' cd -P "$PRELOCK_PROJECT" && pwd)
PRELOCK_SKILL=$PRELOCK_PROJECT/.agents/skills/traceknot
install_initial_skill "$PRELOCK_SKILL"
write_initial_lock "$PRELOCK_PROJECT/skills-lock.json"
"$PRELOCK_SKILL/bin/traceknot-skills-update" status --project "$PRELOCK_PROJECT" >/dev/null
PRELOCK_STATE=$PRELOCK_PROJECT/.agents/.traceknot-update
seed_adoption "$PRELOCK_STATE" "$PRELOCK_PROJECT/skills-lock.json" 0 "$((FAKE_NOW - 1814400))"
printf '%s\t%s\t%s\t%s\n' "$MANIFEST_SHA" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" > "$PRELOCK_STATE/observations.tsv"
before_prelock=$(cat "$NPX_COUNT")
FAKE_INTERRUPT_BEFORE_LOCK=1
export FAKE_INTERRUPT_BEFORE_LOCK
if "$PRELOCK_SKILL/bin/traceknot-skills-update" apply --project "$PRELOCK_PROJECT" >/dev/null 2>&1; then
    printf '%s\n' 'pre-lock interruption unexpectedly succeeded' >&2
    exit 1
fi
unset FAKE_INTERRUPT_BEFORE_LOCK
test "$(cat "$NPX_COUNT")" -eq $((before_prelock + 2))
test -f "$PRELOCK_STATE/pending.json"
test -d "$PRELOCK_STATE/pending-previous-payload"
if "$PRELOCK_SKILL/bin/traceknot-skills-update" check --project "$PRELOCK_PROJECT" >/dev/null 2>&1; then
    printf '%s\n' 'partially replaced registration was discarded as safe' >&2
    exit 1
fi
test -f "$PRELOCK_STATE/pending.json"
test -d "$PRELOCK_STATE/pending-payload"
SYMLINK_PROJECT="$TMP_DIR/symlink project"
SYMLINK_OUTSIDE="$TMP_DIR/symlink outside"
mkdir -p "$SYMLINK_PROJECT" "$SYMLINK_OUTSIDE/.agents/skills/traceknot"
SYMLINK_OUTSIDE=$(CDPATH='' cd -P "$SYMLINK_OUTSIDE" && pwd)
install_initial_skill "$SYMLINK_OUTSIDE/.agents/skills/traceknot"
ln -s "$SYMLINK_OUTSIDE/.agents" "$SYMLINK_PROJECT/.agents"
if "$SYMLINK_OUTSIDE/.agents/skills/traceknot/bin/traceknot-skills-update" \
    status --project "$SYMLINK_PROJECT" >/dev/null 2>&1; then
    printf '%s\n' 'symlinked project Agent root was accepted' >&2
    exit 1
fi
SYMLINK_PROJECT_SKILLS="$TMP_DIR/symlink skills project"
SYMLINK_OUTSIDE_SKILLS="$TMP_DIR/symlink skills outside"
mkdir -p "$SYMLINK_PROJECT_SKILLS/.agents" "$SYMLINK_OUTSIDE_SKILLS/skills/traceknot"
SYMLINK_OUTSIDE_SKILLS=$(CDPATH='' cd -P "$SYMLINK_OUTSIDE_SKILLS" && pwd)
install_initial_skill "$SYMLINK_OUTSIDE_SKILLS/skills/traceknot"
ln -s "$SYMLINK_OUTSIDE_SKILLS/skills" "$SYMLINK_PROJECT_SKILLS/.agents/skills"
if "$SYMLINK_OUTSIDE_SKILLS/skills/traceknot/bin/traceknot-skills-update" \
    status --project "$SYMLINK_PROJECT_SKILLS" >/dev/null 2>&1; then
    printf '%s\n' 'symlinked project Skills root was accepted' >&2
    exit 1
fi
BAD_DATE_PROJECT="$TMP_DIR/bad date project"
mkdir -p "$BAD_DATE_PROJECT"
BAD_DATE_PROJECT=$(CDPATH='' cd -P "$BAD_DATE_PROJECT" && pwd)
BAD_DATE_SKILL=$BAD_DATE_PROJECT/.agents/skills/traceknot
install_initial_skill "$BAD_DATE_SKILL"
write_initial_lock "$BAD_DATE_PROJECT/skills-lock.json"
"$BAD_DATE_SKILL/bin/traceknot-skills-update" status --project "$BAD_DATE_PROJECT" >/dev/null
BAD_DATE_STATE=$BAD_DATE_PROJECT/.agents/.traceknot-update
seed_adoption "$BAD_DATE_STATE" "$BAD_DATE_PROJECT/skills-lock.json" 0 "$((FAKE_NOW - 1814400))"
sed 's/^lastCheck=0$/lastCheck=123/' "$BAD_DATE_STATE/config" > "$BAD_DATE_STATE/config.tmp"
mv "$BAD_DATE_STATE/config.tmp" "$BAD_DATE_STATE/config"
cp "$FIXTURE/manifest-lower.json" "$TMP_DIR/manifest-lower.saved"
jq '.publishedAt = "2026-02-31T00:00:00Z"' "$FIXTURE/manifest-lower.json" \
    > "$FIXTURE/manifest-lower.json.tmp"
mv "$FIXTURE/manifest-lower.json.tmp" "$FIXTURE/manifest-lower.json"
if "$BAD_DATE_SKILL/bin/traceknot-skills-update" check --project "$BAD_DATE_PROJECT" >/dev/null 2>&1; then
    printf '%s\n' 'impossible manifest date was accepted' >&2
    exit 1
fi
test "$(sed -n 's/^lastCheck=//p' "$BAD_DATE_STATE/config")" = 123
mv "$TMP_DIR/manifest-lower.saved" "$FIXTURE/manifest-lower.json"
cp "$FIXTURE/releases.json" "$TMP_DIR/releases.saved"
jq '.[0].published_at = "2026-02-31T00:00:00Z"' "$FIXTURE/releases.json" \
    > "$FIXTURE/releases.json.tmp"
mv "$FIXTURE/releases.json.tmp" "$FIXTURE/releases.json"
if "$BAD_DATE_SKILL/bin/traceknot-skills-update" check --project "$BAD_DATE_PROJECT" >/dev/null 2>&1; then
    printf '%s\n' 'impossible release date was accepted' >&2
    exit 1
fi
mv "$TMP_DIR/releases.saved" "$FIXTURE/releases.json"
FAKE_HTTP_DATE='Mon, 31 Feb 2026 00:00:00 GMT'
export FAKE_HTTP_DATE
if "$BAD_DATE_SKILL/bin/traceknot-skills-update" check --project "$BAD_DATE_PROJECT" >/dev/null 2>&1; then
    printf '%s\n' 'impossible GitHub server date was accepted' >&2
    exit 1
fi
set_http_time

# Disable removes only this updater's schedules and persists opt-out.
"$GLOBAL_SKILL/bin/traceknot-skills-update" disable --global >/dev/null
if grep -F "# traceknot-skills-auto-update:global:$GLOBAL_SKILL" "$CRONTAB_FILE" >/dev/null 2>&1; then
    printf '%s\n' 'global automatic-update schedule remained after disable' >&2
    exit 1
fi
test "$(sed -n 's/^automatic=//p' "$GLOBAL_STATE/config")" = 0

printf '%s\n' 'Skills updater smoke test: PASS'
