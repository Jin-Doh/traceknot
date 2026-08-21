# Post-verdict update advisory

The advisory is deliberately smaller than the automatic updater. It does not add fields to updater state, reconcile transactions, download release artifacts, or run `apply`.

After QA output is fixed, the helper:

1. infers the global or project-local installation from its own canonical path;
2. skips routine checks when the updater config already has `automatic=1`, avoiding contention with the scheduled apply job;
3. acquires an OS-backed advisory lock and checks an advisory-only local success timestamp;
4. invokes the updater in advisory check mode so its own lock makes the pending-state exclusion atomic;
5. calls `traceknot-skills-update check` with one absolute deadline, preserves the scheduler's shared `lastCheck`, and returns a distinct skipped status when recovery is pending;
6. validates any eligibility claim before committing the successful local check timestamp; and
7. prints the scope-correct `apply` command only when the updater reports an eligible semantic release.

Global state is stored under:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/traceknot/update-notice-global/
```

Project-local state is stored under:

```text
<project>/.agents/.traceknot-update-notice/
```

The default interval is 24 hours and the default check deadline is 60 seconds. Override them with `TRACEKNOT_UPDATE_NOTICE_INTERVAL` and `TRACEKNOT_UPDATE_NOTICE_TIMEOUT`. Set `TRACEKNOT_UPDATE_NOTICE=0` to disable the advisory or `TRACEKNOT_UPDATE_NOTICE=force` to bypass both the local interval and the automatic-update skip for a manual diagnostic.

The advisory requires `flock` or `shlock` for cross-process serialization. `flock` owns the Linux lock through its open file descriptor; `shlock` is the portable macOS fallback and reclaims dead owners. When neither utility is available, the helper exits silently rather than implementing stale-owner replacement in shell.

The helper is non-blocking maintenance output. Its updater mode may record normal release observations and an unmanaged adoption baseline, but it does not reconcile transactions or advance the automatic scheduler's `lastCheck` timestamp. It never changes the QA verdict or acts as verification evidence. Artifact digest and provenance verification remain part of the recommended updater `apply` command.
