#!/bin/sh
# Rebuilds the sandboxed Codex demo used by codex-board.tape. Run once:
#   sh assets/readme/tapes/codex-board-setup.sh
# Then record from the demo directory (the script prints its path):
#   vhs assets/readme/tapes/codex-board.tape
set -eu
DEMO=${TRACEKNOT_CODEX_DEMO:-/tmp/traceknot-demo-codex}
BUN=$(command -v bun || printf '%s' '__BUN__')
rm -rf "$DEMO"
mkdir -p "$DEMO/app/src"
printf 'export const version = "1.4.2";\n' > "$DEMO/app/src/version.ts"
git -C "$DEMO/app" init -q
git -C "$DEMO/app" add .
git -C "$DEMO/app" -c user.email=demo@traceknot -c user.name=demo commit -qm "add version module"
cat > "$DEMO/app/request.json" <<EOF_REQ
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
cat > "$DEMO/app/manifest.json" <<EOF_MAN
{
  "schemaVersion": "verification-manifest/v1",
  "obligations": [
    { "id": "obligation:condition:runtime", "executable": "$BUN", "argv": ["--version"] },
    { "id": "obligation:condition:clean-tree", "executable": "/usr/bin/git", "argv": ["status", "--porcelain"] }
  ]
}
EOF_MAN
cat > "$DEMO/prompt.txt" <<'EOF_PROMPT'
Apply Traceknot to verify this change. Run:

$HOME/.agents/skills/traceknot/bin/traceknot verify --request request.json --manifest manifest.json --root . --format markdown --state-dir ../verify-state --session-id demo-session --session-host demo-host

Then report the final verdict exactly as the CLI printed it.
EOF_PROMPT
# Isolated CODEX_HOME: real auth, minimal config, no plugins/hooks/MCP noise.
mkdir -p "$DEMO/codex-home"
cp "$HOME/.codex/auth.json" "$DEMO/codex-home/auth.json"
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
