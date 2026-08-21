from pathlib import Path

path = Path('.github/review-fixes/apply-pr68-current.py')
text = path.read_text()
old = "    return one(text, old, new, f'{label}: recovery guard')\n"
new = "    return subone(text, r'acquire_recovery_guard\\(\\) \\{\\n.*?\\n\\}\\n\\nacquire_lock\\(\\) \\{', new + '\\n\\nacquire_lock() {', f'{label}: recovery guard', re.S)\n"
if text.count(old) != 1:
    raise SystemExit(f'expected one recovery return, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
