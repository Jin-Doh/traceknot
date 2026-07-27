import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

export function extractProse(markdown: string): string {
  let prose = markdown.replace(/^---\n[\s\S]*?\n---\n/, maskContentPreservingLines);
  prose = prose.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, maskContentPreservingLines);
  prose = prose.replace(/(?:^(?: {4}|\t).*(?:\n|$))+/gm, maskContentPreservingLines);
  prose = prose.replace(/^>.*$/gm, maskContentPreservingLines);
  prose = prose.replace(/“[^”]+”|"[^"]+"/g, maskContentPreservingLines);
  prose = prose.replace(/`[^`\n]+`/g, "");
  prose = prose.replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1");
  prose = prose.replace(/<https?:\/\/[^>]+>|https?:\/\/\S+/g, "");
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
      const stat = statSync(path);
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
  const observedStatus: GateStatus = failed > 0 ? "FAIL" : warned > 0 ? "WARN" : "PASS";
  return {
    schemaVersion: "prose-quality-report/v1",
    mode: config.mode,
    status: config.mode === "advisory" && observedStatus === "FAIL" ? "WARN" : observedStatus,
    files,
    summary: { checked: files.length, passed, warned, failed, skipped },
  };
}

function tokenCounts(text: string): Map<string, number> {
  const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function tokenChangeRate(before: string, after: string): number {
  const left = tokenCounts(before);
  const right = tokenCounts(after);
  let common = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  for (const count of left.values()) leftTotal += count;
  for (const [token, count] of right) {
    rightTotal += count;
    common += Math.min(count, left.get(token) ?? 0);
  }
  const combinedTotal = leftTotal + rightTotal;
  return combinedTotal === 0 ? 0 : Math.round((1 - (2 * common) / combinedTotal) * 1_000_000) / 1_000_000;
}

function protectedValues(text: string): Map<string, { category: string; count: number }> {
  const categories: Array<[string, RegExp]> = [
    ["code-block", /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$|(?:^(?: {4}|\t).*(?:\n|$))+/gm],
    ["inline-code", /`[^`\n]+`/g],
    ["link-destination", /\]\(([^)]+)\)/g],
    ["url", /https?:\/\/[^\s)>]+/g],
    ["number", /\b\d+(?:[.,]\d+)*(?:%|[A-Za-z]+)?\b/g],
    ["normative", /\b(?:MUST|SHOULD|MAY|must|should|may)\b|(?:해서는 안 된다|해야 한다|할 수 있다)/g],
    ["quotation", /^>.*(?:\n>.*)*/gm],
    ["quotation", /“[^”]+”|"[^"]+"/g],
  ];
  const values = new Map<string, { category: string; count: number }>();
  for (const [category, pattern] of categories) {
    for (const match of text.matchAll(pattern)) {
      const value = category === "link-destination" ? match[1] ?? match[0] : match[0];
      const key = `${category}\u0000${value}`;
      const current = values.get(key);
      values.set(key, { category, count: (current?.count ?? 0) + 1 });
    }
  }
  return values;
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
  const changeRate = tokenChangeRate(before, after);
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

function parseArguments(argv: string[]): Arguments {
  const options: Arguments = { root: process.cwd(), format: "text" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") options.root = resolve(argv[++index] ?? "");
    else if (argument === "--config") options.config = argv[++index];
    else if (argument === "--format") {
      const format = argv[++index];
      if (format !== "text" && format !== "json") throw new Error(`invalid format: ${format ?? ""}`);
      options.format = format;
    } else if (argument === "--report") options.report = argv[++index];
    else if (argument === "--before") options.before = argv[++index];
    else if (argument === "--after") options.after = argv[++index];
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
