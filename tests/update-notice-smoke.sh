#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -P "$(dirname "$0")/.." && pwd)
NOTICE_SOURCE=$ROOT/bin/traceknot-update-notice
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-update-notice-smoke.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT HUP INT TERM

BIN_DIR=$TMP_ROOT/skill/bin
STATUS_FILE=$TMP_ROOT/status
MODE_FILE=$TMP_ROOT/mode
CALL_LOG=$TMP_ROOT/calls
STATUS_DEADLINE_FILE=$TMP_ROOT/status-deadline
STATUS_CHILD_PID_FILE=$TMP_ROOT/status-child.pid
mkdir -p "$BIN_DIR"
HOME=$TMP_ROOT/home
XDG_STATE_HOME=$TMP_ROOT/state
mkdir -p "$HOME" "$XDG_STATE_HOME/traceknot/skills-update-global"
BIN_DIR=$(CDPATH='' cd -P "$BIN_DIR" && pwd)
cp "$NOTICE_SOURCE" "$BIN_DIR/traceknot-update-notice"
: > "$CALL_LOG"

cat > "$BIN_DIR/traceknot-skills-update" <<'EOF_UPDATER'
#!/bin/sh
set -eu
trap 'exit 143' HUP INT TERM
case "${1:-}" in
    status)
        if [ -n "${STATUS_DEADLINE_FILE:-}" ]; then
            printf '%s\n' "${TRACEKNOT_UPDATE_DEADLINE_EPOCH:-}" > "$STATUS_DEADLINE_FILE"
        fi
        if [ "${FAKE_STATUS_CHILD_IGNORE_TERM:-0}" -eq 1 ]; then
            (
                trap '' TERM
                sleep "${FAKE_STATUS_SLEEP:-30}"
            ) &
            status_child=$!
            printf '%s\n' "$status_child" > "$STATUS_CHILD_PID_FILE"
            wait "$status_child"
        fi
        cat "$STATUS_FILE"
        ;;
    check)
        printf 'check|maintenance=%s|deadline=%s\n' \
            "${TRACEKNOT_UPDATE_MAINTENANCE:-}" \
            "${TRACEKNOT_UPDATE_DEADLINE_EPOCH:-}" >> "$CALL_LOG"
        case "$(cat "$MODE_FILE")" in
            eligible) printf '%s\n' 'Eligible update: v9.9.9 (0123456789abcdef)' ;;
            none) printf '%s\n' 'No release has exceeded the seven-day observation requirement.' ;;
            malformed) printf '%s\n' 'Eligible update: latest (untrusted)' ;;
            fail) exit 2 ;;
            multi)
                sleep 1
                deadline=${TRACEKNOT_UPDATE_DEADLINE_EPOCH:-0}
                while :; do
                    now=$(date -u '+%s')
                    [ "$now" -lt "$deadline" ] || exit 124
                    sleep 1
                done
                ;;
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
lastCheckLocal=$last_check
adoptedAt=0
operationTimeout=0
version=unmanaged
EOF_STATUS
}

run_notice() {
    notice_mode=$1
    notice_timeout=${2:-3}
    HOME=$HOME XDG_STATE_HOME=$XDG_STATE_HOME \
    STATUS_FILE=$STATUS_FILE MODE_FILE=$MODE_FILE CALL_LOG=$CALL_LOG \
    STATUS_DEADLINE_FILE=$STATUS_DEADLINE_FILE STATUS_CHILD_PID_FILE=$STATUS_CHILD_PID_FILE \
    FAKE_STATUS_CHILD_IGNORE_TERM=${FAKE_STATUS_CHILD_IGNORE_TERM:-0} \
    FAKE_STATUS_SLEEP=${FAKE_STATUS_SLEEP:-30} \
    CI= \
    TRACEKNOT_UPDATE_NOTICE=$notice_mode \
    TRACEKNOT_UPDATE_NOTICE_INTERVAL=86400 \
    TRACEKNOT_UPDATE_NOTICE_TIMEOUT=$notice_timeout \
    sh "$BIN_DIR/traceknot-update-notice" 2>&1
}

NOW=$(date -u '+%s')
write_status 0 0 global ''
printf '%s\n' eligible > "$MODE_FILE"
output=$(run_notice 0)
[ -z "$output" ]
[ ! -s "$CALL_LOG" ]

output=$(run_notice auto 10)
printf '%s\n' "$output" | grep -F 'Traceknot update available: v9.9.9' >/dev/null
printf '%s\n' "$output" | grep -F 'Recommended verification-and-update command:' >/dev/null
printf '%s\n' "$output" | grep -F "'${BIN_DIR}/traceknot-skills-update' apply --global" >/dev/null
grep -F 'maintenance=1' "$CALL_LOG" >/dev/null
status_deadline=$(cat "$STATUS_DEADLINE_FILE")
check_deadline=$(sed -n 's/.*deadline=//p' "$CALL_LOG" | tail -n 1)
case "$status_deadline$check_deadline" in *[!0-9]*) exit 1 ;; esac
[ "$status_deadline" = "$check_deadline" ]
[ "$check_deadline" -gt "$NOW" ]

: > "$CALL_LOG"
write_status 0 "$NOW" global ''
output=$(run_notice auto)
[ -z "$output" ]
[ ! -s "$CALL_LOG" ]

sed "s/^lastCheckLocal=.*/lastCheckLocal=$((NOW + 43200))/" "$STATUS_FILE" > "$STATUS_FILE.tmp"
mv "$STATUS_FILE.tmp" "$STATUS_FILE"
output=$(run_notice auto)
printf '%s\n' "$output" | grep -F 'Traceknot update available: v9.9.9' >/dev/null

: > "$CALL_LOG"
printf '%s\n' none > "$MODE_FILE"
output=$(run_notice force)
[ -z "$output" ]
printf '%s\n' malformed > "$MODE_FILE"
output=$(run_notice force)
[ -z "$output" ]

PROJECT_ROOT="$TMP_ROOT/project with ' quote"
mkdir -p "$PROJECT_ROOT"
write_status 0 0 project "$PROJECT_ROOT"
printf '%s\n' eligible > "$MODE_FILE"
output=$(run_notice force)
command_line=$(printf '%s\n' "$output" | sed -n 's/^  //p' | tail -n 1)
eval "set -- $command_line"
[ "$1" = "$BIN_DIR/traceknot-skills-update" ]
[ "$2" = apply ]
[ "$3" = --project ]
[ "$4" = "$PROJECT_ROOT" ]

printf '%s\n' fail > "$MODE_FILE"
output=$(run_notice force)
[ -z "$output" ]

printf '%s\n' multi > "$MODE_FILE"
START=$(date -u '+%s')
output=$(run_notice force 3)
END=$(date -u '+%s')
[ -z "$output" ]
[ "$((END - START))" -lt 6 ]
status_deadline=$(cat "$STATUS_DEADLINE_FILE")
check_deadline=$(sed -n 's/.*deadline=//p' "$CALL_LOG" | tail -n 1)
[ "$status_deadline" = "$check_deadline" ]
[ "$check_deadline" -le $((START + 4)) ]

: > "$CALL_LOG"
rm -f "$STATUS_CHILD_PID_FILE"
START=$(date -u '+%s')
FAKE_STATUS_CHILD_IGNORE_TERM=1 FAKE_STATUS_SLEEP=30 output=$(run_notice force 3)
END=$(date -u '+%s')
[ -z "$output" ]
[ "$((END - START))" -lt 6 ]
[ ! -s "$CALL_LOG" ]
if [ -f "$STATUS_CHILD_PID_FILE" ] && kill -0 "$(cat "$STATUS_CHILD_PID_FILE")" 2>/dev/null; then
    kill -KILL "$(cat "$STATUS_CHILD_PID_FILE")" 2>/dev/null || true
    printf '%s\n' 'status descendant survived advisory deadline' >&2
    exit 1
fi

: > "$CALL_LOG"
printf '%s\n' eligible > "$MODE_FILE"
output=$(CI=1 STATUS_FILE=$STATUS_FILE MODE_FILE=$MODE_FILE CALL_LOG=$CALL_LOG \
    TRACEKNOT_UPDATE_NOTICE=auto sh "$BIN_DIR/traceknot-update-notice" 2>&1)
[ -z "$output" ]
[ ! -s "$CALL_LOG" ]

printf '%s\n' 'Update notice smoke test: PASS'
