#!/bin/sh
# Install the portable Traceknot Skill and host-neutral QA artifacts.

set -eu

PROGRAM=traceknot-install
SOURCE_ROOT=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
MANIFEST_NAME=.traceknot-install-manifest
DRY_RUN=0
PREFIX=
BOOTSTRAP_TMP=
MANIFEST_TMP=
SKILLS_ROOT=
REGISTRATION_PATH=

cleanup() {
    if [ -n "$MANIFEST_TMP" ]; then
        rm -f "$MANIFEST_TMP"
    fi
    if [ -n "$BOOTSTRAP_TMP" ]; then
        rm -rf "$BOOTSTRAP_TMP"
    fi
}

trap cleanup 0
trap 'exit 1' HUP INT TERM

usage() {
    cat <<EOF
Usage: $PROGRAM [--prefix DIR] [--dry-run]

Install Traceknot and register its Skill for OMP and Codex without sudo.

Options:
  --prefix DIR       install into DIR instead of the default
  --destination DIR  alias for --prefix
  --dry-run, -n      show planned writes without changing the filesystem
  --help, -h         show this help

Default prefix: \${XDG_DATA_HOME:-\$HOME/.local/share}/traceknot
Default Skill registration: \$HOME/.agents/skills/traceknot
Set TRACEKNOT_SKILLS_ROOT to override the Agent Skills directory.
Remote installs download the source archive for TRACEKNOT_REF (default: main).
Set TRACEKNOT_REF to a tag or commit to pin the installed revision.
EOF
}

fail() {
    printf '%s: %s\n' "$PROGRAM" "$*" >&2
    exit 2
}

canonical_path() {
    canonical_input=$1
    case "$canonical_input" in
        /*) ;;
        *) return 1 ;;
    esac

    if [ -d "$canonical_input" ]; then
        (CDPATH= cd -P "$canonical_input" && pwd)
        return
    fi

    canonical_parent=$(dirname "$canonical_input")
    canonical_name=$(basename "$canonical_input")
    canonical_parent=$(canonical_path "$canonical_parent") || return 1
    case "$canonical_name" in
        .) printf '%s\n' "$canonical_parent" ;;
        ..) canonical_path "$canonical_parent/.." ;;
        *) printf '%s/%s\n' "$canonical_parent" "$canonical_name" ;;
    esac
}

path_is_under() {
    case "$1/" in
        "$2/"*) return 0 ;;
        *) return 1 ;;
    esac
}

reject_symlink_components() {
    checked_path=$1
    while [ "$checked_path" != "$PREFIX_CANON" ]; do
        if [ -L "$checked_path" ]; then
            fail "refusing symlink in destination path: $checked_path"
        fi
        checked_parent=$(dirname "$checked_path")
        [ "$checked_parent" != "$checked_path" ] || fail "destination path escapes prefix"
        checked_path=$checked_parent
    done
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --prefix|--destination)
            [ "$#" -ge 2 ] || fail "$1 requires a directory"
            PREFIX=$2
            shift 2
            ;;
        --prefix=*|--destination=*)
            PREFIX=${1#*=}
            [ -n "$PREFIX" ] || fail "$1 requires a directory"
            shift
            ;;
        --dry-run|-n)
            DRY_RUN=1
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            usage >&2
            fail "unknown argument: $1"
            ;;
    esac
done

source_is_complete() {
    candidate_root=$1
    for candidate_component in skill contracts adapters system/core; do
        [ -d "$candidate_root/$candidate_component" ] || return 1
    done
    [ -f "$candidate_root/LICENSE" ]
}

bootstrap_source() {
    source_is_complete "$SOURCE_ROOT" && return

    command -v curl >/dev/null 2>&1 || fail 'curl is required for remote installation'
    command -v tar >/dev/null 2>&1 || fail 'tar is required for remote installation'

    remote_ref=${TRACEKNOT_REF:-main}
    case "$remote_ref" in
        ''|/*|-*|*..*|*//*|*[!A-Za-z0-9._/-]*) fail "unsafe TRACEKNOT_REF: $remote_ref" ;;
    esac

    BOOTSTRAP_TMP=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-bootstrap.XXXXXX") ||
        fail 'cannot create temporary bootstrap directory'
    archive_path=$BOOTSTRAP_TMP/source.tar.gz
    archive_url=https://codeload.github.com/Jin-Doh/traceknot/tar.gz/$remote_ref

    printf 'Downloading Traceknot source (%s)...\n' "$remote_ref"
    curl --proto '=https' --tlsv1.2 -fL "$archive_url" -o "$archive_path" ||
        fail "cannot download Traceknot source: $archive_url"
    tar -xzf "$archive_path" -C "$BOOTSTRAP_TMP" ||
        fail 'cannot extract Traceknot source archive'

    discovered_root=
    for candidate_root in "$BOOTSTRAP_TMP"/*; do
        if source_is_complete "$candidate_root"; then
            [ -z "$discovered_root" ] || fail 'archive contains multiple Traceknot source roots'
            discovered_root=$candidate_root
        fi
    done
    [ -n "$discovered_root" ] || fail 'downloaded archive does not contain the required Traceknot files'
    SOURCE_ROOT=$discovered_root
}

bootstrap_source

if [ -z "$PREFIX" ]; then
    [ -n "${HOME:-}" ] || fail 'HOME is required when --prefix is not supplied'
    PREFIX=${XDG_DATA_HOME:-"$HOME/.local/share"}/traceknot
fi

[ -n "${HOME:-}" ] || fail 'HOME is required to register the Traceknot Skill'
SKILLS_ROOT=${TRACEKNOT_SKILLS_ROOT:-"$HOME/.agents/skills"}
case "$SKILLS_ROOT" in
    /*) ;;
    *) fail "Agent Skills directory must be an absolute path: $SKILLS_ROOT" ;;
esac

case "$PREFIX" in
    /*) ;;
    *) fail "destination must be an absolute path: $PREFIX" ;;
esac

SOURCE_CANON=$(canonical_path "$SOURCE_ROOT") || fail "cannot resolve source directory"
PREFIX_CANON=$(canonical_path "$PREFIX") || fail "cannot resolve destination: $PREFIX"
[ "$PREFIX_CANON" != "/" ] || fail 'refusing to install into filesystem root'

if [ "$PREFIX_CANON" = "$SOURCE_CANON" ] || path_is_under "$PREFIX_CANON" "$SOURCE_CANON" || path_is_under "$SOURCE_CANON" "$PREFIX_CANON"; then
    fail 'destination must not overlap the cloned Traceknot source tree'
fi

if [ -e "$PREFIX" ] && [ ! -d "$PREFIX" ]; then
    fail "destination is not a directory: $PREFIX"
fi
if [ -L "$PREFIX" ]; then
    fail "refusing symlink destination: $PREFIX"
fi

source_is_complete "$SOURCE_ROOT" || fail 'Traceknot source is incomplete'

SKILLS_ROOT_CANON=$(canonical_path "$SKILLS_ROOT") || fail "cannot resolve Agent Skills directory: $SKILLS_ROOT"
[ "$SKILLS_ROOT_CANON" != "/" ] || fail 'refusing to register a Skill in filesystem root'
REGISTRATION_PATH=$SKILLS_ROOT_CANON/traceknot

MANIFEST="$PREFIX_CANON/$MANIFEST_NAME"
if [ -L "$MANIFEST" ]; then
    fail "refusing symlink manifest: $MANIFEST"
fi
if [ -e "$MANIFEST" ]; then
    [ -f "$MANIFEST" ] || fail "manifest is not a regular file: $MANIFEST"
    [ "$(sed -n '1p' "$MANIFEST")" = 'traceknot-install/v1' ] || fail "refusing unrelated manifest: $MANIFEST"
fi

if [ -L "$REGISTRATION_PATH" ]; then
    command -v readlink >/dev/null 2>&1 || fail 'readlink is required to verify the existing Skill registration'
    [ "$(readlink "$REGISTRATION_PATH")" = "$PREFIX_CANON/skill" ] ||
        fail "refusing unrelated Skill registration: $REGISTRATION_PATH"
elif [ -e "$REGISTRATION_PATH" ]; then
    fail "refusing to overwrite unowned Skill registration: $REGISTRATION_PATH"
fi

PREVIOUS_MANIFEST=0
if [ -e "$MANIFEST" ]; then
    PREVIOUS_MANIFEST=1
    while IFS= read -r previous_entry; do
        [ -n "$previous_entry" ] || fail 'manifest contains an empty entry'
        case "$previous_entry" in
            LICENSE|skill/*|contracts/*|adapters/*|system/core/*) ;;
            *) fail "unsafe manifest entry: $previous_entry" ;;
        esac
        case "$previous_entry" in
            *'..'*) fail "unsafe manifest entry: $previous_entry" ;;
        esac
    done <<EOF
$(sed -n '2,$p' "$MANIFEST")
EOF
fi

manifest_owns() {
    ownership_entry=$1
    [ "$PREVIOUS_MANIFEST" -eq 1 ] || return 1
    while IFS= read -r previous_entry; do
        [ "$previous_entry" = "$ownership_entry" ] && return 0
    done <<EOF
$(sed -n '2,$p' "$MANIFEST")
EOF
    return 1
}

check_file_target() {
    source_relative=$1
    destination_file=$PREFIX_CANON/$source_relative
    reject_symlink_components "$destination_file"
    if [ -L "$destination_file" ]; then
        fail "refusing symlink destination file: $destination_file"
    fi
    if [ -e "$destination_file" ]; then
        [ -f "$destination_file" ] || fail "destination artifact is not a regular file: $destination_file"
        manifest_owns "$source_relative" || fail "refusing to overwrite unowned file: $destination_file"
    fi
}

check_file_target LICENSE
for component in skill contracts adapters system/core; do
    while IFS= read -r source_file; do
        [ -n "$source_file" ] || continue
        relative=${source_file#"$SOURCE_ROOT"/}
        check_file_target "$relative"
    done <<EOF
$(find "$SOURCE_ROOT/$component" -type f -print)
EOF
done

if [ "$DRY_RUN" -eq 1 ]; then
    printf 'Would install Traceknot to %s\n' "$PREFIX_CANON"
    printf '  %s -> %s/LICENSE\n' "$SOURCE_ROOT/LICENSE" "$PREFIX_CANON"
    for component in skill contracts adapters system/core; do
        while IFS= read -r source_file; do
            [ -n "$source_file" ] || continue
            relative=${source_file#"$SOURCE_ROOT"/}
            printf '  %s -> %s/%s\n' "$source_file" "$PREFIX_CANON" "$relative"
        done <<EOF
$(find "$SOURCE_ROOT/$component" -type f -print)
EOF
    done
    printf '  register %s -> %s/skill\n' "$REGISTRATION_PATH" "$PREFIX_CANON"
    exit 0
fi

mkdir -p "$PREFIX_CANON"
PREFIX_CANON=$(canonical_path "$PREFIX_CANON") || fail 'cannot resolve destination after creation'
[ "$PREFIX_CANON" != "/" ] || fail 'refusing to install into filesystem root'

MANIFEST_TMP="$PREFIX_CANON/$MANIFEST_NAME.tmp.$$"
printf '%s\n' 'traceknot-install/v1' > "$MANIFEST_TMP"

copy_file() {
    source_file=$1
    relative=$2
    destination_file=$PREFIX_CANON/$relative
    reject_symlink_components "$destination_file"
    if [ -L "$destination_file" ]; then
        fail "refusing symlink destination file: $destination_file"
    fi
    destination_parent=$(dirname "$destination_file")
    mkdir -p "$destination_parent"
    reject_symlink_components "$destination_file"
    cp -p "$source_file" "$destination_file"
    printf '%s\n' "$relative" >> "$MANIFEST_TMP"
}

copy_file "$SOURCE_ROOT/LICENSE" LICENSE
for component in skill contracts adapters system/core; do
    while IFS= read -r source_file; do
        [ -n "$source_file" ] || continue
        relative=${source_file#"$SOURCE_ROOT"/}
        copy_file "$source_file" "$relative"
    done <<EOF
$(find "$SOURCE_ROOT/$component" -type f -print)
EOF
done

if [ ! -L "$REGISTRATION_PATH" ]; then
    if [ -L "$SKILLS_ROOT" ]; then
        fail "refusing symlink Agent Skills directory: $SKILLS_ROOT"
    fi
    mkdir -p "$SKILLS_ROOT_CANON"
    SKILLS_ROOT_CANON=$(canonical_path "$SKILLS_ROOT_CANON") ||
        fail 'cannot resolve Agent Skills directory after creation'
    REGISTRATION_PATH=$SKILLS_ROOT_CANON/traceknot
    [ ! -e "$REGISTRATION_PATH" ] && [ ! -L "$REGISTRATION_PATH" ] ||
        fail "Skill registration appeared during installation: $REGISTRATION_PATH"
    ln -s "$PREFIX_CANON/skill" "$REGISTRATION_PATH"
fi

mv "$MANIFEST_TMP" "$PREFIX_CANON/$MANIFEST_NAME"
MANIFEST_TMP=
printf 'Installed Traceknot to %s and registered %s\n' "$PREFIX_CANON" "$REGISTRATION_PATH"
