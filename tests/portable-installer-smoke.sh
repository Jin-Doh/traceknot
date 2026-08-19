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
# Any external Skill registration is outside launcher ownership, even when it
# does not yet contain the generated runtime.
MALFORMED_SKILLS_ROOT=$TMP_DIR/malformed-skills
MALFORMED_REGISTRATION_PATH=$MALFORMED_SKILLS_ROOT/traceknot
MALFORMED_PREFIX=$TMP_DIR/malformed-registration-prefix
mkdir -p "$MALFORMED_REGISTRATION_PATH"
printf '%s\n' preserve-malformed-registration > "$MALFORMED_REGISTRATION_PATH/SKILL.md"
TRACEKNOT_SKILLS_ROOT=$MALFORMED_SKILLS_ROOT sh "$ROOT/install.sh" \
    --prefix "$MALFORMED_PREFIX" --disable-auto-update >/dev/null
test "$(cat "$MALFORMED_REGISTRATION_PATH/SKILL.md")" = preserve-malformed-registration
test -x "$MALFORMED_PREFIX/bin/traceknot"
TRACEKNOT_SKILLS_ROOT=$MALFORMED_SKILLS_ROOT sh "$ROOT/uninstall.sh" \
    --prefix "$MALFORMED_PREFIX" >/dev/null
test "$(cat "$MALFORMED_REGISTRATION_PATH/SKILL.md")" = preserve-malformed-registration
rm -rf "$MALFORMED_SKILLS_ROOT"


# A real Skills CLI registration is external ownership: preserve it while the
# optional prefix launcher follows the managed current release.
REGISTRATION_PATH=$TRACEKNOT_SKILLS_ROOT/traceknot
REGISTRATION_PREFIX=$TMP_DIR/registration-conflict
mkdir -p "$REGISTRATION_PATH/bin"
REGISTRATION_PREFIX_CANON=$(CDPATH='' cd -P "$TMP_DIR" && pwd)/registration-conflict
printf '%s\n' do-not-overwrite > "$REGISTRATION_PATH/SKILL.md"
cat > "$REGISTRATION_PATH/bin/traceknot" <<'EOF'
#!/bin/sh
printf '%s\n' external-registration-runtime
EOF
chmod +x "$REGISTRATION_PATH/bin/traceknot"
sh "$ROOT/install.sh" --prefix "$REGISTRATION_PREFIX" --disable-auto-update >/dev/null
test "$(cat "$REGISTRATION_PATH/SKILL.md")" = do-not-overwrite
test -x "$REGISTRATION_PREFIX/bin/traceknot"
test "$(readlink "$REGISTRATION_PREFIX/bin/traceknot")" = "$REGISTRATION_PREFIX_CANON/skill/bin/traceknot"
test "$("$REGISTRATION_PREFIX/bin/traceknot" verify --help)" != external-registration-runtime
sh "$ROOT/uninstall.sh" --prefix "$REGISTRATION_PREFIX" >/dev/null
test "$(cat "$REGISTRATION_PATH/SKILL.md")" = do-not-overwrite
test -x "$REGISTRATION_PATH/bin/traceknot"
rm -rf "$REGISTRATION_PATH"

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
test -x "$PREFIX/skill/bin/traceknot"
test ! -e "$PREFIX/contracts"
test ! -e "$PREFIX/adapters"
test ! -e "$PREFIX/system"
test -x "$PREFIX/bin/traceknot"
test "$(readlink "$PREFIX/bin/traceknot")" = "$PREFIX_CANON/skill/bin/traceknot"
test -n "$("$PREFIX/bin/traceknot" verify --help)"
test -n "$("$PREFIX/bin/traceknot" storage --help)"
test -x "$PREFIX/bin/traceknot-update"
test -f "$PREFIX/.traceknot-install-manifest"
test ! -e "$REGISTRATION_PATH"
test -f "$PREFIX/skill/references/proof-carrying-success.md"
grep -F '[Proof-carrying success](references/proof-carrying-success.md)' \
    "$PREFIX/skill/SKILL.md" >/dev/null
"$PREFIX/bin/traceknot" self-check >/dev/null
test "$(sed -n 's/^automatic=//p' "$PREFIX/.traceknot-update/config")" = 1
grep -F "# traceknot-auto-update:$PREFIX_CANON" "$CRONTAB_FILE" >/dev/null
test "$(cat "$PREFIX/unrelated-sentinel.txt")" = keep-me

# Reinstall removes a legacy launcher-owned registration instead of retargeting it.
mkdir -p "$TRACEKNOT_SKILLS_ROOT"
ln -s "$PREFIX_CANON/skill" "$REGISTRATION_PATH"

# Reinstall must not require the previously installed updater to know new commands.
cat > "$PREFIX/bin/traceknot-update" <<'EOF'
#!/bin/sh
printf '%s\n' 'legacy updater must not be invoked during installer lock acquisition' >&2
exit 2
EOF
chmod +x "$PREFIX/bin/traceknot-update"

mkdir -p "$PREFIX/releases"
printf '%s\n' keep-release > "$PREFIX/releases/unrelated-sentinel"
# Reinstalling over the same prefix must succeed and preserve unrelated files.
sh "$ROOT/install.sh" --prefix "$PREFIX"
test -x "$PREFIX/skill/bin/traceknot"
test "$(cat "$PREFIX/unrelated-sentinel.txt")" = keep-me
test "$(cat "$PREFIX/releases/unrelated-sentinel")" = keep-release
test -x "$PREFIX/bin/traceknot-update"
test "$(readlink "$PREFIX/bin/traceknot")" = "$PREFIX_CANON/skill/bin/traceknot"
test ! -e "$REGISTRATION_PATH"
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
env -u TRACEKNOT_SKILLS_ROOT sh "$ROOT/install.sh" --prefix "$DISABLED_PREFIX" >/dev/null
test "$(sed -n 's/^automatic=//p' "$DISABLED_PREFIX/.traceknot-update/config")" = 0
test ! -e "$DISABLED_SKILLS/traceknot"
test "$(readlink "$DISABLED_PREFIX/bin/traceknot")" = "$(CDPATH='' cd -P "$DISABLED_PREFIX" && pwd)/skill/bin/traceknot"
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
# Preview modes report the same non-owning registration behavior without mutation.
PREVIEW_PREFIX=$TMP_DIR/preview
PREVIEW_SKILLS=$TMP_DIR/preview-skills
PREVIEW_OUTPUT=$(TRACEKNOT_SKILLS_ROOT=$PREVIEW_SKILLS sh "$ROOT/install.sh" --prefix "$PREVIEW_PREFIX" --dry-run)
printf '%s\n' "$PREVIEW_OUTPUT" | grep -F 'do not create a Skill registration' >/dev/null
test ! -e "$PREVIEW_PREFIX"
test ! -e "$PREVIEW_SKILLS/traceknot"

PREVIEW_EXTERNAL_PREFIX=$TMP_DIR/preview-external-prefix
PREVIEW_EXTERNAL_SKILLS=$TMP_DIR/preview-external-skills
mkdir -p "$PREVIEW_EXTERNAL_SKILLS/traceknot"
PREVIEW_EXTERNAL_SKILLS_CANON=$(CDPATH='' cd -P "$PREVIEW_EXTERNAL_SKILLS" && pwd)
printf '%s\n' preserve-external > "$PREVIEW_EXTERNAL_SKILLS/traceknot/SKILL.md"
PREVIEW_EXTERNAL_OUTPUT=$(TRACEKNOT_SKILLS_ROOT=$PREVIEW_EXTERNAL_SKILLS sh "$ROOT/install.sh" --prefix "$PREVIEW_EXTERNAL_PREFIX" --dry-run)
printf '%s\n' "$PREVIEW_EXTERNAL_OUTPUT" | grep -F "leave existing Skill registration $PREVIEW_EXTERNAL_SKILLS_CANON/traceknot untouched" >/dev/null
test "$(cat "$PREVIEW_EXTERNAL_SKILLS/traceknot/SKILL.md")" = preserve-external
test ! -e "$PREVIEW_EXTERNAL_PREFIX"

PREVIEW_LEGACY_PREFIX_CANON=$(CDPATH='' cd -P "$TMP_DIR" && pwd)/preview-legacy-prefix
PREVIEW_LEGACY_PREFIX=$TMP_DIR/preview-legacy-prefix
PREVIEW_LEGACY_SKILLS=$TMP_DIR/preview-legacy-skills
mkdir -p "$PREVIEW_LEGACY_SKILLS"
PREVIEW_LEGACY_SKILLS_CANON=$(CDPATH='' cd -P "$PREVIEW_LEGACY_SKILLS" && pwd)
ln -s "$PREVIEW_LEGACY_PREFIX_CANON/skill" "$PREVIEW_LEGACY_SKILLS/traceknot"
PREVIEW_LEGACY_OUTPUT=$(TRACEKNOT_SKILLS_ROOT=$PREVIEW_LEGACY_SKILLS sh "$ROOT/install.sh" --prefix "$PREVIEW_LEGACY_PREFIX" --dry-run)
printf '%s\n' "$PREVIEW_LEGACY_OUTPUT" | grep -F "remove legacy Skill registration $PREVIEW_LEGACY_SKILLS_CANON/traceknot" >/dev/null
test -L "$PREVIEW_LEGACY_SKILLS/traceknot"
test ! -e "$PREVIEW_LEGACY_PREFIX"

sh "$ROOT/uninstall.sh" --prefix "$PREFIX" --dry-run >/dev/null
test -x "$PREFIX/skill/bin/traceknot"
test -f "$PREFIX/.traceknot-install-manifest"
test ! -e "$REGISTRATION_PATH"

# A damaged installation without an executable updater still removes its schedule.
chmod -x "$PREFIX/bin/traceknot-update"
if PATH=$NO_CRONTAB_BIN sh "$ROOT/uninstall.sh" --prefix "$PREFIX" >/dev/null 2>&1; then
    printf '%s\n' 'fallback uninstall succeeded without crontab access' >&2
    exit 1
fi
test -f "$PREFIX/LICENSE"
test ! -e "$PREFIX/.traceknot-update.lock"
sh "$ROOT/uninstall.sh" --prefix "$PREFIX"
test ! -e "$PREFIX/LICENSE"
test ! -e "$PREFIX/skill/SKILL.md"
test ! -e "$PREFIX/skill/contracts/verdict.schema.json"
test ! -e "$PREFIX/skill/references/adversarial-risk-discovery.md"
test ! -e "$PREFIX/skill/contracts/risk-discovery-report.schema.json"
test ! -e "$PREFIX/skill/adapters/codex/capability.json"
test ! -e "$PREFIX/skill/bin/traceknot"
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
