#!/bin/sh
# Build the deterministic Traceknot release archive and signed-manifest input.

set -eu

PROGRAM=traceknot-package-release
VERSION=
OUTPUT_DIR=dist
SOURCE_COMMIT=

fail() {
    printf '%s: %s\n' "$PROGRAM" "$*" >&2
    exit 2
}

usage() {
    cat <<EOF_USAGE
Usage: $PROGRAM --version X.Y.Z [--output DIR] [--source-commit SHA]
EOF_USAGE
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --version)
            [ "$#" -ge 2 ] || fail '--version requires a value'
            VERSION=$2
            shift 2
            ;;
        --output)
            [ "$#" -ge 2 ] || fail '--output requires a directory'
            OUTPUT_DIR=$2
            shift 2
            ;;
        --source-commit)
            [ "$#" -ge 2 ] || fail '--source-commit requires a SHA'
            SOURCE_COMMIT=$2
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *) fail "unknown argument: $1" ;;
    esac
done

case "$VERSION" in
    ''|*[!0-9.]*) fail 'version must be semantic X.Y.Z' ;;
esac
printf '%s\n' "$VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' ||
    fail 'version must be semantic X.Y.Z without a prerelease suffix'

command -v git >/dev/null 2>&1 || fail 'git is required'
command -v gzip >/dev/null 2>&1 || fail 'gzip is required'
command -v jq >/dev/null 2>&1 || fail 'jq is required'

if [ -z "$SOURCE_COMMIT" ]; then
    SOURCE_COMMIT=$(git rev-parse HEAD)
fi
printf '%s\n' "$SOURCE_COMMIT" | grep -Eq '^[0-9a-f]{40}$' || fail 'source commit must be a full lowercase SHA-1'
[ "$(git rev-parse "$SOURCE_COMMIT^{commit}")" = "$SOURCE_COMMIT" ] || fail 'source commit does not exist'
for required_path in \
    LICENSE \
    skill/SKILL.md \
    skill/bin/traceknot \
    skill/bin/traceknot-skills-update \
    skill/bin/traceknot-update-notice \
    bin/traceknot-update \
    bin/traceknot-skills-update \
    bin/traceknot-update-notice \
    contracts/update-manifest.schema.json
do
    git cat-file -e "$SOURCE_COMMIT:$required_path" 2>/dev/null ||
        fail "source commit is missing required release path: $required_path"
done

TAG=v$VERSION
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    [ "$(git rev-list -n 1 "$TAG")" = "$SOURCE_COMMIT" ] || fail "$TAG does not identify $SOURCE_COMMIT"
fi

mkdir -p "$OUTPUT_DIR"
ARCHIVE_NAME=traceknot-v$VERSION.tar.gz
ARCHIVE=$OUTPUT_DIR/$ARCHIVE_NAME
MANIFEST=$OUTPUT_DIR/traceknot-update-manifest.json
TMP_ARCHIVE=$ARCHIVE.tmp.$$
TMP_MANIFEST=$MANIFEST.tmp.$$
trap 'rm -f "$TMP_ARCHIVE" "$TMP_MANIFEST"' EXIT HUP INT TERM

git archive --format=tar --prefix="traceknot-v$VERSION/" "$SOURCE_COMMIT" | gzip -n -9 > "$TMP_ARCHIVE"

if command -v sha256sum >/dev/null 2>&1; then
    SHA256=$(sha256sum "$TMP_ARCHIVE" | cut -d ' ' -f 1)
elif command -v shasum >/dev/null 2>&1; then
    SHA256=$(shasum -a 256 "$TMP_ARCHIVE" | cut -d ' ' -f 1)
else
    fail 'sha256sum or shasum is required'
fi
SIZE=$(wc -c < "$TMP_ARCHIVE" | tr -d ' ')
PUBLISHED_AT=${TRACEKNOT_PUBLISHED_AT:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}

jq -n \
    --arg schemaVersion 'traceknot-update-manifest/v1' \
    --arg version "$VERSION" \
    --arg releaseTag "$TAG" \
    --arg sourceRepository 'Jin-Doh/traceknot' \
    --arg sourceCommit "$SOURCE_COMMIT" \
    --arg publishedAt "$PUBLISHED_AT" \
    --arg artifactName "$ARCHIVE_NAME" \
    --argjson artifactSize "$SIZE" \
    --arg artifactSha256 "$SHA256" \
    '{
      schemaVersion: $schemaVersion,
      version: $version,
      releaseTag: $releaseTag,
      sourceRepository: $sourceRepository,
      sourceCommit: $sourceCommit,
      publishedAt: $publishedAt,
      artifact: {
        name: $artifactName,
        size: $artifactSize,
        sha256: $artifactSha256
      }
    }' > "$TMP_MANIFEST"

mv "$TMP_ARCHIVE" "$ARCHIVE"
mv "$TMP_MANIFEST" "$MANIFEST"
trap - EXIT HUP INT TERM
printf 'Packaged %s (%s bytes, sha256:%s)\n' "$ARCHIVE" "$SIZE" "$SHA256"
printf 'Wrote %s\n' "$MANIFEST"
