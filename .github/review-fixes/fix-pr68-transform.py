from pathlib import Path

path = Path('.github/review-fixes/apply-pr68-current.py')
text = path.read_text()

old_return = "    return one(text, old, new, f'{label}: recovery guard')\n"
new_return = "    return subone(text, r'acquire_recovery_guard\\(\\) \\{\\n.*?\\n\\}\\n\\nacquire_lock\\(\\) \\{', new + '\\n\\nacquire_lock() {', f'{label}: recovery guard', re.S)\n"
if text.count(old_return) != 1:
    raise SystemExit(f'expected one recovery return, found {text.count(old_return)}')
text = text.replace(old_return, new_return, 1)

old_cleanup = '''    text = one(
        text,
        ''' + "'''" + '''    LOCK_CLAIM=\\n    if [ \"$LOCK_HELD\" -eq 1 ]; then''' + "'''" + ''',
        ''' + "'''" + '''    LOCK_CLAIM=
    if [ -n \"$RECOVERY_CLAIM\" ]; then
        rm -f \"$RECOVERY_CLAIM\"
    fi
    RECOVERY_CLAIM=
    if [ \"$LOCK_HELD\" -eq 1 ]; then''' + "'''" + ''',
        f'{label}: recovery claim cleanup',
    )
'''
new_cleanup = '''    text = subone(
        text,
        r'(?m)^    LOCK_CLAIM=\\n',
        ''' + "'''" + '''    LOCK_CLAIM=
    if [ -n \"$RECOVERY_CLAIM\" ]; then
        rm -f \"$RECOVERY_CLAIM\"
    fi
    RECOVERY_CLAIM=
''' + "'''" + ''',
        f'{label}: recovery claim cleanup',
    )
'''
if text.count(old_cleanup) != 1:
    raise SystemExit(f'expected one recovery cleanup transform, found {text.count(old_cleanup)}')
text = text.replace(old_cleanup, new_cleanup, 1)

for function_name in ('patch_tests', 'patch_docs'):
    old = f"def {function_name}(path: Path) -> None:\n    text = path.read_text()\n"
    new = f"def {function_name}(path: Path) -> None:\n    return\n"
    if text.count(old) != 1:
        raise SystemExit(f'expected one {function_name} function, found {text.count(old)}')
    text = text.replace(old, new, 1)

path.write_text(text)

tests_path = Path('.github/review-fixes/patch-pr68-tests.py')
tests = tests_path.read_text()
old = '''    unset FAKE_POISON_PREFLIGHT FAKE_POISON_APPLY FAKE_RUNTIME_MARKER
    test ! -e \"$RUNTIME_MARKER\"
done

''' + "'''" + '''
text = text.replace(marker, block + marker, 1)
'''
new = '''    unset FAKE_POISON_PREFLIGHT FAKE_POISON_APPLY FAKE_RUNTIME_MARKER
    test ! -e \"$RUNTIME_MARKER\"
done

# Keep the existing smoke assertions independent from the focused regression prelude.
printf '%s\\n' 0 > \"$NPX_COUNT\"
: > \"$NPX_LOG\"

''' + "'''" + '''
text = text.replace(marker, block + marker, 1)
'''
if tests.count(old) != 1:
    raise SystemExit(f'expected one regression block tail, found {tests.count(old)}')
tests_path.write_text(tests.replace(old, new, 1))
