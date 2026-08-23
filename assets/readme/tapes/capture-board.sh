#!/bin/sh
# Capture a localized Board produced by the disposable Codex demo sandbox.
set -eu

STATE_DIR=${1:-/tmp/traceknot-demo-codex/verify-state}
LOCALE=${3:-en}
case "$LOCALE" in
    en|ko|zh-CN) ;;
    *) printf '%s\n' "capture-board: unsupported Board locale: $LOCALE" >&2; exit 2 ;;
esac
OUTPUT=${2:-/tmp/traceknot-demo-codex/app/board.$LOCALE.png}

set -- "$STATE_DIR"/sessions/*/"index.$LOCALE.html"
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    printf '%s\n' "capture-board: expected exactly one $LOCALE Board at $STATE_DIR/sessions/*/index.$LOCALE.html" >&2
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

if [ -n "${TRACEKNOT_CAPTURE_VALIDATOR:-}" ]; then
    VALIDATOR=$TRACEKNOT_CAPTURE_VALIDATOR
    [ -x "$VALIDATOR" ] || { printf '%s\n' "capture-board: validator is not executable: $VALIDATOR" >&2; exit 1; }
    capture_is_valid() { "$VALIDATOR" "$1"; }
elif command -v ffprobe >/dev/null 2>&1; then
    FFPROBE=$(command -v ffprobe)
    capture_is_valid() {
        [ "$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$1" 2>/dev/null)" = 1024x720 ]
    }
else
    printf '%s\n' 'capture-board: ffprobe is required to validate the completed screenshot' >&2
    exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"
rm -f "$OUTPUT"
PROFILE=$(mktemp -d "${TMPDIR:-/tmp}/traceknot-board-chrome.XXXXXX")
CAPTURE=$PROFILE/board.png
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
    --user-data-dir="$PROFILE/chrome" \
    --window-size=1024,720 \
    --screenshot="$CAPTURE" \
    "file://$BOARD" >/dev/null 2>&1 &
BROWSER_PID=$!

attempt=0
stable_attempts=0
last_size=
while :; do
    browser_exited=false
    if ! kill -0 "$BROWSER_PID" 2>/dev/null; then
        status=0
        wait "$BROWSER_PID" || status=$?
        BROWSER_PID=
        if [ "$status" -ne 0 ]; then
            printf '%s\n' "capture-board: browser exited with status $status" >&2
            exit 1
        fi
        browser_exited=true
    fi

    if [ -s "$CAPTURE" ]; then
        size=$(wc -c < "$CAPTURE")
        if [ "$size" = "$last_size" ]; then
            stable_attempts=$((stable_attempts + 1))
        else
            last_size=$size
            stable_attempts=0
        fi
        if { [ "$browser_exited" = true ] || [ "$stable_attempts" -ge 5 ]; } && capture_is_valid "$CAPTURE"; then
            break
        fi
    fi

    if [ "$browser_exited" = true ]; then
        printf '%s\n' "capture-board: browser exited without a complete 1024x720 screenshot" >&2
        exit 1
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 150 ]; then
        printf '%s\n' 'capture-board: browser did not produce a complete screenshot within 15 seconds' >&2
        exit 1
    fi
    sleep 0.1
done

if [ -n "$BROWSER_PID" ]; then
    kill "$BROWSER_PID" 2>/dev/null || true
    wait "$BROWSER_PID" 2>/dev/null || true
    BROWSER_PID=
fi
mv "$CAPTURE" "$OUTPUT"
printf 'captured Board screenshot: %s\n' "$OUTPUT"
