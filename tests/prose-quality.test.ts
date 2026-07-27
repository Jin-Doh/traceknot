import { describe, expect, test } from "bun:test";
import { analyzeProse, detectLocale, extractProse, verifyPreservation } from "../scripts/audit-prose-quality";

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
  });

  test("distinguishes Korean, English, mixed, and unknown prose", () => {
    expect(detectLocale("한국어로 작성한 자연스러운 문장입니다. 설명을 조금 더 붙입니다.")).toBe("ko");
    expect(detectLocale("This is a natural English paragraph with enough letters to classify.")).toBe("en");
    expect(detectLocale("한국어 설명을 충분히 작성하고 문맥도 자연스럽게 이어갑니다. English context is also deliberately substantial here.")).toBe("mixed");
    expect(detectLocale("1234 -- []")).toBe("unknown");
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
});
