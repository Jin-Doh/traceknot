# Post-verdict update advisory

The advisory is deliberately smaller than the automatic updater. It does not add fields to updater state, reconcile transactions, download release artifacts, or run `apply`.

After QA output is fixed, the helper:

1. infers the global or project-local installation from its own canonical path;
2. skips routine checks when the updater config already has `automatic=1`, avoiding contention with the scheduled apply job;
3. pins one available OS-backed lock backend per advisory state directory and acquires the non-blocking advisory lock;
4. checks an advisory-only local success timestamp;
5. invokes the updater in advisory check mode so its own lock makes the automatic-update exclusion atomic;
6. calls `traceknot-skills-update check` with one absolute deadline, preserves the scheduler's shared `lastCheck`, and returns a distinct skipped status when recovery is pending;
7. validates any eligibility claim before committing the successful local check timestamp; and
8. prints the scope-correct `apply` command only when the updater reports an eligible semantic release.

Global state is stored under:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/traceknot/update-notice-global/
```

Project-local state is stored under:

```text
<project>/.agents/.traceknot-update-notice/
```

The default interval is 24 hours and the default check deadline is 60 seconds. Override them with `TRACEKNOT_UPDATE_NOTICE_INTERVAL` and `TRACEKNOT_UPDATE_NOTICE_TIMEOUT`. Set `TRACEKNOT_UPDATE_NOTICE=0` to disable the advisory or `TRACEKNOT_UPDATE_NOTICE=force` to bypass both the local interval and the automatic-update skip for a manual diagnostic.

The advisory pins `flock`, `lockf`, or `shlock` in `lock-backend` for each state directory, so concurrent processes with different `PATH` values cannot silently use incompatible protocols for the same lock file. `flock` owns the Linux lock through its open file descriptor; `lockf` provides the macOS kernel-backed fallback; `shlock` is retained as a last resort on systems without either utility. When the pinned backend is unavailable, the helper exits silently rather than changing protocols or implementing stale-owner replacement in shell.

Routine read-only checks revalidate `automatic=1` after acquiring the updater lock and yield before network work, closing the race with the scheduled apply job. `force` explicitly permits that check for manual diagnostics. The helper is non-blocking maintenance output. Its updater mode may record normal release observations and an unmanaged adoption baseline, but it does not reconcile transactions or advance the automatic scheduler's `lastCheck` timestamp. It never changes the QA verdict or acts as verification evidence. Artifact digest and provenance verification remain part of the recommended updater `apply` command.
