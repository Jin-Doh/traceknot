#!/bin/sh
# Verify a published Traceknot release through its public GitHub surfaces.

set -eu

PROGRAM=traceknot-verify-published-release
REPOSITORY=Jin-Doh/traceknot
SIGNER_WORKFLOW=Jin-Doh/traceknot/.github/workflows/release.yml
TAG=
EXPECTED_COMMIT=
OUTPUT_DIR=release-evidence

fail() {
    printf '%s: %s\n' "$PROGRAM" "$*" >&2
    exit 2
}

usage() {
    cat <<EOF
Usage: $PROGRAM --tag vX.Y.Z --source-commit SHA [--output DIR]
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --tag) [ "$#" -ge 2 ] || fail '--tag requires a value'; TAG=$2; shift 2 ;;
        --source-commit) [ "$#" -ge 2 ] || fail '--source-commit requires a value'; EXPECTED_COMMIT=$2; shift 2 ;;
        --output) [ "$#" -ge 2 ] || fail '--output requires a directory'; OUTPUT_DIR=$2; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) fail "unknown argument: $1" ;;
    esac
done

printf '%s\n' "$TAG" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' ||
    fail 'tag must be vX.Y.Z without a prerelease suffix'
printf '%s\n' "$EXPECTED_COMMIT" | grep -Eq '^[0-9a-f]{40}$' ||
    fail 'source commit must be a full lowercase SHA-1'
for utility in bun curl gh jq tar; do
    command -v "$utility" >/dev/null 2>&1 || fail "$utility is required"
done
if command -v sha256sum >/dev/null 2>&1; then
    sha256_file() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
    sha256_file() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
    fail 'sha256sum or shasum is required'
fi

mkdir -p "$OUTPUT_DIR"
CDPATH=
export CDPATH
OUTPUT_DIR=$(cd -P -- "$OUTPUT_DIR" && pwd)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-release-verify.XXXXXX")
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT HUP INT TERM

RELEASE_JSON=$TMP_ROOT/release.json
MANIFEST=$TMP_ROOT/traceknot-update-manifest.json
ARCHIVE=$TMP_ROOT/archive.tar.gz
TAG_JSON=$TMP_ROOT/tag.json

gh api -H 'Accept: application/vnd.github+json' \
    "/repos/$REPOSITORY/releases/tags/$TAG" > "$RELEASE_JSON"
cp "$RELEASE_JSON" "$OUTPUT_DIR/public-release.json"
jq -e --arg tag "$TAG" '
  .tag_name == $tag and .draft == false and .prerelease == false and .immutable == true
  and ([.assets[] | select(.name == "traceknot-update-manifest.json")] | length == 1)
' "$RELEASE_JSON" >/dev/null || fail 'release is missing, mutable, non-stable, or has an invalid manifest asset set'

gh api -H 'Accept: application/vnd.github+json' \
    "/repos/$REPOSITORY/git/ref/tags/$TAG" > "$TAG_JSON"
cp "$TAG_JSON" "$OUTPUT_DIR/public-tag.json"
TAG_OBJECT_TYPE=$(jq -r .object.type "$TAG_JSON")
TAG_OBJECT_SHA=$(jq -r .object.sha "$TAG_JSON")
case "$TAG_OBJECT_TYPE" in
    commit) TAG_COMMIT=$TAG_OBJECT_SHA ;;
    tag)
        TAG_COMMIT=$(gh api -H 'Accept: application/vnd.github+json' \
            "/repos/$REPOSITORY/git/tags/$TAG_OBJECT_SHA" --jq '.object.sha')
        ;;
    *) fail "unsupported tag object type: $TAG_OBJECT_TYPE" ;;
esac
[ "$TAG_COMMIT" = "$EXPECTED_COMMIT" ] || fail 'published tag does not identify the expected source commit'

MANIFEST_ASSET_ID=$(jq -r '[.assets[] | select(.name == "traceknot-update-manifest.json")][0].id' "$RELEASE_JSON")
gh api -H 'Accept: application/octet-stream' \
    "/repos/$REPOSITORY/releases/assets/$MANIFEST_ASSET_ID" > "$MANIFEST"
cp "$MANIFEST" "$OUTPUT_DIR/traceknot-update-manifest.json"
bun x --no-install ajv validate --spec=draft2020 \
    -s contracts/update-manifest.schema.json -d "$MANIFEST" >/dev/null

VERSION=${TAG#v}
ARTIFACT_NAME=traceknot-v$VERSION.tar.gz
jq -e --arg tag "$TAG" --arg version "$VERSION" --arg repository "$REPOSITORY" \
    --arg commit "$EXPECTED_COMMIT" --arg artifact "$ARTIFACT_NAME" '
  .releaseTag == $tag and .version == $version and .sourceRepository == $repository
  and .sourceCommit == $commit and .artifact.name == $artifact
' "$MANIFEST" >/dev/null || fail 'manifest identity does not match the published release'
[ "$(jq -r --arg name "$ARTIFACT_NAME" '[.assets[] | select(.name == $name)] | length' "$RELEASE_JSON")" -eq 1 ] ||
    fail 'release must contain exactly one expected archive asset'
ARTIFACT_ASSET_ID=$(jq -r --arg name "$ARTIFACT_NAME" '[.assets[] | select(.name == $name)][0].id' "$RELEASE_JSON")
gh api -H 'Accept: application/octet-stream' \
    "/repos/$REPOSITORY/releases/assets/$ARTIFACT_ASSET_ID" > "$ARCHIVE"

EXPECTED_SIZE=$(jq -r .artifact.size "$MANIFEST")
EXPECTED_SHA=$(jq -r .artifact.sha256 "$MANIFEST")
[ "$(wc -c < "$ARCHIVE" | tr -d ' ')" = "$EXPECTED_SIZE" ] || fail 'public archive size does not match the manifest'
[ "$(sha256_file "$ARCHIVE")" = "$EXPECTED_SHA" ] || fail 'public archive digest does not match the manifest'

attempt=1
while ! gh attestation verify "$ARCHIVE" \
    --repo "$REPOSITORY" \
    --signer-workflow "$SIGNER_WORKFLOW" \
    --source-ref "refs/tags/$TAG" \
    --source-digest "$EXPECTED_COMMIT" \
    --deny-self-hosted-runners >/dev/null 2>&1; do
    [ "$attempt" -lt 6 ] || fail 'public artifact provenance verification failed'
    sleep 10
    attempt=$((attempt + 1))
done

STAGING=$TMP_ROOT/staging
mkdir "$STAGING"
tar -tzf "$ARCHIVE" | while IFS= read -r entry; do
    case "$entry" in /*|../*|*/../*|*/..|..) fail "unsafe archive entry: $entry" ;; esac
done
tar -xzf "$ARCHIVE" -C "$STAGING" --strip-components 1
if find "$STAGING" -type l -print | grep . >/dev/null; then fail 'release archive contains a symbolic link'; fi
if find "$STAGING" ! -type f ! -type d -print | grep . >/dev/null; then fail 'release archive contains a special filesystem entry'; fi
[ -x "$STAGING/install.sh" ] || fail 'published archive is missing install.sh'
[ -x "$STAGING/bin/traceknot-update" ] || fail 'published archive is missing traceknot-update'

PREFIX=$TMP_ROOT/prefix
SKILLS_ROOT=$TMP_ROOT/skills
TRACEKNOT_SKILLS_ROOT=$SKILLS_ROOT sh "$STAGING/install.sh" \
    --prefix "$PREFIX" --disable-auto-update >/dev/null
TRACEKNOT_SKILLS_ROOT=$SKILLS_ROOT "$PREFIX/bin/traceknot-update" check --prefix "$PREFIX" \
    > "$OUTPUT_DIR/updater-check.txt"
grep -F "Observing $TAG;" "$OUTPUT_DIR/updater-check.txt" >/dev/null ||
    fail 'clean updater check did not keep the new release in observation'
if grep -F "Eligible update: $TAG" "$OUTPUT_DIR/updater-check.txt" >/dev/null; then
    fail 'clean updater check made the new release immediately eligible'
fi
MANIFEST_SHA=$(sha256_file "$MANIFEST")
OBSERVATION=$(grep "^$MANIFEST_SHA$(printf '\t').*$(printf '\t')$TAG$(printf '\t')$EXPECTED_SHA$" \
    "$PREFIX/.traceknot-update/observations.tsv") ||
    fail 'clean updater check did not record the published release observation'
FIRST_SEEN_EPOCH=$(printf '%s\n' "$OBSERVATION" | cut -f 2)

RELEASE_URL=$(jq -r .html_url "$RELEASE_JSON")
PUBLISHED_AT=$(jq -r .published_at "$RELEASE_JSON")
VERIFIED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
ELIGIBLE_AFTER=$(jq -nr --arg value "$PUBLISHED_AT" --argjson firstSeen "$FIRST_SEEN_EPOCH" '
  ($value | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) as $published
  | ([$published, $firstSeen] | max) + 604801 | todateiso8601
')
jq -n \
    --arg schemaVersion 'traceknot-release-evidence/v1' \
    --arg tag "$TAG" --arg sourceCommit "$EXPECTED_COMMIT" \
    --arg releaseUrl "$RELEASE_URL" --arg publishedAt "$PUBLISHED_AT" \
    --argjson firstSeenEpoch "$FIRST_SEEN_EPOCH" \
    --arg verifiedAt "$VERIFIED_AT" --arg eligibleAfter "$ELIGIBLE_AFTER" \
    --arg artifactName "$ARTIFACT_NAME" --arg artifactSha256 "$EXPECTED_SHA" \
    --arg manifestSha256 "$MANIFEST_SHA" \
    '{schemaVersion:$schemaVersion,tag:$tag,sourceCommit:$sourceCommit,releaseUrl:$releaseUrl,
      publishedAt:$publishedAt,firstSeenEpoch:$firstSeenEpoch,
      verifiedAt:$verifiedAt,eligibleAfter:$eligibleAfter,
      artifact:{name:$artifactName,sha256:$artifactSha256},manifestSha256:$manifestSha256,
      checks:{immutable:true,identity:true,schema:true,digest:true,provenance:true,
              archiveSafety:true,cleanInstall:true,updaterObservation:true}}' \
    > "$OUTPUT_DIR/release-evidence.json"
printf 'Verified published release %s (%s)\n' "$TAG" "$EXPECTED_SHA"
