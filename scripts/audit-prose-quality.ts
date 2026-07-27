import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

export type Locale = "ko" | "en" | "mixed" | "unknown";
export type Severity = "S1" | "S2" | "S3";
export type GateStatus = "PASS" | "WARN" | "FAIL" | "BLOCKED";

export interface ProseRule {
  id: string;
  locale: "ko" | "en";
  severity: Severity;
  description: string;
  pattern: RegExp;
  threshold: number;
}

export interface ProseFinding {
  ruleId: string;
  severity: Severity;
  description: string;
  count: number;
  line: number;
  excerptHash: string;
}

export interface FileReport {
  path: string;
  locale: Locale;
  proseCharacters: number;
  findings: ProseFinding[];
  status: GateStatus;
}

export interface PreservationFailure {
  category: string;
  valueHash: string;
  expectedCount: number;
  actualCount: number;
}

export interface PreservationReport {
  status: "PASS" | "WARN" | "FAIL";
  tokenChangeRate: number;
  protectedTotal: number;
  protectedPreserved: number;
  failures: PreservationFailure[];
}

export interface ProseQualityReport {
  schemaVersion: "prose-quality-report/v1";
  mode: "advisory" | "blocking";
  status: GateStatus;
  files: FileReport[];
  summary: { checked: number; passed: number; warned: number; failed: number; skipped: number };
  preservation?: PreservationReport;
}

export interface Config {
  schemaVersion: "prose-quality-config/v1";
  enabled: boolean;
  mode: "advisory" | "blocking";
  locales: Array<"ko" | "en">;
  include: string[];
  exclude: string[];
  minimumProseCharacters: number;
  maxChangeRate: number;
  rejectChangeRate: number;
}

export const RULES: readonly ProseRule[] = [
  { id: "KO-C-001", locale: "ko", severity: "S1", description: "기계적인 세 단계 병렬 구조", pattern: /첫째[\s\S]{0,800}둘째[\s\S]{0,800}셋째/g, threshold: 1 },
  { id: "KO-D-001", locale: "ko", severity: "S1", description: "상투적인 결론 또는 과장 표현", pattern: /결론적으로|시사하는 바가 크다|주목할 만하다/g, threshold: 2 },
  { id: "KO-G-001", locale: "ko", severity: "S1", description: "중첩된 완곡 표현", pattern: /할 수 있을 것으로 보인다/g, threshold: 1 },
  { id: "KO-H-001", locale: "ko", severity: "S2", description: "문두 접속사 반복", pattern: /^(?:또한|따라서|즉|나아가)[,\s]/gm, threshold: 3 },
  { id: "KO-A-001", locale: "ko", severity: "S2", description: "번역투 '통해' 반복", pattern: /(?:을|를) 통해/g, threshold: 4 },
  { id: "EN-C-001", locale: "en", severity: "S1", description: "mechanical three-part structure", pattern: /\bfirst(?:ly)?\b[\s\S]{0,1000}\bsecond(?:ly)?\b[\s\S]{0,1000}\bthird(?:ly)?\b/gi, threshold: 1 },
  { id: "EN-D-001", locale: "en", severity: "S1", description: "formulaic or inflated prose", pattern: /\b(?:in today's rapidly evolving landscape|this underscores the importance of|transformative potential)\b/gi, threshold: 2 },
  { id: "EN-G-001", locale: "en", severity: "S2", description: "generic meta-claim", pattern: /\b(?:it is important to note that|it is worth noting that)\b/gi, threshold: 2 },
  { id: "EN-H-001", locale: "en", severity: "S2", description: "repetitive paragraph transition", pattern: /^(?:Furthermore|Moreover|Additionally)[,\s]/gim, threshold: 3 },
];

const DEFAULT_CONFIG: Config = {
  schemaVersion: "prose-quality-config/v1",
  enabled: true,
  mode: "advisory",
  locales: ["ko", "en"],
  include: ["README.md", "README.ko.md", "BRAND.md", "BRAND.ko.md"],
  exclude: [],
  minimumProseCharacters: 200,
  maxChangeRate: 0.3,
  rejectChangeRate: 0.5,
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clonePattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

function maskContentPreservingLines(value: string): string {
  return value.replace(/[^\n]/g, " ");
}

function markdownFencedBlocks(text: string): string[] {
  const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index].match(/^([ \t]*)(`{3,}|~{3,})/);
    if (!opening || indentationColumns(opening[1]) > 3) continue;
    const delimiter = opening[2];
    const marker = delimiter[0];
    let end = lines.length - 1;
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      const closing = lines[candidate].match(/^([ \t]*)(`+|~+)[ \t]*(?:\r?\n|$)/);
      if (closing && indentationColumns(closing[1]) <= 3 && closing[2][0] === marker && closing[2].length >= delimiter.length) {
        end = candidate;
        break;
      }
    }
    blocks.push(lines.slice(index, end + 1).join(""));
    index = end;
  }
  return blocks;
}

function markdownInlineCodeSpans(text: string): string[] {
  const spans: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("`", cursor);
    if (start < 0) break;
    let openingLength = 1;
    while (text[start + openingLength] === "`") openingLength += 1;
    let candidate = start + openingLength;
    let closed = false;
    while (candidate < text.length) {
      candidate = text.indexOf("`", candidate);
      if (candidate < 0) break;
      let closingLength = 1;
      while (text[candidate + closingLength] === "`") closingLength += 1;
      if (closingLength === openingLength) {
        spans.push(text.slice(start, candidate + closingLength));
        cursor = candidate + closingLength;
        closed = true;
        break;
      }
      candidate += closingLength;
    }
    if (!closed) cursor = start + openingLength;
  }
  return spans;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function directQuotationSpans(text: string): string[] {
  const spans: string[] = [];
  for (const [opening, closing] of [["\"", "\""], ["“", "”"]] as const) {
    let cursor = 0;
    while (cursor < text.length) {
      let start = text.indexOf(opening, cursor);
      while (start >= 0 && isEscaped(text, start)) start = text.indexOf(opening, start + 1);
      if (start < 0) break;
      let end = text.indexOf(closing, start + 1);
      while (end >= 0 && isEscaped(text, end)) end = text.indexOf(closing, end + 1);
      if (end < 0) break;
      spans.push(text.slice(start, end + 1));
      cursor = end + 1;
    }
  }
  return spans;
}

function visualColumns(value: string): number {
  let columns = 0;
  for (const character of value) columns = character === "\t" ? columns + (4 - (columns % 4)) : columns + 1;
  return columns;
}

function indentationColumns(value: string): number {
  return visualColumns(value.match(/^[ \t]*/)?.[0] ?? "");
}

function markdownIndentedCodeBlocks(text: string): string[] {
  const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  const blocks: string[] = [];
  let listCodeIndent: number | null = null;
  let previousBlank = true;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[ \t]*(?:\r?\n|$)/.test(line)) {
      previousBlank = true;
      continue;
    }
    const listMarker = line.match(/^( {0,3})([-+*]|\d+[.)])([ \t]+)/);
    if (listMarker) {
      listCodeIndent = visualColumns(`${listMarker[1]}${listMarker[2]}${listMarker[3]}`) + 4;
      previousBlank = false;
      continue;
    }
    if (/^\S/.test(line)) listCodeIndent = null;
    const requiredIndent = listCodeIndent ?? 4;
    const codeIndent = previousBlank && indentationColumns(line) >= requiredIndent;
    if (!codeIndent) {
      previousBlank = false;
      continue;
    }
    let end = index;
    while (end + 1 < lines.length) {
      const next = lines[end + 1];
      if (/^[ \t]*(?:\r?\n|$)/.test(next)) {
        end += 1;
        continue;
      }
      if (indentationColumns(next) < requiredIndent) break;
      end += 1;
    }
    blocks.push(lines.slice(index, end + 1).join(""));
    previousBlank = /^[ \t]*(?:\r?\n|$)/.test(lines[end]);
    index = end;
  }
  return blocks;
}

function startsInterruptingMarkdownBlock(line: string): boolean {
  return /^[ \t]{0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-+*]|\d+[.)])[ \t]+|`{3,}|~{3,}|(?:\*\s*){3,}$|(?:-\s*){3,}$|(?:_\s*){3,}$|<)/.test(line.trimEnd());
}

function blockquoteContent(line: string): string | null {
  const match = line.match(/^([ \t]*)>[ \t]?/);
  if (!match || indentationColumns(match[1]) > 3) return null;
  return line.slice(match[0].length);
}

function markdownBlockquotes(text: string): string[] {
  const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const openingContent = blockquoteContent(lines[index]);
    if (openingContent === null) continue;
    let end = index;
    let allowsLazyContinuation = !startsInterruptingMarkdownBlock(openingContent);
    while (end + 1 < lines.length) {
      const next = lines[end + 1];
      if (/^[ \t]*(?:\r?\n|$)/.test(next)) break;
      const continuedContent = blockquoteContent(next);
      if (continuedContent !== null) {
        allowsLazyContinuation = !startsInterruptingMarkdownBlock(continuedContent);
        end += 1;
        continue;
      }
      if (!allowsLazyContinuation || startsInterruptingMarkdownBlock(next)) break;
      end += 1;
    }
    blocks.push(lines.slice(index, end + 1).join(""));
    index = end;
  }
  return blocks;
}

function htmlCodeSpans(text: string): Array<{ category: "code-block" | "inline-code"; value: string }> {
  const spans: Array<{ category: "code-block" | "inline-code"; value: string }> = [];
  let remaining = text;
  for (const match of text.matchAll(/<pre\b[^>]*>[\s\S]*?<\/pre\s*>/gi)) {
    spans.push({ category: "code-block", value: match[0] });
    remaining = remaining.replace(match[0], " ".repeat(match[0].length));
  }
  for (const match of remaining.matchAll(/<code\b[^>]*>[\s\S]*?<\/code\s*>/gi)) {
    spans.push({ category: "inline-code", value: match[0] });
  }
  return spans;
}

export function extractProse(markdown: string): string {
  let prose = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, maskContentPreservingLines);
  for (const block of markdownFencedBlocks(prose)) prose = prose.replace(block, maskContentPreservingLines);
  for (const block of markdownIndentedCodeBlocks(prose)) prose = prose.replace(block, maskContentPreservingLines);
  for (const span of htmlCodeSpans(prose)) prose = prose.replace(span.value, maskContentPreservingLines);
  for (const quote of markdownBlockquotes(prose)) prose = prose.replace(quote, maskContentPreservingLines);
  for (const quote of directQuotationSpans(prose)) prose = prose.replace(quote, maskContentPreservingLines);
  for (const span of markdownInlineCodeSpans(prose)) prose = prose.replace(span, maskContentPreservingLines);
  prose = prose.replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1");
  prose = prose.replace(/<(?:(?:[A-Za-z][A-Za-z0-9+.-]*:[^>\s]+)|(?:[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}))>|https?:\/\/\S+/g, "");
  prose = prose.replace(/^\s*[-*+]\s*$/gm, "");
  return prose;
}

export function detectLocale(text: string): Locale {
  const korean = (text.match(/[가-힣]/g) ?? []).length;
  const english = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = korean + english;
  if (total === 0) return "unknown";
  if (korean / total >= 0.6) return "ko";
  if (english / total >= 0.8) return "en";
  if (korean >= 20 && english >= 20) return "mixed";
  return korean > english ? "ko" : "en";
}

function firstMatchLine(text: string, rule: ProseRule): number {
  const match = clonePattern(rule.pattern).exec(text);
  return match ? text.slice(0, match.index).split("\n").length : 1;
}

export function analyzeProse(markdown: string, allowedLocales: ReadonlyArray<"ko" | "en"> = ["ko", "en"]): Omit<FileReport, "path"> {
  const prose = extractProse(markdown);
  const locale = detectLocale(prose);
  const applicableLocales = locale === "mixed" ? allowedLocales : locale === "unknown" ? [] : allowedLocales.filter((entry) => entry === locale);
  const findings = RULES.filter((rule) => applicableLocales.includes(rule.locale)).flatMap((rule) => {
    const matches = [...prose.matchAll(clonePattern(rule.pattern))];
    if (matches.length < rule.threshold) return [];
    const excerpt = matches[0]?.[0] ?? rule.id;
    return [{
      ruleId: rule.id,
      severity: rule.severity,
      description: rule.description,
      count: matches.length,
      line: firstMatchLine(prose, rule),
      excerptHash: hash(excerpt),
    }];
  });
  const status: GateStatus = findings.some((finding) => finding.severity === "S1") ? "FAIL" : findings.length > 0 ? "WARN" : "PASS";
  return { locale, proseCharacters: prose.replace(/\s/g, "").length, findings, status };
}

function globPattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**/", "\u0000")
    .replaceAll("**", "\u0001")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", "(?:.*/)?")
    .replaceAll("\u0001", ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globPattern(pattern).test(path));
}

function collectMarkdown(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === ".git" || entry === "node_modules" || entry === ".sisyphus") continue;
      const path = resolve(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) visit(path);
      else if (extname(entry) === ".md") files.push(path);
    }
  };
  visit(root);
  return files;
}

export function loadConfig(root: string, configPath?: string): Config {
  if (!configPath) return DEFAULT_CONFIG;
  const configFile = resolve(root, configPath);
  const parsed: unknown = JSON.parse(readFileSync(configFile, "utf8"));
  const schema = JSON.parse(readFileSync(resolve(root, "contracts/prose-quality-config.schema.json"), "utf8")) as object;
  const validate = new Ajv2020({ strict: true }).compile(schema);
  if (!validate(parsed)) throw new Error(`invalid prose-quality config: ${validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ?? "schema validation failed"}`);
  const config = parsed as Config;
  if (config.maxChangeRate >= config.rejectChangeRate) throw new Error("maxChangeRate must be lower than rejectChangeRate");
  return config;
}

export function scanRepository(root: string, config: Config = DEFAULT_CONFIG): ProseQualityReport {
  if (!config.enabled) return { schemaVersion: "prose-quality-report/v1", mode: config.mode, status: "PASS", files: [], summary: { checked: 0, passed: 0, warned: 0, failed: 0, skipped: 0 } };
  const candidates = collectMarkdown(root).filter((file) => {
    const path = relative(root, file).replaceAll("\\", "/");
    return matchesAny(path, config.include) && !matchesAny(path, config.exclude);
  });
  let skipped = 0;
  const files = candidates.flatMap((file): FileReport[] => {
    const path = relative(root, file).replaceAll("\\", "/");
    const analysis = analyzeProse(readFileSync(file, "utf8"), config.locales);
    const localeDisabled = analysis.locale !== "mixed" && analysis.locale !== "unknown" && !config.locales.includes(analysis.locale);
    if (analysis.proseCharacters < config.minimumProseCharacters || analysis.locale === "unknown" || localeDisabled) {
      skipped += 1;
      return [];
    }
    return [{ path, ...analysis }];
  });
  const failed = files.filter((file) => file.status === "FAIL").length;
  const warned = files.filter((file) => file.status === "WARN").length;
  const passed = files.filter((file) => file.status === "PASS").length;
  const observedStatus: GateStatus = files.length === 0 && config.mode === "blocking" ? "BLOCKED" : failed > 0 ? "FAIL" : warned > 0 ? "WARN" : "PASS";
  return {
    schemaVersion: "prose-quality-report/v1",
    mode: config.mode,
    status: config.mode === "advisory" && observedStatus === "FAIL" ? "WARN" : observedStatus,
    files,
    summary: { checked: files.length, passed, warned, failed, skipped },
  };
}

function sequenceEditDistance(left: string[], right: string[], maximumDistance: number): number | null {
  const maximum = left.length + right.length;
  if (maximum === 0) return 0;
  const offset = maximum;
  const frontier = new Int32Array((2 * maximum) + 1);
  for (let distance = 0; distance <= Math.min(maximum, maximumDistance); distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal;
      let horizontal: number;
      if (diagonal === -distance || (diagonal !== distance && frontier[index - 1] < frontier[index + 1])) horizontal = frontier[index + 1];
      else horizontal = frontier[index - 1] + 1;
      let vertical = horizontal - diagonal;
      while (horizontal < left.length && vertical < right.length && left[horizontal] === right[vertical]) {
        horizontal += 1;
        vertical += 1;
      }
      frontier[index] = horizontal;
      if (horizontal >= left.length && vertical >= right.length) return distance;
    }
  }
  return null;
}

function tokenChangeRate(before: string, after: string, rejectionThreshold: number): number {
  const leftTokens = before.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const rightTokens = after.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const combinedTotal = leftTokens.length + rightTokens.length;
  if (combinedTotal === 0) return 0;
  const maximumDistance = Math.ceil(rejectionThreshold * combinedTotal);
  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();
  for (const token of leftTokens) leftCounts.set(token, (leftCounts.get(token) ?? 0) + 1);
  for (const token of rightTokens) rightCounts.set(token, (rightCounts.get(token) ?? 0) + 1);
  let common = 0;
  for (const [token, count] of rightCounts) common += Math.min(count, leftCounts.get(token) ?? 0);
  if (combinedTotal - (2 * common) >= maximumDistance) return rejectionThreshold;
  const distance = sequenceEditDistance(leftTokens, rightTokens, maximumDistance);
  return distance === null ? rejectionThreshold : Math.round((distance / combinedTotal) * 1_000_000) / 1_000_000;
}

function markdownLinkDestinations(text: string): string[] {
  const destinations: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("](", cursor);
    if (start < 0) break;
    let depth = 1;
    let escaped = false;
    let closed = false;
    for (let index = start + 2; index < text.length; index += 1) {
      const character = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          destinations.push(text.slice(start + 2, index));
          cursor = index + 1;
          closed = true;
          break;
        }
      }
    }
    if (!closed) cursor = start + 2;
  }
  for (const match of text.matchAll(/^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:<([^>\n]+)>|(\S+))/gm)) {
    destinations.push(match[1] ?? match[2] ?? "");
  }
  return destinations;
}

function standaloneUrls(text: string): string[] {
  const urls: string[] = [];
  const withoutAutolinks = text.replace(/<((?:[A-Za-z][A-Za-z0-9+.-]*:[^>\s]+)|(?:[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}))>/g, (_match, destination: string) => {
    urls.push(destination);
    return " ".repeat(destination.length + 2);
  });
  for (const match of withoutAutolinks.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    let value = match[0];
    const openings = (value.match(/\(/g) ?? []).length;
    let closings = (value.match(/\)/g) ?? []).length;
    while (value.endsWith(")") && closings > openings) {
      value = value.slice(0, -1);
      closings -= 1;
    }
    value = value.replace(/[.,]+$/, "");
    if (value.length > 0) urls.push(value);
  }
  return urls;
}

function protectedValues(text: string): Map<string, { category: string; count: number }> {
  const categories: Array<[string, RegExp]> = [
    ["number", /\b\d{4}-\d{2}-\d{2}\b|\bv\d+(?:\.\d+)+\b|(?<![\w.])[$€£¥₩]?[+-]?\d+(?:[.,]\d+)*(?:\s+(?:(?:kg|g|mg|lb|oz|km|m|cm|mm|mi|ft|in|ms|s|h|USD|EUR|GBP|JPY|KRW)\b|(?:개|명|건|회|원|년|월|일|시간|분|초|대|권|장|마리|곳|배|퍼센트))|(?:개|명|건|회|원|년|월|일|시간|분|초|대|권|장|마리|곳|배|퍼센트)|%|[A-Za-z]+\b|\b)/g],
    ["normative", /\b(?:MUST|SHOULD|MAY)(?:\s+NOT)?\b|(?:해서는\s+안\s+된다|해야\s+한다|할\s+수\s+있다)/gi],
  ];
  const values = new Map<string, { category: string; count: number }>();
  for (const [category, pattern] of categories) {
    for (const match of text.matchAll(pattern)) {
      const value = category === "normative" || category === "number" ? match[0].replace(/\s+/g, " ") : match[0];
      const key = `${category}\u0000${value}`;
      const current = values.get(key);
      values.set(key, { category, count: (current?.count ?? 0) + 1 });
    }
  }
  for (const quote of directQuotationSpans(text)) {
    const key = `quotation\u0000${quote}`;
    const current = values.get(key);
    values.set(key, { category: "quotation", count: (current?.count ?? 0) + 1 });
  }
  for (const url of standaloneUrls(text)) {
    const key = `url\u0000${url}`;
    const current = values.get(key);
    values.set(key, { category: "url", count: (current?.count ?? 0) + 1 });
  }
  for (const span of markdownInlineCodeSpans(text)) {
    const key = `inline-code\u0000${span}`;
    const current = values.get(key);
    values.set(key, { category: "inline-code", count: (current?.count ?? 0) + 1 });
  }
  for (const block of markdownIndentedCodeBlocks(text)) {
    const key = `code-block\u0000${block}`;
    const current = values.get(key);
    values.set(key, { category: "code-block", count: (current?.count ?? 0) + 1 });
  }
  for (const span of htmlCodeSpans(text)) {
    const key = `${span.category}\u0000${span.value}`;
    const current = values.get(key);
    values.set(key, { category: span.category, count: (current?.count ?? 0) + 1 });
  }
  for (const destination of markdownLinkDestinations(text)) {
    const key = `link-destination\u0000${destination}`;
    const current = values.get(key);
    values.set(key, { category: "link-destination", count: (current?.count ?? 0) + 1 });
  }
  for (const block of markdownFencedBlocks(text)) {
    const key = `code-block\u0000${block}`;
    const current = values.get(key);
    values.set(key, { category: "code-block", count: (current?.count ?? 0) + 1 });
  }
  for (const quote of markdownBlockquotes(text)) {
    const key = `quotation\u0000${quote}`;
    const current = values.get(key);
    values.set(key, { category: "quotation", count: (current?.count ?? 0) + 1 });
  }
  return values;
}

const CLAIM_LABELS = new Set([
  "minimum", "maximum", "min", "max", "lower", "upper", "before", "after", "previous", "next", "start", "end", "initial", "final",
  "increase", "decrease", "enabled", "disabled", "allowed", "forbidden", "required", "optional", "success", "failure",
  "최소", "최대", "하한", "상한", "이전", "이후", "시작", "종료", "초기", "최종", "증가", "감소", "활성", "비활성", "허용", "금지", "필수", "선택", "성공", "실패",
]);

function claimLabel(text: string, index: number, valueLength: number): string {
  const tokens = (value: string): string[] => value.match(/[\p{L}\p{N}_-]+/gu)?.map((token) => token.toLowerCase()) ?? [];
  const before = tokens(text.slice(Math.max(0, index - 96), index)).slice(-8).reverse().find((token) => CLAIM_LABELS.has(token));
  if (before) return before;
  return tokens(text.slice(index + valueLength, index + valueLength + 48)).slice(0, 3).find((token) => CLAIM_LABELS.has(token)) ?? "";
}

function protectedValueBindings(text: string, values: Map<string, { category: string; count: number }>): string[] {
  const normalizedText = text.replace(/\s+/g, " ");
  const occurrences: Array<{ index: number; binding: string }> = [];
  for (const [key, item] of values) {
    const separator = key.indexOf("\u0000");
    const value = key.slice(separator + 1).replace(/\s+/g, " ");
    let cursor = 0;
    for (let count = 0; count < item.count; count += 1) {
      const index = normalizedText.indexOf(value, cursor);
      if (index < 0) break;
      occurrences.push({ index, binding: `${key}\u0002${claimLabel(normalizedText, index, value.length)}` });
      cursor = index + Math.max(value.length, 1);
    }
  }
  occurrences.sort((left, right) => left.index - right.index || left.binding.localeCompare(right.binding));
  return occurrences.map((occurrence) => occurrence.binding);
}

export function verifyPreservation(before: string, after: string, maxChangeRate = 0.3, rejectChangeRate = 0.5): PreservationReport {
  const expected = protectedValues(before);
  const actual = protectedValues(after);
  const failures: PreservationFailure[] = [];
  let protectedTotal = 0;
  let protectedPreserved = 0;
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  for (const key of keys) {
    const expectedItem = expected.get(key);
    const actualItem = actual.get(key);
    const expectedCount = expectedItem?.count ?? 0;
    const actualCount = actualItem?.count ?? 0;
    protectedTotal += expectedCount;
    protectedPreserved += Math.min(expectedCount, actualCount);
    if (actualCount !== expectedCount) failures.push({ category: expectedItem?.category ?? actualItem?.category ?? "unknown", valueHash: hash(key), expectedCount, actualCount });
  }
  if (failures.length === 0) {
    const expectedBindings = protectedValueBindings(before, expected);
    const actualBindings = protectedValueBindings(after, actual);
    if (JSON.stringify(expectedBindings) !== JSON.stringify(actualBindings)) {
      failures.push({
        category: "protected-context",
        valueHash: hash(`${expectedBindings.join("\u0001")}\u0000${actualBindings.join("\u0001")}`),
        expectedCount: expectedBindings.length,
        actualCount: actualBindings.length,
      });
    }
  }
  const changeRate = tokenChangeRate(before, after, rejectChangeRate);
  const status = failures.length > 0 || changeRate >= rejectChangeRate ? "FAIL" : changeRate >= maxChangeRate ? "WARN" : "PASS";
  return { status, tokenChangeRate: changeRate, protectedTotal, protectedPreserved, failures };
}

interface Arguments {
  root: string;
  config?: string;
  format: "text" | "json";
  report?: string;
  before?: string;
  after?: string;
}

function requiredOptionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseArguments(argv: string[]): Arguments {
  const options: Arguments = { root: process.cwd(), format: "text" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") options.root = resolve(requiredOptionValue(argv, index++, argument));
    else if (argument === "--config") options.config = requiredOptionValue(argv, index++, argument);
    else if (argument === "--format") {
      const format = requiredOptionValue(argv, index++, argument);
      if (format !== "text" && format !== "json") throw new Error(`invalid format: ${format}`);
      options.format = format;
    } else if (argument === "--report") options.report = requiredOptionValue(argv, index++, argument);
    else if (argument === "--before") options.before = requiredOptionValue(argv, index++, argument);
    else if (argument === "--after") options.after = requiredOptionValue(argv, index++, argument);
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: bun scripts/audit-prose-quality.ts [--root DIR] [--config FILE] [--format text|json] [--report FILE] [--before FILE --after FILE]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  if ((options.before && !options.after) || (!options.before && options.after)) throw new Error("--before and --after must be supplied together");
  return options;
}

if (import.meta.main) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const config = loadConfig(options.root, options.config);
    let report: ProseQualityReport;
    if (options.before && options.after) {
      const preservation = verifyPreservation(readFileSync(resolve(options.root, options.before), "utf8"), readFileSync(resolve(options.root, options.after), "utf8"), config.maxChangeRate, config.rejectChangeRate);
      report = { schemaVersion: "prose-quality-report/v1", mode: config.mode, status: preservation.status, files: [], summary: { checked: 0, passed: 0, warned: 0, failed: preservation.status === "FAIL" ? 1 : 0, skipped: 0 }, preservation };
    } else report = scanRepository(options.root, config);
    const serialized = JSON.stringify(report, null, 2);
    if (options.report) writeFileSync(resolve(options.root, options.report), `${serialized}\n`);
    if (options.format === "json") console.log(serialized);
    else console.log(`Prose quality: ${report.status}; ${report.summary.checked} checked, ${report.summary.passed} passed, ${report.summary.warned} warned, ${report.summary.failed} failed, ${report.summary.skipped} skipped.`);
    process.exitCode = report.status === "FAIL" ? 1 : report.status === "BLOCKED" ? 2 : 0;
  } catch (error) {
    console.error(`prose-quality scanner: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
