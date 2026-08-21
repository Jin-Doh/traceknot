from pathlib import Path
import re


def one(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


def subone(text: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return updated


def patch_updater(path: Path) -> None:
    text = path.read_text()
    text = one(text, 'LOCK_OWNER_ID=\n', 'LOCK_OWNER_ID=\nRECOVERY_CLAIM=\n', f'{path}: recovery claim variable')
    text = subone(
        text,
        r'(?m)^    LOCK_CLAIM=\n',
        '''    LOCK_CLAIM=
    if [ -n "$RECOVERY_CLAIM" ]; then
        rm -f "$RECOVERY_CLAIM"
    fi
    RECOVERY_CLAIM=
''',
        f'{path}: recovery claim cleanup',
    )
    recovery = '''acquire_recovery_guard() {
    if [ -L "$RECOVERY_LOCK" ]; then
        fail "unsafe stale-lock recovery path: $RECOVERY_LOCK"
    elif [ -d "$RECOVERY_LOCK" ]; then
        recovery_owner_file=$RECOVERY_LOCK/owner
        if [ ! -e "$recovery_owner_file" ]; then
            [ -z "$(ls -A "$RECOVERY_LOCK" 2>/dev/null)" ] ||
                fail "invalid stale-lock recovery ownership: $RECOVERY_LOCK"
            rm -rf "$RECOVERY_LOCK"
        else
            [ -f "$recovery_owner_file" ] && [ ! -L "$recovery_owner_file" ] ||
                fail "invalid stale-lock recovery ownership: $RECOVERY_LOCK"
            recovery_pid=$(sed -n '1p' "$recovery_owner_file" 2>/dev/null || true)
            recovery_identity=$(sed -n '2p' "$recovery_owner_file" 2>/dev/null || true)
            case "$recovery_pid" in
                ''|*[!0-9]*)
                    [ ! -s "$recovery_owner_file" ] || fail "invalid stale-lock recovery PID: $RECOVERY_LOCK"
                    rm -rf "$RECOVERY_LOCK"
                    ;;
                *)
                    if kill -0 "$recovery_pid" 2>/dev/null; then
                        [ -n "$recovery_identity" ] || fail 'live stale-lock recovery has no process-start identity'
                        current_identity=$(process_identity "$recovery_pid" || true)
                        [ -n "$current_identity" ] || fail 'cannot verify stale-lock recovery identity'
                        [ "$current_identity" = "$recovery_identity" ] &&
                            fail "stale-lock recovery is already in progress: $RECOVERY_LOCK"
                    fi
                    rm -rf "$RECOVERY_LOCK"
                    ;;
            esac
        fi
    elif [ -f "$RECOVERY_LOCK" ]; then
        [ ! -L "$RECOVERY_LOCK" ] || fail "unsafe stale-lock recovery path: $RECOVERY_LOCK"
        recovery_pid=$(sed -n '1p' "$RECOVERY_LOCK" 2>/dev/null || true)
        recovery_identity=$(sed -n '2p' "$RECOVERY_LOCK" 2>/dev/null || true)
        case "$recovery_pid" in
            ''|*[!0-9]*)
                command -v flock >/dev/null 2>&1 ||
                    fail "invalid stale-lock recovery ownership: $RECOVERY_LOCK"
                ;;
            *)
                if kill -0 "$recovery_pid" 2>/dev/null; then
                    [ -n "$recovery_identity" ] || fail 'live stale-lock recovery has no process-start identity'
                    current_identity=$(process_identity "$recovery_pid" || true)
                    [ -n "$current_identity" ] || fail 'cannot verify stale-lock recovery identity'
                    [ "$current_identity" = "$recovery_identity" ] &&
                        fail "stale-lock recovery is already in progress: $RECOVERY_LOCK"
                fi
                rm -f "$RECOVERY_LOCK"
                ;;
        esac
    elif [ -e "$RECOVERY_LOCK" ]; then
        fail "unsafe stale-lock recovery path: $RECOVERY_LOCK"
    fi
    if command -v flock >/dev/null 2>&1; then
        if [ ! -e "$RECOVERY_LOCK" ]; then
            (set -C; : > "$RECOVERY_LOCK") 2>/dev/null ||
                fail "cannot create stale-lock recovery guard: $RECOVERY_LOCK"
        fi
        [ -f "$RECOVERY_LOCK" ] && [ ! -L "$RECOVERY_LOCK" ] ||
            fail "unsafe stale-lock recovery path: $RECOVERY_LOCK"
        exec 9>>"$RECOVERY_LOCK"
        flock -n 9 || fail "stale-lock recovery is already in progress: $RECOVERY_LOCK"
        RECOVERY_LOCK_HELD=2
    else
        RECOVERY_CLAIM=$RECOVERY_LOCK.claim.$$
        if ! (set -C; printf '%s\n%s\n' "$$" "$LOCK_OWNER_ID" > "$RECOVERY_CLAIM") 2>/dev/null; then
            fail "cannot create stale-lock recovery claim: $RECOVERY_CLAIM"
        fi
        [ -f "$RECOVERY_CLAIM" ] && [ ! -L "$RECOVERY_CLAIM" ] ||
            fail "unsafe stale-lock recovery claim: $RECOVERY_CLAIM"
        if [ ! -e "$RECOVERY_LOCK" ] && [ ! -L "$RECOVERY_LOCK" ] &&
           ln "$RECOVERY_CLAIM" "$RECOVERY_LOCK" 2>/dev/null; then
            rm -f "$RECOVERY_CLAIM"
            RECOVERY_CLAIM=
            RECOVERY_LOCK_HELD=3
        else
            rm -f "$RECOVERY_CLAIM"
            RECOVERY_CLAIM=
            fail "stale-lock recovery is already in progress: $RECOVERY_LOCK"
        fi
    fi
}'''
    text = subone(
        text,
        r'acquire_recovery_guard\(\) \{\n.*?\n\}\n\nacquire_lock\(\) \{',
        recovery + '\n\nacquire_lock() {',
        f'{path}: recovery guard',
        re.S,
    )

    deadline = '''run_with_deadline() {
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
                signal_process_tree TERM "$bounded_pid"
                bounded_grace_deadline=$((bounded_now + 2))
                while kill -0 "$bounded_pid" 2>/dev/null; do
                    bounded_now=$(date -u '+%s') || break
                    [ "$bounded_now" -lt "$bounded_grace_deadline" ] || break
                    sleep 1
                done
                if kill -0 "$bounded_pid" 2>/dev/null; then
                    signal_process_tree KILL "$bounded_pid"
                fi
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
}'''
    text = subone(
        text,
        r'run_with_deadline\(\) \{\n.*?\n\}\n\ndurable_sync\(\) \{',
        deadline + '\n\ndurable_sync() {',
        f'{path}: deadline escalation',
        re.S,
    )

    text = one(text, '''        [ -x "$REGISTRATION/bin/traceknot" ] ||
            fail 'pending update did not leave the Traceknot runtime'
        "$REGISTRATION/bin/traceknot" self-check >/dev/null 2>&1 ||
            fail 'pending update left an invalid Traceknot runtime'
        command -v diff >/dev/null 2>&1 || fail 'diff is required to reconcile a pending update'
''', '''        [ -x "$REGISTRATION/bin/traceknot" ] ||
            fail 'pending update did not leave the Traceknot runtime'
        command -v diff >/dev/null 2>&1 || fail 'diff is required to reconcile a pending update'
''', f'{path}: pending early execute')
    text = one(text, '''        if ! diff -r "$PENDING_PAYLOAD_DIR" "$REGISTRATION" >/dev/null 2>&1; then
            fail 'pending update payload differs from the installed registration'
        fi
        if [ -f "$ACTIVE_STATE" ] &&
''', '''        if ! run_with_deadline diff -r "$PENDING_PAYLOAD_DIR" "$REGISTRATION" >/dev/null 2>&1; then
            fail 'pending update payload differs from the installed registration'
        fi
        run_with_deadline "$REGISTRATION/bin/traceknot" self-check >/dev/null 2>&1 ||
            fail 'pending update left an invalid Traceknot runtime'
        if [ -f "$ACTIVE_STATE" ] &&
''', f'{path}: pending verify before execute')
    text = one(text, '''[ -x "$PREFLIGHT_SKILL/bin/traceknot" ] || fail 'preflight Skill runtime is missing'
[ -x "$PREFLIGHT_SKILL/bin/traceknot-skills-update" ] || fail 'preflight Skills updater is missing'
if ! "$PREFLIGHT_SKILL/bin/traceknot" self-check >/dev/null 2>&1; then
    fail 'preflight runtime self-check failed'
fi
reject_registration_symlinks "$PREFLIGHT_SKILL"
if ! diff -r "$VERIFIED_RELEASE/skill" "$PREFLIGHT_SKILL" >/dev/null 2>&1; then
    fail 'Skills CLI preflight payload differs from the verified release artifact'
fi
''', '''[ -x "$PREFLIGHT_SKILL/bin/traceknot" ] || fail 'preflight Skill runtime is missing'
[ -x "$PREFLIGHT_SKILL/bin/traceknot-skills-update" ] || fail 'preflight Skills updater is missing'
reject_registration_symlinks "$PREFLIGHT_SKILL"
if ! run_with_deadline diff -r "$VERIFIED_RELEASE/skill" "$PREFLIGHT_SKILL" >/dev/null 2>&1; then
    fail 'Skills CLI preflight payload differs from the verified release artifact'
fi
run_with_deadline "$PREFLIGHT_SKILL/bin/traceknot" self-check >/dev/null 2>&1 ||
    fail 'preflight runtime self-check failed'
''', f'{path}: preflight order')
    text = one(text, '''[ -x "$REGISTRATION/bin/traceknot" ] || fail 'updated Traceknot runtime is missing'
[ -x "$REGISTRATION/bin/traceknot-skills-update" ] || fail 'updated Skills updater is missing'
if ! "$REGISTRATION/bin/traceknot" self-check >/dev/null 2>&1; then
    fail 'updated runtime self-check failed'
fi
if ! diff -r "$VERIFIED_RELEASE/skill" "$REGISTRATION" >/dev/null 2>&1; then
    fail 'installed Skills payload differs from the verified release artifact'
fi
''', '''[ -x "$REGISTRATION/bin/traceknot" ] || fail 'updated Traceknot runtime is missing'
[ -x "$REGISTRATION/bin/traceknot-skills-update" ] || fail 'updated Skills updater is missing'
if ! run_with_deadline diff -r "$VERIFIED_RELEASE/skill" "$REGISTRATION" >/dev/null 2>&1; then
    fail 'installed Skills payload differs from the verified release artifact'
fi
run_with_deadline "$REGISTRATION/bin/traceknot" self-check >/dev/null 2>&1 ||
    fail 'updated runtime self-check failed'
''', f'{path}: installed order')
    text = one(text, '''        if [ "$LOCK_REF" = "$SOURCE_COMMIT" ]; then
            record_unmanaged_lock_match
            continue
        fi
''', '''        if [ "$LOCK_REF" = "$SOURCE_COMMIT" ]; then
            record_unmanaged_lock_match
            if [ "$MANUAL_ADOPTION" -eq 0 ]; then
                continue
            fi
        fi
''', f'{path}: matching adoption')
    text = one(text, '''HEADERS=$TMP_ROOT/headers
RELEASE_JSON=$TMP_ROOT/releases.json

validate_asset_api_url() {''', '''HEADERS=$TMP_ROOT/headers
RELEASE_JSON=$TMP_ROOT/releases.json
STARTUP_REGISTRATION=
STARTUP_LOCK_REF=$LOCK_REF
STARTUP_LOCK_ENTRY_SHA256=$LOCK_ENTRY_SHA256
if [ "$COMMAND" = apply ]; then
    command -v diff >/dev/null 2>&1 || fail 'diff is required to snapshot the starting registration'
    reject_registration_symlinks "$REGISTRATION"
    STARTUP_REGISTRATION=$TMP_ROOT/startup-registration
    mkdir "$STARTUP_REGISTRATION"
    cp -R "$REGISTRATION/." "$STARTUP_REGISTRATION/"
    if ! run_with_deadline diff -r "$REGISTRATION" "$STARTUP_REGISTRATION" >/dev/null 2>&1; then
        fail 'cannot snapshot the starting Skills registration'
    fi
fi
revalidate_starting_state() {
    [ -f "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ] ||
        fail 'Skills CLI lock disappeared before update commit'
    commit_lock_ref=$(jq -r '.skills.traceknot.ref // ""' "$LOCK_FILE")
    commit_lock_entry_sha256=$(jq -cS '.skills.traceknot' "$LOCK_FILE" | sha256_stdin)
    [ "$commit_lock_ref" = "$STARTUP_LOCK_REF" ] &&
        [ "$commit_lock_entry_sha256" = "$STARTUP_LOCK_ENTRY_SHA256" ] ||
        fail 'Skills CLI lock changed while the verified update was being prepared'
    reject_registration_symlinks "$REGISTRATION"
    if ! run_with_deadline diff -r "$STARTUP_REGISTRATION" "$REGISTRATION" >/dev/null 2>&1; then
        fail 'Skills registration changed while the verified update was being prepared'
    fi
}

validate_asset_api_url() {''', f'{path}: startup snapshot')
    text = one(text, '''if [ -e "$PENDING_PREVIOUS_PAYLOAD_DIR" ] || [ -L "$PENDING_PREVIOUS_PAYLOAD_DIR" ]; then
    fail 'previous pending payload path already exists'
fi
if find "$REGISTRATION" -type l -print | grep . >/dev/null; then
    fail 'installed registration contains a symbolic link'
fi
''', '''revalidate_starting_state
if [ -e "$PENDING_PREVIOUS_PAYLOAD_DIR" ] || [ -L "$PENDING_PREVIOUS_PAYLOAD_DIR" ]; then
    fail 'previous pending payload path already exists'
fi
''', f'{path}: first revalidation')
    text = one(text, '''CURRENT_LOCK_REF=$(jq -r '.skills.traceknot.ref // empty' "$LOCK_FILE")
write_pending_state''', '''revalidate_starting_state
CURRENT_LOCK_REF=$(jq -r '.skills.traceknot.ref // empty' "$LOCK_FILE")
write_pending_state''', f'{path}: final revalidation')
    text = one(text, '''VERIFIED_RELEASE=$TMP_ROOT/verified-release
mkdir "$VERIFIED_RELEASE"
tar -tzf "$ARCHIVE" | while IFS= read -r entry; do
    case "$entry" in
        /*|../*|*/../*|*/..|..) fail "unsafe archive entry: $entry" ;;
    esac
done
tar -xzf "$ARCHIVE" -C "$VERIFIED_RELEASE" --strip-components 1
''', '''VERIFIED_RELEASE=$TMP_ROOT/verified-release
ARCHIVE_LIST=$TMP_ROOT/archive.list
mkdir "$VERIFIED_RELEASE"
run_with_deadline tar -tzf "$ARCHIVE" > "$ARCHIVE_LIST" || fail 'cannot list the release archive within the operation deadline'
while IFS= read -r entry; do
    case "$entry" in
        /*|../*|*/../*|*/..|..) fail "unsafe archive entry: $entry" ;;
    esac
done < "$ARCHIVE_LIST"
run_with_deadline tar -xzf "$ARCHIVE" -C "$VERIFIED_RELEASE" --strip-components 1 ||
    fail 'cannot extract the release archive within the operation deadline'
''', f'{path}: archive deadline')
    path.write_text(text)


def patch_tests(path: Path) -> None:
    text = path.read_text()
    text = one(text, '''if [ -n "${FAKE_CURL_SLEEP:-}" ]; then
    sleep "$FAKE_CURL_SLEEP"
fi
''', '''if [ -n "${FAKE_CURL_PID_FILE:-}" ]; then
    printf '%s\n' "$$" > "$FAKE_CURL_PID_FILE"
fi
if [ "${FAKE_CURL_IGNORE_TERM:-0}" -eq 1 ]; then
    trap '' TERM
fi
if [ -n "${FAKE_CURL_SLEEP:-}" ]; then
    sleep "$FAKE_CURL_SLEEP"
fi
''', 'tests: curl escalation')
    text = one(text, '''if [ "${FAKE_TAMPER_PREFLIGHT:-0}" -eq 1 ] && [ "$HOME" != "$REAL_HOME" ]; then
    printf '%s\n' '# tampered preflight payload' >> "$target/SKILL.md"
fi
''', '''if [ "${FAKE_TAMPER_PREFLIGHT:-0}" -eq 1 ] && [ "$HOME" != "$REAL_HOME" ]; then
    printf '%s\n' '# tampered preflight payload' >> "$target/SKILL.md"
fi
if [ "${FAKE_POISON_PREFLIGHT:-0}" -eq 1 ] && [ "$HOME" != "$REAL_HOME" ]; then
    cat > "$target/bin/traceknot" <<'EOF_POISON'
#!/bin/sh
: > "$FAKE_RUNTIME_MARKER"
exit 0
EOF_POISON
    chmod +x "$target/bin/traceknot"
fi
if [ "${FAKE_MUTATE_LOCK_PATH:-}" != "" ] && [ "$HOME" != "$REAL_HOME" ]; then
    jq '.skills.traceknot.computedHash = "concurrent-change"' "$FAKE_MUTATE_LOCK_PATH" > "$FAKE_MUTATE_LOCK_PATH.tmp"
    mv "$FAKE_MUTATE_LOCK_PATH.tmp" "$FAKE_MUTATE_LOCK_PATH"
fi
if [ "${FAKE_MUTATE_REGISTRATION_PATH:-}" != "" ] && [ "$HOME" != "$REAL_HOME" ]; then
    printf '%s\n' '# concurrent registration change' >> "$FAKE_MUTATE_REGISTRATION_PATH/SKILL.md"
fi
''', 'tests: preflight mutations')
    text = one(text, '''if [ "${FAKE_TAMPER_APPLY:-0}" -eq 1 ] && [ "$HOME" = "$REAL_HOME" ]; then
    printf '%s\n' '# tampered canonical payload' >> "$target/SKILL.md"
fi
''', '''if [ "${FAKE_TAMPER_APPLY:-0}" -eq 1 ] && [ "$HOME" = "$REAL_HOME" ]; then
    printf '%s\n' '# tampered canonical payload' >> "$target/SKILL.md"
fi
if [ "${FAKE_POISON_APPLY:-0}" -eq 1 ] && [ "$HOME" = "$REAL_HOME" ]; then
    cat > "$target/bin/traceknot" <<'EOF_POISON'
#!/bin/sh
: > "$FAKE_RUNTIME_MARKER"
exit 0
EOF_POISON
    chmod +x "$target/bin/traceknot"
fi
''', 'tests: apply poison')
    text = one(text, '''[ "$((END_TIMEOUT - START_TIMEOUT))" -lt 6 ]
test ! -e "$TIMEOUT_STATE/update.lock"
''', '''[ "$((END_TIMEOUT - START_TIMEOUT))" -lt 6 ]
test ! -e "$TIMEOUT_STATE/update.lock"
CURL_PID_FILE=$TMP_DIR/timeout-curl.pid
START_TIMEOUT=$(date -u '+%s')
if FAKE_CURL_SLEEP=30 FAKE_CURL_IGNORE_TERM=1 FAKE_CURL_PID_FILE="$CURL_PID_FILE" \
    TRACEKNOT_UPDATE_OPERATION_TIMEOUT=2 \
    "$TIMEOUT_SKILL/bin/traceknot-skills-update" --project "$TIMEOUT_PROJECT" --auto >/dev/null 2>&1; then
    printf '%s\n' 'TERM-ignoring bounded check unexpectedly succeeded' >&2
    exit 1
fi
END_TIMEOUT=$(date -u '+%s')
[ "$((END_TIMEOUT - START_TIMEOUT))" -lt 7 ]
if [ -f "$CURL_PID_FILE" ] && kill -0 "$(cat "$CURL_PID_FILE")" 2>/dev/null; then
    printf '%s\n' 'timeout child survived KILL escalation' >&2
    exit 1
fi
''', 'tests: kill escalation')
    text = one(text, '''test ! -e "$BASELINE_STATE/update.lock-recovery"
mkdir "$BASELINE_STATE/pending-payload"
''', '''test ! -e "$BASELINE_STATE/update.lock-recovery"
NO_FLOCK_BIN=$TMP_DIR/no-flock-bin
mkdir -p "$NO_FLOCK_BIN"
for no_flock_cmd in awk basename cat cut date dirname find grep jq kill ln ls mkdir mv pgrep ps pwd rm sed sha256sum sh sleep sync tr wc; do
    no_flock_path=$(command -v "$no_flock_cmd" 2>/dev/null || true)
    [ -z "$no_flock_path" ] || ln -s "$no_flock_path" "$NO_FLOCK_BIN/$no_flock_cmd"
done
sleep 30 &
NO_FLOCK_STALE_PID=$!
printf '%s\n%s\n' "$NO_FLOCK_STALE_PID" stale-process-identity > "$BASELINE_STATE/update.lock"
mkdir "$BASELINE_STATE/update.lock-recovery"
PATH=$FAKE_BIN:$NO_FLOCK_BIN "$BASELINE_SKILL/bin/traceknot-skills-update" status --project "$BASELINE_PROJECT" >/dev/null
kill "$NO_FLOCK_STALE_PID" 2>/dev/null || true
test ! -e "$BASELINE_STATE/update.lock-recovery"
mkdir "$BASELINE_STATE/pending-payload"
''', 'tests: fallback crash recovery')
    marker = '# Global registration: opt-in scheduling, strict seven-day boundary, exact-commit apply.\nGLOBAL_SKILL=$HOME/.agents/skills/traceknot\n'
    block = '''# Explicit apply completes adoption even when the current lock already matches the eligible release.
MATCH_ADOPTION_PROJECT="$TMP_DIR/matching adoption project"
mkdir -p "$MATCH_ADOPTION_PROJECT"
MATCH_ADOPTION_SKILL=$MATCH_ADOPTION_PROJECT/.agents/skills/traceknot
install_initial_skill "$MATCH_ADOPTION_SKILL"
write_initial_lock "$MATCH_ADOPTION_PROJECT/skills-lock.json"
jq --arg commit "$SOURCE_COMMIT" '.skills.traceknot.ref = $commit' "$MATCH_ADOPTION_PROJECT/skills-lock.json" > "$MATCH_ADOPTION_PROJECT/skills-lock.json.tmp"
mv "$MATCH_ADOPTION_PROJECT/skills-lock.json.tmp" "$MATCH_ADOPTION_PROJECT/skills-lock.json"
MATCH_ADOPTION_STATE=$MATCH_ADOPTION_PROJECT/.agents/.traceknot-update
seed_adoption "$MATCH_ADOPTION_STATE" "$MATCH_ADOPTION_PROJECT/skills-lock.json" 0 "$FAKE_NOW"
printf '%s\t%s\t%s\t%s\n' "$(manifest_sha)" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" > "$MATCH_ADOPTION_STATE/observations.tsv"
"$MATCH_ADOPTION_SKILL/bin/traceknot-skills-update" apply --project "$MATCH_ADOPTION_PROJECT" >/dev/null
jq -e --arg commit "$SOURCE_COMMIT" '.sourceCommit == $commit' "$MATCH_ADOPTION_STATE/active.json" >/dev/null

# Concurrent lock or registration changes during preflight are rejected before real mutation.
for mutation_kind in lock registration; do
    RACE_PROJECT="$TMP_DIR/race-$mutation_kind"
    mkdir -p "$RACE_PROJECT"
    RACE_SKILL=$RACE_PROJECT/.agents/skills/traceknot
    install_initial_skill "$RACE_SKILL"
    write_initial_lock "$RACE_PROJECT/skills-lock.json"
    RACE_STATE=$RACE_PROJECT/.agents/.traceknot-update
    seed_adoption "$RACE_STATE" "$RACE_PROJECT/skills-lock.json" 0 "$((FAKE_NOW - 1814400))"
    printf '%s\t%s\t%s\t%s\n' "$(manifest_sha)" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" > "$RACE_STATE/observations.tsv"
    if [ "$mutation_kind" = lock ]; then export FAKE_MUTATE_LOCK_PATH="$RACE_PROJECT/skills-lock.json"; else export FAKE_MUTATE_REGISTRATION_PATH="$RACE_SKILL"; fi
    if "$RACE_SKILL/bin/traceknot-skills-update" apply --project "$RACE_PROJECT" >/dev/null 2>&1; then
        printf 'concurrent %s mutation was not rejected\n' "$mutation_kind" >&2
        exit 1
    fi
    unset FAKE_MUTATE_LOCK_PATH FAKE_MUTATE_REGISTRATION_PATH
    test ! -e "$RACE_STATE/pending.json"
done

# Candidate runtimes are never executed before exact payload equality.
for poison_kind in preflight apply; do
    POISON_PROJECT="$TMP_DIR/poison-$poison_kind"
    mkdir -p "$POISON_PROJECT"
    POISON_SKILL=$POISON_PROJECT/.agents/skills/traceknot
    install_initial_skill "$POISON_SKILL"
    write_initial_lock "$POISON_PROJECT/skills-lock.json"
    POISON_STATE=$POISON_PROJECT/.agents/.traceknot-update
    seed_adoption "$POISON_STATE" "$POISON_PROJECT/skills-lock.json" 0 "$((FAKE_NOW - 1814400))"
    printf '%s\t%s\t%s\t%s\n' "$(manifest_sha)" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" > "$POISON_STATE/observations.tsv"
    RUNTIME_MARKER=$TMP_DIR/runtime-$poison_kind.executed
    export FAKE_RUNTIME_MARKER="$RUNTIME_MARKER"
    if [ "$poison_kind" = preflight ]; then export FAKE_POISON_PREFLIGHT=1; else export FAKE_POISON_APPLY=1; fi
    if "$POISON_SKILL/bin/traceknot-skills-update" apply --project "$POISON_PROJECT" >/dev/null 2>&1; then
        printf 'poisoned %s runtime unexpectedly applied\n' "$poison_kind" >&2
        exit 1
    fi
    unset FAKE_POISON_PREFLIGHT FAKE_POISON_APPLY FAKE_RUNTIME_MARKER
    test ! -e "$RUNTIME_MARKER"
done

printf '%s\n' 0 > "$NPX_COUNT"
: > "$NPX_LOG"

'''
    if text.count(marker) != 1:
        raise SystemExit('tests: global marker mismatch')
    text = text.replace(marker, block + marker, 1)
    path.write_text(text)


for updater in (Path('bin/traceknot-skills-update'), Path('skill/bin/traceknot-skills-update')):
    patch_updater(updater)
patch_tests(Path('tests/skills-updater-smoke.sh'))
if Path('bin/traceknot-skills-update').read_bytes() != Path('skill/bin/traceknot-skills-update').read_bytes():
    raise SystemExit('Skills updater mirror drift after restack patch')
print('PR69 restack patch applied')
