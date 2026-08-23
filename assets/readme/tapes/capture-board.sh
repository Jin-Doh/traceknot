#!/bin/sh
# Capture the English Board produced by the disposable Codex demo sandbox.
set -eu

STATE_DIR=${1:-/tmp/traceknot-demo-codex/verify-state}
OUTPUT=${2:-/tmp/traceknot-demo-codex/app/board.png}

set -- "$STATE_DIR"/sessions/*/index.en.html
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    printf '%s\n' "capture-board: expected exactly one English Board at $STATE_DIR/sessions/*/index.en.html" >&2
    exit 1
fi
BOARD=$1

if [ -n "${TRACEKNOT_CHROME:-}" ]; then
    CHROME=$TRACEKNOT_CHROME
elif command -v google-chrome-stable >/dev/null 2>&1; then
    CHROME=$(command -v google-chrome-stable)
elif command -v google-chrome >/dev/null 2>&1; then
    CHROME=$(command -v google-chrome)
elif command -v chromium >/dev/null 2>&1; then
    CHROME=$(command -v chromium)
elif command -v chromium-browser >/dev/null 2>&1; then
    CHROME=$(command -v chromium-browser)
elif [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
else
    printf '%s\n' 'capture-board: Chrome or Chromium is required' >&2
    exit 1
fi
[ -x "$CHROME" ] || { printf '%s\n' "capture-board: browser is not executable: $CHROME" >&2; exit 1; }

mkdir -p "$(dirname "$OUTPUT")"
rm -f "$OUTPUT"
PROFILE=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-board-chrome.XXXXXX")
BROWSER_PID=
cleanup() {
    if [ -n "$BROWSER_PID" ]; then
        kill "$BROWSER_PID" 2>/dev/null || true
        wait "$BROWSER_PID" 2>/dev/null || true
    fi
    rm -rf "$PROFILE"
}
trap cleanup EXIT HUP INT TERM

"$CHROME" \
    --headless=new \
    --disable-gpu \
    --hide-scrollbars \
    --force-device-scale-factor=1 \
    --user-data-dir="$PROFILE" \
    --window-size=1024,720 \
    --screenshot="$OUTPUT" \
    "file://$BOARD" >/dev/null 2>&1 &
BROWSER_PID=$!

attempt=0
while [ ! -s "$OUTPUT" ]; do
    if ! kill -0 "$BROWSER_PID" 2>/dev/null; then
        wait "$BROWSER_PID" 2>/dev/null || true
        BROWSER_PID=
        break
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 150 ]; then
        printf '%s\n' 'capture-board: browser did not produce a screenshot within 15 seconds' >&2
        exit 1
    fi
    sleep 0.1
done
[ -s "$OUTPUT" ] || { printf '%s\n' "capture-board: screenshot was not created: $OUTPUT" >&2; exit 1; }

kill "$BROWSER_PID" 2>/dev/null || true
wait "$BROWSER_PID" 2>/dev/null || true
BROWSER_PID=
printf 'captured Board screenshot: %s\n' "$OUTPUT"
