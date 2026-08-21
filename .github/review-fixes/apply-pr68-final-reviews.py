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

    deadline_block = r'''signal_process_tree\(\) \{\n.*?\n\}\n\nrun_with_deadline\(\) \{\n.*?\n\}\n\ndurable_sync\(\) \{'''
    deadline_replacement = '''collect_process_tree() {
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
                # PIDs are intentionally word-split into a retained process set.
                # shellcheck disable=SC2086
                signal_process_list TERM $bounded_processes
                bounded_grace_deadline=$((bounded_now + 2))
                # Do not key escalation only to the command parent: it may exit
                # while a TERM-ignoring descendant remains alive and reparented.
                # shellcheck disable=SC2086
                while process_list_alive $bounded_processes; do
                    bounded_now=$(date -u '+%s') || break
                    [ "$bounded_now" -lt "$bounded_grace_deadline" ] || break
                    sleep 1
                done
                # Always KILL the retained descendant set after the grace period.
                # Dead PIDs are harmless; live descendants cannot escape merely
                # because their original parent already exited.
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
    text = subone(text, deadline_block, deadline_replacement, f"{path}: retained timeout process set", re.S)

    revalidate_pattern = r'''revalidate_starting_state\(\) \{\n.*?\n\}\n\nvalidate_asset_api_url\(\) \{'''
    revalidate_replacement = '''starting_state_unchanged() {
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
    text = subone(text, revalidate_pattern, revalidate_replacement, f"{path}: complete starting-state predicate", re.S)

    pending_write = '''write_pending_state "$TRUSTED_NOW" "$VERSION" "$RELEASE_TAG" "$SOURCE_COMMIT" \\
    "$ARTIFACT_SHA" "$CURRENT_LOCK_REF" "$LOCK_ENTRY_SHA256"
APPLY_LOG=$TMP_ROOT/apply.log
'''
    pending_hardened = '''write_pending_state "$TRUSTED_NOW" "$VERSION" "$RELEASE_TAG" "$SOURCE_COMMIT" \\
    "$ARTIFACT_SHA" "$CURRENT_LOCK_REF" "$LOCK_ENTRY_SHA256"
# The pending record is durable now, so close the remaining preparation window
# before invoking Skills CLI. External/manual changes are not governed by our
# private update.lock and must not be overwritten.
if ! starting_state_unchanged; then
    rm -f "$PENDING_STATE"
    rm -rf "$PENDING_PAYLOAD_DIR" "$PENDING_PREVIOUS_PAYLOAD_DIR"
    durable_sync
    fail 'Skills CLI lock or registration changed immediately before update mutation'
fi
APPLY_LOG=$TMP_ROOT/apply.log
'''
    text = replaceone(text, pending_write, pending_hardened, f"{path}: immediate pre-mutation revalidation")

    path.write_text(text)


for updater in (Path('bin/traceknot-skills-update'), Path('skill/bin/traceknot-skills-update')):
    patch_updater(updater)

# Keep the mirror byte-identical even if the two starting copies had incidental differences.
Path('skill/bin/traceknot-skills-update').write_bytes(Path('bin/traceknot-skills-update').read_bytes())

path = Path('tests/skills-updater-smoke.sh')
text = path.read_text()

old_curl = '''if [ -n "${FAKE_CURL_PID_FILE:-}" ]; then
    printf '%s
' "$$" > "$FAKE_CURL_PID_FILE"
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
text = replaceone(text, old_curl, new_curl, 'curl descendant timeout fixture')

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
text = replaceone(text, crontab_marker, sync_fixture, 'post-pending sync race fixture')

existing_timeout = '''if [ -f "$CURL_PID_FILE" ] && kill -0 "$(cat "$CURL_PID_FILE")" 2>/dev/null; then
    printf '%s
' 'timeout child survived KILL escalation' >&2
    exit 1
fi

# Explicit apply completes adoption even when the current lock already matches the eligible release.
'''
expanded_timeout = '''if [ -f "$CURL_PID_FILE" ] && kill -0 "$(cat "$CURL_PID_FILE")" 2>/dev/null; then
    printf '%s\\n' 'timeout child survived KILL escalation' >&2
    exit 1
fi

# A TERM-responsive command parent must not let a TERM-ignoring descendant
# escape after reparenting.
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
text = replaceone(text, existing_timeout, expanded_timeout, 'descendant timeout regression')

race_marker = '''# Candidate runtimes are never executed before byte equality is established.
for poison_kind in preflight apply; do
'''
race_block = '''# A manual/external lock change after pending state becomes durable but before
# the real Skills CLI invocation must abort without overwriting the new lock.
PENDING_RACE_PROJECT="$TMP_DIR/pending-race"
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
text = replaceone(text, race_marker, race_block, 'post-pending race regression')

path.write_text(text)
