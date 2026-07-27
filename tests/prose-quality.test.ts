import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProse, detectLocale, extractProse, loadConfig, scanRepository, verifyPreservation, type Config } from "../scripts/audit-prose-quality";

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
    const rewritten = "Use [the guide](https://example.com/guide) to install version 1.3.14. You MUST run `traceknot --dry-run`.\n```sh\ntraceknot verify\n```";
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
});
