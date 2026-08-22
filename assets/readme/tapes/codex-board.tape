# Traceknot x Codex demo — regenerate with:
#   sh assets/readme/tapes/codex-board-setup.sh
#   cd /tmp/traceknot-demo-codex/app && vhs "$OLDPWD/assets/readme/tapes/codex-board.tape"
#   mv codex-board.gif "$OLDPWD/assets/readme/"
Output codex-board.gif

Set FontSize 15
Set Width 1180
Set Height 760
Set Padding 20
Set Framerate 24
Set TypingSpeed 25ms
Set Theme {
  "background": "#1A1917",
  "foreground": "#F4F1EA",
  "cursor": "#B33A2B",
  "black": "#1A1917",
  "bright_black": "#8a857c",
  "white": "#F4F1EA",
  "bright_white": "#FFFEFA",
  "red": "#B33A2B",
  "bright_red": "#d94f3d",
  "green": "#3E7C6F",
  "bright_green": "#5aa892",
  "yellow": "#C08A2E",
  "blue": "#5b8def",
  "magenta": "#9a6dd7",
  "cyan": "#4fa8a0"
}

Type "cd /tmp/traceknot-demo-codex/app"
Enter
Sleep 300ms
Type "clear && CODEX_HOME=/tmp/traceknot-demo-codex/codex-home codex"
Enter
Sleep 4500ms
Type "Apply Traceknot to verify this change: run $HOME/.agents/skills/traceknot/bin/traceknot verify --request request.json --manifest manifest.json --root . --format markdown --state-dir ../verify-state --session-id demo-session --session-host demo-host then report the verdict."
Enter
Sleep 50s
Sleep 30s
Sleep 20s
Sleep 12s
Ctrl+C
Sleep 900ms
