#!/bin/sh
# Install the portable Traceknot Skill and host-neutral QA artifacts.

set -eu

PROGRAM=traceknot-install
SOURCE_ROOT=$(CDPATH='' cd -P "$(dirname "$0")" && pwd)
MANIFEST_NAME=.traceknot-install-manifest
DRY_RUN=0
AUTO_UPDATE=1
AUTO_UPDATE_EXPLICIT=0
PREFIX=
BOOTSTRAP_TMP=
MANIFEST_TMP=
SKILLS_ROOT=
REGISTRATION_PATH=
INSTALL_LOCK_OWNED=0
INSTALL_RECOVERY_LOCK_HELD=0
INSTALL_LOCK_CLAIM=
MANAGED_STATE_RESET=0

try_acquire_install_lock() {
    install_lock=$PREFIX_CANON/.traceknot-update.lock
    INSTALL_LOCK_CLAIM=$PREFIX_CANON/.traceknot-update-lock-claim.$$
    if ! (set -C; printf '%s\n' "$$" > "$INSTALL_LOCK_CLAIM") 2>/dev/null; then
        fail "unsafe update lock claim path: $INSTALL_LOCK_CLAIM"
    fi
    [ -f "$INSTALL_LOCK_CLAIM" ] && [ ! -L "$INSTALL_LOCK_CLAIM" ] ||
        fail "unsafe update lock claim path: $INSTALL_LOCK_CLAIM"
    lock_claim=$INSTALL_LOCK_CLAIM
    if [ ! -e "$install_lock" ] && [ ! -L "$install_lock" ] &&
       ln "$lock_claim" "$install_lock" 2>/dev/null; then
        if [ ! -f "$install_lock" ] || [ -L "$install_lock" ]; then
            rm -f "$lock_claim"
            return 1
        fi
        rm -f "$lock_claim"
        INSTALL_LOCK_CLAIM=
        INSTALL_LOCK_OWNED=1
        return 0
    fi
    rm -f "$lock_claim"
    INSTALL_LOCK_CLAIM=
    return 1
}

acquire_install_lock() {
    try_acquire_install_lock && return
    install_lock=$PREFIX_CANON/.traceknot-update.lock
    recovery_lock=$PREFIX_CANON/.traceknot-update.lock-recovery
    [ -f "$install_lock" ] && [ ! -L "$install_lock" ] ||
        fail "unsafe update lock path: $install_lock"
    lock_pid=$(sed -n '1p' "$install_lock" 2>/dev/null || true)
    case "$lock_pid" in
        ''|*[!0-9]*) fail "update lock has invalid ownership metadata: $install_lock" ;;
    esac
    kill -0 "$lock_pid" 2>/dev/null &&
        fail "another update owns the lock: $install_lock"
    if [ -e "$recovery_lock" ] || [ -L "$recovery_lock" ]; then
        [ -f "$recovery_lock" ] && [ ! -L "$recovery_lock" ] ||
            fail "unsafe stale-lock recovery path: $recovery_lock"
    fi
    if command -v shlock >/dev/null 2>&1; then
        shlock -f "$recovery_lock" -p "$$" ||
            fail "stale-lock recovery is already in progress: $recovery_lock"
        INSTALL_RECOVERY_LOCK_HELD=1
    elif command -v flock >/dev/null 2>&1; then
        if [ ! -e "$recovery_lock" ]; then
            (set -C; : > "$recovery_lock") 2>/dev/null ||
                fail "cannot create stale-lock recovery guard: $recovery_lock"
        fi
        [ -f "$recovery_lock" ] && [ ! -L "$recovery_lock" ] ||
            fail "unsafe stale-lock recovery path: $recovery_lock"
        exec 9>>"$recovery_lock"
        flock -n 9 ||
            fail "stale-lock recovery is already in progress: $recovery_lock"
        INSTALL_RECOVERY_LOCK_HELD=2
    else
        fail 'shlock or flock is required for safe stale-lock recovery'
    fi
    if [ -e "$install_lock" ]; then
        [ -f "$install_lock" ] && [ ! -L "$install_lock" ] ||
            fail "unsafe update lock path during recovery: $install_lock"
        recovered_pid=$(sed -n '1p' "$install_lock" 2>/dev/null || true)
        [ "$recovered_pid" = "$lock_pid" ] ||
            fail 'update lock changed during stale-lock recovery'
        kill -0 "$recovered_pid" 2>/dev/null &&
            fail 'update lock owner became live during recovery'
        rm -f "$install_lock"
    fi
    try_acquire_install_lock ||
        fail 'cannot acquire update lock after stale-lock recovery'
    rm -rf "$recovery_lock"
    INSTALL_RECOVERY_LOCK_HELD=0
}

release_install_lock() {
    [ "$INSTALL_LOCK_OWNED" -eq 1 ] || return 0
    install_lock=$PREFIX_CANON/.traceknot-update.lock
    if [ -f "$install_lock" ] && [ ! -L "$install_lock" ] &&
       [ "$(sed -n '1p' "$install_lock" 2>/dev/null || true)" = "$$" ]; then
        rm -f "$install_lock"
    fi
    INSTALL_LOCK_OWNED=0
}
cleanup() {
    if [ -n "$INSTALL_LOCK_CLAIM" ] && [ -f "$INSTALL_LOCK_CLAIM" ] &&
       [ ! -L "$INSTALL_LOCK_CLAIM" ] &&
       [ "$(sed -n '1p' "$INSTALL_LOCK_CLAIM" 2>/dev/null || true)" = "$$" ]; then
        rm -f "$INSTALL_LOCK_CLAIM"
    fi
    INSTALL_LOCK_CLAIM=
    if [ "$INSTALL_RECOVERY_LOCK_HELD" -ne 0 ]; then
        rm -rf "$PREFIX_CANON/.traceknot-update.lock-recovery"
        INSTALL_RECOVERY_LOCK_HELD=0
    fi
    release_install_lock
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
Usage: $PROGRAM [--prefix DIR] [--dry-run] [--disable-auto-update]

Install Traceknot and register its Skill for OMP and Codex without sudo.

Options:
  --prefix DIR       install into DIR instead of the default
  --destination DIR  alias for --prefix
  --dry-run, -n      show planned writes without changing the filesystem
  --disable-auto-update  install without scheduling automatic update checks
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
        (CDPATH='' cd -P "$canonical_input" && pwd)
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
        --disable-auto-update)
            AUTO_UPDATE=0
            AUTO_UPDATE_EXPLICIT=1
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
    for candidate_component in skill contracts adapters system/core system/runtime system/cli system/presentation bin; do
        [ -d "$candidate_root/$candidate_component" ] || return 1
    done
    [ -f "$candidate_root/LICENSE" ]
    [ -x "$candidate_root/bin/traceknot-update" ]
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


PREVIOUS_MANIFEST=0
if [ -e "$MANIFEST" ]; then
    PREVIOUS_MANIFEST=1
    while IFS= read -r previous_entry; do
        [ -n "$previous_entry" ] || fail 'manifest contains an empty entry'
        case "$previous_entry" in
            LICENSE|skill/*|contracts/*|adapters/*|system/core/*|system/runtime/*|system/cli/*|system/presentation/*|bin/*) ;;
            *) fail "unsafe manifest entry: $previous_entry" ;;
        esac
        case "$previous_entry" in
            *'..'*) fail "unsafe manifest entry: $previous_entry" ;;
        esac
    done <<EOF
$(sed -n '2,$p' "$MANIFEST")
EOF
fi
UPDATE_STATE_DIR=$PREFIX_CANON/.traceknot-update
if [ -e "$UPDATE_STATE_DIR" ] || [ -L "$UPDATE_STATE_DIR" ]; then
    [ -d "$UPDATE_STATE_DIR" ] && [ ! -L "$UPDATE_STATE_DIR" ] ||
        fail "refusing unsafe update state directory: $UPDATE_STATE_DIR"
fi
EXISTING_UPDATE_CONFIG=$PREFIX_CANON/.traceknot-update/config
if [ -e "$EXISTING_UPDATE_CONFIG" ] || [ -L "$EXISTING_UPDATE_CONFIG" ]; then
    [ -f "$EXISTING_UPDATE_CONFIG" ] && [ ! -L "$EXISTING_UPDATE_CONFIG" ] ||
        fail "refusing unsafe update configuration: $EXISTING_UPDATE_CONFIG"
    [ "$(sed -n '1p' "$EXISTING_UPDATE_CONFIG")" = traceknot-update-config/v1 ] ||
        fail "unsupported update configuration: $EXISTING_UPDATE_CONFIG"
    EXISTING_AUTOMATIC=$(sed -n 's/^automatic=//p' "$EXISTING_UPDATE_CONFIG")
    case "$EXISTING_AUTOMATIC" in
        0) AUTO_UPDATE=0 ;;
        1) ;;
        *) fail "invalid automatic update setting: $EXISTING_UPDATE_CONFIG" ;;
    esac
fi
if [ -z "${TRACEKNOT_SKILLS_ROOT+x}" ] &&
   [ -e "$EXISTING_UPDATE_CONFIG" ] && [ ! -L "$EXISTING_UPDATE_CONFIG" ]; then
    PERSISTED_SKILLS_ROOT=$(sed -n 's/^skillsRoot=//p' "$EXISTING_UPDATE_CONFIG")
    if [ -n "$PERSISTED_SKILLS_ROOT" ]; then
        case "$PERSISTED_SKILLS_ROOT" in
            /*) ;;
            *) fail "persisted Skills root must be absolute: $EXISTING_UPDATE_CONFIG" ;;
        esac
        case "$PERSISTED_SKILLS_ROOT" in *'
'*) fail "persisted Skills root contains a line break: $EXISTING_UPDATE_CONFIG" ;; esac
        SKILLS_ROOT=$PERSISTED_SKILLS_ROOT
        SKILLS_ROOT_CANON=$(canonical_path "$SKILLS_ROOT") ||
            fail "cannot resolve persisted Agent Skills directory: $SKILLS_ROOT"
        [ "$SKILLS_ROOT_CANON" != "/" ] ||
            fail 'refusing to register a Skill in filesystem root'
        REGISTRATION_PATH=$SKILLS_ROOT_CANON/traceknot
    fi
fi
if [ -L "$REGISTRATION_PATH" ]; then
    command -v readlink >/dev/null 2>&1 ||
        fail 'readlink is required to verify the existing Skill registration'
    registration_target=$(readlink "$REGISTRATION_PATH")
    case "$registration_target" in
        "$PREFIX_CANON/skill"|"$PREFIX_CANON/current/skill") ;;
        *) fail "refusing unrelated Skill registration: $REGISTRATION_PATH" ;;
    esac
elif [ -e "$REGISTRATION_PATH" ]; then
    fail "refusing unowned Skill registration: $REGISTRATION_PATH; inspect it and remove it only if intended, or choose another TRACEKNOT_SKILLS_ROOT"
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
for component in skill contracts adapters system/core system/runtime system/cli system/presentation bin; do
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
    for component in skill contracts adapters system/core system/runtime system/cli system/presentation bin; do
        while IFS= read -r source_file; do
            [ -n "$source_file" ] || continue
            relative=${source_file#"$SOURCE_ROOT"/}
            printf '  %s -> %s/%s\n' "$source_file" "$PREFIX_CANON" "$relative"
        done <<EOF
$(find "$SOURCE_ROOT/$component" -type f -print)
EOF
    done
    printf '  register %s -> %s/skill\n' "$REGISTRATION_PATH" "$PREFIX_CANON"
    if [ "$AUTO_UPDATE" -eq 1 ]; then
        printf '  enable daily automatic updates after installation\n'
    else
        printf '  leave automatic updates disabled\n'
    fi
    exit 0
fi

mkdir -p "$PREFIX_CANON"
PREFIX_CANON=$(canonical_path "$PREFIX_CANON") || fail 'cannot resolve destination after creation'
[ "$PREFIX_CANON" != "/" ] || fail 'refusing to install into filesystem root'
acquire_install_lock
MANAGED_RELEASES_DIR=$PREFIX_CANON/releases
if [ -e "$PREFIX_CANON/current" ] || [ -L "$PREFIX_CANON/current" ] ||
   [ -e "$PREFIX_CANON/rollback" ] || [ -L "$PREFIX_CANON/rollback" ] ||
   [ -e "$PREFIX_CANON/.traceknot-update/active.json" ] ||
   [ -L "$PREFIX_CANON/.traceknot-update/active.json" ] ||
   [ -e "$PREFIX_CANON/.traceknot-update/rollback-active.json" ] ||
   [ -L "$PREFIX_CANON/.traceknot-update/rollback-active.json" ] ||
   [ -e "$PREFIX_CANON/.traceknot-update/transaction" ] ||
   [ -L "$PREFIX_CANON/.traceknot-update/transaction" ] ||
   [ -e "$PREFIX_CANON/.traceknot-update/transaction-active-before.json" ] ||
   [ -L "$PREFIX_CANON/.traceknot-update/transaction-active-before.json" ] ||
   [ -e "$PREFIX_CANON/.traceknot-update/transaction-rollback-before.json" ] ||
   [ -L "$PREFIX_CANON/.traceknot-update/transaction-rollback-before.json" ] ||
   [ -e "$PREFIX_CANON/.traceknot-update/reinstall-reset" ] ||
   [ -L "$PREFIX_CANON/.traceknot-update/reinstall-reset" ]; then
    if [ -e "$MANAGED_RELEASES_DIR" ] || [ -L "$MANAGED_RELEASES_DIR" ]; then
        [ -d "$MANAGED_RELEASES_DIR" ] && [ ! -L "$MANAGED_RELEASES_DIR" ] ||
            fail "refusing unsafe managed releases directory: $MANAGED_RELEASES_DIR"
    fi
    if [ -e "$PREFIX_CANON/.traceknot-update/reinstall-reset" ] ||
       [ -L "$PREFIX_CANON/.traceknot-update/reinstall-reset" ]; then
        [ -f "$PREFIX_CANON/.traceknot-update/reinstall-reset" ] &&
            [ ! -L "$PREFIX_CANON/.traceknot-update/reinstall-reset" ] &&
            [ "$(sed -n '1p' "$PREFIX_CANON/.traceknot-update/reinstall-reset")" = traceknot-reinstall-reset/v1 ] ||
            fail 'refusing unsafe flat reinstall recovery journal'
    fi
    for managed_link in "$PREFIX_CANON/current" "$PREFIX_CANON/rollback"; do
        if [ -e "$managed_link" ] || [ -L "$managed_link" ]; then
            [ -L "$managed_link" ] ||
                fail "refusing non-symlink managed activation path: $managed_link"
            managed_target=$(readlink "$managed_link")
            case "$managed_target" in
                "$MANAGED_RELEASES_DIR"/*) ;;
                *) fail "managed activation escapes releases directory: $managed_link" ;;
            esac
            [ -d "$managed_target" ] && [ ! -L "$managed_target" ] ||
                fail "managed activation target is unsafe: $managed_target"
        fi
    done
    for managed_metadata in \
        "$PREFIX_CANON/.traceknot-update/active.json" \
        "$PREFIX_CANON/.traceknot-update/rollback-active.json" \
        "$PREFIX_CANON/.traceknot-update/transaction" \
        "$PREFIX_CANON/.traceknot-update/transaction-active-before.json" \
        "$PREFIX_CANON/.traceknot-update/transaction-rollback-before.json"; do
        if [ -e "$managed_metadata" ] || [ -L "$managed_metadata" ]; then
            [ -f "$managed_metadata" ] && [ ! -L "$managed_metadata" ] ||
                fail "refusing unsafe managed metadata path: $managed_metadata"
        fi
    done
    MANAGED_STATE_RESET=1
fi
if [ "$MANAGED_STATE_RESET" -eq 1 ]; then
    command -v sync >/dev/null 2>&1 ||
        fail 'sync is required for a managed-to-flat reinstall'
fi
if [ "$AUTO_UPDATE_EXPLICIT" -eq 0 ]; then
    AUTO_UPDATE=1
    if [ -e "$EXISTING_UPDATE_CONFIG" ] || [ -L "$EXISTING_UPDATE_CONFIG" ]; then
        [ -f "$EXISTING_UPDATE_CONFIG" ] && [ ! -L "$EXISTING_UPDATE_CONFIG" ] ||
            fail "refusing unsafe update configuration after locking: $EXISTING_UPDATE_CONFIG"
        [ "$(sed -n '1p' "$EXISTING_UPDATE_CONFIG")" = traceknot-update-config/v1 ] ||
            fail "unsupported update configuration after locking: $EXISTING_UPDATE_CONFIG"
        EXISTING_AUTOMATIC=$(sed -n 's/^automatic=//p' "$EXISTING_UPDATE_CONFIG")
        case "$EXISTING_AUTOMATIC" in
            0) AUTO_UPDATE=0 ;;
            1) ;;
            *) fail "invalid automatic update setting after locking: $EXISTING_UPDATE_CONFIG" ;;
        esac
    fi
fi

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
for component in skill contracts adapters system/core system/runtime system/cli system/presentation bin; do
    while IFS= read -r source_file; do
        [ -n "$source_file" ] || continue
        relative=${source_file#"$SOURCE_ROOT"/}
        copy_file "$source_file" "$relative"
    done <<EOF
$(find "$SOURCE_ROOT/$component" -type f -print)
EOF
done

if [ "$MANAGED_STATE_RESET" -eq 1 ]; then
    mv "$MANIFEST_TMP" "$PREFIX_CANON/$MANIFEST_NAME"
    MANIFEST_TMP=
fi
if [ "$MANAGED_STATE_RESET" -eq 1 ] &&
   [ ! -e "$PREFIX_CANON/.traceknot-update/reinstall-reset" ] &&
   [ ! -L "$PREFIX_CANON/.traceknot-update/reinstall-reset" ]; then
    reinstall_reset_tmp=$PREFIX_CANON/.traceknot-update/reinstall-reset.tmp.$$
    if ! (set -C; printf '%s\n' traceknot-reinstall-reset/v1 > "$reinstall_reset_tmp") 2>/dev/null; then
        fail 'cannot create flat reinstall recovery journal'
    fi
    mv "$reinstall_reset_tmp" "$PREFIX_CANON/.traceknot-update/reinstall-reset"
    sync
fi
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
if [ "$(readlink "$REGISTRATION_PATH")" != "$PREFIX_CANON/skill" ]; then
    registration_tmp=$REGISTRATION_PATH.tmp.$$
    rm -f "$registration_tmp"
    ln -s "$PREFIX_CANON/skill" "$registration_tmp"
    if ! mv -fh "$registration_tmp" "$REGISTRATION_PATH" 2>/dev/null &&
       ! mv -fT "$registration_tmp" "$REGISTRATION_PATH" 2>/dev/null; then
        rm -f "$registration_tmp"
        fail 'cannot atomically retarget Skill registration'
    fi
fi

if [ -n "$MANIFEST_TMP" ]; then
    mv "$MANIFEST_TMP" "$PREFIX_CANON/$MANIFEST_NAME"
    MANIFEST_TMP=
fi
if [ "$MANAGED_STATE_RESET" -eq 1 ]; then
    rm -f "$PREFIX_CANON/current" "$PREFIX_CANON/rollback" \
        "$PREFIX_CANON/.traceknot-update/active.json" \
        "$PREFIX_CANON/.traceknot-update/rollback-active.json" \
        "$PREFIX_CANON/.traceknot-update/transaction" \
        "$PREFIX_CANON/.traceknot-update/transaction-active-before.json" \
        "$PREFIX_CANON/.traceknot-update/transaction-rollback-before.json"
    rm -rf "$MANAGED_RELEASES_DIR"
    sync
fi
if [ "$AUTO_UPDATE" -eq 1 ]; then
    "$PREFIX_CANON/bin/traceknot-update" enable-install-lock --prefix "$PREFIX_CANON"
else
    "$PREFIX_CANON/bin/traceknot-update" disable-install-lock --prefix "$PREFIX_CANON"
fi
if [ "$MANAGED_STATE_RESET" -eq 1 ]; then
    rm -f "$PREFIX_CANON/.traceknot-update/reinstall-reset"
    sync
fi
release_install_lock
printf 'Installed Traceknot to %s and registered %s\n' "$PREFIX_CANON" "$REGISTRATION_PATH"
