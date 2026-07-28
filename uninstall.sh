#!/bin/sh
# Remove only files recorded by the portable Traceknot installer.

set -eu

PROGRAM=traceknot-uninstall
LOCAL_SOURCE=0
SOURCE_ROOT=
case "$0" in
    */*)
        LOCAL_SOURCE=1
        SOURCE_ROOT=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
        ;;
esac
MANIFEST_NAME=.traceknot-install-manifest
DRY_RUN=0
PREFIX=
SKILLS_ROOT=
REGISTRATION_PATH=
REGISTRATION_OWNED=0

usage() {
    cat <<EOF
Usage: $PROGRAM [--prefix DIR] [--dry-run]

Remove files and the OMP/Codex Skill registration installed by Traceknot.

Options:
  --prefix DIR       uninstall from DIR instead of the default
  --destination DIR  alias for --prefix
  --dry-run, -n      show planned removals without changing the filesystem
  --help, -h         show this help

Default prefix: \${XDG_DATA_HOME:-\$HOME/.local/share}/traceknot
Default Skill registration: \$HOME/.agents/skills/traceknot
Set TRACEKNOT_SKILLS_ROOT to override the Agent Skills directory.
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

validate_entry() {
    manifest_entry=$1
    case "$manifest_entry" in
        LICENSE|skill/*|contracts/*|adapters/*|system/core/*|bin/*) ;;
        /*|../*|*/../*|*/..|.|./*|*/./*) fail "unsafe manifest entry: $manifest_entry" ;;
        *) fail "unknown manifest entry: $manifest_entry" ;;
    esac
    case "$manifest_entry" in
        *'..'*) fail "unsafe manifest entry: $manifest_entry" ;;
    esac

    entry_path=$PREFIX_CANON/$manifest_entry
    reject_symlink_components "$entry_path"
    if [ -L "$entry_path" ]; then
        fail "refusing symlink artifact: $entry_path"
    fi
    if [ -d "$entry_path" ]; then
        fail "refusing to remove directory artifact: $entry_path"
    fi

    entry_canon=$(canonical_path "$entry_path") || fail "cannot resolve manifest entry: $manifest_entry"
    path_is_under "$entry_canon" "$PREFIX_CANON" || fail "manifest entry escapes prefix: $manifest_entry"
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

[ -n "${HOME:-}" ] || fail 'HOME is required to locate the Traceknot Skill registration'
SKILLS_ROOT=${TRACEKNOT_SKILLS_ROOT:-"$HOME/.agents/skills"}
case "$SKILLS_ROOT" in
    /*) ;;
    *) fail "Agent Skills directory must be an absolute path: $SKILLS_ROOT" ;;
esac

case "$PREFIX" in
    /*) ;;
    *) fail "destination must be an absolute path: $PREFIX" ;;
esac

PREFIX_CANON=$(canonical_path "$PREFIX") || fail "cannot resolve destination: $PREFIX"
[ "$PREFIX_CANON" != "/" ] || fail 'refusing to uninstall from filesystem root'

if [ "$LOCAL_SOURCE" -eq 1 ]; then
    SOURCE_CANON=$(canonical_path "$SOURCE_ROOT") || fail "cannot resolve source directory"
    if [ "$PREFIX_CANON" = "$SOURCE_CANON" ] || path_is_under "$PREFIX_CANON" "$SOURCE_CANON" || path_is_under "$SOURCE_CANON" "$PREFIX_CANON"; then
        fail 'destination must not overlap the cloned Traceknot source tree'
    fi
fi
if [ -e "$PREFIX" ] && [ ! -d "$PREFIX" ]; then
    fail "destination is not a directory: $PREFIX"
fi
if [ -L "$PREFIX" ]; then
    fail "refusing symlink destination: $PREFIX"
fi

MANIFEST="$PREFIX_CANON/$MANIFEST_NAME"
if [ ! -e "$MANIFEST" ]; then
    printf 'Traceknot is not installed at %s\n' "$PREFIX_CANON"
    exit 0
fi
[ -f "$MANIFEST" ] || fail "manifest is not a regular file: $MANIFEST"
[ "$(sed -n '1p' "$MANIFEST")" = 'traceknot-install/v1' ] || fail "refusing unrelated manifest: $MANIFEST"

SKILLS_ROOT_CANON=$(canonical_path "$SKILLS_ROOT") || fail "cannot resolve Agent Skills directory: $SKILLS_ROOT"
[ "$SKILLS_ROOT_CANON" != "/" ] || fail 'refusing to inspect a Skill registration in filesystem root'
REGISTRATION_PATH=$SKILLS_ROOT_CANON/traceknot
if [ -L "$REGISTRATION_PATH" ]; then
    command -v readlink >/dev/null 2>&1 || fail 'readlink is required to verify the Skill registration'
    registration_target=$(readlink "$REGISTRATION_PATH")
    if [ "$registration_target" = "$PREFIX_CANON/skill" ] ||
       [ "$registration_target" = "$PREFIX_CANON/current/skill" ]; then
        REGISTRATION_OWNED=1
    fi
fi

# Validate every entry before deleting any file, so a malformed manifest is harmless.
while IFS= read -r manifest_entry; do
    [ -n "$manifest_entry" ] || fail 'manifest contains an empty entry'
    validate_entry "$manifest_entry"
done <<EOF
$(sed -n '2,$p' "$MANIFEST")
EOF

if [ "$DRY_RUN" -eq 1 ]; then
    printf 'Would uninstall Traceknot from %s\n' "$PREFIX_CANON"
    while IFS= read -r manifest_entry; do
        printf '  remove %s/%s\n' "$PREFIX_CANON" "$manifest_entry"
    done <<EOF
$(sed -n '2,$p' "$MANIFEST")
EOF
    printf '  remove %s\n' "$MANIFEST"
    if [ "$REGISTRATION_OWNED" -eq 1 ]; then
        printf '  remove Skill registration %s\n' "$REGISTRATION_PATH"
    fi
    if [ -e "$PREFIX_CANON/.traceknot-update" ] || [ -e "$PREFIX_CANON/releases" ] ||
       [ -L "$PREFIX_CANON/current" ] || [ -L "$PREFIX_CANON/rollback" ]; then
        printf '  remove updater state and managed release directories\n'
    fi
    exit 0
fi

if [ -x "$PREFIX_CANON/bin/traceknot-update" ]; then
    "$PREFIX_CANON/bin/traceknot-update" disable --prefix "$PREFIX_CANON" >/dev/null
fi
if [ "$REGISTRATION_OWNED" -eq 1 ]; then
    rm -f "$REGISTRATION_PATH"
fi

while IFS= read -r manifest_entry; do
    entry_path=$PREFIX_CANON/$manifest_entry
    if [ -e "$entry_path" ]; then
        rm -f "$entry_path"
    fi
done <<EOF
$(sed -n '2,$p' "$MANIFEST")
EOF
if [ -L "$PREFIX_CANON/current" ]; then
    rm -f "$PREFIX_CANON/current"
fi
if [ -L "$PREFIX_CANON/rollback" ]; then
    rm -f "$PREFIX_CANON/rollback"
fi
if [ -e "$PREFIX_CANON/.traceknot-update" ]; then
    [ -d "$PREFIX_CANON/.traceknot-update" ] && [ ! -L "$PREFIX_CANON/.traceknot-update" ] ||
        fail 'refusing unsafe updater state path'
    rm -rf "$PREFIX_CANON/.traceknot-update"
fi
if [ -e "$PREFIX_CANON/releases" ]; then
    [ -d "$PREFIX_CANON/releases" ] && [ ! -L "$PREFIX_CANON/releases" ] ||
        fail 'refusing unsafe releases path'
    rm -rf "$PREFIX_CANON/releases"
fi
rm -f "$MANIFEST"
printf 'Uninstalled Traceknot from %s and removed its owned Skill registration\n' "$PREFIX_CANON"
