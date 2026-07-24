#!/bin/sh
# Targeted smoke coverage for the portable Traceknot installer pair.

set -eu

ROOT=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-installer.XXXXXX")
trap 'rm -rf "$TMP_DIR"' 0 HUP INT TERM
HOME=$TMP_DIR/home
TRACEKNOT_SKILLS_ROOT=$HOME/.agents/skills
export HOME TRACEKNOT_SKILLS_ROOT
mkdir -p "$HOME"

PREFIX=$TMP_DIR/prefix
mkdir -p "$PREFIX"
printf '%s\n' keep-me > "$PREFIX/unrelated-sentinel.txt"

CONFLICT_PREFIX=$TMP_DIR/conflict
mkdir -p "$CONFLICT_PREFIX/skill"
printf '%s\n' do-not-overwrite > "$CONFLICT_PREFIX/skill/SKILL.md"
if sh "$ROOT/install.sh" --prefix "$CONFLICT_PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'unowned artifact unexpectedly overwritten' >&2
    exit 1
fi
test "$(cat "$CONFLICT_PREFIX/skill/SKILL.md")" = do-not-overwrite

# An unrelated harness registration must never be overwritten.
REGISTRATION_PATH=$TRACEKNOT_SKILLS_ROOT/traceknot
mkdir -p "$TRACEKNOT_SKILLS_ROOT"
printf '%s\n' do-not-overwrite > "$REGISTRATION_PATH"
if sh "$ROOT/install.sh" --prefix "$TMP_DIR/registration-conflict" >/dev/null 2>&1; then
    printf '%s\n' 'unowned Skill registration unexpectedly overwritten' >&2
    exit 1
fi
test "$(cat "$REGISTRATION_PATH")" = do-not-overwrite
rm -f "$REGISTRATION_PATH"

sh "$ROOT/install.sh" --prefix "$PREFIX"
PREFIX_CANON=$(CDPATH= cd -P "$PREFIX" && pwd)
test -f "$PREFIX/LICENSE"
test -f "$PREFIX/skill/SKILL.md"
test -f "$PREFIX/skill/references/test-process.md"
test -f "$PREFIX/contracts/verdict.schema.json"
test -f "$PREFIX/contracts/verification-request.schema.json"
test -f "$PREFIX/adapters/codex/capability.json"
test -f "$PREFIX/adapters/claude-code/capability.json"
test -f "$PREFIX/system/core/qa-core.ts"
test -f "$PREFIX/system/core/qa-core.test.ts"
test -f "$PREFIX/.traceknot-install-manifest"
test -L "$REGISTRATION_PATH"
test "$(readlink "$REGISTRATION_PATH")" = "$PREFIX_CANON/skill"
test "$(cat "$PREFIX/unrelated-sentinel.txt")" = keep-me

# Reinstalling over the same prefix must succeed and preserve unrelated files.
sh "$ROOT/install.sh" --prefix "$PREFIX"
test -f "$PREFIX/system/core/qa-core.ts"
test "$(cat "$PREFIX/unrelated-sentinel.txt")" = keep-me
test -L "$REGISTRATION_PATH"
test "$(readlink "$REGISTRATION_PATH")" = "$PREFIX_CANON/skill"

# Preview modes must not create or remove anything.
PREVIEW_PREFIX=$TMP_DIR/preview
TRACEKNOT_SKILLS_ROOT=$TMP_DIR/preview-skills sh "$ROOT/install.sh" --prefix "$PREVIEW_PREFIX" --dry-run >/dev/null
test ! -e "$PREVIEW_PREFIX"
sh "$ROOT/uninstall.sh" --prefix "$PREFIX" --dry-run >/dev/null
test -f "$PREFIX/system/core/qa-core.ts"
test -f "$PREFIX/.traceknot-install-manifest"
test -L "$REGISTRATION_PATH"

sh "$ROOT/uninstall.sh" --prefix "$PREFIX"
test ! -e "$PREFIX/LICENSE"
test ! -e "$PREFIX/skill/SKILL.md"
test ! -e "$PREFIX/contracts/verdict.schema.json"
test ! -e "$PREFIX/adapters/codex/capability.json"
test ! -e "$PREFIX/system/core/qa-core.ts"
test ! -e "$PREFIX/.traceknot-install-manifest"
test ! -e "$REGISTRATION_PATH"
test ! -L "$REGISTRATION_PATH"
test "$(cat "$PREFIX/unrelated-sentinel.txt")" = keep-me

# A second uninstall is intentionally harmless.
sh "$ROOT/uninstall.sh" --prefix "$PREFIX" >/dev/null

# A piped uninstaller must not mistake its current directory for the source tree.
PIPE_PREFIX=$TMP_DIR/pipe-prefix
sh "$ROOT/install.sh" --prefix "$PIPE_PREFIX" >/dev/null
(cd "$PIPE_PREFIX" && sh -s -- --prefix "$PIPE_PREFIX" < "$ROOT/uninstall.sh")
test ! -e "$PIPE_PREFIX/skill/SKILL.md"
test ! -e "$REGISTRATION_PATH"
test ! -L "$REGISTRATION_PATH"

# Remote refs are validated before any download.
if (cd "$TMP_DIR" && TRACEKNOT_REF='../unsafe' sh -s -- --prefix "$TMP_DIR/unsafe" < "$ROOT/install.sh") >/dev/null 2>&1; then
    printf '%s\n' 'unsafe remote ref unexpectedly accepted' >&2
    exit 1
fi

# Relative, root, and source-overlapping destinations are rejected.
if sh "$ROOT/install.sh" --prefix relative-destination >/dev/null 2>&1; then
    printf '%s\n' 'relative destination unexpectedly accepted' >&2
    exit 1
fi
if sh "$ROOT/install.sh" --prefix / >/dev/null 2>&1; then
    printf '%s\n' 'filesystem root unexpectedly accepted' >&2
    exit 1
fi
if sh "$ROOT/install.sh" --prefix "$ROOT" >/dev/null 2>&1; then
    printf '%s\n' 'source tree unexpectedly accepted' >&2
    exit 1
fi

printf '%s\n' 'portable installer smoke test: PASS'
