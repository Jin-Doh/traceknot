# Published prose quality

Use the prose-quality obligation only for repository paths declared as Korean, English, or Simplified Chinese publication prose. Simplified Chinese uses an explicit `zh-Hans` path mapping rather than script inference. The audit assesses observable style and preservation properties; it does not infer whether a person or an AI authored the text.

## Test basis

- `PQ-BASIS-001`: configured publication prose meets the repository's language-specific readability policy.
- `PQ-BASIS-002`: remediation preserves facts, numbers, links, quotations, code, normative terms, genre, and register.
- `PQ-BASIS-003`: findings are reported as prose patterns, never as authorship evidence.

## Risks

- `PQ-RISK-001` (`R1`): formulaic prose reduces readability or public trust.
- `PQ-RISK-002` (`R2`): remediation changes a public fact, command, URL, version, or normative contract.
- `PQ-RISK-003` (`R2`): a style heuristic is misrepresented as proof of authorship.
- `PQ-RISK-004` (`R1`): rules for one language are applied to another language, or Chinese script is inferred without an explicit publication-path declaration.

## Conditions and obligations

| Condition | Expected result | Mandatory evidence | Minimum independence |
|---|---|---|---|
| `PQ-COND-001` target extraction | Only configured prose is checked; protected Markdown is excluded | `PQ-OBL-001` static analysis | self-check |
| `PQ-COND-002` locale routing | Korean and English rules apply only to matching prose; `zh-Hans` rules require an explicit path override | `PQ-OBL-002` test result | separate-verification-context |
| `PQ-COND-003` style policy | Findings and thresholds are deterministic | `PQ-OBL-003` static analysis | separate-verification-context |
| `PQ-COND-004` rewrite preservation | Every protected token is preserved | `PQ-OBL-004` test result | independent-producer |
| `PQ-COND-005` rewrite scope | Change rate remains below configured review and rejection boundaries | `PQ-OBL-005` test result | independent-producer |

An advisory style finding does not fail the repository gate. Scanner failure, malformed configuration, missing mandatory preservation evidence, a protected-content change, or a rejection-boundary rewrite cannot be converted to PASS.

## Execution

Require a host-advertised static analyzer or reviewer that can apply the configured language policy and, after remediation, compare the original and rewritten artifacts. The canonical Skill bundle includes the Traceknot CLI and Board renderer, but prose-quality remains a separate verification obligation; it does not claim that the bundled CLI is a prose scanner. If no suitable verifier is available for a mandatory obligation, report `BLOCKED`; never substitute the rewriting provider's self-report.

The Traceknot source repository includes `scripts/audit-prose-quality.ts` as a reference implementation for maintaining that repository. Source-repository contributors can run it through the documented `bun run prose-quality` command. The repository maps `README.zh.md` to `zh-Hans`; it does not create or infer a Traditional Chinese publication target. Other repositories and installed-Skill users must use a host-provided equivalent unless they deliberately adopt the reference implementation and its dependencies.

Bind the verifier's structured report to the target snapshot and relevant obligation as a static-analysis or test-result evidence artifact. Run preservation verification and the repository gate again on the rewritten snapshot.

The Korean categories and preservation approach were informed by the `epoko77-ai/im-not-ai` project. This is a provenance note only; Traceknot neither fetches nor executes that project. Traceknot's scanner is an independent multilingual, deterministic verification boundary.
