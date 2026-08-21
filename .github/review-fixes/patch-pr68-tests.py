from pathlib import Path
import re

path = Path('tests/skills-updater-smoke.sh')
text = path.read_text()

def sub(pattern: str, replacement: str, label: str, flags: int = 0) -> None:
    global text
    text, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')

sub(r'''if \[ -n "\$\{FAKE_CURL_SLEEP:-\}" \]; then\n    sleep "\$FAKE_CURL_SLEEP"\nfi\n''', '''if [ -n "${FAKE_CURL_PID_FILE:-}" ]; then
    printf '%s\\n' "$$" > "$FAKE_CURL_PID_FILE"
fi
if [ "${FAKE_CURL_IGNORE_TERM:-0}" -eq 1 ]; then
    trap '' TERM
fi
if [ -n "${FAKE_CURL_SLEEP:-}" ]; then
    sleep "$FAKE_CURL_SLEEP"
fi
''', 'curl escalation fixture')

sub(r'''(if \[ "\$\{FAKE_TAMPER_PREFLIGHT:-0\}" -eq 1 \] && \[ "\$HOME" != "\$REAL_HOME" \]; then\n    printf '%s\\n' '# tampered preflight payload' >> "\$target/SKILL.md"\nfi\n)''', r'''\1if [ "${FAKE_POISON_PREFLIGHT:-0}" -eq 1 ] && [ "$HOME" != "$REAL_HOME" ]; then
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
''', 'preflight mutation fixtures')

sub(r'''(if \[ "\$\{FAKE_TAMPER_APPLY:-0\}" -eq 1 \] && \[ "\$HOME" = "\$REAL_HOME" \]; then\n    printf '%s\\n' '# tampered canonical payload' >> "\$target/SKILL.md"\nfi\n)''', r'''\1if [ "${FAKE_POISON_APPLY:-0}" -eq 1 ] && [ "$HOME" = "$REAL_HOME" ]; then
    cat > "$target/bin/traceknot" <<'EOF_POISON'
#!/bin/sh
: > "$FAKE_RUNTIME_MARKER"
exit 0
EOF_POISON
    chmod +x "$target/bin/traceknot"
fi
''', 'apply poison fixture')

sub(r'''test ! -e "\$BASELINE_STATE/update\.lock-recovery"\nmkdir "\$BASELINE_STATE/pending-payload"\n''', '''test ! -e "$BASELINE_STATE/update.lock-recovery"
NO_FLOCK_BIN=$TMP_DIR/no-flock-bin
mkdir -p "$NO_FLOCK_BIN"
for no_flock_cmd in awk basename cat cut date dirname find grep jq kill ln ls mkdir mv pgrep ps pwd rm sed sha256sum sh sleep sync tr wc; do
    no_flock_path=$(command -v "$no_flock_cmd" 2>/dev/null || true)
    [ -z "$no_flock_path" ] || ln -s "$no_flock_path" "$NO_FLOCK_BIN/$no_flock_cmd"
done
sleep 30 &
NO_FLOCK_STALE_PID=$!
printf '%s\\n%s\\n' "$NO_FLOCK_STALE_PID" stale-process-identity > "$BASELINE_STATE/update.lock"
mkdir "$BASELINE_STATE/update.lock-recovery"
PATH=$FAKE_BIN:$NO_FLOCK_BIN "$BASELINE_SKILL/bin/traceknot-skills-update" status --project "$BASELINE_PROJECT" >/dev/null
kill "$NO_FLOCK_STALE_PID" 2>/dev/null || true
test ! -e "$BASELINE_STATE/update.lock-recovery"
mkdir "$BASELINE_STATE/pending-payload"
''', 'fallback crash recovery')

sub(r'''\[ "\$\(\(END_TIMEOUT - START_TIMEOUT\)\)" -lt 6 \]\ntest ! -e "\$TIMEOUT_STATE/update\.lock"\n''', '''[ "$((END_TIMEOUT - START_TIMEOUT))" -lt 6 ]
test ! -e "$TIMEOUT_STATE/update.lock"
CURL_PID_FILE=$TMP_DIR/timeout-curl.pid
START_TIMEOUT=$(date -u '+%s')
if FAKE_CURL_SLEEP=30 FAKE_CURL_IGNORE_TERM=1 FAKE_CURL_PID_FILE="$CURL_PID_FILE" \\
    TRACEKNOT_UPDATE_OPERATION_TIMEOUT=2 \\
    "$TIMEOUT_SKILL/bin/traceknot-skills-update" --project "$TIMEOUT_PROJECT" --auto >/dev/null 2>&1; then
    printf '%s\\n' 'TERM-ignoring bounded check unexpectedly succeeded' >&2
    exit 1
fi
END_TIMEOUT=$(date -u '+%s')
[ "$((END_TIMEOUT - START_TIMEOUT))" -lt 7 ]
if [ -f "$CURL_PID_FILE" ] && kill -0 "$(cat "$CURL_PID_FILE")" 2>/dev/null; then
    printf '%s\\n' 'timeout child survived KILL escalation' >&2
    exit 1
fi
''', 'kill escalation')

marker = '# Global registration: opt-in scheduling, strict seven-day boundary, exact-commit apply.\nGLOBAL_SKILL=$HOME/.agents/skills/traceknot\n'
if text.count(marker) != 1:
    raise SystemExit(f'current review insertion: expected one marker, found {text.count(marker)}')
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
printf '%s\\t%s\\t%s\\t%s\\n' "$(manifest_sha)" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" > "$MATCH_ADOPTION_STATE/observations.tsv"
before_match_adoption=$(cat "$NPX_COUNT")
"$MATCH_ADOPTION_SKILL/bin/traceknot-skills-update" apply --project "$MATCH_ADOPTION_PROJECT" >/dev/null
test "$(cat "$NPX_COUNT")" -eq $((before_match_adoption + 2))
jq -e --arg commit "$SOURCE_COMMIT" '.sourceCommit == $commit' "$MATCH_ADOPTION_STATE/active.json" >/dev/null

# Concurrent lock or registration changes during preflight are rejected before the real mutation.
for mutation_kind in lock registration; do
    RACE_PROJECT="$TMP_DIR/race-$mutation_kind"
    mkdir -p "$RACE_PROJECT"
    RACE_SKILL=$RACE_PROJECT/.agents/skills/traceknot
    install_initial_skill "$RACE_SKILL"
    write_initial_lock "$RACE_PROJECT/skills-lock.json"
    RACE_STATE=$RACE_PROJECT/.agents/.traceknot-update
    seed_adoption "$RACE_STATE" "$RACE_PROJECT/skills-lock.json" 0 "$((FAKE_NOW - 1814400))"
    printf '%s\\t%s\\t%s\\t%s\\n' "$(manifest_sha)" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" > "$RACE_STATE/observations.tsv"
    before_race=$(cat "$NPX_COUNT")
    if [ "$mutation_kind" = lock ]; then export FAKE_MUTATE_LOCK_PATH="$RACE_PROJECT/skills-lock.json"; else export FAKE_MUTATE_REGISTRATION_PATH="$RACE_SKILL"; fi
    if "$RACE_SKILL/bin/traceknot-skills-update" apply --project "$RACE_PROJECT" >/dev/null 2>&1; then
        printf 'concurrent %s mutation was not rejected\\n' "$mutation_kind" >&2
        exit 1
    fi
    unset FAKE_MUTATE_LOCK_PATH FAKE_MUTATE_REGISTRATION_PATH
    test "$(cat "$NPX_COUNT")" -eq $((before_race + 1))
    test ! -e "$RACE_STATE/pending.json"
done

# Candidate runtimes are never executed before byte equality is established.
for poison_kind in preflight apply; do
    POISON_PROJECT="$TMP_DIR/poison-$poison_kind"
    mkdir -p "$POISON_PROJECT"
    POISON_SKILL=$POISON_PROJECT/.agents/skills/traceknot
    install_initial_skill "$POISON_SKILL"
    write_initial_lock "$POISON_PROJECT/skills-lock.json"
    POISON_STATE=$POISON_PROJECT/.agents/.traceknot-update
    seed_adoption "$POISON_STATE" "$POISON_PROJECT/skills-lock.json" 0 "$((FAKE_NOW - 1814400))"
    printf '%s\\t%s\\t%s\\t%s\\n' "$(manifest_sha)" "$((FAKE_NOW - 604801))" "$TAG" "$ARTIFACT_SHA" > "$POISON_STATE/observations.tsv"
    RUNTIME_MARKER=$TMP_DIR/runtime-$poison_kind.executed
    export FAKE_RUNTIME_MARKER="$RUNTIME_MARKER"
    if [ "$poison_kind" = preflight ]; then export FAKE_POISON_PREFLIGHT=1; else export FAKE_POISON_APPLY=1; fi
    if "$POISON_SKILL/bin/traceknot-skills-update" apply --project "$POISON_PROJECT" >/dev/null 2>&1; then
        printf 'poisoned %s runtime unexpectedly applied\\n' "$poison_kind" >&2
        exit 1
    fi
    unset FAKE_POISON_PREFLIGHT FAKE_POISON_APPLY FAKE_RUNTIME_MARKER
    test ! -e "$RUNTIME_MARKER"
done

'''
text = text.replace(marker, block + marker, 1)
path.write_text(text)
