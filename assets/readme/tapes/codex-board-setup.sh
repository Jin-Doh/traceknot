#!/bin/sh
# Rebuilds the sandboxed Codex demo used by codex-board.tape. Run once:
#   sh assets/readme/tapes/codex-board-setup.sh
# Then record from the demo directory (the script prints its path):
#   vhs assets/readme/tapes/codex-board.tape
set -eu
umask 077
DEMO=${TRACEKNOT_CODEX_DEMO:-/tmp/traceknot-demo-codex}
BUN=$(command -v bun || printf '%s' '__BUN__')
rm -rf "$DEMO"
if ! mkdir "$DEMO"; then
    printf '%s\n' "codex-board-setup: sandbox path was claimed before private creation: $DEMO" >&2
    exit 1
fi
mkdir -p "$DEMO/app/src"
printf 'export const version = "1.4.2";\n' > "$DEMO/app/src/version.ts"
git -C "$DEMO/app" init -q
git -C "$DEMO/app" add .
git -C "$DEMO/app" -c user.email=demo@traceknot -c user.name=demo commit -qm "add version module"
mkdir -p "$DEMO/home/.agents/skills"
cp -R skill "$DEMO/home/.agents/skills/traceknot"
cat > "$DEMO/check-clean" <<'EOF_CLEAN'
#!/bin/sh
set -eu
[ "$#" -eq 1 ] || exit 2
[ -z "$(/usr/bin/git -C "$1" status --porcelain)" ]
EOF_CLEAN
chmod +x "$DEMO/check-clean"
cat > "$DEMO/request.json" <<EOF_REQ
{
  "schemaVersion": "verification-request/v1",
  "requestId": "codex-demo",
  "project": { "rootIdentity": "auto", "snapshotId": "auto" },
  "change": { "summary": "guard the shipped snapshot", "paths": ["src"] },
  "testBasis": [
    { "id": "runtime", "kind": "acceptance-criterion", "origin": "explicit", "text": "the pinned Bun runtime reports its version" },
    { "id": "clean-tree", "kind": "acceptance-criterion", "origin": "explicit", "text": "the shipped snapshot has no uncommitted changes" }
  ]
}
EOF_REQ
cat > "$DEMO/manifest.json" <<EOF_MAN
{
  "schemaVersion": "verification-manifest/v1",
  "obligations": [
    { "id": "obligation:condition:runtime", "executable": "$BUN", "argv": ["--version"] },
    { "id": "obligation:condition:clean-tree", "executable": "$DEMO/check-clean", "argv": ["$DEMO/app"] }
  ]
}
EOF_MAN
cat > "$DEMO/prompt.txt" <<'EOF_PROMPT'
Apply Traceknot to verify this change. Run:

$HOME/.agents/skills/traceknot/bin/traceknot verify --request ../request.json --manifest ../manifest.json --root . --format markdown --state-dir ../verify-state --session-id demo-session --session-host demo-host

Then report the final verdict exactly as the CLI printed it.
EOF_PROMPT
# Isolated writable homes: copy only authentication into the private sandbox.
mkdir -p "$DEMO/codex-home"
cp "$HOME/.codex/auth.json" "$DEMO/codex-home/auth.json"
chmod 600 "$DEMO/codex-home/auth.json"
cat > "$DEMO/codex-home/config.toml" <<EOF_CFG
model = "gpt-5.6-luna"
model_reasoning_effort = "medium"
approval_policy = "never"
sandbox_mode = "danger-full-access"
hide_rate_limit_model_nudge = true

[projects."$DEMO/app"]
trust_level = "trusted"
EOF_CFG
printf '%s
' "$DEMO"
