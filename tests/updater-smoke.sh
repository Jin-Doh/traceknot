#!/bin/sh
# Boundary, provenance, transaction, scheduling, and compatibility smoke scenarios.

set -eu

ROOT=$(CDPATH='' cd -P "$(dirname "$0")/.." && pwd)
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-updater.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM
HOME=$TMP_DIR/home
TRACEKNOT_SKILLS_ROOT=$HOME/.agents/skills
PREFIX=$TMP_DIR/prefix
FAKE_BIN=$TMP_DIR/bin
FIXTURE=$TMP_DIR/fixture
CRONTAB_FILE=$TMP_DIR/crontab
export HOME TRACEKNOT_SKILLS_ROOT CRONTAB_FILE
mkdir -p "$HOME" "$FAKE_BIN" "$FIXTURE"


VERSION=1.2.3
TAG=v$VERSION
SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567
FAKE_NOW=$(date -u '+%s')
ARCHIVE_NAME=traceknot-v$VERSION.tar.gz
STAGE=$TMP_DIR/stage/traceknot-v$VERSION
mkdir -p "$STAGE"
cp -R "$ROOT/LICENSE" "$ROOT/skill" "$ROOT/contracts" "$ROOT/adapters" "$ROOT/system" "$ROOT/bin" "$STAGE/"
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

cat > "$FIXTURE/releases.json" <<EOF
[
  {
    "tag_name": "$TAG",
    "published_at": "$PUBLISHED_AT",
    "draft": false,
    "prerelease": false,
    "immutable": true,
    "assets": [
      {"name": "traceknot-update-manifest.json", "url": "https://api.github.test/manifest"},
      {"name": "$ARCHIVE_NAME", "url": "https://api.github.test/artifact"}
    ]
  }
]
EOF

cat > "$FAKE_BIN/curl" <<'EOF'
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
        --proto|--tlsv1.2) if [ "$1" = --proto ]; then shift 2; else shift; fi ;;
        --fail|--silent|--show-error|--location) shift ;;
        *) url=$1; shift ;;
    esac
done
if [ -n "$headers" ]; then
    printf 'HTTP/2 200\r\ndate: %s\r\n\r\n' "$FAKE_HTTP_DATE" > "$headers"
fi
case "$url" in
    */releases) cp "$FAKE_FIXTURE/releases.json" "$output" ;;
    */manifest) cp "$FAKE_FIXTURE/manifest.json" "$output" ;;
    */artifact)
        cp "$FAKE_FIXTURE/$FAKE_ARCHIVE_NAME" "$output"
        if [ "${FAKE_CORRUPT_ARTIFACT:-0}" -ne 0 ]; then
            printf X | dd of="$output" bs=1 seek=0 conv=notrunc 2>/dev/null
        fi
        ;;
    *) printf 'unexpected URL: %s\n' "$url" >&2; exit 2 ;;
esac
EOF
chmod +x "$FAKE_BIN/curl"

cat > "$FAKE_BIN/gh" <<'EOF'
#!/bin/sh
set -eu
[ "$1" = attestation ]
[ "$2" = verify ]
case " $* " in *" --repo Jin-Doh/traceknot "*) ;; *) exit 2 ;; esac
case " $* " in *" --signer-workflow Jin-Doh/traceknot/.github/workflows/release.yml "*) ;; *) exit 2 ;; esac
case " $* " in *" --source-ref refs/tags/v1.2.3 "*) ;; *) exit 2 ;; esac
case " $* " in *" --source-digest 0123456789abcdef0123456789abcdef01234567 "*) ;; *) exit 2 ;; esac
case " $* " in *" --deny-self-hosted-runners "*) ;; *) exit 2 ;; esac
[ "${FAKE_GH_FAIL:-0}" -eq 0 ] || exit 1
exit 0
EOF
chmod +x "$FAKE_BIN/gh"

cat > "$FAKE_BIN/crontab" <<'EOF'
#!/bin/sh
set -eu
case "${1:-}" in
    -l) [ -f "$CRONTAB_FILE" ] && cat "$CRONTAB_FILE" || exit 1 ;;
    -) cat > "$CRONTAB_FILE" ;;
    *) exit 2 ;;
esac
EOF
chmod +x "$FAKE_BIN/crontab"

FAKE_HTTP_DATE=$(jq -nr --argjson epoch "$FAKE_NOW" '$epoch | strftime("%a, %d %b %Y %H:%M:%S GMT")')
FAKE_FIXTURE=$FIXTURE
FAKE_ARCHIVE_NAME=$ARCHIVE_NAME
PATH=$FAKE_BIN:$PATH
export FAKE_HTTP_DATE FAKE_FIXTURE FAKE_ARCHIVE_NAME PATH
sh "$ROOT/install.sh" --prefix "$PREFIX" >/dev/null
PREFIX_CANON=$(CDPATH='' cd -P "$PREFIX" && pwd)
test -x "$PREFIX/bin/traceknot-update"
test "$(sed -n 's/^automatic=//p' "$PREFIX/.traceknot-update/config")" = 1
grep -F "# traceknot-auto-update:$PREFIX_CANON" "$CRONTAB_FILE" >/dev/null

# Runtime opt-out must survive a subsequent ordinary reinstall.
"$PREFIX/bin/traceknot-update" disable --prefix "$PREFIX" >/dev/null
test "$(sed -n 's/^automatic=//p' "$PREFIX/.traceknot-update/config")" = 0
if grep -F "# traceknot-auto-update:$PREFIX_CANON" "$CRONTAB_FILE" >/dev/null 2>&1; then
    printf '%s\n' 'runtime disable unexpectedly left an automatic-update schedule' >&2
    exit 1
fi
sh "$ROOT/install.sh" --prefix "$PREFIX" >/dev/null
test "$(sed -n 's/^automatic=//p' "$PREFIX/.traceknot-update/config")" = 0
if grep -F "# traceknot-auto-update:$PREFIX_CANON" "$CRONTAB_FILE" >/dev/null 2>&1; then
    printf '%s\n' 'ordinary reinstall unexpectedly re-enabled runtime opt-out' >&2
    exit 1
fi

# First observation is never immediately eligible, even for an old published release.
first_output=$("$PREFIX/bin/traceknot-update" check --prefix "$PREFIX")
printf '%s\n' "$first_output" | grep -F 'No release has exceeded' >/dev/null
MANIFEST_SHA=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum "$FIXTURE/manifest.json" | cut -d ' ' -f 1; else shasum -a 256 "$FIXTURE/manifest.json" | cut -d ' ' -f 1; fi)
printf '%s\t%s\t%s\t%s\n' "$MANIFEST_SHA" "$((FAKE_NOW - 604800))" "$TAG" "$ARTIFACT_SHA" > "$PREFIX/.traceknot-update/observations.tsv"

# Exactly seven days is still ineligible.
boundary_output=$("$PREFIX/bin/traceknot-update" check --prefix "$PREFIX")
printf '%s\n' "$boundary_output" | grep -F 'No release has exceeded' >/dev/null

# The first second after seven complete days is eligible.
FAKE_NOW=$((FAKE_NOW + 1))
FAKE_HTTP_DATE=$(jq -nr --argjson epoch "$FAKE_NOW" '$epoch | strftime("%a, %d %b %Y %H:%M:%S GMT")')
export FAKE_HTTP_DATE
eligible_output=$("$PREFIX/bin/traceknot-update" check --prefix "$PREFIX")
printf '%s\n' "$eligible_output" | grep -F "Eligible update: $TAG" >/dev/null

# Digest and provenance failures preserve the legacy activation.
FAKE_CORRUPT_ARTIFACT=1
export FAKE_CORRUPT_ARTIFACT
if "$PREFIX/bin/traceknot-update" apply --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'digest mismatch unexpectedly applied' >&2
    exit 1
fi
unset FAKE_CORRUPT_ARTIFACT
test ! -e "$PREFIX/current"

FAKE_GH_FAIL=1
export FAKE_GH_FAIL
if "$PREFIX/bin/traceknot-update" apply --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'unverified provenance unexpectedly applied' >&2
    exit 1
fi
unset FAKE_GH_FAIL
test ! -e "$PREFIX/current"

"$PREFIX/bin/traceknot-update" apply --prefix "$PREFIX" >/dev/null
test -L "$PREFIX/current"
test -f "$PREFIX/current/skill/SKILL.md"
test -f "$PREFIX/.traceknot-update/active.json"
test "$(jq -r .releaseTag "$PREFIX/.traceknot-update/active.json")" = "$TAG"
test -L "$TRACEKNOT_SKILLS_ROOT/traceknot"
test "$(readlink "$TRACEKNOT_SKILLS_ROOT/traceknot")" = "$PREFIX_CANON/current/skill"

# A committed release can be rolled back and then restored without network access.
"$PREFIX/current/bin/traceknot-update" rollback --prefix "$PREFIX" >/dev/null
test "$(jq -r .releaseTag "$PREFIX/.traceknot-update/active.json")" = legacy
legacy_check=$("$PREFIX/bin/traceknot-update" check --prefix "$PREFIX")
printf '%s\n' "$legacy_check" | grep -F "Eligible update: $TAG" >/dev/null
"$PREFIX/bin/traceknot-update" rollback --prefix "$PREFIX" >/dev/null
test "$(jq -r .releaseTag "$PREFIX/.traceknot-update/active.json")" = "$TAG"
test -f "$PREFIX/current/skill/SKILL.md"

# Default-on scheduling and explicit opt-out own only their marked schedule.
"$PREFIX/current/bin/traceknot-update" enable --prefix "$PREFIX" >/dev/null
grep -F "# traceknot-auto-update:$PREFIX_CANON" "$CRONTAB_FILE" >/dev/null
test "$(sed -n 's/^automatic=//p' "$PREFIX/.traceknot-update/config")" = 1
"$PREFIX/current/bin/traceknot-update" disable --prefix "$PREFIX" >/dev/null
if grep -F "# traceknot-auto-update:$PREFIX_CANON" "$CRONTAB_FILE" >/dev/null; then exit 1; fi
test "$(sed -n 's/^automatic=//p' "$PREFIX/.traceknot-update/config")" = 0

# Prefix marker matching is exact: /x must not remove a foreign /x-alt schedule.
X_PREFIX=$TMP_DIR/x
X_ALT_PREFIX=$TMP_DIR/x-alt
X_SKILLS_ROOT=$TMP_DIR/x-skills
X_FOREIGN_MARKER="# traceknot-auto-update:$X_ALT_PREFIX"
X_FOREIGN_ENTRY="17 3 * * * /foreign/traceknot-update --prefix $X_ALT_PREFIX --auto $X_FOREIGN_MARKER"
X_UNMARKED_ENTRY='MAILTO=traceknot-smoke@example.test'
printf '%s\n%s\n' "$X_FOREIGN_ENTRY" "$X_UNMARKED_ENTRY" > "$CRONTAB_FILE"
TRACEKNOT_SKILLS_ROOT=$X_SKILLS_ROOT sh "$ROOT/install.sh" --prefix "$X_PREFIX" >/dev/null
X_PREFIX_CANON=$(CDPATH='' cd -P "$X_PREFIX" && pwd)
grep -Fx "$X_FOREIGN_ENTRY" "$CRONTAB_FILE" >/dev/null
grep -Fx "$X_UNMARKED_ENTRY" "$CRONTAB_FILE" >/dev/null
awk -v marker="# traceknot-auto-update:$X_PREFIX_CANON" \
    'substr($0, length($0) - length(marker) + 1) = marker { found=1 } END { exit !found }' \
    "$CRONTAB_FILE"
"$X_PREFIX/bin/traceknot-update" disable --prefix "$X_PREFIX" >/dev/null
grep -Fx "$X_FOREIGN_ENTRY" "$CRONTAB_FILE" >/dev/null
grep -Fx "$X_UNMARKED_ENTRY" "$CRONTAB_FILE" >/dev/null
if awk -v marker="# traceknot-auto-update:$X_PREFIX_CANON" \
    'substr($0, length($0) - length(marker) + 1) = marker { found=1 } END { exit found }' \
    "$CRONTAB_FILE"; then
    printf '%s\n' 'disabling /x unexpectedly removed only-partially-matching schedules' >&2
    exit 1
fi

# A held lock blocks a second writer without changing the activation.
printf '%s\n' "$$" > "$PREFIX/.traceknot-update.lock"
if "$PREFIX/current/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'concurrent updater unexpectedly acquired the lock' >&2
    exit 1
fi
rm -f "$PREFIX/.traceknot-update.lock"
printf '%s\n' 2147483647 > "$PREFIX/.traceknot-update.lock"
"$PREFIX/current/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null
test ! -e "$PREFIX/.traceknot-update.lock"
test -f "$PREFIX/current/skill/SKILL.md"

# Recovery from an interrupted activated phase restores the previous target.
PREVIOUS=$(readlink "$PREFIX/current")
ROLLBACK_PREVIOUS=$(readlink "$PREFIX/rollback")
BAD=$PREFIX_CANON/releases/bad
mkdir -p "$BAD"
rm -f "$PREFIX/current"
ln -s "$BAD" "$PREFIX/current"
cp "$PREFIX/.traceknot-update/active.json" "$PREFIX/.traceknot-update/transaction-active-before.json"
cp "$PREFIX/.traceknot-update/rollback-active.json" "$PREFIX/.traceknot-update/transaction-rollback-before.json"
printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    operation=apply phase=activated "previous=$PREVIOUS" "candidate=$BAD" \
    "staging=$PREFIX_CANON/releases/.staging-bad" "registrationPrevious=$PREFIX_CANON/current/skill" \
    "rollbackPrevious=$ROLLBACK_PREVIOUS" > "$PREFIX/.traceknot-update/transaction"
"$PREFIX/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null
test "$(readlink "$PREFIX/current")" = "$PREVIOUS"
test "$(jq -r .releaseTag "$PREFIX/.traceknot-update/active.json")" = "$TAG"
test "$(readlink "$PREFIX/rollback")" = "$ROLLBACK_PREVIOUS"
test ! -e "$BAD"
test ! -e "$PREFIX/.traceknot-update/transaction"

# A corrupted journal cannot delete a path outside the managed releases directory.
OUTSIDE=$TMP_DIR/outside-sentinel
mkdir "$OUTSIDE"
printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    operation=apply phase=prepared "previous=$PREVIOUS" "candidate=$OUTSIDE" \
    "staging=$PREFIX_CANON/releases/.staging-bad" "registrationPrevious=$PREFIX_CANON/current/skill" \
    "rollbackPrevious=$ROLLBACK_PREVIOUS" > "$PREFIX/.traceknot-update/transaction"
if "$PREFIX/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'unsafe transaction journal unexpectedly recovered' >&2
    exit 1
fi
test -d "$OUTSIDE"
rm -f "$PREFIX/.traceknot-update/transaction"
ln -s "$OUTSIDE" "$PREFIX/releases/link"
printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    operation=apply phase=prepared "previous=$PREVIOUS" "candidate=$PREFIX_CANON/releases/link" \
    "staging=$PREFIX_CANON/releases/.staging-bad" "registrationPrevious=$PREFIX_CANON/current/skill" \
    "rollbackPrevious=$ROLLBACK_PREVIOUS" > "$PREFIX/.traceknot-update/transaction"
if "$PREFIX/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'symlinked transaction path unexpectedly recovered' >&2
    exit 1
fi
test -d "$OUTSIDE"
rm -f "$PREFIX/.traceknot-update/transaction" "$PREFIX/releases/link"

sh "$ROOT/uninstall.sh" --prefix "$PREFIX" >/dev/null
test ! -e "$PREFIX/current"
test ! -e "$PREFIX/releases"
test ! -e "$PREFIX/.traceknot-update"
test ! -e "$TRACEKNOT_SKILLS_ROOT/traceknot"

printf '%s\n' 'updater smoke test: PASS'
