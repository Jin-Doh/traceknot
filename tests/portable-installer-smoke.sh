#!/bin/sh
# Targeted smoke coverage for the portable Traceknot installer pair.

set -eu

ROOT=$(CDPATH='' cd -P "$(dirname "$0")/.." && pwd)
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-installer.XXXXXX")
trap 'rm -rf "$TMP_DIR"' 0 HUP INT TERM
HOME=$TMP_DIR/home
TRACEKNOT_SKILLS_ROOT=$HOME/.agents/skills
export HOME TRACEKNOT_SKILLS_ROOT
FAKE_BIN=$TMP_DIR/bin
CRONTAB_FILE=$TMP_DIR/crontab
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/crontab" <<'EOF'
#!/bin/sh
if [ "${1:-}" = -l ]; then
    [ ! -f "$CRONTAB_FILE" ] || cat "$CRONTAB_FILE"
    exit 0
fi
if [ "${CRONTAB_REJECT_WRITES:-0}" -ne 0 ]; then
    exit 1
fi
cat > "$CRONTAB_FILE"
EOF
chmod +x "$FAKE_BIN/crontab"
ORIGINAL_PATH=$PATH
PATH=$FAKE_BIN:$ORIGINAL_PATH
export PATH CRONTAB_FILE
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

# A fresh prefix honors the updater lock before writing any payload.
FRESH_LOCKED_PREFIX=$TMP_DIR/fresh-locked
FRESH_LOCKED_SKILLS=$TMP_DIR/fresh-locked-skills
mkdir -p "$FRESH_LOCKED_PREFIX"
printf '%s\n' "$$" > "$FRESH_LOCKED_PREFIX/.traceknot-update.lock"
if TRACEKNOT_SKILLS_ROOT=$FRESH_LOCKED_SKILLS sh "$ROOT/install.sh" \
    --prefix "$FRESH_LOCKED_PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'fresh install unexpectedly acquired a live update lock' >&2
    exit 1
fi
test ! -e "$FRESH_LOCKED_PREFIX/LICENSE"
rm -rf "$FRESH_LOCKED_PREFIX" "$FRESH_LOCKED_SKILLS"

sh "$ROOT/install.sh" --prefix "$PREFIX"
PREFIX_CANON=$(CDPATH='' cd -P "$PREFIX" && pwd)
test -f "$PREFIX/LICENSE"
test -f "$PREFIX/skill/SKILL.md"
test -f "$PREFIX/skill/references/test-process.md"
test -f "$PREFIX/contracts/verdict.schema.json"
test -f "$PREFIX/contracts/verification-request.schema.json"
test -f "$PREFIX/adapters/codex/capability.json"
test -f "$PREFIX/adapters/claude-code/capability.json"
test -f "$PREFIX/system/core/qa-core.ts"
test -f "$PREFIX/system/core/qa-core.test.ts"
test -x "$PREFIX/bin/traceknot-update"
test -f "$PREFIX/.traceknot-install-manifest"
test -L "$REGISTRATION_PATH"
test "$(readlink "$REGISTRATION_PATH")" = "$PREFIX_CANON/skill"
test "$(sed -n 's/^automatic=//p' "$PREFIX/.traceknot-update/config")" = 1
grep -F "# traceknot-auto-update:$PREFIX_CANON" "$CRONTAB_FILE" >/dev/null
test "$(cat "$PREFIX/unrelated-sentinel.txt")" = keep-me

# Reinstall must not require the previously installed updater to know new commands.
cat > "$PREFIX/bin/traceknot-update" <<'EOF'
#!/bin/sh
printf '%s\n' 'legacy updater must not be invoked during installer lock acquisition' >&2
exit 2
EOF
chmod +x "$PREFIX/bin/traceknot-update"

# Reinstalling over the same prefix must succeed and preserve unrelated files.
sh "$ROOT/install.sh" --prefix "$PREFIX"
test -f "$PREFIX/system/core/qa-core.ts"
test "$(cat "$PREFIX/unrelated-sentinel.txt")" = keep-me
test -x "$PREFIX/bin/traceknot-update"
test -L "$REGISTRATION_PATH"
test "$(readlink "$REGISTRATION_PATH")" = "$PREFIX_CANON/skill"
test "$(grep -Fc "# traceknot-auto-update:$PREFIX_CANON" "$CRONTAB_FILE")" = 1

# Explicit opt-out persists disabled state and creates no schedule, including across ordinary reinstall.
DISABLED_PREFIX=$TMP_DIR/disabled-prefix
DISABLED_SKILLS=$TMP_DIR/disabled-skills
TRACEKNOT_SKILLS_ROOT=$DISABLED_SKILLS sh "$ROOT/install.sh" \
    --prefix "$DISABLED_PREFIX" --disable-auto-update >/dev/null
test "$(sed -n 's/^automatic=//p' "$DISABLED_PREFIX/.traceknot-update/config")" = 0
if grep -F "# traceknot-auto-update:$DISABLED_PREFIX" "$CRONTAB_FILE" >/dev/null 2>&1; then
    printf '%s\n' 'opted-out installation unexpectedly scheduled updates' >&2
    exit 1
fi
TRACEKNOT_SKILLS_ROOT=$DISABLED_SKILLS sh "$ROOT/install.sh" \
    --prefix "$DISABLED_PREFIX" >/dev/null
test "$(sed -n 's/^automatic=//p' "$DISABLED_PREFIX/.traceknot-update/config")" = 0
if grep -F "# traceknot-auto-update:$DISABLED_PREFIX" "$CRONTAB_FILE" >/dev/null 2>&1; then
    printf '%s\n' 'ordinary reinstall unexpectedly re-enabled opted-out updates' >&2
    exit 1
fi
TRACEKNOT_SKILLS_ROOT=$DISABLED_SKILLS sh "$ROOT/uninstall.sh" \
    --prefix "$DISABLED_PREFIX" >/dev/null
# A default install with no crontab must fail closed with a disabled policy.
MISSING_PREFIX=$TMP_DIR/missing-crontab-prefix
MISSING_SKILLS=$TMP_DIR/missing-crontab-skills
NO_CRONTAB_BIN=$TMP_DIR/no-crontab-bin
mkdir -p "$NO_CRONTAB_BIN"
for utility in awk basename cat cp dirname find ln mkdir mv readlink rm sed sh; do
    utility_path=$(PATH=$ORIGINAL_PATH command -v "$utility")
    case "$utility_path" in
        /*) ln -s "$utility_path" "$NO_CRONTAB_BIN/$utility" ;;
        *) printf '%s\n' "missing required test utility: $utility" >&2; exit 1 ;;
    esac
done
if missing_output=$(PATH=$NO_CRONTAB_BIN TRACEKNOT_SKILLS_ROOT="$MISSING_SKILLS" \
    sh "$ROOT/install.sh" --prefix "$MISSING_PREFIX" 2>&1); then
    printf '%s\n' 'installation unexpectedly succeeded without crontab' >&2
    exit 1
fi
printf '%s\n' "$missing_output" | grep -F 'crontab is required to enable automatic updates' >/dev/null
test "$(sed -n 's/^automatic=//p' "$MISSING_PREFIX/.traceknot-update/config")" = 0
if grep -F "# traceknot-auto-update:$MISSING_PREFIX" "$CRONTAB_FILE" >/dev/null 2>&1; then
    printf '%s\n' 'missing-crontab installation unexpectedly scheduled updates' >&2
    exit 1
fi

# A crontab write rejection must fail closed with automatic=0.
REJECT_PREFIX=$TMP_DIR/rejected-crontab-prefix
REJECT_SKILLS=$TMP_DIR/rejected-crontab-skills
REJECT_CRONTAB_FILE=$TMP_DIR/rejected-crontab
if CRONTAB_FILE="$REJECT_CRONTAB_FILE" CRONTAB_REJECT_WRITES=1 \
    TRACEKNOT_SKILLS_ROOT="$REJECT_SKILLS" sh "$ROOT/install.sh" \
    --prefix "$REJECT_PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'installation unexpectedly succeeded after crontab rejection' >&2
    exit 1
fi
test "$(sed -n 's/^automatic=//p' "$REJECT_PREFIX/.traceknot-update/config")" = 0
test ! -e "$REJECT_CRONTAB_FILE"
if grep -F "# traceknot-auto-update:$REJECT_PREFIX" "$CRONTAB_FILE" >/dev/null 2>&1; then
    printf '%s\n' 'rejected crontab write unexpectedly enabled updates' >&2
    exit 1
fi

# Unsafe updater state is rejected before any installed payload can be overwritten.
STATE_PREFIX=$TMP_DIR/state-symlink-prefix
STATE_SKILLS=$TMP_DIR/state-symlink-skills
TRACEKNOT_SKILLS_ROOT=$STATE_SKILLS sh "$ROOT/install.sh" \
    --prefix "$STATE_PREFIX" --disable-auto-update >/dev/null
printf '%s\n' preserve-state-payload >> "$STATE_PREFIX/skill/SKILL.md"
rm -rf "$STATE_PREFIX/.traceknot-update"
mkdir -p "$TMP_DIR/outside-state"
printf '%s\n%s\n%s\n' traceknot-update-config/v1 automatic=0 lastCheck=0 \
    > "$TMP_DIR/outside-state/config"
ln -s "$TMP_DIR/outside-state" "$STATE_PREFIX/.traceknot-update"
if TRACEKNOT_SKILLS_ROOT=$STATE_SKILLS sh "$ROOT/install.sh" \
    --prefix "$STATE_PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'reinstall unexpectedly accepted symlink update state' >&2
    exit 1
fi
grep -F preserve-state-payload "$STATE_PREFIX/skill/SKILL.md" >/dev/null

# A dangling config symlink cannot escape the prefix during reinstall.
CONFIG_PREFIX=$TMP_DIR/config-symlink-prefix
CONFIG_SKILLS=$TMP_DIR/config-symlink-skills
OUTSIDE_CONFIG=$TMP_DIR/outside-config
TRACEKNOT_SKILLS_ROOT=$CONFIG_SKILLS sh "$ROOT/install.sh" \
    --prefix "$CONFIG_PREFIX" --disable-auto-update >/dev/null
printf '%s\n' preserve-config-payload >> "$CONFIG_PREFIX/skill/SKILL.md"
rm -f "$CONFIG_PREFIX/.traceknot-update/config"
ln -s "$OUTSIDE_CONFIG" "$CONFIG_PREFIX/.traceknot-update/config"
if TRACEKNOT_SKILLS_ROOT=$CONFIG_SKILLS sh "$ROOT/install.sh" \
    --prefix "$CONFIG_PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'reinstall unexpectedly accepted symlink update config' >&2
    exit 1
fi
test ! -e "$OUTSIDE_CONFIG"
grep -F preserve-config-payload "$CONFIG_PREFIX/skill/SKILL.md" >/dev/null
# Preview modes must not create or remove anything.
PREVIEW_PREFIX=$TMP_DIR/preview
TRACEKNOT_SKILLS_ROOT=$TMP_DIR/preview-skills sh "$ROOT/install.sh" --prefix "$PREVIEW_PREFIX" --dry-run >/dev/null
test ! -e "$PREVIEW_PREFIX"
sh "$ROOT/uninstall.sh" --prefix "$PREFIX" --dry-run >/dev/null
test -f "$PREFIX/system/core/qa-core.ts"
test -f "$PREFIX/.traceknot-install-manifest"
test -L "$REGISTRATION_PATH"

# A damaged installation without an executable updater still removes its schedule.
chmod -x "$PREFIX/bin/traceknot-update"
sh "$ROOT/uninstall.sh" --prefix "$PREFIX"
test ! -e "$PREFIX/LICENSE"
test ! -e "$PREFIX/skill/SKILL.md"
test ! -e "$PREFIX/contracts/verdict.schema.json"
test ! -e "$PREFIX/adapters/codex/capability.json"
test ! -e "$PREFIX/system/core/qa-core.ts"
test ! -e "$PREFIX/bin/traceknot-update"
test ! -e "$PREFIX/.traceknot-install-manifest"
test ! -e "$REGISTRATION_PATH"
test ! -L "$REGISTRATION_PATH"
if grep -F "# traceknot-auto-update:$PREFIX_CANON" "$CRONTAB_FILE" >/dev/null 2>&1; then
    printf '%s\n' 'fallback uninstall left its automatic-update schedule behind' >&2
    exit 1
fi
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
