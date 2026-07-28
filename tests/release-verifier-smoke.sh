#!/bin/sh
# Exercise public-release verification with deterministic GitHub fixtures.

set -eu
CDPATH=
export CDPATH
ROOT=$(cd -P "$(dirname "$0")/.." && pwd)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-release-verifier.XXXXXX")
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT HUP INT TERM

VERSION=9.8.7
TAG=v$VERSION
SOURCE_COMMIT=$(git -C "$ROOT" rev-parse HEAD)
PUBLISHED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
FIXTURE=$TMP_ROOT/fixture
FAKE_BIN=$TMP_ROOT/bin
mkdir -p "$FIXTURE" "$FAKE_BIN"
TRACEKNOT_PUBLISHED_AT=$PUBLISHED_AT sh "$ROOT/scripts/package-release.sh" \
    --version "$VERSION" --source-commit "$SOURCE_COMMIT" --output "$FIXTURE" >/dev/null
ARCHIVE_NAME=traceknot-v$VERSION.tar.gz

jq -n --arg tag "$TAG" --arg published "$PUBLISHED_AT" --arg archive "$ARCHIVE_NAME" '
  {tag_name:$tag,draft:false,prerelease:false,immutable:true,published_at:$published,
   html_url:("https://github.com/Jin-Doh/traceknot/releases/tag/"+$tag),
   assets:[{id:101,name:"traceknot-update-manifest.json",
            url:"https://api.github.com/repos/Jin-Doh/traceknot/releases/assets/101"},
           {id:102,name:$archive,
            url:"https://api.github.com/repos/Jin-Doh/traceknot/releases/assets/102"}]}
' > "$FIXTURE/release.json"
jq -n --arg sha "$SOURCE_COMMIT" '{object:{type:"commit",sha:$sha}}' > "$FIXTURE/tag.json"
jq -s 'map(.)' "$FIXTURE/release.json" > "$FIXTURE/releases.json"

cat > "$FAKE_BIN/gh" <<'EOF'
#!/bin/sh
set -eu
fixture=${RELEASE_FIXTURE:?}
if [ "$1" = attestation ] && [ "$2" = verify ]; then exit 0; fi
[ "$1" = api ] || exit 2
shift
jq_filter=
endpoint=
while [ "$#" -gt 0 ]; do
    case "$1" in
        -H) shift 2 ;;
        --jq) jq_filter=$2; shift 2 ;;
        *) endpoint=$1; shift ;;
    esac
done
case "$endpoint" in
    */releases/tags/*) source=$fixture/release.json ;;
    */git/ref/tags/*) source=$fixture/tag.json ;;
    */releases/assets/101) source=$fixture/traceknot-update-manifest.json ;;
    */releases/assets/102) source=$fixture/traceknot-v9.8.7.tar.gz ;;
    *) exit 2 ;;
esac
if [ -n "$jq_filter" ]; then jq -r "$jq_filter" "$source"; else cat "$source"; fi
EOF
chmod +x "$FAKE_BIN/gh"

cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/sh
set -eu
fixture=${RELEASE_FIXTURE:?}
headers=
output=
url=
while [ "$#" -gt 0 ]; do
    case "$1" in
        -D) headers=$2; shift 2 ;;
        -o|--output) output=$2; shift 2 ;;
        -H) shift 2 ;;
        --proto|--tlsv1.2) if [ "$1" = --proto ]; then shift 2; else shift; fi ;;
        --fail|--silent|--show-error|--location) shift ;;
        *) url=$1; shift ;;
    esac
done
[ -n "$output" ] || exit 2
case "$url" in
    *'/releases?per_page=100&page=1') source=$fixture/releases.json ;;
    *'/releases/assets/101') source=$fixture/traceknot-update-manifest.json ;;
    *) exit 2 ;;
esac
cp "$source" "$output"
if [ -n "$headers" ]; then printf 'Date: %s\r\n' "$(jq -nr 'now | strftime("%a, %d %b %Y %H:%M:%S GMT")')" > "$headers"; fi
EOF
chmod +x "$FAKE_BIN/curl"

OUTPUT=$TMP_ROOT/evidence
PATH=$FAKE_BIN:$PATH RELEASE_FIXTURE=$FIXTURE \
    sh "$ROOT/scripts/verify-published-release.sh" \
    --tag "$TAG" --source-commit "$SOURCE_COMMIT" --output "$OUTPUT" >/dev/null
jq -e --arg tag "$TAG" --arg commit "$SOURCE_COMMIT" '
  .schemaVersion == "traceknot-release-evidence/v1"
  and .tag == $tag and .sourceCommit == $commit
  and (.checks | to_entries | all(.value == true))
' "$OUTPUT/release-evidence.json" >/dev/null
grep -F "Observing $TAG" "$OUTPUT/updater-check.txt" >/dev/null

# Recording an observation is insufficient when the installed updater reports immediate eligibility.
MALICIOUS=$TMP_ROOT/malicious
mkdir "$MALICIOUS"
tar -xzf "$FIXTURE/$ARCHIVE_NAME" -C "$MALICIOUS"
PAYLOAD=$MALICIOUS/traceknot-v$VERSION
sed 's/Observing %s;/Eligible update: %s;/' \
    "$PAYLOAD/bin/traceknot-update" > "$PAYLOAD/bin/traceknot-update.modified"
mv "$PAYLOAD/bin/traceknot-update.modified" "$PAYLOAD/bin/traceknot-update"
chmod +x "$PAYLOAD/bin/traceknot-update"
tar -czf "$FIXTURE/$ARCHIVE_NAME" -C "$MALICIOUS" "traceknot-v$VERSION"
if command -v sha256sum >/dev/null 2>&1; then
    malicious_sha=$(sha256sum "$FIXTURE/$ARCHIVE_NAME" | cut -d ' ' -f 1)
else
    malicious_sha=$(shasum -a 256 "$FIXTURE/$ARCHIVE_NAME" | cut -d ' ' -f 1)
fi
malicious_size=$(wc -c < "$FIXTURE/$ARCHIVE_NAME" | tr -d ' ')
jq --arg sha "$malicious_sha" --argjson size "$malicious_size" \
    '.artifact.sha256=$sha | .artifact.size=$size' \
    "$FIXTURE/traceknot-update-manifest.json" > "$FIXTURE/manifest-malicious.json"
mv "$FIXTURE/manifest-malicious.json" "$FIXTURE/traceknot-update-manifest.json"
if PATH=$FAKE_BIN:$PATH RELEASE_FIXTURE=$FIXTURE \
    sh "$ROOT/scripts/verify-published-release.sh" \
    --tag "$TAG" --source-commit "$SOURCE_COMMIT" --output "$TMP_ROOT/eligible-rejected" \
    >/dev/null 2>"$TMP_ROOT/eligible-error.log"; then
    printf '%s\n' 'release verifier accepted immediate eligibility after first observation' >&2
    exit 1
fi
test -f "$TMP_ROOT/eligible-rejected/updater-check.txt" || {
    cat "$TMP_ROOT/eligible-error.log" >&2
    printf '%s\n' 'negative eligibility fixture failed before the updater oracle' >&2
    exit 1
}
grep -F "Eligible update: $TAG" "$TMP_ROOT/eligible-rejected/updater-check.txt" >/dev/null

# A tag pointing at any other commit must fail before installation.
jq --arg sha 0000000000000000000000000000000000000000 '.object.sha=$sha' \
    "$FIXTURE/tag.json" > "$FIXTURE/tag-wrong.json"
mv "$FIXTURE/tag.json" "$FIXTURE/tag-good.json"
mv "$FIXTURE/tag-wrong.json" "$FIXTURE/tag.json"
if PATH=$FAKE_BIN:$PATH RELEASE_FIXTURE=$FIXTURE \
    sh "$ROOT/scripts/verify-published-release.sh" \
    --tag "$TAG" --source-commit "$SOURCE_COMMIT" --output "$TMP_ROOT/rejected" >/dev/null 2>&1; then
    printf '%s\n' 'release verifier accepted a mismatched tag commit' >&2
    exit 1
fi
test -f "$TMP_ROOT/rejected/public-release.json"
test -f "$TMP_ROOT/rejected/public-tag.json"

printf '%s\n' 'release verifier smoke test: PASS'
