#!/bin/sh
# Rebuilds the sandboxed demo used by verify.tape. Run once before recording:
#   sh assets/readme/tapes/verify-setup.sh && vhs assets/readme/tapes/verify.tape
set -eu
DEMO=${TRACEKNOT_DEMO_DIR:-/tmp/traceknot-demo}
BUN=$(command -v bun || printf '%s' '__BUN__')
rm -rf "$DEMO"
mkdir -p "$DEMO/demo-app/src"
printf 'export const version = "1.0.0";\n' > "$DEMO/demo-app/src/version.ts"
git -C "$DEMO/demo-app" init -q
git -C "$DEMO/demo-app" add .
git -C "$DEMO/demo-app" -c user.email=demo@traceknot -c user.name=demo commit -qm "demo snapshot"
cat > "$DEMO/request.json" <<EOF_REQ
{
  "schemaVersion": "verification-request/v1",
  "requestId": "verify-demo",
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
    { "id": "obligation:condition:clean-tree", "executable": "/usr/bin/git", "argv": ["-C", "$DEMO/demo-app", "status", "--porcelain"] }
  ]
}
EOF_MAN
if [ -x "$HOME/.agents/skills/traceknot/bin/traceknot" ]; then
    ln -sf "$HOME/.agents/skills/traceknot/bin/traceknot" "$DEMO/traceknot"
else
    cp bin/traceknot "$DEMO/traceknot"
fi
printf 'demo sandbox ready at %s\n' "$DEMO"
printf '%s\n' "$DEMO" > "$DEMO/.path"
