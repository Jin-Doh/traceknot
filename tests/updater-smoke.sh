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
LOWER_VERSION=1.1.9
LOWER_TAG=v$LOWER_VERSION
LOWER_ARCHIVE_NAME=traceknot-v$LOWER_VERSION.tar.gz
jq -n \
    --arg version "$LOWER_VERSION" \
    --arg tag "$LOWER_TAG" \
    --arg commit "$SOURCE_COMMIT" \
    --arg published "$PUBLISHED_AT" \
    --arg name "$LOWER_ARCHIVE_NAME" \
    --arg sha "$ARTIFACT_SHA" \
    --argjson size "$ARTIFACT_SIZE" \
    '{schemaVersion:"traceknot-update-manifest/v1",version:$version,releaseTag:$tag,sourceRepository:"Jin-Doh/traceknot",sourceCommit:$commit,publishedAt:$published,artifact:{name:$name,size:$size,sha256:$sha}}' \
    > "$FIXTURE/manifest-lower.json"

cat > "$FIXTURE/releases.json" <<EOF
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
EOF
jq -n '[range(0;100) | {
  tag_name:("v0.0." + tostring),
  published_at:"2020-01-01T00:00:00Z",
  draft:true,
  prerelease:false,
  immutable:true,
  assets:[]
}]' > "$FIXTURE/releases-page-1.json"

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
    */releases\?*)
        if [ "${FAKE_PAGINATED_RELEASES:-0}" -eq 1 ]; then
            case "$url" in
                *page=1) cp "$FAKE_FIXTURE/releases-page-1.json" "$output" ;;
                *page=2) cp "$FAKE_FIXTURE/releases.json" "$output" ;;
                *) printf '%s\n' '[]' > "$output" ;;
            esac
        else
            cp "$FAKE_FIXTURE/releases.json" "$output"
        fi
        ;;
    */manifest-lower) cp "$FAKE_FIXTURE/manifest-lower.json" "$output" ;;
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
    -l) [ -f "$CRONTAB_FILE" ] && cat "$CRONTAB_FILE" || { printf '%s\n' 'no crontab for traceknot-smoke' >&2; exit 1; } ;;
    -) cat > "$CRONTAB_FILE" ;;
    *) exit 2 ;;
esac
EOF
chmod +x "$FAKE_BIN/crontab"
REAL_MV=$(command -v mv)
export REAL_MV
cat > "$FAKE_BIN/mv" <<'EOF'
#!/bin/sh
last=
for argument do
    last=$argument
done
if [ -n "${FAKE_MV_FAIL_BASENAME:-}" ] &&
   [ "${last##*/}" = "$FAKE_MV_FAIL_BASENAME" ]; then
    exit 1
fi
exec "$REAL_MV" "$@"
EOF
chmod +x "$FAKE_BIN/mv"

FAKE_HTTP_DATE=$(jq -nr --argjson epoch "$FAKE_NOW" '$epoch | strftime("%a, %d %b %Y %H:%M:%S GMT")')
FAKE_FIXTURE=$FIXTURE
FAKE_ARCHIVE_NAME=$ARCHIVE_NAME
PATH=$FAKE_BIN:$PATH
export FAKE_HTTP_DATE FAKE_FIXTURE FAKE_ARCHIVE_NAME PATH
sh "$ROOT/install.sh" --prefix "$PREFIX" >/dev/null
PREFIX_CANON=$(CDPATH='' cd -P "$PREFIX" && pwd)
assert_flat_launcher() {
    test -L "$PREFIX/bin/traceknot"
    test "$(readlink "$PREFIX/bin/traceknot")" = "$PREFIX_CANON/skill/bin/traceknot"
    test -x "$PREFIX/bin/traceknot"
}
assert_managed_launcher() {
    test -L "$PREFIX/bin/traceknot"
    test "$(readlink "$PREFIX/bin/traceknot")" = "$PREFIX_CANON/current/skill/bin/traceknot"
    test -x "$PREFIX/bin/traceknot"
}
assert_flat_launcher
test -x "$PREFIX/bin/traceknot-update"
test "$(sed -n 's/^automatic=//p' "$PREFIX/.traceknot-update/config")" = 1
grep -F "# traceknot-auto-update:$PREFIX_CANON" "$CRONTAB_FILE" >/dev/null

# Release metadata cannot redirect asset fetches outside the approved GitHub API origin.
cp "$FIXTURE/releases.json" "$FIXTURE/releases.safe.json"
jq '.[0].assets |= map(.url = "https://evil.example/" + .name)' \
    "$FIXTURE/releases.safe.json" > "$FIXTURE/releases.json"
if "$PREFIX/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'unapproved release asset origin unexpectedly accepted' >&2
    exit 1
fi
mv "$FIXTURE/releases.safe.json" "$FIXTURE/releases.json"
test ! -e "$PREFIX/current"
# Runtime opt-out must survive a subsequent ordinary reinstall.
"$PREFIX/bin/traceknot-update" disable --prefix "$PREFIX" >/dev/null
test "$(sed -n 's/^automatic=//p' "$PREFIX/.traceknot-update/config")" = 0
assert_flat_launcher
if grep -F "# traceknot-auto-update:$PREFIX_CANON" "$CRONTAB_FILE" >/dev/null 2>&1; then
    printf '%s\n' 'runtime disable unexpectedly left an automatic-update schedule' >&2
    exit 1
fi
sh "$ROOT/install.sh" --prefix "$PREFIX" >/dev/null
test "$(sed -n 's/^automatic=//p' "$PREFIX/.traceknot-update/config")" = 0
assert_flat_launcher
if grep -F "# traceknot-auto-update:$PREFIX_CANON" "$CRONTAB_FILE" >/dev/null 2>&1; then
    printf '%s\n' 'ordinary reinstall unexpectedly re-enabled runtime opt-out' >&2
    exit 1
fi
# Enable fails before scheduling when no checksum implementation is available.
NO_CHECKSUM_BIN=$TMP_DIR/no-checksum-bin
mkdir -p "$NO_CHECKSUM_BIN"
for checksum_dependency in awk basename cat crontab curl dirname gh jq ln mkdir mktemp mv readlink rm sed sh sync tar; do
    checksum_dependency_path=$(command -v "$checksum_dependency")
    ln -s "$checksum_dependency_path" "$NO_CHECKSUM_BIN/$checksum_dependency"
done
if PATH=$NO_CHECKSUM_BIN "$PREFIX/bin/traceknot-update" enable --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'automatic updates enabled without a checksum utility' >&2
    exit 1
fi
test "$(sed -n 's/^automatic=//p' "$PREFIX/.traceknot-update/config")" = 0
if grep -F "# traceknot-auto-update:$PREFIX_CANON" "$CRONTAB_FILE" >/dev/null 2>&1; then
    printf '%s\n' 'missing checksum preflight still installed a schedule' >&2
    exit 1
fi

# Observation state refuses symbolic links before reading or appending.
OBSERVATION_TARGET=$TMP_DIR/observation-target
printf '%s\n' preserve-observation-target > "$OBSERVATION_TARGET"
ln -s "$OBSERVATION_TARGET" "$PREFIX/.traceknot-update/observations.tsv"
if "$PREFIX/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'symbolic-link observations file unexpectedly accepted' >&2
    exit 1
fi
test "$(cat "$OBSERVATION_TARGET")" = preserve-observation-target
rm -f "$PREFIX/.traceknot-update/observations.tsv"

FAKE_PAGINATED_RELEASES=1
export FAKE_PAGINATED_RELEASES
# First observation is never immediately eligible, even for an old published release.
first_output=$("$PREFIX/bin/traceknot-update" check --prefix "$PREFIX")
printf '%s\n' "$first_output" | grep -F 'No release has exceeded' >/dev/null
unset FAKE_PAGINATED_RELEASES
MANIFEST_SHA=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum "$FIXTURE/manifest.json" | cut -d ' ' -f 1; else shasum -a 256 "$FIXTURE/manifest.json" | cut -d ' ' -f 1; fi)
LOWER_MANIFEST_SHA=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum "$FIXTURE/manifest-lower.json" | cut -d ' ' -f 1; else shasum -a 256 "$FIXTURE/manifest-lower.json" | cut -d ' ' -f 1; fi)
{
    printf '%s\t%s\t%s\t%s\n' "$LOWER_MANIFEST_SHA" "$((FAKE_NOW - 604800))" "$LOWER_TAG" "$ARTIFACT_SHA"
    printf '%s\t%s\t%s\t%s\n' "$MANIFEST_SHA" "$((FAKE_NOW - 604800))" "$TAG" "$ARTIFACT_SHA"
} > "$PREFIX/.traceknot-update/observations.tsv"

# Exactly seven days is still ineligible.
boundary_output=$("$PREFIX/bin/traceknot-update" check --prefix "$PREFIX")
printf '%s\n' "$boundary_output" | grep -F 'No release has exceeded' >/dev/null

# The first second after seven complete days selects the highest eligible semantic version, not the first API entry.
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

# A pre-Skills installer owned a regular root launcher. Reject an unowned
# replacement before mutation, then migrate the manifest-owned legacy file.
rm -f "$PREFIX/bin/traceknot"
cp "$PREFIX/skill/bin/traceknot" "$PREFIX/bin/traceknot"
test -f "$PREFIX/bin/traceknot"
test ! -L "$PREFIX/bin/traceknot"
MANIFEST_BACKUP=$TMP_DIR/install-manifest.backup
cp "$PREFIX/.traceknot-install-manifest" "$MANIFEST_BACKUP"
sed '/^bin\/traceknot$/d' "$MANIFEST_BACKUP" > "$PREFIX/.traceknot-install-manifest"
if "$PREFIX/bin/traceknot-update" apply --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'unowned regular launcher unexpectedly replaced' >&2
    exit 1
fi
test ! -e "$PREFIX/current"
test ! -e "$PREFIX/.traceknot-update/transaction"
cp "$MANIFEST_BACKUP" "$PREFIX/.traceknot-install-manifest"

"$PREFIX/bin/traceknot-update" enable --prefix "$PREFIX" >/dev/null
"$PREFIX/bin/traceknot-update" apply --prefix "$PREFIX" >/dev/null
test -L "$PREFIX/current"
test -f "$PREFIX/current/skill/SKILL.md"
test -f "$PREFIX/.traceknot-update/active.json"
test "$(jq -r .releaseTag "$PREFIX/.traceknot-update/active.json")" = "$TAG"
test -L "$TRACEKNOT_SKILLS_ROOT/traceknot"
test "$(readlink "$TRACEKNOT_SKILLS_ROOT/traceknot")" = "$PREFIX_CANON/current/skill"
assert_managed_launcher
# An interrupted managed-to-flat cutover is completed from its durable journal.
printf '%s\n' traceknot-reinstall-reset/v1 > "$PREFIX/.traceknot-update/reinstall-reset"
rm -f "$TRACEKNOT_SKILLS_ROOT/traceknot"
ln -s "$PREFIX_CANON/skill" "$TRACEKNOT_SKILLS_ROOT/traceknot"
"$PREFIX/current/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null
test ! -e "$PREFIX/.traceknot-update/reinstall-reset"
test ! -e "$PREFIX/current"
test ! -e "$PREFIX/releases"
test "$(readlink "$TRACEKNOT_SKILLS_ROOT/traceknot")" = "$PREFIX_CANON/skill"
assert_flat_launcher
grep -F "$PREFIX_CANON/bin/traceknot-update" "$CRONTAB_FILE" >/dev/null
if grep -F "$PREFIX_CANON/current/bin/traceknot-update" "$CRONTAB_FILE" >/dev/null 2>&1; then
    printf '%s\n' 'reinstall recovery left cron pointed at the removed managed updater' >&2
    exit 1
fi
"$PREFIX/bin/traceknot-update" --prefix "$PREFIX" --auto >/dev/null
"$PREFIX/bin/traceknot-update" apply --prefix "$PREFIX" >/dev/null
# Ordinary reinstall retargets registration to the newly installed flat payload.
sh "$ROOT/install.sh" --prefix "$PREFIX" >/dev/null
assert_flat_launcher
test "$(readlink "$TRACEKNOT_SKILLS_ROOT/traceknot")" = "$PREFIX_CANON/skill"
test ! -e "$PREFIX/current"
test ! -e "$PREFIX/rollback"
test ! -e "$PREFIX/.traceknot-update/active.json"
test ! -e "$PREFIX/.traceknot-update/rollback-active.json"
test ! -e "$PREFIX/releases"
# Flat reinstall also clears a prepared first-apply transaction with no activation links.
PREPARED_CANDIDATE=$PREFIX_CANON/releases/prepared-candidate
mkdir -p "$PREPARED_CANDIDATE"
printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    operation=apply phase=prepared previous= \
    "candidate=$PREPARED_CANDIDATE" "staging=$PREFIX_CANON/releases/.staging-prepared" \
    "registrationPrevious=$PREFIX_CANON/skill" rollbackPrevious= \
    > "$PREFIX/.traceknot-update/transaction"
sh "$ROOT/install.sh" --prefix "$PREFIX" >/dev/null
test ! -e "$PREFIX/releases"
test ! -e "$PREFIX/.traceknot-update/transaction"
assert_flat_launcher
"$PREFIX/bin/traceknot-update" apply --prefix "$PREFIX" >/dev/null
test "$(readlink "$TRACEKNOT_SKILLS_ROOT/traceknot")" = "$PREFIX_CANON/current/skill"
assert_managed_launcher

# Transaction snapshot destinations refuse symbolic links.
SNAPSHOT_TARGET=$TMP_DIR/snapshot-target
printf '%s\n' preserve-snapshot-target > "$SNAPSHOT_TARGET"
ln -s "$SNAPSHOT_TARGET" "$PREFIX/.traceknot-update/transaction-active-before.json"
if "$PREFIX/current/bin/traceknot-update" rollback --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'symbolic-link transaction snapshot unexpectedly accepted' >&2
    exit 1
fi
test "$(cat "$SNAPSHOT_TARGET")" = preserve-snapshot-target
rm -f "$PREFIX/.traceknot-update/transaction-active-before.json"
# A regular pre-journal snapshot orphan is cleaned before the next operation.
cp "$PREFIX/.traceknot-update/active.json" \
    "$PREFIX/.traceknot-update/transaction-active-before.json"
"$PREFIX/current/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null
test ! -e "$PREFIX/.traceknot-update/transaction-active-before.json"

# A failed atomic rename keeps the previous activation link continuously available.
CURRENT_BEFORE=$(readlink "$PREFIX/current")
FAKE_MV_FAIL_BASENAME=current
export FAKE_MV_FAIL_BASENAME
if "$PREFIX/current/bin/traceknot-update" rollback --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'rollback unexpectedly survived injected atomic-rename failure' >&2
    exit 1
fi
test -L "$PREFIX/current"
test "$(readlink "$PREFIX/current")" = "$CURRENT_BEFORE"
unset FAKE_MV_FAIL_BASENAME
"$PREFIX/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null
test ! -e "$PREFIX/.traceknot-update/transaction"
# A rolled-back release can be verified and reapplied from its retained directory.
"$PREFIX/current/bin/traceknot-update" rollback --prefix "$PREFIX" >/dev/null
test "$(jq -r .releaseTag "$PREFIX/.traceknot-update/active.json")" = legacy
test "$(readlink "$TRACEKNOT_SKILLS_ROOT/traceknot")" = "$PREFIX_CANON/current/skill"
assert_managed_launcher
legacy_check=$("$PREFIX/bin/traceknot-update" check --prefix "$PREFIX")
printf '%s\n' "$legacy_check" | grep -F "Eligible update: $TAG" >/dev/null
"$PREFIX/bin/traceknot-update" apply --prefix "$PREFIX" >/dev/null
test "$(jq -r .releaseTag "$PREFIX/.traceknot-update/active.json")" = "$TAG"
test "$(readlink "$TRACEKNOT_SKILLS_ROOT/traceknot")" = "$PREFIX_CANON/current/skill"
assert_managed_launcher
test -f "$PREFIX/current/skill/SKILL.md"
# Committed recovery prunes a release that is no longer current or rollback.
OBSOLETE=$PREFIX_CANON/releases/obsolete
mkdir -p "$OBSOLETE"
printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    operation=apply phase=committed "previous=$(readlink "$PREFIX/rollback")" \
    "candidate=$(readlink "$PREFIX/current")" staging= \
    "registrationPrevious=$PREFIX_CANON/current/skill" \
    "rollbackPrevious=$OBSOLETE" > "$PREFIX/.traceknot-update/transaction"
"$PREFIX/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null
test ! -e "$OBSOLETE"
test -L "$PREFIX/current"
test -L "$PREFIX/rollback"

# Default-on scheduling and explicit opt-out own only their marked schedule.
"$PREFIX/current/bin/traceknot-update" enable --prefix "$PREFIX" >/dev/null
grep -F "# traceknot-auto-update:$PREFIX_CANON" "$CRONTAB_FILE" >/dev/null
grep -F "TRACEKNOT_SKILLS_ROOT='$TRACEKNOT_SKILLS_ROOT'" "$CRONTAB_FILE" >/dev/null
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
    'substr($0, length($0) - length(marker) + 1) == marker { found=1 } END { exit !found }' \
    "$CRONTAB_FILE"
"$X_PREFIX/bin/traceknot-update" disable --prefix "$X_PREFIX" >/dev/null
grep -Fx "$X_FOREIGN_ENTRY" "$CRONTAB_FILE" >/dev/null
grep -Fx "$X_UNMARKED_ENTRY" "$CRONTAB_FILE" >/dev/null
if awk -v marker="# traceknot-auto-update:$X_PREFIX_CANON" \
    'substr($0, length($0) - length(marker) + 1) == marker { found=1 } END { exit !found }' \
    "$CRONTAB_FILE"; then
    printf '%s\n' 'disabling /x unexpectedly retained its own schedule' >&2
    exit 1
fi

# Exact marker matching treats backslashes in a legal absolute prefix literally.
BACKSLASH_PREFIX=$TMP_DIR/'prefix\b'
BACKSLASH_SKILLS=$TMP_DIR/backslash-skills
TRACEKNOT_SKILLS_ROOT=$BACKSLASH_SKILLS sh "$ROOT/install.sh" \
    --prefix "$BACKSLASH_PREFIX" >/dev/null
BACKSLASH_PREFIX_CANON=$(CDPATH='' cd -P "$BACKSLASH_PREFIX" && pwd)
TRACEKNOT_CRON_MARKER="# traceknot-auto-update:$BACKSLASH_PREFIX_CANON" \
    awk 'BEGIN { marker=ENVIRON["TRACEKNOT_CRON_MARKER"] }
         substr($0, length($0) - length(marker) + 1) == marker { found++ }
         END { exit found != 1 }' "$CRONTAB_FILE"
"$BACKSLASH_PREFIX/bin/traceknot-update" disable \
    --prefix "$BACKSLASH_PREFIX" >/dev/null
if TRACEKNOT_CRON_MARKER="# traceknot-auto-update:$BACKSLASH_PREFIX_CANON" \
    awk 'BEGIN { marker=ENVIRON["TRACEKNOT_CRON_MARKER"] }
         substr($0, length($0) - length(marker) + 1) == marker { found=1 }
         END { exit !found }' "$CRONTAB_FILE"; then
    printf '%s\n' 'backslash-prefix schedule survived explicit opt-out' >&2
    exit 1
fi
TRACEKNOT_SKILLS_ROOT=$BACKSLASH_SKILLS sh "$ROOT/install.sh" \
    --prefix "$BACKSLASH_PREFIX" >/dev/null
test "$(sed -n 's/^automatic=//p' "$BACKSLASH_PREFIX/.traceknot-update/config")" = 0
# A held lock blocks a second writer without changing the activation.
printf '%s\n' "$$" > "$PREFIX/.traceknot-update.lock"
printf '%s\n' preserve-locked-reinstall >> "$PREFIX/skill/SKILL.md"
if sh "$ROOT/install.sh" --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'reinstall unexpectedly mutated files while the update lock was held' >&2
    exit 1
fi
grep -F preserve-locked-reinstall "$PREFIX/skill/SKILL.md" >/dev/null
if "$PREFIX/current/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'concurrent updater unexpectedly acquired the lock' >&2
    exit 1
fi
rm -f "$PREFIX/.traceknot-update.lock"
# Predictable claim paths are created without following pre-existing symlinks.
CLAIM_WRAPPER=$TMP_DIR/claim-wrapper
cat > "$CLAIM_WRAPPER" <<'EOF'
#!/bin/sh
printf '%s\n' "$$" > "$CLAIM_PID_FILE"
while [ ! -e "$CLAIM_GO_FILE" ]; do sleep 0.01; done
exec "$@"
EOF
chmod +x "$CLAIM_WRAPPER"
for claim_entrypoint in updater installer; do
    CLAIM_TARGET=$TMP_DIR/claim-target-$claim_entrypoint
    CLAIM_PID_FILE=$TMP_DIR/claim-pid
    CLAIM_GO_FILE=$TMP_DIR/claim-go
    printf '%s\n' preserve-claim-target > "$CLAIM_TARGET"
    rm -f "$CLAIM_PID_FILE" "$CLAIM_GO_FILE"
    if [ "$claim_entrypoint" = updater ]; then
        CLAIM_PID_FILE=$CLAIM_PID_FILE CLAIM_GO_FILE=$CLAIM_GO_FILE \
            "$CLAIM_WRAPPER" "$PREFIX/current/bin/traceknot-update" \
            check --prefix "$PREFIX" >/dev/null 2>&1 &
    else
        CLAIM_PID_FILE=$CLAIM_PID_FILE CLAIM_GO_FILE=$CLAIM_GO_FILE \
            "$CLAIM_WRAPPER" sh "$ROOT/install.sh" \
            --prefix "$PREFIX" >/dev/null 2>&1 &
    fi
    claim_process=$!
    while [ ! -s "$CLAIM_PID_FILE" ]; do sleep 0.01; done
    claim_pid=$(cat "$CLAIM_PID_FILE")
    claim_path=$PREFIX/.traceknot-update-lock-claim.$claim_pid
    ln -s "$CLAIM_TARGET" "$claim_path"
    touch "$CLAIM_GO_FILE"
    if wait "$claim_process"; then
        printf '%s\n' "$claim_entrypoint unexpectedly followed a lock claim symlink" >&2
        exit 1
    fi
    test "$(cat "$CLAIM_TARGET")" = preserve-claim-target
    rm -f "$claim_path"
done
# Predictable state-temporary paths are also no-clobber.
STATE_TARGET=$TMP_DIR/state-target
printf '%s\n' preserve-state-target > "$STATE_TARGET"
rm -f "$CLAIM_PID_FILE" "$CLAIM_GO_FILE"
CLAIM_PID_FILE=$CLAIM_PID_FILE CLAIM_GO_FILE=$CLAIM_GO_FILE \
    "$CLAIM_WRAPPER" "$PREFIX/current/bin/traceknot-update" \
    disable --prefix "$PREFIX" >/dev/null 2>&1 &
state_process=$!
while [ ! -s "$CLAIM_PID_FILE" ]; do sleep 0.01; done
state_pid=$(cat "$CLAIM_PID_FILE")
state_tmp=$PREFIX/.traceknot-update/config.tmp.$state_pid
ln -s "$STATE_TARGET" "$state_tmp"
touch "$CLAIM_GO_FILE"
if wait "$state_process"; then
    printf '%s\n' 'state temporary symlink unexpectedly accepted' >&2
    exit 1
fi
test "$(cat "$STATE_TARGET")" = preserve-state-target
rm -f "$state_tmp"

# Directory lock paths cannot be mistaken for successful hard-link acquisition.
mkdir "$PREFIX/.traceknot-update.lock"
if sh "$ROOT/install.sh" --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'installer unexpectedly acquired a directory lock path' >&2
    exit 1
fi
if "$PREFIX/current/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'updater unexpectedly acquired a directory lock path' >&2
    exit 1
fi
test -d "$PREFIX/.traceknot-update.lock"
rm -rf "$PREFIX/.traceknot-update.lock"

# A symbolic-link recovery guard is rejected without touching its target.
RECOVERY_TARGET=$TMP_DIR/recovery-target
printf '%s\n' preserve-recovery-target > "$RECOVERY_TARGET"
printf '%s\n' 2147483647 > "$PREFIX/.traceknot-update.lock"
ln -s "$RECOVERY_TARGET" "$PREFIX/.traceknot-update.lock-recovery"
if sh "$ROOT/install.sh" --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'installer unexpectedly followed a symbolic-link recovery guard' >&2
    exit 1
fi
test "$(cat "$RECOVERY_TARGET")" = preserve-recovery-target
if "$PREFIX/current/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'updater unexpectedly followed a symbolic-link recovery guard' >&2
    exit 1
fi
test "$(cat "$RECOVERY_TARGET")" = preserve-recovery-target
rm -f "$PREFIX/.traceknot-update.lock" "$PREFIX/.traceknot-update.lock-recovery"
printf '%s\n' 2147483647 > "$PREFIX/.traceknot-update.lock"
# Corrupt apply journals cannot alias and delete the active release.
ALIASED_CURRENT=$(readlink "$PREFIX/current")
printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    operation=apply phase=prepared "previous=$ALIASED_CURRENT" \
    "candidate=$ALIASED_CURRENT" "staging=$PREFIX_CANON/releases/.staging-alias" \
    "registrationPrevious=$PREFIX_CANON/current/skill" \
    "rollbackPrevious=$(readlink "$PREFIX/rollback")" > "$PREFIX/.traceknot-update/transaction"
if "$PREFIX/bin/traceknot-update" check --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'aliased recovery journal unexpectedly accepted' >&2
    exit 1
fi
test -f "$ALIASED_CURRENT/skill/SKILL.md"
test "$(readlink "$PREFIX/current")" = "$ALIASED_CURRENT"
rm -f "$PREFIX/.traceknot-update/transaction"

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
