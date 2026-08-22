# Traceknot verify demo — regenerate with:
#   sh assets/readme/tapes/verify-setup.sh
#   cd "$(cat /tmp/traceknot-demo/.path 2>/dev/null || echo /tmp/traceknot-demo)" && vhs "$OLDPWD/assets/readme/tapes/verify.tape"
#   mv traceknot-verify.gif "$OLDPWD/assets/readme/"
Output traceknot-verify.gif

Set FontSize 16
Set Width 1120
Set Height 560
Set Padding 26
Set Framerate 24
Set TypingSpeed 55ms
Set Theme {
  "background": "#F4F1EA",
  "foreground": "#1A1917",
  "cursor": "#B33A2B",
  "black": "#1A1917",
  "bright_black": "#5b687b",
  "white": "#FFFEFA",
  "bright_white": "#ffffff",
  "red": "#B33A2B",
  "bright_red": "#d94f3d",
  "green": "#087a46",
  "bright_green": "#0a9a58",
  "yellow": "#9a4d00",
  "blue": "#2f61d5",
  "magenta": "#7c3aed",
  "cyan": "#0e7490"
}

Type "ls"
Enter
Sleep 700ms
Type "./traceknot verify --request request.json --manifest manifest.json --root demo-app --format markdown --session-id demo-session --session-host demo-host"
Enter
Sleep 2600ms
