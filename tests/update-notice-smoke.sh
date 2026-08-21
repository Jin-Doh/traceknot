#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -P "$(dirname "$0")/.." && pwd)
NOTICE_SOURCE=$ROOT/bin/traceknot-update-notice
grep -F 'CHECK_TIMEOUT=${TRACEKNOT_UPDATE_NOTICE_TIMEOUT:-60}' "$NOTICE_SOURCE" >/dev/null
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-update-notice-smoke.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT HUP INT TERM

HOME=$TMP_ROOT/home
XDG_STATE_HOME=$TMP_ROOT/state
GLOBAL_BIN=$HOME/.agents/skills/traceknot/bin
FIXTURE_MODE=$TMP_ROOT/mode
CALL_LOG=$TMP_ROOT/calls
UPDATER_STATE=$XDG_STATE_HOME/traceknot/skills-update-global
mkdir -p "$GLOBAL_BIN" "$UPDATER_STATE"
cp "$NOTICE_SOURCE" "$GLOBAL_BIN/traceknot-update-notice"
: > "$CALL_LOG"

cat > "$GLOBAL_BIN/traceknot-skills-update" <<'EOF_UPDATER'
#!/bin/sh
set -eu
printf '%s|readOnly=%s|deadline=%s\n' \
    "$*" "${TRACEKNOT_UPDATE_READ_ONLY_CHECK:-}" "${TRACEKNOT_UPDATE_DEADLINE_EPOCH:-}" \
    >> "$NOTICE_TEST_CALL_LOG"
case "$(cat "$NOTICE_TEST_MODE")" in
    eligible)
        printf '%s\n' 'Eligible update: v9.9.9 (0123456789abcdef)'
        ;;
    none)
        printf '%s\n' 'No release has exceeded the seven-day observation requirement.'
        ;;
    malformed)
        printf '%s\n' 'Eligible update: latest (untrusted)'
        ;;
    fail)
        exit 2
        ;;
    slow)
        sleep 1
        printf '%s\n' 'Eligible update: v9.9.9 (0123456789abcdef)'
        ;;
    *) exit 2 ;;
esac
EOF_UPDATER
chmod +x "$GLOBAL_BIN/traceknot-skills-update"

run_global() {
    mode=$1
    HOME=$HOME XDG_STATE_HOME=$XDG_STATE_HOME \
    NOTICE_TEST_MODE=$FIXTURE_MODE NOTICE_TEST_CALL_LOG=$CALL_LOG \
    CI= TRACEKNOT_UPDATE_NOTICE=$mode \
    TRACEKNOT_UPDATE_NOTICE_INTERVAL=86400 \
    TRACEKNOT_UPDATE_NOTICE_TIMEOUT=5 \
        sh "$GLOBAL_BIN/traceknot-update-notice" 2>&1
}

printf '%s\n' eligible > "$FIXTURE_MODE"
output=$(run_global 0)
[ -z "$output" ]
[ ! -s "$CALL_LOG" ]

output=$(run_global auto)
printf '%s\n' "$output" | grep -F 'Traceknot update available: v9.9.9' >/dev/null
printf '%s\n' "$output" | grep -F "'$GLOBAL_BIN/traceknot-skills-update' apply --global" >/dev/null
printf '%s\n' "$output" | grep -F 'apply command performs artifact and provenance verification' >/dev/null
[ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 1 ]
deadline=$(sed -n 's/.*deadline=//p' "$CALL_LOG" | tail -n 1)
case "$deadline" in ''|*[!0-9]*) exit 1 ;; esac
grep -F 'readOnly=1' "$CALL_LOG" >/dev/null

# A successful check owns the separate local rate-limit state.
output=$(run_global auto)
[ -z "$output" ]
[ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 1 ]

# Force bypasses the interval, while no-update remains a completed check.
printf '%s\n' none > "$FIXTURE_MODE"
output=$(run_global force)
[ -z "$output" ]

# A malformed eligibility claim is silent and does not advance the interval.
rm -f "$XDG_STATE_HOME/traceknot/update-notice-global/last-success"
printf '%s\n' malformed > "$FIXTURE_MODE"
output=$(run_global auto)
[ -z "$output" ]
test ! -e "$XDG_STATE_HOME/traceknot/update-notice-global/last-success"
printf '%s\n' eligible > "$FIXTURE_MODE"
output=$(run_global auto)
printf '%s\n' "$output" | grep -F 'Traceknot update available: v9.9.9' >/dev/null

# A failed check does not advance the local success timestamp.
rm -f "$XDG_STATE_HOME/traceknot/update-notice-global/last-success"
printf '%s\n' fail > "$FIXTURE_MODE"
output=$(run_global auto)
[ -z "$output" ]
printf '%s\n' eligible > "$FIXTURE_MODE"
output=$(run_global auto)
printf '%s\n' "$output" | grep -F 'Traceknot update available: v9.9.9' >/dev/null

# Pending updater recovery state suppresses the advisory without invoking check.
rm -f "$XDG_STATE_HOME/traceknot/update-notice-global/last-success"
: > "$UPDATER_STATE/pending.json"
before_pending=$(wc -l < "$CALL_LOG" | tr -d ' ')
output=$(run_global force)
[ -z "$output" ]
[ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq "$before_pending" ]
rm -f "$UPDATER_STATE/pending.json"

# Routine notices yield completely when automatic updates are enabled; an
# explicit force remains available for manual diagnostics.
cat > "$UPDATER_STATE/config" <<'EOF_CONFIG'
traceknot-skills-update-config/v1
automatic=1
EOF_CONFIG
rm -f "$XDG_STATE_HOME/traceknot/update-notice-global/last-success"
before_automatic=$(wc -l < "$CALL_LOG" | tr -d ' ')
output=$(run_global auto)
[ -z "$output" ]
[ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq "$before_automatic" ]
output=$(run_global force)
printf '%s\n' "$output" | grep -F 'Traceknot update available: v9.9.9' >/dev/null
rm -f "$UPDATER_STATE/config" "$XDG_STATE_HOME/traceknot/update-notice-global/last-success"

# Per-invocation claims avoid shared-path stale replacement races.
NOTICE_STATE=$XDG_STATE_HOME/traceknot/update-notice-global
CLAIM_DIR=$NOTICE_STATE/check-claims
mkdir -p "$CLAIM_DIR"
rm -f "$NOTICE_STATE/last-success" "$CLAIM_DIR"/.claim.*.active

# A stale dead claim is reclaimed.
printf '%s\n%s\n' 999999 dead-owner > "$CLAIM_DIR/.claim.stale.active"
output=$(run_global force)
printf '%s\n' "$output" | grep -F 'Traceknot update available: v9.9.9' >/dev/null
test ! -e "$CLAIM_DIR/.claim.stale.active"

# A live exact owner is preserved; a recycled PID with a mismatched identity is
# reclaimed without touching another invocation's unique claim.
process_identity() {
    identity_pid=$1
    if [ -r "/proc/$identity_pid/stat" ]; then
        awk '{ print $22 }' "/proc/$identity_pid/stat"
    else
        ps -p "$identity_pid" -o lstart= |
            sed 's/^[[:space:]]*//; s/[[:space:]][[:space:]]*/ /g; s/[[:space:]]*$//'
    fi
}
sleep 30 &
live_claim_pid=$!
live_claim_identity=$(process_identity "$live_claim_pid")
printf '%s\n%s\n' "$live_claim_pid" "$live_claim_identity" > "$CLAIM_DIR/.claim.live.active"
before_live=$(wc -l < "$CALL_LOG" | tr -d ' ')
output=$(run_global force)
[ -z "$output" ]
[ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq "$before_live" ]
test -f "$CLAIM_DIR/.claim.live.active"
printf '%s\n%s\n' "$live_claim_pid" recycled-owner > "$CLAIM_DIR/.claim.live.active"
output=$(run_global force)
printf '%s\n' "$output" | grep -F 'Traceknot update available: v9.9.9' >/dev/null
test ! -e "$CLAIM_DIR/.claim.live.active"
kill "$live_claim_pid" 2>/dev/null || true

# An unsafe claim directory is fail-closed and never reaches the updater.
rm -rf "$CLAIM_DIR"
mkdir "$TMP_ROOT/outside-claims"
ln -s "$TMP_ROOT/outside-claims" "$CLAIM_DIR"
before_unsafe=$(wc -l < "$CALL_LOG" | tr -d ' ')
output=$(run_global force)
[ -z "$output" ]
[ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq "$before_unsafe" ]
rm -f "$CLAIM_DIR"
mkdir "$CLAIM_DIR"

# Two simultaneous invocations that both publish claims cannot both proceed:
# either one sees the other and exits, or both conservatively exit. A follow-up
# invocation remains immediately eligible because no duplicate success is set.
rm -f "$NOTICE_STATE/last-success" "$CLAIM_DIR"/.claim.*.active
: > "$CALL_LOG"
printf '%s\n' slow > "$FIXTURE_MODE"
HOME=$HOME XDG_STATE_HOME=$XDG_STATE_HOME NOTICE_TEST_MODE=$FIXTURE_MODE NOTICE_TEST_CALL_LOG=$CALL_LOG \
    CI= TRACEKNOT_UPDATE_NOTICE=auto TRACEKNOT_UPDATE_NOTICE_TIMEOUT=5 \
    sh "$GLOBAL_BIN/traceknot-update-notice" 2> "$TMP_ROOT/concurrent-1" &
pid1=$!
HOME=$HOME XDG_STATE_HOME=$XDG_STATE_HOME NOTICE_TEST_MODE=$FIXTURE_MODE NOTICE_TEST_CALL_LOG=$CALL_LOG \
    CI= TRACEKNOT_UPDATE_NOTICE=auto TRACEKNOT_UPDATE_NOTICE_TIMEOUT=5 \
    sh "$GLOBAL_BIN/traceknot-update-notice" 2> "$TMP_ROOT/concurrent-2" &
pid2=$!
wait "$pid1"
wait "$pid2"
call_count=$(wc -l < "$CALL_LOG" | tr -d ' ')
[ "$call_count" -le 1 ]
notice_count=$(cat "$TMP_ROOT/concurrent-1" "$TMP_ROOT/concurrent-2" | grep -c 'Traceknot update available:' || true)
[ "$notice_count" -le 1 ]
if [ "$call_count" -eq 0 ]; then
    output=$(run_global auto)
    printf '%s\n' "$output" | grep -F 'Traceknot update available: v9.9.9' >/dev/null
fi
remaining=$(find "$CLAIM_DIR" -name '.claim.*.active' -type f | wc -l | tr -d ' ')
[ "$remaining" -eq 0 ]

# Project-local scope is inferred from the installed helper path and quoted safely.
PROJECT_ROOT="$TMP_ROOT/project with ' quote"
PROJECT_BIN=$PROJECT_ROOT/.agents/skills/traceknot/bin
mkdir -p "$PROJECT_BIN" "$PROJECT_ROOT/.agents/.traceknot-update"
cp "$NOTICE_SOURCE" "$PROJECT_BIN/traceknot-update-notice"
cp "$GLOBAL_BIN/traceknot-skills-update" "$PROJECT_BIN/traceknot-skills-update"
printf '%s\n' eligible > "$FIXTURE_MODE"
output=$(HOME=$HOME XDG_STATE_HOME=$XDG_STATE_HOME NOTICE_TEST_MODE=$FIXTURE_MODE NOTICE_TEST_CALL_LOG=$CALL_LOG \
    CI= TRACEKNOT_UPDATE_NOTICE=force TRACEKNOT_UPDATE_NOTICE_TIMEOUT=5 \
    sh "$PROJECT_BIN/traceknot-update-notice" 2>&1)
command_line=$(printf '%s\n' "$output" | sed -n 's/^  //p' | tail -n 1)
eval "set -- $command_line"
[ "$1" = "$PROJECT_BIN/traceknot-skills-update" ]
[ "$2" = apply ]
[ "$3" = --project ]
[ "$4" = "$PROJECT_ROOT" ]

# CI suppresses the advisory unless explicitly forced.
: > "$CALL_LOG"
output=$(HOME=$HOME XDG_STATE_HOME=$XDG_STATE_HOME NOTICE_TEST_MODE=$FIXTURE_MODE NOTICE_TEST_CALL_LOG=$CALL_LOG \
    CI=1 TRACEKNOT_UPDATE_NOTICE=auto sh "$GLOBAL_BIN/traceknot-update-notice" 2>&1)
[ -z "$output" ]
[ ! -s "$CALL_LOG" ]

printf '%s\n' 'Update notice smoke test: PASS'
