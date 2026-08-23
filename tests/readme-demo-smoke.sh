#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -P -- "$(dirname "$0")/.." && pwd)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-readme-demo.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT HUP INT TERM

HOME_DIR=$TMP_ROOT/home
VERIFY_DEMO=$TMP_ROOT/verify-demo
CODEX_DEMO=$TMP_ROOT/codex-demo
mkdir -p "$HOME_DIR/.codex"
printf '{}\n' > "$HOME_DIR/.codex/auth.json"

run_verify_setup() {
    HOME=$HOME_DIR TRACEKNOT_DEMO_DIR=$VERIFY_DEMO sh "$ROOT/assets/readme/tapes/verify-setup.sh" >/dev/null
    [ -x "$VERIFY_DEMO/traceknot" ]
    cmp -s "$ROOT/skill/bin/traceknot" "$VERIFY_DEMO/traceknot"
    HOME=$HOME_DIR "$VERIFY_DEMO/traceknot" verify \
        --request "$VERIFY_DEMO/request.json" \
        --manifest "$VERIFY_DEMO/manifest.json" \
        --root "$VERIFY_DEMO/demo-app" \
        --state-dir "$VERIFY_DEMO/verify-state" \
        --format json \
        --session-id readme-demo-session \
        --session-host readme-demo-host >/dev/null
}

run_verify_setup
run_verify_setup
printf 'dirty\n' >> "$VERIFY_DEMO/demo-app/src/version.ts"
DIRTY_OUTPUT=$TMP_ROOT/dirty-output.json
if HOME=$HOME_DIR "$VERIFY_DEMO/traceknot" verify \
    --request "$VERIFY_DEMO/request.json" \
    --manifest "$VERIFY_DEMO/manifest.json" \
    --root "$VERIFY_DEMO/demo-app" \
    --state-dir "$VERIFY_DEMO/dirty-state" \
    --format json >"$DIRTY_OUTPUT" 2>&1; then
    printf '%s\n' 'dirty demo repository unexpectedly passed the clean-tree obligation' >&2
    exit 1
fi
grep -F '"qaVerdict": "FAIL"' "$DIRTY_OUTPUT" >/dev/null
grep -F '"obligation:condition:clean-tree"' "$DIRTY_OUTPUT" >/dev/null

HOME=$HOME_DIR TRACEKNOT_CODEX_DEMO=$CODEX_DEMO sh "$ROOT/assets/readme/tapes/codex-board-setup.sh" >/dev/null
case "$(uname -s)" in
    Darwin)
        SANDBOX_MODE=$(stat -f '%Lp' "$CODEX_DEMO")
        AUTH_MODE=$(stat -f '%Lp' "$CODEX_DEMO/codex-home/auth.json")
        ;;
    *)
        SANDBOX_MODE=$(stat -c '%a' "$CODEX_DEMO")
        AUTH_MODE=$(stat -c '%a' "$CODEX_DEMO/codex-home/auth.json")
        ;;
esac
[ "$SANDBOX_MODE" = 700 ]
[ "$AUTH_MODE" = 600 ]
[ -f "$CODEX_DEMO/request.json" ]
[ -f "$CODEX_DEMO/manifest.json" ]
cmp -s "$ROOT/skill/bin/traceknot" "$CODEX_DEMO/home/.agents/skills/traceknot/bin/traceknot"
[ ! -e "$CODEX_DEMO/app/request.json" ]
[ ! -e "$CODEX_DEMO/app/manifest.json" ]
[ -z "$(git -C "$CODEX_DEMO/app" status --porcelain)" ]
HOME=$CODEX_DEMO/home "$CODEX_DEMO/home/.agents/skills/traceknot/bin/traceknot" verify \
    --request "$CODEX_DEMO/request.json" \
    --manifest "$CODEX_DEMO/manifest.json" \
    --root "$CODEX_DEMO/app" \
    --state-dir "$CODEX_DEMO/verify-state" \
    --format json \
    --session-id codex-demo-session \
    --session-host codex-demo-host >/dev/null

FAKE_CHROME=$TMP_ROOT/fake-chrome
cat > "$FAKE_CHROME" <<'EOF_CHROME'
#!/bin/sh
set -eu
OUTPUT=
BOARD=
for argument do
    case "$argument" in
        --screenshot=*) OUTPUT=${argument#--screenshot=} ;;
        file://*) BOARD=$argument ;;
    esac
done
[ -n "$OUTPUT" ] || exit 2
printf '%s\n' "$BOARD" > "$OUTPUT"
EOF_CHROME
chmod +x "$FAKE_CHROME"
TRACEKNOT_CHROME=$FAKE_CHROME sh "$ROOT/assets/readme/tapes/capture-board.sh" \
    "$CODEX_DEMO/verify-state" "$CODEX_DEMO/app/board.png" >/dev/null
[ -s "$CODEX_DEMO/app/board.png" ]
grep -F '/index.en.html' "$CODEX_DEMO/app/board.png" >/dev/null

printf '%s\n' 'README demo smoke test: PASS'
