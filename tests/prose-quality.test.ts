import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProse, createPreservationQualityReport, detectLocale, extractProse, formatTextReport, loadConfig, parseArguments, scanRepository, verifyPreservation, type Config } from "../scripts/audit-prose-quality";

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
    expect(detectLocale("简体中文必须通过显式路径映射选择规则。")).toBe("unknown");
    expect(detectLocale("这是以简体中文撰写的主要内容，其中包含 API、CLI、PASS 和 BLOCKED 等技术标识符，但不应被识别为英文文档。")).toBe("unknown");
    expect(detectLocale("简体中文必须通过显式路径映射选择规则。")).toBe("unknown");
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

  test("applies zhlint only through an explicit zh-Hans override", () => {
    const source = "自动在中文和English之间加入空格。";
    const report = analyzeProse(source, ["ko", "en", "zh-Hans"], "zh-Hans");
    expect(report.locale).toBe("zh-Hans");
    expect(report.findings).toContainEqual(expect.objectContaining({
      ruleId: expect.stringMatching(/^ZH-ZHLINT-/),
      severity: "S2",
      count: 2,
    }));
    expect(report.findings.some((finding) => finding.ruleId.startsWith("KO-") || finding.ruleId.startsWith("EN-"))).toBe(false);
    expect(report.status).toBe("WARN");
  });

  test("aggregates zhlint diagnostics by stable message", () => {
    const report = analyzeProse("甲,乙;丙:丁", ["zh-Hans"], "zh-Hans");
    expect(report.findings).toContainEqual(expect.objectContaining({
      ruleId: expect.stringMatching(/^ZH-ZHLINT-/),
      description: "zhlint: 此处标点符号需要使用全角",
      count: 3,
    }));
    expect(report.status).toBe("WARN");
  });

  test("does not apply zh-Hans rules to inferred Korean and English mixed prose", () => {
    const source = "한국어 설명을 충분히 작성하고 문맥도 자연스럽게 이어갑니다. English context is also deliberately substantial here. 第一，记录事实。第二，评估证据。第三，给出判定。";
    const report = analyzeProse(source, ["ko", "en", "zh-Hans"]);
    expect(report.locale).toBe("mixed");
    expect(report.findings.some((finding) => finding.ruleId.startsWith("ZH-"))).toBe(false);
  });

  test("skips inferred mixed prose when no applicable inferred locale is enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "traceknot-prose-mixed-disabled-"));
    writeFileSync(join(root, "README.md"), "한국어 설명을 충분히 작성하고 문맥도 자연스럽게 이어갑니다. English context is also deliberately substantial here.");
    const report = scanRepository(root, {
      schemaVersion: "prose-quality-config/v1",
      enabled: true,
      mode: "blocking",
      locales: ["zh-Hans"],
      include: ["README.md"],
      exclude: [],
      minimumProseCharacters: 1,
      maxChangeRate: 0.3,
      rejectChangeRate: 0.5,
    });
    expect(report.summary).toEqual({ checked: 0, passed: 0, warned: 0, failed: 0, skipped: 1 });
    expect(report.status).toBe("BLOCKED");
  });

  test("routes README.zh.md through its configured zh-Hans path override", () => {
    const root = mkdtempSync(join(tmpdir(), "traceknot-prose-zh-hans-"));
    writeFileSync(join(root, "README.zh.md"), "自动在中文和English之间加入空格。");
    const config: Config = {
      schemaVersion: "prose-quality-config/v1",
      enabled: true,
      mode: "blocking",
      locales: ["zh-Hans"],
      localeOverrides: { "README.zh.md": "zh-Hans" },
      include: ["README.zh.md"],
      exclude: [],
      minimumProseCharacters: 1,
      maxChangeRate: 0.3,
      rejectChangeRate: 0.5,
    };
    const report = scanRepository(root, config);
    expect(report.summary.checked).toBe(1);
    expect(report.files[0]).toEqual(expect.objectContaining({ path: "README.zh.md", locale: "zh-Hans", status: "WARN" }));
    expect(report.files[0]?.findings).toContainEqual(expect.objectContaining({
      ruleId: expect.stringMatching(/^ZH-ZHLINT-/),
      count: 2,
    }));
  });

  test("does not infer zh-Hans rules from Chinese script without an override", () => {
    const report = analyzeProse("此外，系统稳定。\n此外，证据完整。\n此外，判定明确。", ["zh-Hans"]);
    expect(report.locale).toBe("unknown");
    expect(report.findings).toEqual([]);
    expect(report.status).toBe("PASS");
  });

  test("skips an explicitly mapped zh-Hans file when that locale is disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "traceknot-prose-zh-hans-disabled-"));
    writeFileSync(join(root, "README.zh.md"), "此外，系统稳定。\n此外，证据完整。\n此外，判定明确。");
    const report = scanRepository(root, {
      schemaVersion: "prose-quality-config/v1",
      enabled: true,
      mode: "blocking",
      locales: ["en"],
      localeOverrides: { "README.zh.md": "zh-Hans" },
      include: ["README.zh.md"],
      exclude: [],
      minimumProseCharacters: 1,
      maxChangeRate: 0.3,
      rejectChangeRate: 0.5,
    });
    expect(report.summary).toEqual(expect.objectContaining({ checked: 0, skipped: 1 }));
    expect(report.files).toEqual([]);
  });

  test("does not flag ordinary Simplified Chinese technical prose", () => {
    const report = analyzeProse("验证器会把每项结果绑定到目标快照。强制义务未满足时，最终判定为失败。审阅者可以检查记录的证据。", ["zh-Hans"], "zh-Hans");
    expect(report.locale).toBe("zh-Hans");
    expect(report.findings).toEqual([]);
    expect(report.status).toBe("PASS");
  });

  test("delegates Markdown code exclusions to zhlint without using autofix", () => {
    const report = analyzeProse("`中文English`\n\n```txt\n中文English\n```\n\n正文完整。", ["zh-Hans"], "zh-Hans");
    expect(report.findings).toEqual([]);
    expect(report.status).toBe("PASS");
  });

  test("masks inline code before deriving direct quotation ranges", () => {
    const report = analyzeProse('`"`中文English"', ["zh-Hans"], "zh-Hans");
    expect(report.findings).toContainEqual(expect.objectContaining({
      description: "zhlint: 此处中英文内容之间需要一个空格",
      count: 1,
    }));
    expect(report.status).toBe("WARN");
  });

  test.each([
    "资料原文是“中文English”。正文完整。",
    "资料原文是「中文English」。正文完整。",
    "资料原文是『中文English』。正文完整。",
    "> 中文English\n\n正文完整。",
    "<blockquote>中文English</blockquote>\n\n正文完整。",
  ])("keeps protected quotations outside the zhlint boundary: %s", (source) => {
    const report = analyzeProse(source, ["zh-Hans"], "zh-Hans");
    expect(report.findings).toEqual([]);
    expect(report.status).toBe("PASS");
  });

  test("masks overlapping nested quotation ranges as one protected region", () => {
    const before = "资料原文是『中文English「内部」内容』。";
    const after = "资料原文是『中文English「修改」内容』。";
    expect(analyzeProse(before, ["zh-Hans"], "zh-Hans").findings).toEqual([]);
    expect(verifyPreservation(before, after).failures)
      .toContainEqual(expect.objectContaining({ category: "quotation" }));
  });

  test("tracks protected whitespace independently from replacement text", () => {
    const report = analyzeProse("资料原文是“甲, 乙”。", ["zh-Hans"], "zh-Hans");
    expect(report.findings).toEqual([]);
    expect(report.status).toBe("PASS");
  });

  test("keeps visible zhlint findings outside protected quotations", () => {
    const report = analyzeProse("中文English，资料原文是“中文English”。", ["zh-Hans"], "zh-Hans");
    expect(report.findings).toContainEqual(expect.objectContaining({
      description: "zhlint: 此处中英文内容之间需要一个空格",
      count: 1,
    }));
    expect(report.status).toBe("WARN");
  });

  test("keeps adjacent punctuation findings outside protected quotations", () => {
    const report = analyzeProse("资料原文是:“引用”。", ["zh-Hans"], "zh-Hans");
    expect(report.findings).toContainEqual(expect.objectContaining({
      description: "zhlint: 此处标点符号需要使用全角",
      count: 1,
    }));
    expect(report.status).toBe("WARN");
  });

  test("does not lint Markdown link destinations as Chinese prose", () => {
    const report = analyzeProse("[证据](https://example.com/中文English)", ["zh-Hans"], "zh-Hans");
    expect(report.findings).toEqual([]);
    expect(report.status).toBe("PASS");
  });

  test("accepts Chinese quotation punctuation under the repository preset", () => {
    const report = analyzeProse("他说：“证据完整”。审阅者可以继续检查。", ["zh-Hans"], "zh-Hans");
    expect(report.findings).toEqual([]);
    expect(report.status).toBe("PASS");
  });

  test("reports fullwidth punctuation and spacing diagnostics", () => {
    const report = analyzeProse("甲, 乙; 丙: 丁", ["zh-Hans"], "zh-Hans");
    expect(report.findings).toContainEqual(expect.objectContaining({ description: "zhlint: 此处标点符号需要使用全角", count: 3 }));
    expect(report.findings).toContainEqual(expect.objectContaining({ description: "zhlint: 此处标点符号后不需要空格", count: 3 }));
    expect(report.status).toBe("WARN");
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

  test("does not claim semantic preservation for Simplified Chinese grammar", () => {
    const context = Array(20).fill("系统持续记录运行结果并保留完整证据供审阅者检查。").join("\n");
    const report = verifyPreservation(`${context}\n用户必须审核三项检查。`, `${context}\n用户可以审核四项检查。`);
    expect(report.failures).toEqual([]);
    expect(report.status).toBe("PASS");
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

  test("masks inline code before collecting protected corner-bracket quotations", () => {
    const report = verifyPreservation("`「`普通文本」", "`「`修改文本」");
    expect(report.failures.some((failure) => failure.category === "quotation")).toBe(false);
  });

  test("masks link destinations before deriving quotation ranges", () => {
    const report = analyzeProse('[证据](<https://example.com/">)中文English"', ["zh-Hans"], "zh-Hans");
    expect(report.findings).toContainEqual(expect.objectContaining({
      description: "zhlint: 此处中英文内容之间需要一个空格",
      count: 1,
    }));
  });

  test("masks autolink destinations before deriving quotation ranges", () => {
    const source = '<https://example.com/">中文English"';
    const report = analyzeProse(source, ["zh-Hans"], "zh-Hans");
    expect(report.findings).toContainEqual(expect.objectContaining({
      description: "zhlint: 此处中英文内容之间需要一个空格",
      count: 1,
    }));
    const preservation = verifyPreservation(source, '<https://example.com/">修改文本"');
    expect(preservation.failures.some((failure) => failure.category === "quotation")).toBe(false);
  });

  test("masks Markdown destinations by source range rather than repeated value", () => {
    const source = "> docs/中文English\n\n[证据](docs/中文English)";
    const report = analyzeProse(source, ["zh-Hans"], "zh-Hans");
    expect(report.findings).toEqual([]);
    expect(report.status).toBe("PASS");
  });

  test("locates the real inline destination after escaped label delimiters", () => {
    const report = analyzeProse("[前缀\\](中文English](dest)", ["zh-Hans"], "zh-Hans");
    expect(report.findings).toContainEqual(expect.objectContaining({
      description: "zhlint: 此处中英文内容之间需要一个空格",
      count: 1,
    }));
  });

  test("masks complete reference definitions before deriving quotation ranges", () => {
    const report = analyzeProse('["ref]: /dest\n\n中文English"', ["zh-Hans"], "zh-Hans");
    expect(report.findings).toContainEqual(expect.objectContaining({
      description: "zhlint: 此处中英文内容之间需要一个空格",
      count: 1,
    }));
  });

  test("masks raw HTML destinations by source range rather than repeated value", () => {
    const report = analyzeProse('1" ... <a href=\'1"\'>证据</a>中文English"', ["zh-Hans"], "zh-Hans");
    expect(report.findings).toContainEqual(expect.objectContaining({
      description: "zhlint: 此处中英文内容之间需要一个空格",
      count: 1,
    }));
  });

  test("masks repeated Markdown blockquotes by source range", () => {
    const source = "资料原文是“> 中文English\\n结束”。\n\n> 中文English\n";
    expect(analyzeProse(source, ["zh-Hans"], "zh-Hans").findings).toEqual([]);
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

  test("recognizes Korean particles attached to claim labels", () => {
    const before = "하한은 1.2이고 상한은 2.0이다.";
    const after = "상한은 1.2이고 하한은 2.0이다.";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("does not protect destinations without opening link brackets", () => {
    const report = verifyPreservation("The notation ](old) is explained here.", "The notation ](new) is explained here.");
    expect(report.failures.some((failure) => failure.category === "link-destination")).toBe(false);
  });

  test("rejects backticks inside backtick fence info strings", () => {
    const prose = extractProse("```invalid`info\nFormulaic publication prose follows.");
    expect(prose).toContain("Formulaic publication prose follows.");
  });

  test("binds short numeric values at exact boundaries", () => {
    const before = "The minimum release is 10, while the maximum release is 1.";
    const after = "The minimum release is 10, while the minimum release is 1.";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("preserves signs before currency symbols", () => {
    const report = verifyPreservation("The adjustment is -$5.", "The adjustment is +$5.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("ignores escaped Markdown closing brackets", () => {
    const report = verifyPreservation("The notation [marker\\](old) is explained.", "The notation [marker\\](new) is explained.");
    expect(report.failures.some((failure) => failure.category === "link-destination")).toBe(false);
  });

  test("binds postfix claim labels within their local clause", () => {
    const before = "Release 1.2 is minimum, while release 2.0 is maximum.";
    const after = "Release 1.2 is minimum, while release 2.0 is minimum.";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("protects multiline reference-link destinations", () => {
    const before = "[guide][setup]\n\n[setup]:\n  docs/old.md";
    const after = "[guide][setup]\n\n[setup]:\n  docs/new.md";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("preserves degree-prefixed temperature units", () => {
    const report = verifyPreservation("The target is 5°C.", "The target is 5°F.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("ignores escaped inline-code delimiters", () => {
    const before = "The literal \\`old\\` marker is prose.";
    const after = "The literal \\`new\\` marker is prose.";
    expect(extractProse(before)).toContain("old");
    expect(verifyPreservation(before, after).failures.some((failure) => failure.category === "inline-code")).toBe(false);
  });

  test("stops lazy blockquote continuation after blank quote lines", () => {
    const before = "> quoted\n>\nOrdinary publication prose.";
    const after = "> quoted\n>\nNatural publication prose.";
    expect(extractProse(before)).toContain("Ordinary publication prose.");
    expect(verifyPreservation(before, after).failures.some((failure) => failure.category === "quotation")).toBe(false);
  });

  test("stops claim-label lookup at sentence boundaries", () => {
    const before = "The optional appendix provides background. Version 1.2 remains supported.";
    const after = "The supplementary appendix provides background. Version 1.2 remains supported.";
    expect(verifyPreservation(before, after).status).toBe("PASS");
  });

  test("protects reference destinations with escaped label brackets", () => {
    const before = "[foo\\]]: docs/old.md";
    const after = "[foo\\]]: docs/new.md";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("preserves formal Korean normative endings", () => {
    const report = verifyPreservation("복구 절차를 수행해야 합니다.", "복구 절차를 수행할 수 있습니다.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("preserves Unicode numeric signs", () => {
    expect(verifyPreservation("허용 오차는 ±5입니다.", "허용 오차는 5입니다.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
    expect(verifyPreservation("변화량은 −5입니다.", "변화량은 5입니다.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("binds multiword limit labels to numeric values", () => {
    const before = "Use at least 1 item, but at most 2 items.";
    const after = "Use at most 1 item, but at least 2 items.";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("recognizes sentence ends before Markdown closers", () => {
    const before = "The optional appendix provides **background.** Version 1.2 remains supported.";
    const after = "The supplementary appendix provides **background.** Version 1.2 remains supported.";
    expect(verifyPreservation(before, after).status).toBe("PASS");
  });

  test("rejects unescaped opening brackets in reference labels", () => {
    const report = verifyPreservation("[foo[bar]: docs/old.md", "[foo[bar]: docs/new.md");
    expect(report.failures.some((failure) => failure.category === "link-destination")).toBe(false);
  });

  test("keeps inline-HTML paragraphs eligible for lazy quoting", () => {
    const before = "> <em>Quoted opening</em>\nLazy quoted continuation.";
    const after = "> <em>Quoted opening</em>\nChanged quoted continuation.";
    expect(extractProse(before)).not.toContain("Lazy quoted continuation.");
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
  });

  test("preserves curly single-quoted passages", () => {
    const before = "The guide states ‘minimum release 1.2’ for deployment.";
    const after = "The guide states ‘maximum release 1.2’ for deployment.";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
  });

  test("preserves leading-decimal values", () => {
    const report = verifyPreservation("The ratio is .5 for this release.", "The ratio is .6 for this release.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("protects raw script and style blocks as code", () => {
    const before = "<script>const oldName = 1;</script>\n<style>.old-name { color: red; }</style>";
    const after = "<script>const newName = 1;</script>\n<style>.new-name { color: red; }</style>";
    expect(extractProse(before)).not.toContain("oldName");
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
  });

  test("preserves numeric comparison operators", () => {
    expect(verifyPreservation("Batch size must be < 5.", "Batch size must be > 5.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
    expect(verifyPreservation("Batch size must be <= 5.", "Batch size must be >= 5.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves exponential numeric literals", () => {
    const report = verifyPreservation("The capacity is 1e3 records.", "The capacity is 2e3 records.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves SHALL as a normative term", () => {
    const report = verifyPreservation("The service SHALL retain records.", "The service can retain records.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("protects destinations after multiline inline-link labels", () => {
    const before = "[deployment\nguide](docs/old.md)";
    const after = "[deployment\nguide](docs/new.md)";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("tracks nested list indentation for code classification", () => {
    const before = "- Outer\n    - Nested\n\n        Nested prose remains visible.";
    const after = "- Outer\n    - Nested\n\n        Natural nested prose remains visible.";
    expect(extractProse(before)).toContain("Nested prose remains visible.");
    expect(verifyPreservation(before, after).failures.some((failure) => failure.category === "code-block")).toBe(false);
  });

  test("normalizes optional spacing before measurement units", () => {
    const report = verifyPreservation("The package weighs 5kg.", "The package weighs 5 kg.");
    expect(report.failures.some((failure) => failure.category === "number" || failure.category === "protected-context")).toBe(false);
  });

  test("preserves numeric range, ratio, and time separators", () => {
    const report = verifyPreservation("The accepted retry range is 1–5.", "The accepted retry range is 1/5.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("retains source offsets for canonicalized claim labels", () => {
    const before = "At least 1 is required, and at most 2 is required.";
    const after = "At most 1 is required, and at least 2 is required.";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("recognizes indented code after headings without blank lines", () => {
    const before = "# Example\n    traceknot verify";
    const after = "# Example\n    traceknot delete";
    expect(extractProse(before)).not.toContain("traceknot verify");
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
  });

  test("preserves numeric equality operators", () => {
    const report = verifyPreservation("Batch size = 5.", "Batch size ≠ 5.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves separators between exponential values", () => {
    const report = verifyPreservation("The range is 1e3–2e3.", "The ratio is 1e3/2e3.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("binds less-than and greater-than claim labels", () => {
    const before = "Use less than 5 retries and greater than 1 retry.";
    const after = "Use greater than 5 retries and less than 1 retry.";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("keeps lazy continuation disabled inside non-paragraph quotes", () => {
    const before = "> ```js\n> const x = 1;\nOrdinary publication prose.";
    const after = "> ```js\n> const x = 1;\nNatural publication prose.";
    expect(extractProse(before)).toContain("Ordinary publication prose.");
    expect(verifyPreservation(before, after).failures.some((failure) => failure.category === "quotation")).toBe(false);
  });

  test("matches complete dates before generic numeric pairs", () => {
    const report = verifyPreservation("Published on 2026-07-27.", "Published on 2026-07/27.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("recognizes indented code after Setext headings", () => {
    const before = "Example\n=======\n    traceknot verify";
    const after = "Example\n=======\n    traceknot delete";
    expect(extractProse(before)).not.toContain("traceknot verify");
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
  });

  test("recognizes hyphenated Setext heading underlines", () => {
    const before = "Example\n-\n    traceknot verify";
    const after = "Example\n-\n    traceknot delete";
    expect(extractProse(before)).not.toContain("traceknot verify");
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
  });

  test("disables lazy quoting after indented code blocks", () => {
    const before = ">     traceknot verify\nOrdinary publication prose.";
    const after = ">     traceknot verify\nNatural publication prose.";
    expect(extractProse(before)).toContain("Ordinary publication prose.");
    expect(verifyPreservation(before, after).failures.some((failure) => failure.category === "quotation")).toBe(false);
  });

  test("preserves spelled-out measurement units", () => {
    const report = verifyPreservation("The timeout is 5 minutes.", "The timeout is 5 hours.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves separators between fully formatted numeric operands", () => {
    expect(verifyPreservation("The range is −5–−1.", "The ratio is −5/−1.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
    expect(verifyPreservation("The range is 1,000–2,000.", "The ratio is 1,000/2,000.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("parses angle-bracket link destinations as a unit", () => {
    const before = "[guide](<docs/old)path>)";
    const after = "[guide](<docs/old)new>)";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("recognizes uncontracted Korean obligations", () => {
    const report = verifyPreservation("서비스는 기록을 보존하여야 한다.", "서비스는 기록을 보존할 수 있다.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("recognizes uncontracted Korean prohibitions", () => {
    const report = verifyPreservation("서비스는 기록을 공개하여서는 안 된다.", "서비스는 기록을 공개한다.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("preserves separators between unit-bearing operands", () => {
    const report = verifyPreservation("The accepted range is 10%–20%.", "The accepted ratio is 10%/20%.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("binds exactness qualifiers to numeric values", () => {
    const report = verifyPreservation("The documented target is exactly 5 retries.", "The documented target is approximately 5 retries.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("treats nested blockquotes as non-paragraph blocks", () => {
    const before = "> > Nested quotation.\nOrdinary publication prose.";
    const after = "> > Nested quotation.\nNatural publication prose.";
    expect(extractProse(before)).toContain("Ordinary publication prose.");
    expect(verifyPreservation(before, after).failures.some((failure) => failure.category === "quotation")).toBe(false);
  });

  test("protects postfix comparison operators", () => {
    const report = verifyPreservation("Use 5 < retry_count.", "Use 5 > retry_count.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("protects raw-HTML link destinations", () => {
    expect(verifyPreservation("<a href='docs/old.md'>Guide</a>", "<a href='docs/new.md'>Guide</a>").failures)
      .toContainEqual(expect.objectContaining({ category: "link-destination" }));
    expect(verifyPreservation("<a href=docs/old.md>Guide</a>", "<a href=docs/new.md>Guide</a>").failures)
      .toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("distinguishes inch marks from quotation delimiters", () => {
    const before = 'Use 5" old boards and 6" wide boards.';
    const after = 'Use 5" new boards and 6" wide boards.';
    expect(extractProse(before)).toContain("old boards");
    expect(verifyPreservation(before, after).failures.some((failure) => failure.category === "quotation")).toBe(false);
  });

  test("treats digit-final quotes as closing quotation delimiters", () => {
    const before = 'The report says "Version 5" for supported deployments.';
    const after = 'The report says "Release 5" for supported deployments.';
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
  });

  test("counts preservation runs in report summaries", () => {
    const base = { tokenChangeRate: 0, protectedTotal: 0, protectedPreserved: 0, failures: [] };
    expect(createPreservationQualityReport({ ...base, status: "PASS" }, "advisory").summary)
      .toEqual({ checked: 1, passed: 1, warned: 0, failed: 0, skipped: 0 });
    expect(createPreservationQualityReport({ ...base, status: "WARN" }, "advisory").summary)
      .toEqual({ checked: 1, passed: 0, warned: 1, failed: 0, skipped: 0 });
    expect(createPreservationQualityReport({ ...base, status: "FAIL" }, "blocking").summary)
      .toEqual({ checked: 1, passed: 0, warned: 0, failed: 1, skipped: 0 });
  });

  test("scans quoted HTML attributes before locating href", () => {
    const before = "<a title='open > closed' href='docs/old.md'>Guide</a>";
    const after = "<a title='open > closed' href='docs/new.md'>Guide</a>";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("normalizes units on both compound operands", () => {
    const report = verifyPreservation("The range is 10%–20%.", "The range is 10 %–20 %.");
    expect(report.failures.some((failure) => failure.category === "number" || failure.category === "protected-context")).toBe(false);
  });

  test("preserves currency codes on compound operands", () => {
    const report = verifyPreservation("The budget is 10 USD–20 USD.", "The budget is 10 USD/20 USD.");
    expect(report.failures).toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves every separator in multipart dates and times", () => {
    expect(verifyPreservation("The time is 12:30:45.", "The time is 12:30/45.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
    expect(verifyPreservation("Published 2026/07/27.", "Published 2026/07:27.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves meridiem markers with times", () => {
    expect(verifyPreservation("Maintenance starts at 12:30 PM.", "Maintenance starts at 12:30 AM.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves prerelease and build version suffixes", () => {
    expect(verifyPreservation("Deploy v1.2.3-beta.1.", "Deploy v1.2.3-rc.1.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
    expect(verifyPreservation("Deploy v1.2.3+build.1.", "Deploy v1.2.3+build.2.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("protects unterminated raw code blocks through EOF", () => {
    const before = "<script>\nconst oldCode = 1;";
    const after = "<script>\nconst newCode = 1;";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
    expect(extractProse(before)).not.toContain("oldCode");
  });

  test("preserves dotted meridiem markers", () => {
    expect(verifyPreservation("Maintenance starts at 12:30 p.m.", "Maintenance starts at 12:30 a.m.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves prereleases without a v prefix", () => {
    expect(verifyPreservation("Deploy version 1.2.3-beta.1.", "Deploy version 1.2.3-rc.1.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("recognizes conditional Korean prohibitions", () => {
    expect(verifyPreservation("서비스를 삭제하면 안 된다.", "서비스를 삭제해도 된다.").failures)
      .toContainEqual(expect.objectContaining({ category: "normative" }));
    expect(verifyPreservation("서비스를 삭제한다면 안 됩니다.", "서비스를 삭제해도 됩니다.").failures)
      .toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("preserves hour-only meridiem times", () => {
    expect(verifyPreservation("Maintenance starts at 12 PM.", "Maintenance starts at 12 AM.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves separators between storage-size operands", () => {
    expect(verifyPreservation("Storage is 10 MB–20 MB.", "Storage is 10 MB/20 MB.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
    expect(verifyPreservation("Storage is 10 MiB–20 MiB.", "Storage is 10 MiB/20 MiB.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("recognizes unterminated fenced blocks nested in lists", () => {
    const before = "- Example\n\n    ```sh\n    traceknot verify";
    const after = "- Example\n\n    ```sh\n    traceknot delete";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
    expect(extractProse(before)).not.toContain("traceknot verify");
  });

  test("binds timezone designators to protected times", () => {
    expect(verifyPreservation("Maintenance starts at 12:30 UTC.", "Maintenance starts at 12:30 EST.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("rejects over-indented top-level fence closers", () => {
    const before = "   ```js\nconst first = 1;\n    ```\nconst oldCode = 2;\n```";
    const after = "   ```js\nconst first = 1;\n    ```\nconst newCode = 2;\n```";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
    expect(extractProse(before)).not.toContain("oldCode");
  });

  test("preserves month names in textual dates", () => {
    expect(verifyPreservation("Release is July 27, 2026.", "Release is August 27, 2026.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
    expect(verifyPreservation("Release is 27 July 2026.", "Release is 27 August 2026.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves separators between data-rate operands", () => {
    expect(verifyPreservation("Throughput is 10 Mbps–20 Mbps.", "Throughput is 10 Mbps/20 Mbps.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
    expect(verifyPreservation("Throughput is 10 Gbps–20 Gbps.", "Throughput is 10 Gbps/20 Gbps.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("binds magnitude words to protected numbers", () => {
    expect(verifyPreservation("Budget is $5 million.", "Budget is $5 billion.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("tracks list context across intervening paragraphs", () => {
    const before = "- Example\n\n  Here is the command:\n\n    ```sh\n    traceknot verify";
    const after = "- Example\n\n  Here is the command:\n\n    ```sh\n    traceknot delete";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
    expect(extractProse(before)).not.toContain("traceknot verify");
  });

  test("protects declarative English obligations", () => {
    expect(verifyPreservation("Operators are required to preserve audit records.", "Operators are permitted to preserve audit records.").failures)
      .toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("preserves HTML blockquote content", () => {
    expect(verifyPreservation("<blockquote>Original attributed text.</blockquote>", "<blockquote>Changed attributed text.</blockquote>").failures)
      .toContainEqual(expect.objectContaining({ category: "quotation" }));
  });

  test("restores outer list indentation after nested lists", () => {
    const before = "- Outer\n  - Inner\n  Outer paragraph.\n\n      traceknot verify";
    const after = "- Outer\n  - Inner\n  Outer paragraph.\n\n      traceknot delete";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
    expect(extractProse(before)).not.toContain("traceknot verify");
  });

  test("binds reference-use labels to destinations", () => {
    const definitions = "\n\n[stable]: docs/stable.md\n[beta]: docs/beta.md";
    expect(verifyPreservation(`[guide][stable]${definitions}`, `[guide][beta]${definitions}`).failures)
      .toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("protects units on standalone storage and rate values", () => {
    expect(verifyPreservation("Capacity is 5 MB.", "Capacity is 5 GB.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
    expect(verifyPreservation("Throughput is 5 Mbps.", "Throughput is 5 Gbps.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("binds prefix currency codes to numeric amounts", () => {
    expect(verifyPreservation("Budget is USD 5 million.", "Budget is EUR 5 million.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("excludes HTML comments from prose analysis", () => {
    const comment = "<!-- It is important to note that this underscores the importance of this. -->\nVisible publication prose.";
    expect(extractProse(comment)).not.toContain("important");
    expect(extractProse(comment)).toContain("Visible publication prose.");
  });

  test("binds weekday names to textual dates", () => {
    expect(verifyPreservation("Release is Monday, July 27, 2026.", "Release is Tuesday, July 27, 2026.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("binds shortcut references to destinations", () => {
    const definitions = "\n\n[stable]: docs/stable.md\n[beta]: docs/beta.md";
    expect(verifyPreservation(`[stable]${definitions}`, `[beta]${definitions}`).failures)
      .toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("recognizes blockquotes nested under list containers", () => {
    const before = "- Evidence\n\n    > Original attributed text";
    const after = "- Evidence\n\n    > Changed attributed text";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
    expect(extractProse(before)).not.toContain("Original attributed text");
  });

  test("binds timezone designators to hour-only times", () => {
    expect(verifyPreservation("Maintenance starts at 12 UTC.", "Maintenance starts at 12 EST.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("prints individual findings in text reports", () => {
    const report = { path: "posts/example.md", ...analyzeProse("In today's rapidly evolving landscape, teams change. This underscores the importance of a transformative potential for every organization.", ["en"]) };
    const output = formatTextReport({
      schemaVersion: "prose-quality-report/v1",
      mode: "advisory",
      status: report.status,
      files: [report],
      summary: { checked: 1, passed: 0, warned: 1, failed: 0, skipped: 0 },
    });
    expect(output).toContain("posts/example.md:");
    expect(output).toContain("EN-");
  });

  test("recognizes fences on list marker lines", () => {
    const before = "- ```sh\n  traceknot verify\n  ```\nVisible publication prose.";
    const after = "- ```sh\n  traceknot delete\n  ```\nVisible publication prose.";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "code-block" }));
    expect(extractProse(before)).not.toContain("traceknot verify");
    expect(extractProse(before)).toContain("Visible publication prose.");
  });

  test("excludes raw HTML blockquotes from style analysis", () => {
    const quote = "<blockquote>In today's rapidly evolving landscape, this underscores the importance of transformative potential.</blockquote>\nVisible prose.";
    expect(extractProse(quote)).not.toContain("rapidly evolving");
    expect(analyzeProse(quote, ["en"]).findings).toEqual([]);
  });

  test("protects yearless textual dates", () => {
    expect(verifyPreservation("Release is July 27.", "Release is August 27.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
    expect(verifyPreservation("Release is 27 July.", "Release is 27 August.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("protects predicate obligations without an infinitive", () => {
    expect(verifyPreservation("Authentication is required for deployments.", "Authentication is optional for deployments.").failures)
      .toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("parses nested brackets in reference-link text", () => {
    const definitions = "\n\n[stable]: docs/stable.md\n[beta]: docs/beta.md";
    expect(verifyPreservation(`[the [deployment] guide][stable]${definitions}`, `[the [deployment] guide][beta]${definitions}`).failures)
      .toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("protects month-and-year textual dates", () => {
    expect(verifyPreservation("Release is July 2026.", "Release is August 2026.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("recognizes blockquotes on list marker lines", () => {
    const before = "- > Original attributed text";
    const after = "- > Changed attributed text";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
    expect(extractProse(before)).not.toContain("Original attributed text");
  });

  test("parses nested raw HTML blockquotes to the outer close", () => {
    const before = "<blockquote>Outer <blockquote>Inner</blockquote> original tail</blockquote>";
    const after = "<blockquote>Outer <blockquote>Inner</blockquote> changed tail</blockquote>";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
    expect(extractProse(before)).not.toContain("original tail");
  });

  test("binds obligations to their subjects", () => {
    const before = "Operators MUST preserve audit records, while guests MAY view them.";
    const after = "Guests MUST preserve audit records, while operators MAY view them.";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("binds inline-link text to its destination", () => {
    const before = "[stable](docs/stable.md) and [beta](docs/beta.md)";
    const after = "[beta](docs/stable.md) and [stable](docs/beta.md)";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("binds raw HTML anchor text to its href", () => {
    const before = '<a href="docs/stable.md">stable</a> and <a href="docs/beta.md">beta</a>';
    const after = '<a href="docs/stable.md">beta</a> and <a href="docs/beta.md">stable</a>';
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("binds declarative obligations to their clauses", () => {
    const before = "Operators are required to retain records, while guests are optional participants.";
    const after = "Guests are required to retain records, while operators are optional participants.";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("matches only real href attributes", () => {
    const before = '<a data-href="tracking" href="docs/stable.md">stable</a>';
    const after = '<a data-href="tracking" href="docs/beta.md">stable</a>';
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("accounts for nested marker width when closing fences", () => {
    const markdown = "  - ```sh\n    traceknot verify\n    ```\nVisible publication prose.";
    expect(extractProse(markdown)).not.toContain("traceknot verify");
    expect(extractProse(markdown)).toContain("Visible publication prose.");
  });

  test("binds numeric facts to their local subjects", () => {
    const before = "HTTP listens on port 80. HTTPS listens on port 443.";
    const after = "HTTPS listens on port 80. HTTP listens on port 443.";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("routes substantial minority-language prose through mixed rules", () => {
    const korean = "한국어게시문서내용".repeat(22);
    const english = "In today's rapidly evolving landscape, this underscores the importance. ".repeat(2);
    expect((korean.match(/[가-힣]/g) ?? []).length).toBeGreaterThan(150);
    expect((english.match(/[A-Za-z]/g) ?? []).length).toBeGreaterThan(85);
    expect(detectLocale(`${korean}\n${english}`)).toBe("mixed");
    expect(analyzeProse(`${korean}\n${english}`).findings.some((finding) => finding.ruleId === "EN-D-001")).toBe(true);
  });

  test("prints preservation failures in text reports", () => {
    const preservation = verifyPreservation("Deploy v1.2.3.", "Deploy v2.0.0.");
    const output = formatTextReport(createPreservationQualityReport(preservation, "blocking"));
    expect(output).toContain("preservation token-change-rate");
    expect(output).toContain("preservation number");
    expect(output).toContain("expected 1 actual 0");
  });

  test("protects URL attributes beyond anchor hrefs", () => {
    expect(verifyPreservation("<img src='images/stable.png'>", "<img src='images/beta.png'>").failures)
      .toContainEqual(expect.objectContaining({ category: "link-destination" }));
    expect(verifyPreservation("<img src=images/stable.png>", "<img src=images/beta.png>").failures)
      .toContainEqual(expect.objectContaining({ category: "link-destination" }));
    expect(verifyPreservation('<source srcset="small.png 1x, large.png 2x">', '<source srcset="small.png 1x, huge.png 2x">').failures)
      .toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("binds lowercase subjects to numeric facts", () => {
    const before = "frontend listens on port 80 while backend listens on port 443";
    const after = "backend listens on port 80 while frontend listens on port 443";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("binds object-side subjects to numeric facts", () => {
    const before = "Port 80 serves frontend, while port 443 serves backend.";
    const after = "Port 80 serves backend, while port 443 serves frontend.";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("protects obligations containing intervening auxiliaries", () => {
    expect(verifyPreservation("Authentication will be required for deployments.", "Authentication will be optional for deployments.").failures)
      .toContainEqual(expect.objectContaining({ category: "normative" }));
    expect(verifyPreservation("Access has been prohibited.", "Access has been allowed.").failures)
      .toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("preserves spelled-out numeric quantities", () => {
    expect(verifyPreservation("The system allows five retries.", "The system allows six retries.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
    expect(verifyPreservation("시스템은 다섯 개를 허용한다.", "시스템은 여섯 개를 허용한다.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("keeps list-relative lazy blockquote continuations protected", () => {
    const before = "- > Original attributed text\n    lazy continuation text";
    const after = "- > Original attributed text\n    changed continuation text";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
    expect(extractProse(before)).not.toContain("lazy continuation");
  });

  test("computes list indentation from complete ordered markers", () => {
    const before = "1234. > Original text\n      lazy continuation";
    const after = "1234. > Original text\n      changed continuation";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
    expect(extractProse(before)).not.toContain("lazy continuation");
  });

  test("preserves complete compound spelled-out quantities", () => {
    expect(verifyPreservation("The system allows one hundred retries.", "The system allows two hundred retries.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves spelled-out numeric bindings across soft line wraps", () => {
    const context = Array(20).fill("The system records every result and retains complete evidence for reviewers.").join("\n");
    const before = `${context}\nMinimum supports one\nhundred users. Maximum supports two\nhundred users.`;
    const after = `${context}\nMinimum supports two\nhundred users. Maximum supports one\nhundred users.`;
    expect(verifyPreservation(before, after).failures)
      .toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test.each([
    ["资料原文是「保持原样」。", "资料原文是「改变内容」。"],
    ["资料原文是『保持原样』。", "资料原文是『改变内容』。"],
  ])("preserves Chinese corner-bracket quotations: %s", (before, after) => {
    expect(verifyPreservation(before, after).failures)
      .toContainEqual(expect.objectContaining({ category: "quotation" }));
  });

  test("skips articles when binding numeric subjects", () => {
    const before = "The frontend listens on port 80 while the backend listens on port 443";
    const after = "The backend listens on port 80 while the frontend listens on port 443";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("protects teen and tens quantities", () => {
    expect(verifyPreservation("The system allows twenty retries.", "The system allows thirty retries.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
    expect(verifyPreservation("The system allows thirteen retries.", "The system allows nineteen retries.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("protects predicates through negated auxiliary chains", () => {
    expect(verifyPreservation("Authentication will not be required.", "Authentication will not be optional.").failures)
      .toContainEqual(expect.objectContaining({ category: "normative" }));
    expect(verifyPreservation("Access has not been prohibited.", "Access has not been allowed.").failures)
      .toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("protects straight-single-quoted passages", () => {
    const before = "'Original attributed wording remains here'";
    const after = "'Changed attributed wording remains here'";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
    expect(extractProse(before)).not.toContain("Original attributed");
    expect(extractProse("It's ordinary publication prose.")).toContain("It's ordinary publication prose.");
  });

  test("binds passive numeric assignments to endpoints", () => {
    const before = "Port 80 is assigned to frontend, while port 443 is assigned to backend";
    const after = "Port 80 is assigned to backend, while port 443 is assigned to frontend";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("protects Korean quantities counted with 번", () => {
    expect(verifyPreservation("다섯 번 재시도를 허용합니다.", "여섯 번 재시도를 허용합니다.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("preserves conjunctions in compound spelled-out quantities", () => {
    expect(verifyPreservation("The system allows one hundred and five retries.", "The system allows two hundred and five retries.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("matches negation after simple copulas", () => {
    expect(verifyPreservation("Authentication is not permitted.", "Authentication is not prohibited.").failures)
      .toContainEqual(expect.objectContaining({ category: "normative" }));
  });

  test("binds reference-link text to its destination", () => {
    const before = "[stable guide][one] and [beta guide][two]\n\n[one]: /stable\n[two]: /beta";
    const after = "[beta guide][one] and [stable guide][two]\n\n[one]: /stable\n[two]: /beta";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("skips articles before passive assignment targets", () => {
    const before = "Port 80 is assigned to the frontend, while port 443 is assigned to the backend";
    const after = "Port 80 is assigned to the backend, while port 443 is assigned to the frontend";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("binds nested reference-link text to its destination", () => {
    const before = "[see [stable] guide][one] and [see [beta] guide][two]\n\n[one]: /stable\n[two]: /beta";
    const after = "[see [beta] guide][one] and [see [stable] guide][two]\n\n[one]: /stable\n[two]: /beta";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("protects form override destinations", () => {
    expect(verifyPreservation("<button formaction=actions/stable>Submit</button>", "<button formaction=actions/beta>Submit</button>").failures)
      .toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("preserves Sino-Korean counter quantities", () => {
    expect(verifyPreservation("오 회 재시도를 허용합니다.", "육 회 재시도를 허용합니다.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("protects object data destinations", () => {
    expect(verifyPreservation("<object data=docs/stable.pdf></object>", "<object data=docs/beta.pdf></object>").failures)
      .toContainEqual(expect.objectContaining({ category: "link-destination" }));
  });

  test("binds future passive assignments to endpoints", () => {
    const before = "Port 80 will be assigned to frontend, while port 443 will be assigned to backend";
    const after = "Port 80 will be assigned to backend, while port 443 will be assigned to frontend";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });

  test("treats inline q elements as quotations", () => {
    const before = "<q>Original attributed wording remains here</q>";
    const after = "<q>Changed attributed wording remains here</q>";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "quotation" }));
    expect(extractProse(before)).not.toContain("Original attributed");
  });

  test("binds weekdays to numeric dates", () => {
    expect(verifyPreservation("Release is Monday, 2026-07-27.", "Release is Tuesday, 2026-07-27.").failures)
      .toContainEqual(expect.objectContaining({ category: "number" }));
  });

  test("binds perfect passive assignments to endpoints", () => {
    const before = "Port 80 has been assigned to frontend, while port 443 has been assigned to backend";
    const after = "Port 80 has been assigned to backend, while port 443 has been assigned to frontend";
    expect(verifyPreservation(before, after).failures).toContainEqual(expect.objectContaining({ category: "protected-context" }));
  });
});
