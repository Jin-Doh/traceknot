from pathlib import Path
import re


def subone(text: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return updated


def replaceone(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def patch_updater(path: Path) -> None:
    text = path.read_text()

    deadline_pattern = r'''signal_process_tree\(\) \{\n.*?\n\}\n\nrun_with_deadline\(\) \{\n.*?\n\}\n\ndurable_sync\(\) \{'''
    deadline = '''collect_process_tree() {
    process_pid=$1
    if command -v pgrep >/dev/null 2>&1; then
        for child_pid in $(pgrep -P "$process_pid" 2>/dev/null || true); do
            collect_process_tree "$child_pid"
        done
    fi
    printf '%s\\n' "$process_pid"
}

signal_process_list() {
    signal_name=$1
    shift
    for process_pid in "$@"; do
        kill -s "$signal_name" "$process_pid" 2>/dev/null || true
    done
}

process_list_alive() {
    for process_pid in "$@"; do
        if kill -0 "$process_pid" 2>/dev/null; then
            return 0
        fi
    done
    return 1
}

run_with_deadline() {
    if [ "$OPERATION_TIMEOUT" -eq 0 ]; then
        "$@"
        return
    fi
    remaining=$(remaining_operation_seconds) || return 124
    bounded_state=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-bounded.XXXXXX") || return 70
    bounded_done=$bounded_state/done
    bounded_timed_out=$bounded_state/timed-out
    "$@" &
    bounded_pid=$!
    (
        while [ ! -e "$bounded_done" ]; do
            bounded_now=$(date -u '+%s') || exit 0
            if [ "$bounded_now" -ge "$OPERATION_DEADLINE" ]; then
                : > "$bounded_timed_out"
                bounded_processes=$(collect_process_tree "$bounded_pid")
                # shellcheck disable=SC2086
                signal_process_list TERM $bounded_processes
                bounded_grace_deadline=$((bounded_now + 2))
                # Retain the descendant PID set before TERM. The command parent
                # may exit and reparent a TERM-ignoring child during the grace window.
                # shellcheck disable=SC2086
                while process_list_alive $bounded_processes; do
                    bounded_now=$(date -u '+%s') || break
                    [ "$bounded_now" -lt "$bounded_grace_deadline" ] || break
                    sleep 1
                done
                # shellcheck disable=SC2086
                signal_process_list KILL $bounded_processes
                exit 0
            fi
            sleep 1
        done
    ) >/dev/null 2>&1 &
    bounded_watchdog=$!
    bounded_status=0
    if wait "$bounded_pid"; then
        :
    else
        bounded_status=$?
    fi
    : > "$bounded_done"
    wait "$bounded_watchdog" 2>/dev/null || true
    if [ -e "$bounded_timed_out" ]; then
        bounded_status=124
    fi
    rm -rf "$bounded_state"
    return "$bounded_status"
}

durable_sync() {'''
    text = subone(text, deadline_pattern, deadline, f"{path}: retained timeout process set", re.S)

    revalidate_pattern = r'''revalidate_starting_state\(\) \{\n.*?\n\}\n\nvalidate_asset_api_url\(\) \{'''
    revalidate = '''starting_state_unchanged() {
    [ -f "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ] || return 1
    commit_lock_ref=$(jq -r '.skills.traceknot.ref // ""' "$LOCK_FILE") || return 1
    commit_lock_entry_sha256=$(jq -cS '.skills.traceknot' "$LOCK_FILE" | sha256_stdin) || return 1
    [ "$commit_lock_ref" = "$STARTUP_LOCK_REF" ] &&
        [ "$commit_lock_entry_sha256" = "$STARTUP_LOCK_ENTRY_SHA256" ] || return 1
    [ -d "$REGISTRATION" ] && [ ! -L "$REGISTRATION" ] || return 1
    if find "$REGISTRATION" -type l -print | grep . >/dev/null; then
        return 1
    fi
    run_with_deadline diff -r "$STARTUP_REGISTRATION" "$REGISTRATION" >/dev/null 2>&1
}

revalidate_starting_state() {
    starting_state_unchanged ||
        fail 'Skills CLI lock or registration changed while the verified update was being prepared'
}

validate_asset_api_url() {'''
    text = subone(text, revalidate_pattern, revalidate, f"{path}: complete starting-state predicate", re.S)

    pending = '''write_pending_state "$TRUSTED_NOW" "$VERSION" "$RELEASE_TAG" "$SOURCE_COMMIT" \\
    "$ARTIFACT_SHA" "$CURRENT_LOCK_REF" "$LOCK_ENTRY_SHA256"
APPLY_LOG=$TMP_ROOT/apply.log
'''
    pending_hardened = '''write_pending_state "$TRUSTED_NOW" "$VERSION" "$RELEASE_TAG" "$SOURCE_COMMIT" \\
    "$ARTIFACT_SHA" "$CURRENT_LOCK_REF" "$LOCK_ENTRY_SHA256"
if ! starting_state_unchanged; then
    rm -f "$PENDING_STATE"
    rm -rf "$PENDING_PAYLOAD_DIR" "$PENDING_PREVIOUS_PAYLOAD_DIR"
    durable_sync
    fail 'Skills CLI lock or registration changed immediately before update mutation'
fi
APPLY_LOG=$TMP_ROOT/apply.log
'''
    text = replaceone(text, pending, pending_hardened, f"{path}: immediate pre-mutation revalidation")
    path.write_text(text)


for updater in (Path('bin/traceknot-skills-update'), Path('skill/bin/traceknot-skills-update')):
    patch_updater(updater)
Path('skill/bin/traceknot-skills-update').write_bytes(Path('bin/traceknot-skills-update').read_bytes())

# Extend the inherited updater smoke suite with the two final PR #68 regressions.
path = Path('tests/skills-updater-smoke.sh')
text = path.read_text()
old_curl = '''if [ -n "${FAKE_CURL_PID_FILE:-}" ]; then
    printf '%s\\n' "$$" > "$FAKE_CURL_PID_FILE"
fi
if [ "${FAKE_CURL_IGNORE_TERM:-0}" -eq 1 ]; then
    trap '' TERM
fi
if [ -n "${FAKE_CURL_SLEEP:-}" ]; then
    sleep "$FAKE_CURL_SLEEP"
fi
'''
new_curl = '''if [ "${FAKE_CURL_CHILD_IGNORE_TERM:-0}" -eq 1 ]; then
    trap 'exit 143' TERM
    (
        trap '' TERM
        sleep "${FAKE_CURL_SLEEP:-30}"
    ) &
    fake_child_pid=$!
    if [ -n "${FAKE_CURL_CHILD_PID_FILE:-}" ]; then
        printf '%s\\n' "$fake_child_pid" > "$FAKE_CURL_CHILD_PID_FILE"
    fi
    wait "$fake_child_pid"
else
    if [ -n "${FAKE_CURL_PID_FILE:-}" ]; then
        printf '%s\\n' "$$" > "$FAKE_CURL_PID_FILE"
    fi
    if [ "${FAKE_CURL_IGNORE_TERM:-0}" -eq 1 ]; then
        trap '' TERM
    fi
    if [ -n "${FAKE_CURL_SLEEP:-}" ]; then
        sleep "$FAKE_CURL_SLEEP"
    fi
fi
'''
text = replaceone(text, old_curl, new_curl, 'tests: descendant timeout fixture')

crontab_marker = '''EOF_CRONTAB
chmod +x "$FAKE_BIN/crontab"

cat > "$FAKE_BIN/npx" <<'EOF_NPX'
'''
sync_fixture = '''EOF_CRONTAB
chmod +x "$FAKE_BIN/crontab"

cat > "$FAKE_BIN/sync" <<'EOF_SYNC'
#!/bin/sh
set -eu
if [ -n "${FAKE_MUTATE_AFTER_PENDING_LOCK:-}" ] &&
   [ -n "${FAKE_MUTATE_AFTER_PENDING_STATE:-}" ] &&
   [ -n "${FAKE_MUTATE_AFTER_PENDING_SENTINEL:-}" ] &&
   [ -f "$FAKE_MUTATE_AFTER_PENDING_STATE" ] &&
   [ ! -e "$FAKE_MUTATE_AFTER_PENDING_SENTINEL" ]; then
    jq '.skills.traceknot.computedHash = "external-after-pending"' \\
        "$FAKE_MUTATE_AFTER_PENDING_LOCK" > "$FAKE_MUTATE_AFTER_PENDING_LOCK.tmp"
    mv "$FAKE_MUTATE_AFTER_PENDING_LOCK.tmp" "$FAKE_MUTATE_AFTER_PENDING_LOCK"
    : > "$FAKE_MUTATE_AFTER_PENDING_SENTINEL"
fi
exit 0
EOF_SYNC
chmod +x "$FAKE_BIN/sync"

cat > "$FAKE_BIN/npx" <<'EOF_NPX'
'''
text = replaceone(text, crontab_marker, sync_fixture, 'tests: post-pending sync race fixture')

timeout_marker = '''if [ -f "$CURL_PID_FILE" ] && kill -0 "$(cat "$CURL_PID_FILE")" 2>/dev/null; then
    printf '%s\\n' 'timeout child survived KILL escalation' >&2
    exit 1
fi

# Explicit apply completes adoption even when the current lock already matches the eligible release.
'''
timeout_block = '''if [ -f "$CURL_PID_FILE" ] && kill -0 "$(cat "$CURL_PID_FILE")" 2>/dev/null; then
    printf '%s\\n' 'timeout child survived KILL escalation' >&2
    exit 1
fi
DESCENDANT_PID_FILE=$TMP_DIR/timeout-descendant.pid
START_TIMEOUT=$(date -u '+%s')
if FAKE_CURL_CHILD_IGNORE_TERM=1 FAKE_CURL_CHILD_PID_FILE="$DESCENDANT_PID_FILE" FAKE_CURL_SLEEP=30 \\
    TRACEKNOT_UPDATE_OPERATION_TIMEOUT=2 \\
    "$TIMEOUT_SKILL/bin/traceknot-skills-update" --project "$TIMEOUT_PROJECT" --auto >/dev/null 2>&1; then
    printf '%s\\n' 'descendant timeout check unexpectedly succeeded' >&2
    exit 1
fi
END_TIMEOUT=$(date -u '+%s')
[ "$((END_TIMEOUT - START_TIMEOUT))" -lt 7 ]
if [ -f "$DESCENDANT_PID_FILE" ] && kill -0 "$(cat "$DESCENDANT_PID_FILE")" 2>/dev/null; then
    kill -KILL "$(cat "$DESCENDANT_PID_FILE")" 2>/dev/null || true
    printf '%s\\n' 'TERM-ignoring descendant survived parent exit and KILL escalation' >&2
    exit 1
fi

# Explicit apply completes adoption even when the current lock already matches the eligible release.
'''
text = replaceone(text, timeout_marker, timeout_block, 'tests: retained descendant regression')

race_marker = '''# Candidate runtimes are never executed before byte equality is established.
for poison_kind in preflight apply; do
'''
race_block = '''PENDING_RACE_PROJECT="$TMP_DIR/pending-race"
mkdir -p "$PENDING_RACE_PROJECT"
PENDING_RACE_SKILL=$PENDING_RACE_PROJECT/.agents/skills/traceknot
install_initial_skill "$PENDING_RACE_SKILL"
write_initial_lock "$PENDING_RACE_PROJECT/skills-lock.json"
PENDING_RACE_STATE=$PENDING_RACE_PROJECT/.agents/.traceknot-update
seed_adoption "$PENDING_RACE_STATE" "$PENDING_RACE_PROJECT/skills-lock.json" 0 "$((FAKE_NOW - 1814400))"
printf '%s\\t%s\\t%s\\t%s\\n' "$(manifest_sha)" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" > "$PENDING_RACE_STATE/observations.tsv"
PENDING_RACE_SENTINEL=$TMP_DIR/pending-race.mutated
before_pending_race=$(cat "$NPX_COUNT")
export FAKE_MUTATE_AFTER_PENDING_LOCK="$PENDING_RACE_PROJECT/skills-lock.json"
export FAKE_MUTATE_AFTER_PENDING_STATE="$PENDING_RACE_STATE/pending.json"
export FAKE_MUTATE_AFTER_PENDING_SENTINEL="$PENDING_RACE_SENTINEL"
if "$PENDING_RACE_SKILL/bin/traceknot-skills-update" apply --project "$PENDING_RACE_PROJECT" >/dev/null 2>&1; then
    printf '%s\\n' 'post-pending external lock mutation was not rejected' >&2
    exit 1
fi
unset FAKE_MUTATE_AFTER_PENDING_LOCK FAKE_MUTATE_AFTER_PENDING_STATE FAKE_MUTATE_AFTER_PENDING_SENTINEL
test -f "$PENDING_RACE_SENTINEL"
test "$(cat "$NPX_COUNT")" -eq $((before_pending_race + 1))
test ! -e "$PENDING_RACE_STATE/pending.json"
test ! -e "$PENDING_RACE_STATE/pending-payload"
test ! -e "$PENDING_RACE_STATE/pending-previous-payload"
jq -e '.skills.traceknot.computedHash == "external-after-pending"' "$PENDING_RACE_PROJECT/skills-lock.json" >/dev/null

# Candidate runtimes are never executed before byte equality is established.
for poison_kind in preflight apply; do
'''
text = replaceone(text, race_marker, race_block, 'tests: immediate mutation race regression')
path.write_text(text)

notice = r'''#!/bin/sh
# Advisory update check for Skills CLI installations.

set -u

MODE=${TRACEKNOT_UPDATE_NOTICE:-auto}
CHECK_INTERVAL=${TRACEKNOT_UPDATE_NOTICE_INTERVAL:-86400}
CHECK_TIMEOUT=${TRACEKNOT_UPDATE_NOTICE_TIMEOUT:-5}
TMP_ROOT=
RUN_PID=
WATCH_PID=
RUN_SEQ=0

case "$MODE" in
    0|false|off|disabled) exit 0 ;;
    ''|auto|force) ;;
    *) exit 0 ;;
esac
case "$CHECK_INTERVAL" in ''|*[!0-9]*) exit 0 ;; esac
case "$CHECK_TIMEOUT" in ''|*[!0-9]*) exit 0 ;; esac
[ "$CHECK_TIMEOUT" -gt 0 ] || exit 0

if [ -n "${CI:-}" ] && [ "$MODE" != force ]; then
    exit 0
fi
command -v pgrep >/dev/null 2>&1 || exit 0

BIN_DIR=$(CDPATH='' cd -P "$(dirname "$0")" 2>/dev/null && pwd) || exit 0
UPDATER=$BIN_DIR/traceknot-skills-update
[ -x "$UPDATER" ] || exit 0

START_NOW=$(date -u '+%s' 2>/dev/null) || exit 0
DEADLINE_EPOCH=$((START_NOW + CHECK_TIMEOUT))
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-update-notice.XXXXXX" 2>/dev/null) || exit 0

collect_process_tree() {
    process_pid=$1
    for child_pid in $(pgrep -P "$process_pid" 2>/dev/null || true); do
        collect_process_tree "$child_pid"
    done
    printf '%s\n' "$process_pid"
}

signal_process_list() {
    signal_name=$1
    shift
    for process_pid in "$@"; do
        kill -s "$signal_name" "$process_pid" 2>/dev/null || true
    done
}

process_list_alive() {
    for process_pid in "$@"; do
        if kill -0 "$process_pid" 2>/dev/null; then
            return 0
        fi
    done
    return 1
}

cleanup() {
    if [ -n "$RUN_PID" ]; then
        cleanup_processes=$(collect_process_tree "$RUN_PID" 2>/dev/null || true)
        if [ -n "$cleanup_processes" ]; then
            # shellcheck disable=SC2086
            signal_process_list TERM $cleanup_processes
            # shellcheck disable=SC2086
            signal_process_list KILL $cleanup_processes
        fi
    fi
    if [ -n "$WATCH_PID" ]; then
        kill -TERM "$WATCH_PID" 2>/dev/null || true
        wait "$WATCH_PID" 2>/dev/null || true
    fi
    [ -z "$TMP_ROOT" ] || rm -rf "$TMP_ROOT"
}
trap cleanup EXIT
trap 'exit 0' HUP INT TERM

run_bounded_updater() {
    run_output=$1
    shift
    run_now=$(date -u '+%s' 2>/dev/null) || return 124
    [ "$run_now" -lt "$DEADLINE_EPOCH" ] || return 124
    RUN_SEQ=$((RUN_SEQ + 1))
    run_done=$TMP_ROOT/run-$RUN_SEQ.done
    run_timed_out=$TMP_ROOT/run-$RUN_SEQ.timed-out

    TRACEKNOT_UPDATE_NOTICE=0 \
    TRACEKNOT_UPDATE_DEADLINE_EPOCH="$DEADLINE_EPOCH" \
    TRACEKNOT_UPDATE_SKIP_SYNC=1 \
    TRACEKNOT_UPDATE_MAINTENANCE=1 \
        "$UPDATER" "$@" >"$run_output" 2>/dev/null &
    RUN_PID=$!
    (
        while [ ! -e "$run_done" ]; do
            watch_now=$(date -u '+%s' 2>/dev/null) || exit 0
            if [ "$watch_now" -ge "$DEADLINE_EPOCH" ]; then
                : > "$run_timed_out"
                watch_processes=$(collect_process_tree "$RUN_PID")
                # shellcheck disable=SC2086
                signal_process_list TERM $watch_processes
                watch_grace=$((watch_now + 1))
                # shellcheck disable=SC2086
                while process_list_alive $watch_processes; do
                    watch_now=$(date -u '+%s' 2>/dev/null || printf '%s' "$watch_grace")
                    [ "$watch_now" -lt "$watch_grace" ] || break
                    sleep 1
                done
                # shellcheck disable=SC2086
                signal_process_list KILL $watch_processes
                exit 0
            fi
            sleep 1
        done
    ) >/dev/null 2>&1 &
    WATCH_PID=$!

    run_status=0
    if wait "$RUN_PID" 2>/dev/null; then
        :
    else
        run_status=$?
    fi
    RUN_PID=
    : > "$run_done"
    wait "$WATCH_PID" 2>/dev/null || true
    WATCH_PID=
    [ ! -e "$run_timed_out" ] || return 124
    return "$run_status"
}

STATUS_FILE=$TMP_ROOT/status.out
run_bounded_updater "$STATUS_FILE" status || exit 0
STATUS_OUTPUT=$(cat "$STATUS_FILE")
status_field() {
    printf '%s\n' "$STATUS_OUTPUT" | sed -n "s/^$1=//p" | tail -n 1
}

LAST_CHECK_LOCAL=$(status_field lastCheckLocal)
case "$LAST_CHECK_LOCAL" in ''|*[!0-9]*) LAST_CHECK_LOCAL=0 ;; esac
NOW=$(date -u '+%s' 2>/dev/null) || exit 0
if [ "$MODE" != force ] && [ "$LAST_CHECK_LOCAL" -gt 0 ]; then
    if [ "$NOW" -lt "$LAST_CHECK_LOCAL" ]; then
        LAST_CHECK_LOCAL=0
    elif [ $((NOW - LAST_CHECK_LOCAL)) -lt "$CHECK_INTERVAL" ]; then
        exit 0
    fi
fi

CHECK_OUTPUT=$TMP_ROOT/check.out
run_bounded_updater "$CHECK_OUTPUT" check || exit 0
NOTICE_LINE=$(sed -n '/^Eligible update: /p' "$CHECK_OUTPUT" | tail -n 1)
[ -n "$NOTICE_LINE" ] || exit 0
RELEASE=${NOTICE_LINE#Eligible update: }
RELEASE=${RELEASE%% *}
printf '%s\n' "$RELEASE" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || exit 0

shell_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

SCOPE=$(status_field scope)
PROJECT_ROOT=$(status_field projectRoot)
case "$SCOPE" in
    global)
        UPDATE_COMMAND="$(shell_quote "$UPDATER") apply --global"
        ;;
    project)
        [ -n "$PROJECT_ROOT" ] || exit 0
        UPDATE_COMMAND="$(shell_quote "$UPDATER") apply --project $(shell_quote "$PROJECT_ROOT")"
        ;;
    *) exit 0 ;;
esac

{
    printf '\nTraceknot update available: %s\n' "$RELEASE"
    printf '%s\n' 'A newer release is eligible under the seven-day update policy.'
    printf '%s\n' 'Recommended verification-and-update command:'
    printf '  %s\n' "$UPDATE_COMMAND"
    printf '%s\n' 'This maintenance advisory does not affect the current QA verdict.'
} >&2
'''
Path('bin/traceknot-update-notice').write_text(notice)
Path('skill/bin/traceknot-update-notice').write_text(notice)

notice_test = r'''#!/bin/sh
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

# Status is part of the same deadline and a TERM-ignoring descendant cannot
# survive after the status shell exits.
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
'''
Path('tests/update-notice-smoke.sh').write_text(notice_test)
