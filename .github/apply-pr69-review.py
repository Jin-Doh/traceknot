from __future__ import annotations

from pathlib import Path
import textwrap

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content)


def replace_once(content: str, old: str, new: str, label: str) -> str:
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return content.replace(old, new, 1)


updater_path = "bin/traceknot-skills-update"
updater = read(updater_path)

updater = replace_once(
    updater,
    "PENDING_PREVIOUS_PAYLOAD_TMP=\nOPERATION_TIMEOUT=${TRACEKNOT_UPDATE_OPERATION_TIMEOUT:-}\n",
    "PENDING_PREVIOUS_PAYLOAD_TMP=\nLAST_CHECK_LOCAL_TMP=\nOPERATION_TIMEOUT=${TRACEKNOT_UPDATE_OPERATION_TIMEOUT:-}\n",
    "local timestamp temporary state",
)
updater = replace_once(
    updater,
    "fail() {\n    printf '%s: %s\\n' \"$PROGRAM\" \"$*\" >&2\n    exit 2\n}\n\nusage() {\n",
    "fail() {\n    printf '%s: %s\\n' \"$PROGRAM\" \"$*\" >&2\n    exit 2\n}\nSKIP_SYNC=${TRACEKNOT_UPDATE_SKIP_SYNC:-0}\ncase \"$SKIP_SYNC\" in 0|1) ;; *) fail 'invalid sync policy' ;; esac\nMAINTENANCE_MODE=${TRACEKNOT_UPDATE_MAINTENANCE:-0}\ncase \"$MAINTENANCE_MODE\" in 0|1) ;; *) fail 'invalid maintenance mode' ;; esac\n\nusage() {\n",
    "maintenance environment policy",
)
updater = replace_once(
    updater,
    "PENDING_PREVIOUS_PAYLOAD_DIR=$STATE_DIR/pending-previous-payload\n\ncleanup() {\n",
    "PENDING_PREVIOUS_PAYLOAD_DIR=$STATE_DIR/pending-previous-payload\nLAST_CHECK_LOCAL=$STATE_DIR/lastCheckLocal\n\ncleanup() {\n",
    "local timestamp path",
)
updater = replace_once(
    updater,
    "    if [ -n \"$PENDING_PREVIOUS_PAYLOAD_TMP\" ]; then\n        rm -rf \"$PENDING_PREVIOUS_PAYLOAD_TMP\"\n    fi\n    if [ -n \"$TMP_ROOT\" ]; then\n",
    "    if [ -n \"$PENDING_PREVIOUS_PAYLOAD_TMP\" ]; then\n        rm -rf \"$PENDING_PREVIOUS_PAYLOAD_TMP\"\n    fi\n    if [ -n \"$LAST_CHECK_LOCAL_TMP\" ]; then\n        rm -f \"$LAST_CHECK_LOCAL_TMP\"\n    fi\n    if [ -n \"$TMP_ROOT\" ]; then\n",
    "local timestamp cleanup",
)
updater = replace_once(
    updater,
    "}\n\ncron_escape() {\n",
    "}\n\nwrite_check_state() {\n    write_config \"$AUTOMATIC\" \"$TRUSTED_NOW\" \"$ADOPTED_AT\" \"$ADOPTED_LOCK_SHA256\"\n    LAST_CHECK_LOCAL_TMP=$LAST_CHECK_LOCAL.tmp.$$\n    create_exclusive_file \"$LAST_CHECK_LOCAL_TMP\"\n    CHECK_COMPLETED_LOCAL=$(date -u '+%s') ||\n        fail 'cannot read local check completion time'\n    printf '%s\\n' \"$CHECK_COMPLETED_LOCAL\" > \"$LAST_CHECK_LOCAL_TMP\"\n    mv \"$LAST_CHECK_LOCAL_TMP\" \"$LAST_CHECK_LOCAL\"\n    LAST_CHECK_LOCAL_TMP=\n    if [ \"$SKIP_SYNC\" -eq 0 ]; then\n        durable_sync\n    fi\n}\n\ncron_escape() {\n",
    "successful check state writer",
)
updater = replace_once(
    updater,
    "    validate_active_state\n    validate_pending_state\n    if [ ! -e \"$PENDING_STATE\" ] && [ ! -L \"$PENDING_STATE\" ]; then\n        reclaim_orphan_pending_payload\n    fi\n    validate_skills_lock\n    reconcile_pending_state\nfi\n",
    "    validate_active_state\n    validate_pending_state\n    if [ \"$MAINTENANCE_MODE\" -eq 1 ] && [ \"$COMMAND\" = check ]; then\n        if [ -e \"$PENDING_STATE\" ] || [ -L \"$PENDING_STATE\" ] ||\n           [ -e \"$PENDING_PAYLOAD_DIR\" ] || [ -L \"$PENDING_PAYLOAD_DIR\" ] ||\n           [ -e \"$PENDING_PREVIOUS_PAYLOAD_DIR\" ] || [ -L \"$PENDING_PREVIOUS_PAYLOAD_DIR\" ]; then\n            exit 0\n        fi\n    fi\n    validate_skills_lock\n    if [ \"$MAINTENANCE_MODE\" -eq 0 ]; then\n        if [ ! -e \"$PENDING_STATE\" ] && [ ! -L \"$PENDING_STATE\" ]; then\n            reclaim_orphan_pending_payload\n        fi\n        reconcile_pending_state\n    fi\nfi\n",
    "read-only maintenance mode",
)
updater = replace_once(
    updater,
    "if [ \"$COMMAND\" = status ]; then\n    printf 'scope=%s\\nprojectRoot=%s\\nregistration=%s\\nautomatic=%s\\nlastCheck=%s\\nadoptedAt=%s\\noperationTimeout=%s\\n' \\\n        \"$SCOPE\" \"$PROJECT_ROOT\" \"$REGISTRATION\" \"$AUTOMATIC\" \"$LAST_CHECK\" \"$ADOPTED_AT\" \"$OPERATION_TIMEOUT\"\n",
    "if [ -e \"$LAST_CHECK_LOCAL\" ] || [ -L \"$LAST_CHECK_LOCAL\" ]; then\n    [ -f \"$LAST_CHECK_LOCAL\" ] && [ ! -L \"$LAST_CHECK_LOCAL\" ] ||\n        fail 'unsafe local check timestamp'\n    LAST_CHECK_LOCAL_VALUE=$(cat \"$LAST_CHECK_LOCAL\")\n    case \"$LAST_CHECK_LOCAL_VALUE\" in ''|*[!0-9]*) fail 'invalid local check timestamp' ;; esac\nelse\n    LAST_CHECK_LOCAL_VALUE=\nfi\nif [ \"$COMMAND\" = status ]; then\n    printf 'scope=%s\\nprojectRoot=%s\\nregistration=%s\\nautomatic=%s\\nlastCheck=%s\\nlastCheckLocal=%s\\nadoptedAt=%s\\noperationTimeout=%s\\n' \\\n        \"$SCOPE\" \"$PROJECT_ROOT\" \"$REGISTRATION\" \"$AUTOMATIC\" \"$LAST_CHECK\" \"$LAST_CHECK_LOCAL_VALUE\" \"$ADOPTED_AT\" \"$OPERATION_TIMEOUT\"\n",
    "status local check timestamp",
)
updater = replace_once(
    updater,
    "write_config \"$AUTOMATIC\" \"$TRUSTED_NOW\" \"$ADOPTED_AT\" \"$ADOPTED_LOCK_SHA256\"\n\njq -r '\n",
    "\njq -r '\n",
    "defer successful check timestamp",
)
updater = replace_once(
    updater,
    "if [ \"$CANDIDATE_FOUND\" -eq 0 ]; then\n    printf '%s\\n' 'No immutable stable release with an update manifest is available.'\n",
    "if [ \"$CANDIDATE_FOUND\" -eq 0 ]; then\n    write_check_state\n    printf '%s\\n' 'No immutable stable release with an update manifest is available.'\n",
    "no candidate completion",
)
updater = replace_once(
    updater,
    "if [ \"$POST_ADOPTION_CANDIDATE\" -eq 0 ] && [ ! -f \"$ACTIVE_STATE\" ] && [ \"$MANUAL_ADOPTION\" -eq 0 ]; then\n",
    "if [ \"$POST_ADOPTION_CANDIDATE\" -eq 0 ] && [ ! -f \"$ACTIVE_STATE\" ] && [ \"$MANUAL_ADOPTION\" -eq 0 ]; then\n    write_check_state\n",
    "adoption completion",
)
updater = replace_once(
    updater,
    "if [ \"$ELIGIBLE\" -eq 0 ] && [ \"$CURRENT_MATCH\" -eq 1 ]; then\n    printf '%s\\n' 'The newest eligible Traceknot release is already installed.'\n",
    "if [ \"$ELIGIBLE\" -eq 0 ] && [ \"$CURRENT_MATCH\" -eq 1 ]; then\n    write_check_state\n    printf '%s\\n' 'The newest eligible Traceknot release is already installed.'\n",
    "current release completion",
)
updater = replace_once(
    updater,
    "if [ \"$ELIGIBLE\" -eq 0 ]; then\n    printf '%s\\n' 'No release has exceeded the seven-day observation requirement.'\n",
    "if [ \"$ELIGIBLE\" -eq 0 ]; then\n    write_check_state\n    printf '%s\\n' 'No release has exceeded the seven-day observation requirement.'\n",
    "no eligible release completion",
)
updater = replace_once(
    updater,
    "ARTIFACT_URL=$SELECTED_ARTIFACT_URL\nprintf 'Eligible update: %s (%s)\\n' \"$RELEASE_TAG\" \"$ARTIFACT_SHA\"\n",
    "ARTIFACT_URL=$SELECTED_ARTIFACT_URL\nwrite_check_state\nprintf 'Eligible update: %s (%s)\\n' \"$RELEASE_TAG\" \"$ARTIFACT_SHA\"\n",
    "eligible release completion",
)

write(updater_path, updater)
write("skill/bin/traceknot-skills-update", updater)

notice = r'''#!/bin/sh
# Advisory update check for Skills CLI installations.

set -u

MODE=${TRACEKNOT_UPDATE_NOTICE:-auto}
CHECK_INTERVAL=${TRACEKNOT_UPDATE_NOTICE_INTERVAL:-86400}
CHECK_TIMEOUT=${TRACEKNOT_UPDATE_NOTICE_TIMEOUT:-5}
TMP_ROOT=
CHECK_PID=
WATCH_PID=
WATCH_DONE=

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

STATUS_OUTPUT=$(TRACEKNOT_UPDATE_MAINTENANCE=1 "$UPDATER" status 2>/dev/null) || exit 0
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
DEADLINE_EPOCH=$((NOW + CHECK_TIMEOUT))

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-update-notice.XXXXXX" 2>/dev/null) || exit 0
CHECK_OUTPUT=$TMP_ROOT/check.out
WATCH_DONE=$TMP_ROOT/watch.done
signal_process_tree() {
    signal_name=$1
    process_pid=$2
    for child_pid in $(pgrep -P "$process_pid" 2>/dev/null || true); do
        signal_process_tree "$signal_name" "$child_pid"
    done
    kill -s "$signal_name" "$process_pid" 2>/dev/null || true
}
cleanup() {
    if [ -n "$WATCH_PID" ]; then
        signal_process_tree TERM "$WATCH_PID"
        wait "$WATCH_PID" 2>/dev/null || true
    fi
    if [ -n "$CHECK_PID" ]; then
        signal_process_tree TERM "$CHECK_PID"
        wait "$CHECK_PID" 2>/dev/null || true
    fi
    [ -z "$TMP_ROOT" ] || rm -rf "$TMP_ROOT"
}
trap cleanup EXIT
trap 'exit 0' HUP INT TERM

TRACEKNOT_UPDATE_NOTICE=0 \
TRACEKNOT_UPDATE_DEADLINE_EPOCH="$DEADLINE_EPOCH" \
TRACEKNOT_UPDATE_SKIP_SYNC=1 \
TRACEKNOT_UPDATE_MAINTENANCE=1 \
    "$UPDATER" check >"$CHECK_OUTPUT" 2>/dev/null &
CHECK_PID=$!
(
    while [ ! -e "$WATCH_DONE" ]; do
        WATCH_NOW=$(date -u '+%s' 2>/dev/null) || exit 0
        if [ "$WATCH_NOW" -ge "$DEADLINE_EPOCH" ]; then
            signal_process_tree TERM "$CHECK_PID"
            sleep 1
            signal_process_tree KILL "$CHECK_PID"
            exit 0
        fi
        sleep 1
    done
) >/dev/null 2>&1 &
WATCH_PID=$!

CHECK_STATUS=0
if wait "$CHECK_PID" 2>/dev/null; then
    :
else
    CHECK_STATUS=$?
fi
CHECK_PID=
: > "$WATCH_DONE"
signal_process_tree TERM "$WATCH_PID"
wait "$WATCH_PID" 2>/dev/null || true
WATCH_PID=
[ "$CHECK_STATUS" -eq 0 ] || exit 0

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
write("bin/traceknot-update-notice", notice)
write("skill/bin/traceknot-update-notice", notice)

test_notice = r'''#!/bin/sh
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
HOME=$TMP_ROOT/home
XDG_STATE_HOME=$TMP_ROOT/state
mkdir -p "$HOME" "$XDG_STATE_HOME/traceknot/skills-update-global"
BIN_DIR=$(CDPATH='' cd -P "$BIN_DIR" && pwd)
cp "$NOTICE_SOURCE" "$BIN_DIR/traceknot-update-notice"
: > "$CALL_LOG"

cat > "$BIN_DIR/traceknot-skills-update" <<'EOF_UPDATER'
#!/bin/sh
set -eu
trap 'exit 1' HUP INT TERM
case "${1:-}" in
    status)
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
deadline=$(sed -n 's/.*deadline=//p' "$CALL_LOG" | tail -n 1)
case "$deadline" in ''|*[!0-9]*) exit 1 ;; esac
[ "$deadline" -gt "$NOW" ]

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
deadline=$(sed -n 's/.*deadline=//p' "$CALL_LOG" | tail -n 1)
[ "$deadline" -le $((START + 4)) ]

: > "$CALL_LOG"
printf '%s\n' eligible > "$MODE_FILE"
output=$(CI=1 STATUS_FILE=$STATUS_FILE MODE_FILE=$MODE_FILE CALL_LOG=$CALL_LOG \
    TRACEKNOT_UPDATE_NOTICE=auto sh "$BIN_DIR/traceknot-update-notice" 2>&1)
[ -z "$output" ]
[ ! -s "$CALL_LOG" ]

printf '%s\n' 'Update notice smoke test: PASS'
'''
write("tests/update-notice-smoke.sh", test_notice)

skills_test_path = "tests/skills-updater-smoke.sh"
skills_test = read(skills_test_path)
needle = 'BAD_DATE_STATE=$BAD_DATE_PROJECT/.agents/.traceknot-update\nseed_adoption "$BAD_DATE_STATE" "$BAD_DATE_PROJECT/skills-lock.json" 0 "$((FAKE_NOW - 1814400))"\n'
if needle in skills_test and 'lastCheck=123' not in skills_test:
    skills_test = skills_test.replace(
        needle,
        needle + 'sed \'s/^lastCheck=0$/lastCheck=123/\' "$BAD_DATE_STATE/config" > "$BAD_DATE_STATE/config.tmp"\n'
        'mv "$BAD_DATE_STATE/config.tmp" "$BAD_DATE_STATE/config"\n',
        1,
    )
    failure = '    printf \'%s\\n\' \'impossible manifest date was accepted\' >&2\n    exit 1\nfi\n'
    skills_test = replace_once(
        skills_test,
        failure,
        failure + 'test "$(sed -n \'s/^lastCheck=//p\' "$BAD_DATE_STATE/config")" = 123\n',
        "failed eligibility does not advance lastCheck",
    )
write(skills_test_path, skills_test)

docs_path = "docs/automatic-updates.md"
docs = read(docs_path)
docs = docs.replace("  config\n  observations.tsv", "  config\n  lastCheckLocal\n  observations.tsv")
anchor = "The update lock records both the updater PID and its process-start identity. A live PID with a different identity is treated as a stale lock; a legacy live lock without an identity is rejected rather than guessed.\n"
if anchor in docs and "local completion time for a successful eligibility check" not in docs:
    docs = docs.replace(
        anchor,
        anchor + "`lastCheckLocal` records the local completion time for a successful eligibility check. The advisory uses this local companion for its 24-hour rate limit, while `lastCheck` remains the trusted GitHub timestamp used by updater policy. Failed or incomplete checks update neither timestamp.\n",
        1,
    )
if "## Maintenance advisory" not in docs:
    docs += textwrap.dedent(
        """

        ## Maintenance advisory

        After a QA verdict and Board status are fixed, the installed Skill may invoke `traceknot-update-notice` as maintenance advice outside governed verification. It reads `lastCheckLocal`, performs at most one eligibility check per 24 hours, and prints only when a semantic release is eligible under the seven-day policy.

        The helper passes one absolute `TRACEKNOT_UPDATE_DEADLINE_EPOCH` to the sibling updater. Sequential release-list and manifest requests therefore consume one shared budget instead of receiving a fresh timeout each. The same deadline also bounds the helper watchdog. Network, dependency, malformed-output, recovery-state, and timeout failures remain silent and never change the QA verdict.

        The recommendation never invokes `apply` automatically. Artifact digest and provenance verification occur only when the displayed `traceknot-skills-update apply` command is executed. Set `TRACEKNOT_UPDATE_NOTICE=0` to disable the advisory.
        """
    )
write(docs_path, docs)
