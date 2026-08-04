import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

export interface Rule {
  id: string;
  description: string;
  score: number;
  pattern: RegExp;
}

export interface Finding {
  ruleId: string;
  path: string;
  line: number;
  score: number;
  level: RiskLevel;
  description: string;
  excerpt: string;
  lineHash: string;
  suppressed: boolean;
}

interface ExceptionEntry {
  ruleId: string;
  path: string;
  lineHash: string;
  owner: string;
  reason: string;
  mitigation: string;
  expiresAt: string;
}

interface ExceptionFile {
  schemaVersion: "traceknot.prompt-risk-exceptions/v1";
  exceptions: ExceptionEntry[];
}

export const RULES: readonly Rule[] = [
  {
    id: "PI001",
    description: "instruction hierarchy override",
    score: 5,
    pattern: /\b(?:ignore|disregard|forget|override|bypass)\b.{0,48}\b(?:previous|prior|system|developer|safety|instruction|rule|policy|guardrail)s?\b/i,
  },
  {
    id: "PI002",
    description: "privileged role or message impersonation",
    score: 6,
    pattern: /(?:<\/?(?:system|developer|assistant)(?:[-_ ]?(?:message|directive))?\b|\[(?:system|developer|assistant)\]|\byou are now (?:the |an? )?(?:system|developer|administrator|root)\b)/i,
  },
  {
    id: "PI003",
    description: "credential or hidden-context exfiltration request",
    score: 7,
    pattern: /\b(?:reveal|print|dump|display|exfiltrat\w*|send|upload|post)\b.{0,64}\b(?:secret|token|credential|private key|api key|system prompt|developer message|environment variable|\.env)\b/i,
  },
  {
    id: "PI004",
    description: "safety control suppression",
    score: 6,
    pattern: /\b(?:disable|remove|evade|bypass|turn off)\b.{0,48}\b(?:safety|security|validation|verification|scanner|filter|sandbox|permission|approval|audit|logging)\b/i,
  },
  {
    id: "PI005",
    description: "download or decode followed by execution",
    score: 4,
    pattern: /(?:\bcurl\b|\bwget\b|\bfetch\b|base64\s+(?:--decode|-d)|\beval\b).{0,96}(?:\|\s*(?:sh|bash|zsh)\b|\bexec(?:ute)?\b|\beval\b)/i,
  },
  {
    id: "PI006",
    description: "encoded payload execution instruction",
    score: 6,
    pattern: /\b(?:base64|hex|rot13|unicode)\b.{0,48}\b(?:decode|payload)\b.{0,48}\b(?:execute|eval|run|shell)\b/i,
  },
  {
    id: "PI007",
    description: "external instructions treated as authoritative",
    score: 5,
    pattern: /\b(?:download|fetch|read|load)\b.{0,64}\b(?:instruction|prompt|policy|system message)s?\b.{0,64}\b(?:obey|follow|execute|authoritative|priority)\b/i,
  },
  {
    id: "PI008",
    description: "hidden bidirectional or control character",
    score: 10,
    pattern: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/,
  },
  {
    id: "PI009",
    description: "Simplified Chinese instruction hierarchy override",
    score: 5,
    pattern: /(?:忽略|无视|覆盖|绕过).{0,24}(?:之前|先前|系统|开发者|安全|指令|规则|策略|防护)/,
  },
  {
    id: "PI010",
    description: "Simplified Chinese credential or hidden-context exfiltration request",
    score: 7,
    pattern: /(?:(?:显示|打印|泄露|发送|上传|导出).{0,32}(?:秘密|令牌|凭据|私钥|API\s*密钥|系统提示|开发者消息|环境变量|\.env)|(?:把|将)(?:秘密|令牌|凭据|私钥|API\s*密钥|系统提示|开发者消息|环境变量|\.env).{0,32}(?:显示|打印|泄露|发送|上传|导出))/i,
  },
  {
    id: "PI011",
    description: "Simplified Chinese safety control suppression",
    score: 6,
    pattern: /(?:禁用|关闭|移除|绕过|规避).{0,24}(?:安全|验证|校验|扫描器|过滤器|沙箱|权限|审批|审计|日志)/,
  },
  {
    id: "PI012",
    description: "Simplified Chinese privileged role or message impersonation",
    score: 6,
    pattern: /(?:(?:你|您)(?:现在|从现在起|将)是(?:一(?:名|个|位))?(?:系统(?:管理员|开发者)?|开发者|管理员|超级用户|root)|(?:假装|扮演|伪装|冒充)(?:成|为)?(?:系统(?:管理员|开发者|身份|消息|指令|角色)|开发者|管理员|超级用户|root)|以(?:系统|开发者|管理员|超级用户|root)(?:的)?身份)/i,
  },
];

const LEVEL_RANK: Record<RiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const DEFAULT_TARGETS = [
  "README.md",
  "README.ko.md",
  "README.zh.md",
  "BRAND.md",
  "BRAND.ko.md",
  "assets/readme",
  "docs",
  "skill",
  "contracts",
  "adapters",
  ".github",
];

const TEXT_EXTENSIONS = new Set([".md", ".json", ".txt", ".yaml", ".yml"]);

export function levelForScore(score: number): RiskLevel {
  if (score >= 10) return "critical";
  if (score >= 6) return "high";
  if (score >= 3) return "medium";
  if (score > 0) return "low";
  return "none";
}

function hashLine(line: string): string {
  return createHash("sha256").update(line.trim()).digest("hex");
}

export function analyzeText(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(line)) continue;
      findings.push({
        ruleId: rule.id,
        path,
        line: index + 1,
        score: rule.score,
        level: levelForScore(rule.score),
        description: rule.description,
        excerpt: line.trim().slice(0, 200),
        lineHash: hashLine(line),
        suppressed: false,
      });
    }
  });
  return findings;
}

function collectFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(resolve(path, entry));
      return;
    }
    const dot = path.lastIndexOf(".");
    const extension = dot >= 0 ? path.slice(dot).toLowerCase() : "";
    if (TEXT_EXTENSIONS.has(extension)) files.push(path);
  };
  for (const target of DEFAULT_TARGETS) visit(resolve(root, target));
  return files;
}

function loadExceptions(root: string): ExceptionEntry[] {
  const path = resolve(root, "security/prompt-injection-exceptions.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ExceptionFile;
  if (parsed.schemaVersion !== "traceknot.prompt-risk-exceptions/v1" || !Array.isArray(parsed.exceptions)) {
    throw new Error(`invalid prompt-risk exception file: ${path}`);
  }
  const now = Date.now();
  for (const entry of parsed.exceptions) {
    if (!entry.ruleId || !entry.path || !entry.lineHash || !entry.owner || !entry.reason || !entry.mitigation || !entry.expiresAt) {
      throw new Error(`incomplete prompt-risk exception for ${entry.ruleId || "unknown rule"}`);
    }
    const expires = Date.parse(entry.expiresAt);
    if (!Number.isFinite(expires)) throw new Error(`invalid exception expiry: ${entry.expiresAt}`);
    if (expires <= now) throw new Error(`expired prompt-risk exception: ${entry.ruleId} ${entry.path}`);
  }
  return parsed.exceptions;
}

function applyExceptions(findings: Finding[], exceptions: ExceptionEntry[]): void {
  for (const finding of findings) {
    finding.suppressed = exceptions.some(
      (entry) => entry.ruleId === finding.ruleId && entry.path === finding.path && entry.lineHash === finding.lineHash,
    );
  }
}

function parseArguments(argv: string[]): { root: string; threshold: RiskLevel; format: "text" | "json" } {
  let root = process.cwd();
  let threshold: RiskLevel = "high";
  let format: "text" | "json" = "text";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") root = resolve(argv[++index] ?? "");
    else if (argument === "--threshold") {
      const value = argv[++index] as RiskLevel | undefined;
      if (!value || !(value in LEVEL_RANK)) throw new Error(`invalid threshold: ${value ?? ""}`);
      threshold = value;
    } else if (argument === "--format") {
      const value = argv[++index];
      if (value !== "text" && value !== "json") throw new Error(`invalid format: ${value ?? ""}`);
      format = value;
    } else if (argument === "--help" || argument === "-h") {
      console.log("Usage: bun scripts/audit-prompt-injection.ts [--root DIR] [--threshold LEVEL] [--format text|json]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return { root, threshold, format };
}

export function scanRepository(root: string): Finding[] {
  const findings = collectFiles(root).flatMap((file) =>
    analyzeText(relative(root, file).replaceAll("\\", "/"), readFileSync(file, "utf8")),
  );
  applyExceptions(findings, loadExceptions(root));
  return findings;
}

if (import.meta.main) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const findings = scanRepository(options.root);
    const active = findings.filter((finding) => !finding.suppressed);
    const blocking = active.filter((finding) => LEVEL_RANK[finding.level] >= LEVEL_RANK[options.threshold]);
    if (options.format === "json") {
      console.log(JSON.stringify({ threshold: options.threshold, findings, blockingCount: blocking.length }, null, 2));
    } else {
      for (const finding of active) {
        console.log(`${finding.level.toUpperCase()} ${finding.ruleId} ${finding.path}:${finding.line} +${finding.score} ${finding.description}`);
        console.log(`  ${finding.excerpt}`);
        console.log(`  fingerprint: ${finding.lineHash}`);
      }
      const suppressed = findings.length - active.length;
      console.log(`Prompt-injection risk: ${active.length} active, ${suppressed} suppressed, ${blocking.length} blocking at ${options.threshold}.`);
    }
    process.exitCode = blocking.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`prompt-risk scanner: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
