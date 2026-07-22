#!/bin/sh
# Install the portable Traceknot Skill and host-neutral QA artifacts.

set -eu

PROGRAM=traceknot-install
SOURCE_ROOT=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
MANIFEST_NAME=.traceknot-install-manifest
DRY_RUN=0
PREFIX=

usage() {
    cat <<EOF
Usage: $PROGRAM [--prefix DIR] [--dry-run]

Install Traceknot into an XDG user data directory without sudo.

Options:
  --prefix DIR       install into DIR instead of the default
  --destination DIR  alias for --prefix
  --dry-run, -n      show planned writes without changing the filesystem
  --help, -h         show this help

Default prefix: \${XDG_DATA_HOME:-\$HOME/.local/share}/traceknot
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

if [ -z "$PREFIX" ]; then
    [ -n "${HOME:-}" ] || fail 'HOME is required when --prefix is not supplied'
    PREFIX=${XDG_DATA_HOME:-"$HOME/.local/share"}/traceknot
fi

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

for component in skill contracts adapters system/core; do
    [ -d "$SOURCE_ROOT/$component" ] || fail "missing source component: $component"
done
[ -f "$SOURCE_ROOT/LICENSE" ] || fail 'missing source file: LICENSE'

MANIFEST="$PREFIX_CANON/$MANIFEST_NAME"
if [ -L "$MANIFEST" ]; then
    fail "refusing symlink manifest: $MANIFEST"
fi
if [ -e "$MANIFEST" ]; then
    [ -f "$MANIFEST" ] || fail "manifest is not a regular file: $MANIFEST"
    [ "$(sed -n '1p' "$MANIFEST")" = 'traceknot-install/v1' ] || fail "refusing unrelated manifest: $MANIFEST"
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
    exit 0
fi

mkdir -p "$PREFIX_CANON"
PREFIX_CANON=$(canonical_path "$PREFIX_CANON") || fail 'cannot resolve destination after creation'
[ "$PREFIX_CANON" != "/" ] || fail 'refusing to install into filesystem root'

MANIFEST_TMP="$PREFIX_CANON/$MANIFEST_NAME.tmp.$$"
trap 'rm -f "$MANIFEST_TMP"' 0
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

mv "$MANIFEST_TMP" "$PREFIX_CANON/$MANIFEST_NAME"
trap - 0
printf 'Installed Traceknot to %s\n' "$PREFIX_CANON"
