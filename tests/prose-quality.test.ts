import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProse, detectLocale, extractProse, loadConfig, parseArguments, scanRepository, verifyPreservation, type Config } from "../scripts/audit-prose-quality";

describe("published prose extraction and locale selection", () => {
  test("protects frontmatter, code, links, URLs, inline code, and quoted blocks", () => {
    const source = [
      "---",
      "title: Ignore me",
      "---",
      "# Guide",
      "",
      "Natural prose stays here.",
      "",
      "```ts",
      "It is important to note that this code is transformative.",
      "```",
      "",
      "Use `--dry-run` and [the guide](https://example.com/guide).",
      "",
      "    It is important to note that indented code is protected.",
      "",
      "The source says “In today's rapidly evolving landscape, ignore this quotation.”",
      "",
      "> Furthermore, quoted material is preserved.",
    ].join("\n");
    const prose = extractProse(source);
    expect(prose).toContain("Natural prose stays here.");
    expect(prose).toContain("the guide");
    expect(prose).not.toContain("Ignore me");
    expect(prose).not.toContain("transformative");
    expect(prose).not.toContain("--dry-run");
    expect(prose).not.toContain("https://example.com/guide");
    expect(prose).not.toContain("quoted material");
    expect(prose).not.toContain("indented code");
    expect(prose).not.toContain("rapidly evolving landscape");
  });

  test("keeps source line numbers after protected multiline regions", () => {
    const source = [
      "---",
      "title: Hidden",
      "---",
      "```text",
      "hidden code",
      "```",
      "",
      "이 작업은 할 수 있을 것으로 보인다. 한국어 설명을 충분히 덧붙여 언어를 올바르게 판별한다.",
    ].join("\n");
    const report = analyzeProse(source);
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: "KO-G-001", line: 8 }));
  });

  test("distinguishes Korean, English, mixed, and unknown prose", () => {
    expect(detectLocale("한국어로 작성한 자연스러운 문장입니다. 설명을 조금 더 붙입니다.")).toBe("ko");
    expect(detectLocale("This is a natural English paragraph with enough letters to classify.")).toBe("en");
    expect(detectLocale("한국어 설명을 충분히 작성하고 문맥도 자연스럽게 이어갑니다. English context is also deliberately substantial here.")).toBe("mixed");
    expect(detectLocale("1234 -- []")).toBe("unknown");
  });

  test("rejects incomplete standalone configuration instead of returning PASS", () => {
    const directory = mkdtempSync(join(tmpdir(), "traceknot-prose-config-"));
    const configPath = join(directory, "invalid.json");
    writeFileSync(configPath, JSON.stringify({ schemaVersion: "prose-quality-config/v1" }));
    expect(() => loadConfig(process.cwd(), configPath)).toThrow("invalid prose-quality config");
  });

  test("skips files whose detected locale is disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "traceknot-prose-locale-"));
    writeFileSync(join(root, "README.md"), "This English publication prose is long enough to be checked when English rules are enabled.");
    const config: Config = {
      schemaVersion: "prose-quality-config/v1",
      enabled: true,
      mode: "blocking",
      locales: ["ko"],
      include: ["README.md"],
      exclude: [],
      minimumProseCharacters: 1,
      maxChangeRate: 0.3,
      rejectChangeRate: 0.5,
    };
    const report = scanRepository(root, config);
    expect(report.summary).toEqual({ checked: 0, passed: 0, warned: 0, failed: 0, skipped: 1 });
  });

  test("matches globstars across zero or more directories", () => {
    const root = mkdtempSync(join(tmpdir(), "traceknot-prose-glob-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "README.md"), "Root English publication prose is included by a leading globstar.");
    writeFileSync(join(root, "docs", "guide.md"), "Direct child English publication prose is included by a nested globstar.");
    const base: Config = {
      schemaVersion: "prose-quality-config/v1",
      enabled: true,
      mode: "advisory",
      locales: ["en"],
      include: ["**/*.md"],
      exclude: [],
      minimumProseCharacters: 1,
      maxChangeRate: 0.3,
      rejectChangeRate: 0.5,
    };
    expect(scanRepository(root, base).summary.checked).toBe(2);
    expect(scanRepository(root, { ...base, include: ["docs/**/*.md"] }).summary.checked).toBe(1);
  });

  test("skips directory symlinks without following cycles", () => {
    const root = mkdtempSync(join(tmpdir(), "traceknot-prose-symlink-"));
    writeFileSync(join(root, "README.md"), "English publication prose remains available while a directory cycle is ignored.");
    symlinkSync(root, join(root, "loop"), "dir");
    const config: Config = {
      schemaVersion: "prose-quality-config/v1",
      enabled: true,
      mode: "advisory",
      locales: ["en"],
      include: ["**/*.md"],
      exclude: [],
      minimumProseCharacters: 1,
      maxChangeRate: 0.3,
      rejectChangeRate: 0.5,
    };
    expect(scanRepository(root, config).summary.checked).toBe(1);
  });

  test("excludes blockquotes indented up to three spaces", () => {
    const prose = extractProse("   > In today's rapidly evolving landscape, this underscores the importance of quoted words.\n\nOrdinary prose.");
    expect(prose).not.toContain("rapidly evolving landscape");
    expect(prose).toContain("Ordinary prose.");
  });

  test("blocks enabled blocking scans with no matching publication files", () => {
    const root = mkdtempSync(join(tmpdir(), "traceknot-prose-empty-"));
    writeFileSync(join(root, "README.md"), "Publication prose exists, but the configured include path is stale.");
    const config: Config = {
      schemaVersion: "prose-quality-config/v1",
      enabled: true,
      mode: "blocking",
      locales: ["en"],
      include: ["posts/**/*.md"],
      exclude: [],
      minimumProseCharacters: 1,
      maxChangeRate: 0.3,
      rejectChangeRate: 0.5,
    };
    const report = scanRepository(root, config);
    expect(report.status).toBe("BLOCKED");
    expect(report.summary.checked).toBe(0);
  });

  test("rejects missing values for preservation CLI flags", () => {
    expect(() => parseArguments(["--before"])).toThrow("--before requires a value");
    expect(() => parseArguments(["--before", "--after", "rewritten.md"])).toThrow("--before requires a value");
    expect(() => parseArguments(["--before", "original.md"])).toThrow("--before and --after must be supplied together");
  });

  test("excludes HTML code elements from style analysis", () => {
    const source = "<pre><code>In today's rapidly evolving landscape</code></pre>\n<code>This underscores the importance of code.</code>\nOrdinary prose.";
    const prose = extractProse(source);
    expect(prose).not.toContain("rapidly evolving landscape");
    expect(prose).not.toContain("underscores the importance");
    expect(prose).toContain("Ordinary prose.");
  });
});

describe("language-specific prose rules", () => {
  test("detects strong Korean slop without applying English rules", () => {
    const report = analyzeProse("결론적으로 중요하다. 주목할 만하다. 할 수 있을 것으로 보인다. 한국어 설명을 이어간다.");
    expect(report.locale).toBe("ko");
    expect(report.findings.map((finding) => finding.ruleId)).toEqual(expect.arrayContaining(["KO-D-001", "KO-G-001"]));
    expect(report.findings.some((finding) => finding.ruleId.startsWith("EN-"))).toBe(false);
    expect(report.status).toBe("FAIL");
  });

  test("detects strong English slop without applying Korean rules", () => {
    const report = analyzeProse("In today's rapidly evolving landscape, teams change. This underscores the importance of a transformative potential for every organization.");
    expect(report.locale).toBe("en");
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: "EN-D-001", severity: "S1" }));
    expect(report.findings.some((finding) => finding.ruleId.startsWith("KO-"))).toBe(false);
    expect(report.status).toBe("FAIL");
  });

  test("does not flag ordinary technical prose", () => {
    const report = analyzeProse("The verifier binds each result to a snapshot. A failed mandatory obligation produces a failed verdict. Reviewers can inspect the recorded evidence.");
    expect(report.status).toBe("PASS");
    expect(report.findings).toHaveLength(0);
  });

  test("uses repetition thresholds for weak signals", () => {
    expect(analyzeProse("Furthermore, this works. The next sentence explains why.").findings).toHaveLength(0);
    const report = analyzeProse("Furthermore, this works.\nMoreover, it is clear.\nAdditionally, it remains stable.");
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: "EN-H-001", severity: "S2", count: 3 }));
    expect(report.status).toBe("WARN");
  });
});

describe("rewrite preservation gate", () => {
  const original = "Install version 1.3.14 from [the guide](https://example.com/guide). You MUST run `traceknot --dry-run`.\n```sh\ntraceknot verify\n```";

  test("passes a local rewrite that preserves protected content", () => {
    const rewritten = "Install version 1.3.14 using [the guide](https://example.com/guide). You MUST run `traceknot --dry-run`.\n```sh\ntraceknot verify\n```";
    const report = verifyPreservation(original, rewritten);
    expect(report.status).toBe("PASS");
    expect(report.protectedPreserved).toBe(report.protectedTotal);
    expect(report.failures).toHaveLength(0);
  });

  test("fails when a version, URL, normative term, or code changes", () => {
    const rewritten = "Install version 1.3.15 from [the guide](https://example.org/guide). You MAY run `traceknot`.\n```sh\ntraceknot check\n```";
    const report = verifyPreservation(original, rewritten);
    expect(report.status).toBe("FAIL");
    expect(new Set(report.failures.map((failure) => failure.category))).toEqual(new Set(["code-block", "inline-code", "link-destination", "url", "number", "normative"]));
  });

  test("warns at the review threshold and rejects at the hard threshold", () => {
    const base = "one two three four five six seven eight nine ten";
    expect(verifyPreservation(base, "one two three four five six seven alpha beta ten", 0.2, 0.5).status).toBe("WARN");
    expect(verifyPreservation(base, "one two alpha beta gamma delta epsilon zeta eta theta", 0.2, 0.5).status).toBe("FAIL");
  });

  test("counts inserted prose and rejects unbounded scope expansion", () => {
    const base = "one two three four five six seven eight nine ten";
    const expanded = `${base} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon`;
    expect(verifyPreservation(base, expanded, 0.3, 0.5).status).toBe("FAIL");
    expect(verifyPreservation("", "entirely new publication prose", 0.3, 0.5).status).toBe("FAIL");
  });

  test("rejects newly introduced protected values", () => {
    const report = verifyPreservation("The release remains stable.", "The release remains stable at https://example.com for version 2.0.");
    expect(report.status).toBe("FAIL");
    expect(new Set(report.failures.map((failure) => failure.category))).toEqual(new Set(["url", "number"]));
    expect(report.failures.every((failure) => failure.expectedCount === 0 && failure.actualCount > 0)).toBe(true);
  });

  test("preserves direct and block quotations exactly", () => {
    const direct = verifyPreservation('The report says “Keep this exact quote.” End.', 'The report says “Change this quote.” End.');
    const block = verifyPreservation("> Keep this block quote.\n\nCommentary.", "> Change this block quote.\n\nCommentary.");
    expect(direct.failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
    expect(block.failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
  });

  test("protects four-space-indented Markdown code", () => {
    const before = "Run this command:\n\n    traceknot verify\n\nDone.";
    const after = "Run this command:\n\n    traceknot delete\n\nDone.";
    const report = verifyPreservation(before, after);
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
  });

  test("protects direct quotations wrapped across lines", () => {
    const before = "The report says “Keep this\nexact quotation.” End.";
    const after = "The report says “Change this\nexact quotation.” End.";
    const report = verifyPreservation(before, after);
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
  });

  test("matches the declared Markdown fence length", () => {
    const before = ["````md", "```sh", "traceknot verify", "```", "````"].join("\n");
    const after = ["````md", "```sh", "traceknot delete", "```", "````"].join("\n");
    const report = verifyPreservation(before, after);
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
  });

  test("counts token reordering as a structural rewrite", () => {
    const before = "one two three four five six seven eight nine ten";
    const after = "ten nine eight seven six five four three two one";
    expect(verifyPreservation(before, after, 0.3, 0.5).status).toBe("FAIL");
  });

  test("preserves percentage markers with numeric values", () => {
    const report = verifyPreservation("Coverage remains at 50% for this release.", "Coverage remains at 50 for this release.");
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("captures balanced parentheses in Markdown link destinations", () => {
    const before = "Read the [guide](docs/setup(v1).md) before publishing.";
    const after = "Read the [guide](docs/setup(v1).txt) before publishing.";
    const report = verifyPreservation(before, after);
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("counts reordered long blocks with a full sequence comparison", () => {
    const blocks = ["alpha", "beta", "gamma", "delta"].map((prefix) =>
      Array.from({ length: 25 }, (_, index) => `${prefix}${index}`).join(" "),
    );
    const before = blocks.join("\n\n");
    const after = [blocks[2], blocks[3], blocks[0], blocks[1]].join("\n\n");
    expect(verifyPreservation(before, after, 0.3, 0.5).status).toBe("FAIL");
  });

  test("preserves prefixed semantic versions as whole values", () => {
    const report = verifyPreservation("The supported release is v1.2.3 for this deployment.", "The supported release is v2.2.3 for this deployment.");
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves multi-backtick inline code spans", () => {
    const before = "Use ``printf `one` now`` safely in this workflow.";
    const after = "Use ``printf `two` now`` safely in this workflow.";
    const report = verifyPreservation(before, after);
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "inline-code" }));
  });

  test("protects fenced code indented up to three spaces", () => {
    const before = ["   ```sh", "traceknot verify", "   ```"].join("\n");
    const after = ["   ```sh", "traceknot delete", "   ```"].join("\n");
    const report = verifyPreservation(before, after);
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
  });

  test("preserves signs as part of numeric values", () => {
    const report = verifyPreservation("The measured change is -5 across this stable sample.", "The measured change is 5 across this stable sample.");
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves reference-style link destinations", () => {
    const before = "Read the [guide][setup] before publishing.\n\n[setup]: docs/start.md";
    const after = "Read the [guide][setup] before publishing.\n\n[setup]: docs/quick.md";
    const report = verifyPreservation(before, after);
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("preserves compound normative negation", () => {
    const report = verifyPreservation("Operators MUST NOT delete this record during recovery.", "Operators MUST delete this record during recovery.");
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("accepts closing fences longer than their opener", () => {
    const before = ["~~~sh", "traceknot verify", "~~~~"].join("\n");
    const after = ["~~~sh", "traceknot delete", "~~~~"].join("\n");
    const report = verifyPreservation(before, after);
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
  });

  test("preserves lazy blockquote continuation lines", () => {
    const before = "> Quoted opening\nlazy continuation remains quoted.\n\nCommentary.";
    const after = "> Quoted opening\nchanged continuation remains quoted.\n\nCommentary.";
    const report = verifyPreservation(before, after);
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
  });

  test("preserves normative negation across flexible whitespace", () => {
    const spaced = verifyPreservation("Operators MUST  NOT delete records.", "Operators MUST delete records.");
    const wrapped = verifyPreservation("Operators MUST\nNOT delete records.", "Operators MUST delete records.");
    expect(spaced.failures).toContainEqual(expect.objectContaining({ category: "normative" }));
    expect(wrapped.failures).toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("stops lazy blockquotes at interrupting Markdown blocks", () => {
    const prose = extractProse("> Quoted opening\n# Published heading\nOrdinary publication prose.");
    expect(prose).not.toContain("Quoted opening");
    expect(prose).toContain("Published heading");
    expect(prose).toContain("Ordinary publication prose");
  });

  test("preserves Korean normative terms across flexible whitespace", () => {
    const report = verifyPreservation("운영자는 삭제해서는\n안 된다. 이 규칙을 지킨다.", "운영자는 삭제해서는 된다. 이 규칙을 지킨다.");
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("preserves complete standalone URLs with balanced parentheses", () => {
    const before = "Read https://example.com/a(b)/old before continuing with the publication.";
    const after = "Read https://example.com/a(b)/new before continuing with the publication.";
    const report = verifyPreservation(before, after);
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "url" }));
  });

  test("recognizes CRLF fenced-code closers without masking following prose", () => {
    const before = "```sh\r\ntraceknot verify\r\n```\r\nFollowing publication prose.";
    const after = "```sh\r\ntraceknot delete\r\n```\r\nFollowing publication prose.";
    expect(extractProse(before)).toContain("Following publication prose.");
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
  });

  test("requires exact-run inline-code closing delimiters", () => {
    const before = "Use ``alpha ``` beta`` safely in this workflow.";
    const after = "Use ``alpha ``` gamma`` safely in this workflow.";
    const report = verifyPreservation(before, after);
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "inline-code" }));
  });

  test("does not classify list continuation prose as indented code", () => {
    const before = "- Item\n    Ordinary continuation prose remains editable.";
    const after = "- Item\n    Natural continuation prose remains editable.";
    expect(extractProse(before)).toContain("Ordinary continuation prose");
    expect(verifyPreservation(before, after).failures.some((failure) => failure.category === "code-block")).toBe(false);
  });

  test("excludes CRLF frontmatter from style analysis", () => {
    const source = "---\r\ntitle: In today's rapidly evolving landscape\r\ndescription: This underscores the importance of metadata\r\n---\r\nOrdinary publication prose.";
    const prose = extractProse(source);
    expect(prose).not.toContain("rapidly evolving landscape");
    expect(prose).not.toContain("underscores the importance");
    expect(prose).toContain("Ordinary publication prose.");
  });

  test("keeps immediate indented paragraph continuations in prose", () => {
    const before = "Ordinary paragraph opening.\n    Indented continuation remains prose.";
    const after = "Ordinary paragraph opening.\n    Natural continuation remains prose.";
    expect(extractProse(before)).toContain("Indented continuation remains prose.");
    expect(verifyPreservation(before, after).failures.some((failure) => failure.category === "code-block")).toBe(false);
  });

  test("preserves currency symbols with numeric values", () => {
    const report = verifyPreservation("The published price is $5 for this plan.", "The published price is €5 for this plan.");
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves terminal punctuation inside angle-bracket autolinks", () => {
    const report = verifyPreservation("Search at <https://example.com/search?> now.", "Search at <https://example.com/search!> now.");
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "url" }));
  });

  test("derives nested code indentation from ordered-list marker width", () => {
    const before = "10. Item\n\n      Six-space continuation remains prose.";
    const after = "10. Item\n\n      Natural continuation remains prose.";
    expect(extractProse(before)).toContain("Six-space continuation remains prose.");
    expect(verifyPreservation(before, after).failures.some((failure) => failure.category === "code-block")).toBe(false);
  });

  test("preserves whitespace-separated measurement units", () => {
    const report = verifyPreservation("The package weighs 5 kg for shipping.", "The package weighs 5 lb for shipping.");
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves hyphenated dates as complete values", () => {
    const report = verifyPreservation("The release date is 2026-07-27 for this milestone.", "The release date is 2026-27-07 for this milestone.");
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("normalizes normative whitespace before comparison", () => {
    const report = verifyPreservation("Operators MUST NOT delete records.", "Operators MUST\nNOT delete records.");
    expect(report.failures.some((failure) => failure.category === "normative")).toBe(false);
  });

  test("excludes surrounding punctuation from bare URLs", () => {
    const report = verifyPreservation("Read https://example.com.", "Read https://example.com,");
    expect(report.failures.some((failure) => failure.category === "url")).toBe(false);
  });

  test("uses list-relative indentation for code continuations", () => {
    const before = "10. Item\n\n        traceknot verify\n\n      Six-space list prose.";
    const after = "10. Item\n\n        traceknot verify\n\n      Natural list prose.";
    expect(extractProse(before)).toContain("Six-space list prose.");
    expect(verifyPreservation(before, after).failures.some((failure) => failure.category === "code-block")).toBe(false);
  });

  test("preserves Korean counters with numeric values", () => {
    const report = verifyPreservation("참석자는 5개 좌석을 사용한다.", "참석자는 5명 좌석을 사용한다.");
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("protects inline and block HTML code", () => {
    const inline = verifyPreservation("<code>traceknot verify</code> remains stable.", "<code>traceknot delete</code> remains stable.");
    const block = verifyPreservation("<pre><code>traceknot verify</code></pre>", "<pre><code>traceknot delete</code></pre>");
    expect(inline.failures).toContainEqual(expect.objectContaining({ category: "inline-code" }));
    expect(block.failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
  });

  test("does not extend lazy continuation after a quoted heading", () => {
    const prose = extractProse("> # Quoted heading\nFollowing publication prose.");
    expect(prose).not.toContain("Quoted heading");
    expect(prose).toContain("Following publication prose.");
  });

  test("bounds disjoint edit-distance work at the rejection threshold", () => {
    const before = Array.from({ length: 10_000 }, (_, index) => `left${index}`).join(" ");
    const after = Array.from({ length: 10_000 }, (_, index) => `right${index}`).join(" ");
    const report = verifyPreservation(before, after, 0.3, 0.5);
    expect(report.status).toBe("FAIL");
    expect(report.tokenChangeRate).toBe(0.5);
  });

  test("preserves email and non-HTTP URI autolinks", () => {
    const email = verifyPreservation("Contact <support@example.com> for help.", "Contact <sales@example.com> for help.");
    const mailto = verifyPreservation("Contact <mailto:support@example.com> for help.", "Contact <mailto:sales@example.com> for help.");
    expect(email.failures).toContainEqual(expect.objectContaining({ category: "url" }));
    expect(mailto.failures).toContainEqual(expect.objectContaining({ category: "url" }));
  });

  test("preserves whitespace-separated Korean counters", () => {
    const report = verifyPreservation("참석자는 5 개 좌석을 사용한다.", "참석자는 5 명 좌석을 사용한다.");
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("expands tabs before classifying ordered-list code", () => {
    const before = "10. Item\n\n\tTabbed continuation remains prose.";
    const after = "10. Item\n\n\tNatural continuation remains prose.";
    expect(extractProse(before)).toContain("Tabbed continuation remains prose.");
    expect(verifyPreservation(before, after).failures.some((failure) => failure.category === "code-block")).toBe(false);
  });

  test("binds protected values to their factual order", () => {
    const before = "The minimum release is 1.2, while the maximum release is 2.0 for supported deployments.";
    const after = "The minimum release is 2.0, while the maximum release is 1.2 for supported deployments.";
    const report = verifyPreservation(before, after);
    expect(report.status).toBe("FAIL");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("binds protected values to surrounding claim labels", () => {
    const before = "The minimum release is 1.2, while the maximum release is 2.0 for supported deployments.";
    const after = "The maximum release is 1.2, while the minimum release is 2.0 for supported deployments.";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("protects quotations containing escaped delimiters", () => {
    const before = 'The guide says "Use the \\"old\\" mode" for recovery.';
    const after = 'The guide says "Use the \\"new\\" mode" for recovery.';
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
  });

  test("normalizes whitespace inside numeric measurements", () => {
    const report = verifyPreservation("The package weighs 5 kg.", "The package weighs 5\nkg.");
    expect(report.failures.some((failure) => failure.category === "number")).toBe(false);
  });

  test("treats tab-indented fence markers as indented code", () => {
    const prose = extractProse("\t```not-a-fence\n\tcode\nFollowing publication prose.");
    expect(prose).toContain("Following publication prose.");
  });

  test("allows non-label wording changes around protected values", () => {
    const report = verifyPreservation("The supported version is 1.2.", "The compatible version is 1.2.");
    expect(report.status).toBe("PASS");
  });

  test("does not parse tab-indented greater-than text as a blockquote", () => {
    const before = "\t> command\nFollowing publication prose.";
    const after = "\t> command\nNatural publication prose.";
    expect(extractProse(before)).toContain("Following publication prose.");
    expect(verifyPreservation(before, after).failures.some((failure) => failure.category === "quotation")).toBe(false);
  });
});
