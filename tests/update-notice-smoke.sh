#!/bin/sh
# Update-notice helper: default notice, opt-out, rate limit, failure, and timeout scenarios.

set -eu

ROOT=$(CDPATH='' cd -P "$(dirname "$0")/.." && pwd)
NOTICE_SOURCE=$ROOT/bin/traceknot-update-notice
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-update-notice-smoke.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT HUP INT TERM

BIN_DIR=$TMP_ROOT/skill/bin
STATUS_FILE=$TMP_ROOT/status
MODE_FILE=$TMP_ROOT/mode
CALL_LOG=$TMP_ROOT/calls
mkdir -p "$BIN_DIR"
cp "$NOTICE_SOURCE" "$BIN_DIR/traceknot-update-notice"
: > "$CALL_LOG"

cat > "$BIN_DIR/traceknot-skills-update" <<'EOF_UPDATER'
#!/bin/sh
set -eu
case "${1:-}" in
    status)
        cat "$STATUS_FILE"
        ;;
    check)
        printf '%s\n' check >> "$CALL_LOG"
        case "$(cat "$MODE_FILE")" in
            eligible) printf '%s\n' 'Eligible update: v9.9.9 (0123456789abcdef)' ;;
            none) printf '%s\n' 'No release has exceeded the seven-day observation requirement.' ;;
            fail) exit 2 ;;
            sleep) sleep 3 ;;
            *) exit 2 ;;
        esac
        ;;
    *) exit 2 ;;
esac
EOF_UPDATER
chmod +x "$BIN_DIR/traceknot-skills-update"

write_status() {
    automatic=$1
    last_check=$2
    scope=$3
    project_root=$4
    cat > "$STATUS_FILE" <<EOF_STATUS
scope=$scope
projectRoot=$project_root
registration=$BIN_DIR
automatic=$automatic
lastCheck=$last_check
adoptedAt=0
version=unmanaged
EOF_STATUS
}

run_notice() {
    notice_mode=$1
    CI= \
    STATUS_FILE=$STATUS_FILE MODE_FILE=$MODE_FILE CALL_LOG=$CALL_LOG \
    TRACEKNOT_UPDATE_NOTICE=$notice_mode \
    TRACEKNOT_UPDATE_NOTICE_INTERVAL=86400 \
    TRACEKNOT_UPDATE_NOTICE_TIMEOUT=1 \
    sh "$BIN_DIR/traceknot-update-notice" 2>&1
}

NOW=$(date -u '+%s')

# Explicit notice opt-out performs no eligibility check.
write_status 0 0 global ''
printf '%s\n' eligible > "$MODE_FILE"
output=$(run_notice 0)
[ -z "$output" ]
[ ! -s "$CALL_LOG" ]

# Automatic updates may remain disabled while the default advisory still reaches the user.
output=$(run_notice auto)
printf '%s\n' "$output" | grep -F 'Traceknot update available: v9.9.9' >/dev/null
printf '%s\n' "$output" | grep -F "'${BIN_DIR}/traceknot-skills-update' apply --global" >/dev/null
[ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 1 ]

# A recent trusted check suppresses another network attempt.
: > "$CALL_LOG"
write_status 0 "$NOW" global ''
output=$(run_notice auto)
[ -z "$output" ]
[ ! -s "$CALL_LOG" ]

# A stale global installation receives one advisory and an exact scoped command.
write_status 0 "$((NOW - 90000))" global ''
output=$(run_notice auto)
printf '%s\n' "$output" | grep -F 'Traceknot update available: v9.9.9' >/dev/null
printf '%s\n' "$output" | grep -F "'${BIN_DIR}/traceknot-skills-update' apply --global" >/dev/null
printf '%s\n' "$output" | grep -F 'does not affect the current QA verdict' >/dev/null
[ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 1 ]

# No eligible candidate remains silent.
: > "$CALL_LOG"
printf '%s\n' none > "$MODE_FILE"
output=$(run_notice force)
[ -z "$output" ]
[ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 1 ]

# Project scope preserves paths containing spaces.
: > "$CALL_LOG"
PROJECT_ROOT="$TMP_ROOT/project with space"
mkdir -p "$PROJECT_ROOT"
write_status 0 0 project "$PROJECT_ROOT"
printf '%s\n' eligible > "$MODE_FILE"
output=$(run_notice force)
printf '%s\n' "$output" | grep -F "apply --project '$PROJECT_ROOT'" >/dev/null

# Updater failure and timeout are non-blocking and silent.
: > "$CALL_LOG"
printf '%s\n' fail > "$MODE_FILE"
output=$(run_notice force)
[ -z "$output" ]
printf '%s\n' sleep > "$MODE_FILE"
output=$(run_notice force)
[ -z "$output" ]

# CI suppresses the advisory unless explicitly forced.
: > "$CALL_LOG"
printf '%s\n' eligible > "$MODE_FILE"
output=$(CI=1 STATUS_FILE=$STATUS_FILE MODE_FILE=$MODE_FILE CALL_LOG=$CALL_LOG \
    TRACEKNOT_UPDATE_NOTICE=auto sh "$BIN_DIR/traceknot-update-notice" 2>&1)
[ -z "$output" ]
[ ! -s "$CALL_LOG" ]

printf '%s\n' 'Update notice smoke test: PASS'
