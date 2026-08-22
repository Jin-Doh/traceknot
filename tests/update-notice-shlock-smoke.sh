#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -P "$(dirname "$0")/.." && pwd)
NOTICE_SOURCE=$ROOT/bin/traceknot-update-notice
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-update-notice-shlock.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT HUP INT TERM

HOME=$TMP_ROOT/home
XDG_STATE_HOME=$TMP_ROOT/state
GLOBAL_BIN=$HOME/.agents/skills/traceknot/bin
LOCK_BIN=$TMP_ROOT/bin
MODE_FILE=$TMP_ROOT/mode
CALL_LOG=$TMP_ROOT/calls
mkdir -p "$GLOBAL_BIN" "$LOCK_BIN" "$XDG_STATE_HOME/traceknot/skills-update-global"
cp "$NOTICE_SOURCE" "$GLOBAL_BIN/traceknot-update-notice"
: > "$CALL_LOG"

cat > "$GLOBAL_BIN/traceknot-skills-update" <<'EOF_UPDATER'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$NOTICE_TEST_CALL_LOG"
case "$(cat "$NOTICE_TEST_MODE")" in
    eligible) printf '%s\n' 'Eligible update: v9.9.9 (0123456789abcdef)' ;;
    slow)
        sleep 1
        printf '%s\n' 'Eligible update: v9.9.9 (0123456789abcdef)'
        ;;
    *) exit 2 ;;
esac
EOF_UPDATER
chmod +x "$GLOBAL_BIN/traceknot-skills-update"

cat > "$LOCK_BIN/shlock" <<'EOF_SHLOCK'
#!/bin/sh
set -eu
lock_file=
lock_pid=
while [ "$#" -gt 0 ]; do
    case "$1" in
        -f) lock_file=$2; shift 2 ;;
        -p) lock_pid=$2; shift 2 ;;
        *) exit 2 ;;
    esac
done
[ -n "$lock_file" ] && [ -n "$lock_pid" ] || exit 2
if [ -e "$lock_file" ]; then
    owner=$(sed -n '1p' "$lock_file" 2>/dev/null || true)
    case "$owner" in
        ''|*[!0-9]*) ;;
        *) kill -0 "$owner" 2>/dev/null && exit 1 ;;
    esac
    rm -f "$lock_file"
fi
(set -C; printf '%s\n' "$lock_pid" > "$lock_file") 2>/dev/null
EOF_SHLOCK
chmod +x "$LOCK_BIN/shlock"

# Give the helper only the commands it needs, deliberately excluding flock so
# the macOS-style shlock path is exercised on the Linux CI runner.
for command_name in cat date dirname grep ln mkdir mv rm sed sleep tail; do
    command_path=$(command -v "$command_name")
    ln -s "$command_path" "$LOCK_BIN/$command_name"
done


run_notice() {
    mode=$1
    PATH=$LOCK_BIN \
    HOME=$HOME XDG_STATE_HOME=$XDG_STATE_HOME \
    NOTICE_TEST_MODE=$MODE_FILE NOTICE_TEST_CALL_LOG=$CALL_LOG \
    CI= TRACEKNOT_UPDATE_NOTICE=$mode TRACEKNOT_UPDATE_NOTICE_TIMEOUT=5 \
        /bin/sh "$GLOBAL_BIN/traceknot-update-notice" 2>&1
}

printf '%s\n' eligible > "$MODE_FILE"
output=$(run_notice force)
printf '%s\n' "$output" | grep -F 'Traceknot update available: v9.9.9' >/dev/null
[ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 1 ]
LOCK_FILE=$XDG_STATE_HOME/traceknot/update-notice-global/check.lock
test ! -e "$LOCK_FILE"

# The backend marker is durable for this advisory state directory.
LOCK_BACKEND_FILE=$XDG_STATE_HOME/traceknot/update-notice-global/lock-backend
test "$(cat "$LOCK_BACKEND_FILE")" = shlock

# A later PATH that exposes a different backend must keep using the pinned
# protocol for this advisory state directory.
FLOCK_BIN=$TMP_ROOT/flock-bin
FLOCK_SENTINEL=$TMP_ROOT/flock-called
mkdir "$FLOCK_BIN"
cat > "$FLOCK_BIN/flock" <<'EOF_FLOCK'
#!/bin/sh
: > "$FLOCK_SENTINEL"
exit 1
EOF_FLOCK
chmod +x "$FLOCK_BIN/flock"
rm -f "$XDG_STATE_HOME/traceknot/update-notice-global/last-success"
output=$(PATH=$FLOCK_BIN:$LOCK_BIN HOME=$HOME XDG_STATE_HOME=$XDG_STATE_HOME \
    NOTICE_TEST_MODE=$MODE_FILE NOTICE_TEST_CALL_LOG=$CALL_LOG \
    CI= TRACEKNOT_UPDATE_NOTICE=force TRACEKNOT_UPDATE_NOTICE_TIMEOUT=5 \
    FLOCK_SENTINEL=$FLOCK_SENTINEL \
    /bin/sh "$GLOBAL_BIN/traceknot-update-notice" 2>&1)
printf '%s\n' "$output" | grep -F 'Traceknot update available: v9.9.9' >/dev/null
test ! -e "$FLOCK_SENTINEL"
[ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 2 ]

# shlock ownership also serializes concurrent invocations and is released by
# the winning helper when it exits.
rm -f "$XDG_STATE_HOME/traceknot/update-notice-global/last-success"
: > "$CALL_LOG"
printf '%s\n' slow > "$MODE_FILE"
PATH=$LOCK_BIN HOME=$HOME XDG_STATE_HOME=$XDG_STATE_HOME \
    NOTICE_TEST_MODE=$MODE_FILE NOTICE_TEST_CALL_LOG=$CALL_LOG \
    CI= TRACEKNOT_UPDATE_NOTICE=auto TRACEKNOT_UPDATE_NOTICE_TIMEOUT=5 \
    /bin/sh "$GLOBAL_BIN/traceknot-update-notice" 2> "$TMP_ROOT/one" &
pid_one=$!
PATH=$LOCK_BIN HOME=$HOME XDG_STATE_HOME=$XDG_STATE_HOME \
    NOTICE_TEST_MODE=$MODE_FILE NOTICE_TEST_CALL_LOG=$CALL_LOG \
    CI= TRACEKNOT_UPDATE_NOTICE=auto TRACEKNOT_UPDATE_NOTICE_TIMEOUT=5 \
    /bin/sh "$GLOBAL_BIN/traceknot-update-notice" 2> "$TMP_ROOT/two" &
pid_two=$!
wait "$pid_one"
wait "$pid_two"
[ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 1 ]
notice_count=$(cat "$TMP_ROOT/one" "$TMP_ROOT/two" | grep -c 'Traceknot update available:' || true)
[ "$notice_count" -eq 1 ]
test ! -e "$LOCK_FILE"

printf '%s\n' 'Update notice shlock smoke test: PASS'
