from pathlib import Path
import re


def one(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def patch_updater(path: Path) -> None:
    text = path.read_text()
    text = one(text, "LAST_CHECK_LOCAL_TMP=\n", "", f"{path}: top temp")
    text = one(text, "LAST_CHECK_LOCAL=$STATE_DIR/lastCheckLocal\n", "", f"{path}: state file")
    text = one(
        text,
        '''    if [ -n "$LAST_CHECK_LOCAL_TMP" ]; then
        rm -f "$LAST_CHECK_LOCAL_TMP"
    fi
''',
        "",
        f"{path}: cleanup temp",
    )
    old_config = '''if [ ! -f "$CONFIG" ]; then
    config_tmp=$CONFIG.tmp.$$
    create_exclusive_file "$config_tmp"
    printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' \\
        'traceknot-skills-update-config/v1' \\
        'automatic=0' \\
        'lastCheck=0' \\
        "scope=$SCOPE" \\
        "projectRoot=$PROJECT_ROOT" \\
        'adoptedAt=0' \\
        'adoptedLockSha256=' > "$config_tmp"
    mv "$config_tmp" "$CONFIG"
fi
[ -f "$CONFIG" ] && [ ! -L "$CONFIG" ] || fail 'unsafe update configuration'
[ "$(sed -n '1p' "$CONFIG")" = traceknot-skills-update-config/v1 ] ||
    fail 'unsupported update configuration'
[ "$(wc -l < "$CONFIG" | tr -d ' ')" -eq 7 ] || fail 'invalid update configuration length'
for config_key in automatic lastCheck scope projectRoot adoptedAt adoptedLockSha256; do
    [ "$(grep -c "^$config_key=" "$CONFIG")" -eq 1 ] ||
        fail "invalid update configuration field: $config_key"
done
AUTOMATIC=$(sed -n 's/^automatic=//p' "$CONFIG")
LAST_CHECK=$(sed -n 's/^lastCheck=//p' "$CONFIG")
CONFIG_SCOPE=$(sed -n 's/^scope=//p' "$CONFIG")
CONFIG_PROJECT_ROOT=$(sed -n 's/^projectRoot=//p' "$CONFIG")
ADOPTED_AT=$(sed -n 's/^adoptedAt=//p' "$CONFIG")
ADOPTED_LOCK_SHA256=$(sed -n 's/^adoptedLockSha256=//p' "$CONFIG")
case "$AUTOMATIC" in 0|1) ;; *) fail 'invalid automatic update setting' ;; esac
case "$LAST_CHECK" in ''|*[!0-9]*) fail 'invalid last check time' ;; esac
case "$ADOPTED_AT" in ''|*[!0-9]*) fail 'invalid adoption time' ;; esac
case "$ADOPTED_LOCK_SHA256" in '') ;; *[!0-9a-f]*) fail 'invalid adopted lock digest' ;; esac
if [ "$ADOPTED_AT" -eq 0 ]; then
    [ -z "$ADOPTED_LOCK_SHA256" ] || fail 'uninitialized adoption state has a lock digest'
else
    [ "${#ADOPTED_LOCK_SHA256}" -eq 64 ] || fail 'adopted lock digest must be SHA-256'
fi
[ "$CONFIG_SCOPE" = "$SCOPE" ] || fail 'update state belongs to another scope'
[ "$CONFIG_PROJECT_ROOT" = "$PROJECT_ROOT" ] || fail 'update state belongs to another project'

write_config() {
    automatic_value=$1
    last_check_value=$2
    adopted_at_value=$3
    adopted_lock_value=$4
    config_tmp=$CONFIG.tmp.$$
    create_exclusive_file "$config_tmp"
    printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' \\
        'traceknot-skills-update-config/v1' \\
        "automatic=$automatic_value" \\
        "lastCheck=$last_check_value" \\
        "scope=$SCOPE" \\
        "projectRoot=$PROJECT_ROOT" \\
        "adoptedAt=$adopted_at_value" \\
        "adoptedLockSha256=$adopted_lock_value" > "$config_tmp"
    mv "$config_tmp" "$CONFIG"
}

write_check_state() {
    write_config "$AUTOMATIC" "$TRUSTED_NOW" "$ADOPTED_AT" "$ADOPTED_LOCK_SHA256"
    LAST_CHECK_LOCAL_TMP=$LAST_CHECK_LOCAL.tmp.$$
    create_exclusive_file "$LAST_CHECK_LOCAL_TMP"
    CHECK_COMPLETED_LOCAL=$(date -u '+%s') ||
        fail 'cannot read local check completion time'
    printf '%s\\n' "$CHECK_COMPLETED_LOCAL" > "$LAST_CHECK_LOCAL_TMP"
    mv "$LAST_CHECK_LOCAL_TMP" "$LAST_CHECK_LOCAL"
    LAST_CHECK_LOCAL_TMP=
    if [ "$SKIP_SYNC" -eq 0 ]; then
        durable_sync
    fi
}
'''
    new_config = '''if [ ! -f "$CONFIG" ]; then
    config_tmp=$CONFIG.tmp.$$
    create_exclusive_file "$config_tmp"
    printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' \\
        'traceknot-skills-update-config/v1' \\
        'automatic=0' \\
        'lastCheck=0' \\
        'lastCheckLocal=0' \\
        "scope=$SCOPE" \\
        "projectRoot=$PROJECT_ROOT" \\
        'adoptedAt=0' \\
        'adoptedLockSha256=' > "$config_tmp"
    mv "$config_tmp" "$CONFIG"
fi
[ -f "$CONFIG" ] && [ ! -L "$CONFIG" ] || fail 'unsafe update configuration'
[ "$(sed -n '1p' "$CONFIG")" = traceknot-skills-update-config/v1 ] ||
    fail 'unsupported update configuration'
CONFIG_LENGTH=$(wc -l < "$CONFIG" | tr -d ' ')
case "$CONFIG_LENGTH" in
    7)
        [ "$(grep -c '^lastCheckLocal=' "$CONFIG")" -eq 0 ] ||
            fail 'invalid legacy update configuration'
        ;;
    8)
        [ "$(grep -c '^lastCheckLocal=' "$CONFIG")" -eq 1 ] ||
            fail 'invalid update configuration local check field'
        ;;
    *) fail 'invalid update configuration length' ;;
esac
for config_key in automatic lastCheck scope projectRoot adoptedAt adoptedLockSha256; do
    [ "$(grep -c "^$config_key=" "$CONFIG")" -eq 1 ] ||
        fail "invalid update configuration field: $config_key"
done
AUTOMATIC=$(sed -n 's/^automatic=//p' "$CONFIG")
LAST_CHECK=$(sed -n 's/^lastCheck=//p' "$CONFIG")
if [ "$CONFIG_LENGTH" -eq 8 ]; then
    LAST_CHECK_LOCAL_VALUE=$(sed -n 's/^lastCheckLocal=//p' "$CONFIG")
else
    LAST_CHECK_LOCAL_VALUE=0
fi
CONFIG_SCOPE=$(sed -n 's/^scope=//p' "$CONFIG")
CONFIG_PROJECT_ROOT=$(sed -n 's/^projectRoot=//p' "$CONFIG")
ADOPTED_AT=$(sed -n 's/^adoptedAt=//p' "$CONFIG")
ADOPTED_LOCK_SHA256=$(sed -n 's/^adoptedLockSha256=//p' "$CONFIG")
case "$AUTOMATIC" in 0|1) ;; *) fail 'invalid automatic update setting' ;; esac
case "$LAST_CHECK" in ''|*[!0-9]*) fail 'invalid last check time' ;; esac
case "$LAST_CHECK_LOCAL_VALUE" in ''|*[!0-9]*) fail 'invalid local check time' ;; esac
case "$ADOPTED_AT" in ''|*[!0-9]*) fail 'invalid adoption time' ;; esac
case "$ADOPTED_LOCK_SHA256" in '') ;; *[!0-9a-f]*) fail 'invalid adopted lock digest' ;; esac
if [ "$ADOPTED_AT" -eq 0 ]; then
    [ -z "$ADOPTED_LOCK_SHA256" ] || fail 'uninitialized adoption state has a lock digest'
else
    [ "${#ADOPTED_LOCK_SHA256}" -eq 64 ] || fail 'adopted lock digest must be SHA-256'
fi
[ "$CONFIG_SCOPE" = "$SCOPE" ] || fail 'update state belongs to another scope'
[ "$CONFIG_PROJECT_ROOT" = "$PROJECT_ROOT" ] || fail 'update state belongs to another project'

write_config() {
    automatic_value=$1
    last_check_value=$2
    last_check_local_value=$3
    adopted_at_value=$4
    adopted_lock_value=$5
    config_tmp=$CONFIG.tmp.$$
    create_exclusive_file "$config_tmp"
    printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' \\
        'traceknot-skills-update-config/v1' \\
        "automatic=$automatic_value" \\
        "lastCheck=$last_check_value" \\
        "lastCheckLocal=$last_check_local_value" \\
        "scope=$SCOPE" \\
        "projectRoot=$PROJECT_ROOT" \\
        "adoptedAt=$adopted_at_value" \\
        "adoptedLockSha256=$adopted_lock_value" > "$config_tmp"
    mv "$config_tmp" "$CONFIG"
}

write_check_state() {
    CHECK_COMPLETED_LOCAL=$(date -u '+%s') ||
        fail 'cannot read local check completion time'
    # Trusted and local completion timestamps are committed by the same atomic
    # config rename, so interruption cannot expose one without the other.
    write_config "$AUTOMATIC" "$TRUSTED_NOW" "$CHECK_COMPLETED_LOCAL" "$ADOPTED_AT" "$ADOPTED_LOCK_SHA256"
    LAST_CHECK_LOCAL_VALUE=$CHECK_COMPLETED_LOCAL
    if [ "$SKIP_SYNC" -eq 0 ]; then
        durable_sync
    fi
}
'''
    text = one(text, old_config, new_config, f"{path}: atomic config")
    text = one(text, 'write_config 1 "$LAST_CHECK" "$ADOPTED_AT" "$ADOPTED_LOCK_SHA256"', 'write_config 1 "$LAST_CHECK" "$LAST_CHECK_LOCAL_VALUE" "$ADOPTED_AT" "$ADOPTED_LOCK_SHA256"', f"{path}: enable")
    text = one(text, 'write_config 0 "$LAST_CHECK" "$ADOPTED_AT" "$ADOPTED_LOCK_SHA256"', 'write_config 0 "$LAST_CHECK" "$LAST_CHECK_LOCAL_VALUE" "$ADOPTED_AT" "$ADOPTED_LOCK_SHA256"', f"{path}: disable")
    text = one(
        text,
        '''if [ -e "$LAST_CHECK_LOCAL" ] || [ -L "$LAST_CHECK_LOCAL" ]; then
    [ -f "$LAST_CHECK_LOCAL" ] && [ ! -L "$LAST_CHECK_LOCAL" ] ||
        fail 'unsafe local check timestamp'
    LAST_CHECK_LOCAL_VALUE=$(cat "$LAST_CHECK_LOCAL")
    case "$LAST_CHECK_LOCAL_VALUE" in ''|*[!0-9]*) fail 'invalid local check timestamp' ;; esac
else
    LAST_CHECK_LOCAL_VALUE=
fi
''',
        "",
        f"{path}: separate local state read",
    )
    path.write_text(text)


def patch_test(path: Path) -> None:
    text = path.read_text()
    text = one(
        text,
        '''automatic=$automatic
lastCheck=0
scope=$seed_scope
''',
        '''automatic=$automatic
lastCheck=0
lastCheckLocal=0
scope=$seed_scope
''',
        "test: seeded config",
    )
    marker = '''# A fresh unmanaged registration adopts its current lock as a no-downgrade baseline.
BASELINE_PROJECT="$TMP_DIR/baseline project"
'''
    legacy = '''# The #68 seven-line config remains readable and upgrades on the next write.
LEGACY_PROJECT="$TMP_DIR/legacy config project"
mkdir -p "$LEGACY_PROJECT"
LEGACY_SKILL=$LEGACY_PROJECT/.agents/skills/traceknot
install_initial_skill "$LEGACY_SKILL"
write_initial_lock "$LEGACY_PROJECT/skills-lock.json"
LEGACY_STATE=$LEGACY_PROJECT/.agents/.traceknot-update
mkdir -p "$LEGACY_STATE"
cat > "$LEGACY_STATE/config" <<EOF_LEGACY
traceknot-skills-update-config/v1
automatic=0
lastCheck=0
scope=project
projectRoot=$LEGACY_PROJECT
adoptedAt=0
adoptedLockSha256=
EOF_LEGACY
legacy_status=$("$LEGACY_SKILL/bin/traceknot-skills-update" status --project "$LEGACY_PROJECT")
printf '%s\\n' "$legacy_status" | grep -F 'lastCheckLocal=0' >/dev/null
"$LEGACY_SKILL/bin/traceknot-skills-update" check --project "$LEGACY_PROJECT" >/dev/null
grep -F 'lastCheckLocal=' "$LEGACY_STATE/config" >/dev/null
[ "$(wc -l < "$LEGACY_STATE/config" | tr -d ' ')" -eq 8 ]
test ! -e "$LEGACY_STATE/lastCheckLocal"

'''
    text = one(text, marker, legacy + marker, "test: legacy migration")
    path.write_text(text)


for updater in (Path('bin/traceknot-skills-update'), Path('skill/bin/traceknot-skills-update')):
    patch_updater(updater)
patch_test(Path('tests/skills-updater-smoke.sh'))
