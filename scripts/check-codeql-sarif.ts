import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isCanonicalUtcDate } from "../system/core/canonical-time";

export interface CodeqlException {
  ruleId: string;
  fingerprint: string;
  owner: string;
  reason: string;
  mitigation: string;
  expiresOn: string;
}

export interface CodeqlPolicy {
  schemaVersion: "traceknot-codeql-policy/v1";
  failAtOrAbove: number;
  maxUnexceptedAlerts: number;
  exceptions: CodeqlException[];
}

interface SarifRule {
  id?: string;
  properties?: Record<string, unknown>;
}

interface SarifResult {
  ruleId?: string;
  properties?: Record<string, unknown>;
  partialFingerprints?: Record<string, string>;
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: { startLine?: number };
    };
  }>;
  message?: { text?: string };
}

export interface SarifLog {
  runs?: Array<{
    tool?: {
      driver?: { rules?: SarifRule[] };
      extensions?: Array<{ rules?: SarifRule[] }>;
    };
    results?: SarifResult[];
  }>;
}

export interface CodeqlViolation {
  ruleId: string;
  securitySeverity: number;
  fingerprint: string;
  location: string;
  message: string;
}

export interface CodeqlGateReport {
  status: "PASS" | "FAIL" | "BLOCKED";
  scannedResults: number;
  securityAlerts: number;
  blockingAlerts: number;
  exceptedAlerts: number;
  violations: CodeqlViolation[];
  policyErrors: string[];
}


function requireString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${context}.${key} must be a non-empty string`);
  return value;
}

export function parsePolicy(value: unknown): CodeqlPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("policy must be an object");
  const policyRecord = value as Record<string, unknown>;
  if (policyRecord.schemaVersion !== "traceknot-codeql-policy/v1") throw new Error("unsupported policy schemaVersion");
  if (typeof policyRecord.failAtOrAbove !== "number" || !Number.isFinite(policyRecord.failAtOrAbove) || policyRecord.failAtOrAbove < 0 || policyRecord.failAtOrAbove > 10) {
    throw new Error("policy.failAtOrAbove must be a number from 0 through 10");
  }
  if (!Number.isInteger(policyRecord.maxUnexceptedAlerts) || (policyRecord.maxUnexceptedAlerts as number) < 0) {
    throw new Error("policy.maxUnexceptedAlerts must be a non-negative integer");
  }
  if (!Array.isArray(policyRecord.exceptions)) throw new Error("policy.exceptions must be an array");
  const exceptions = policyRecord.exceptions.map((entry, index): CodeqlException => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`policy.exceptions[${index}] must be an object`);
    const record = entry as Record<string, unknown>;
    return {
      ruleId: requireString(record, "ruleId", `policy.exceptions[${index}]`),
      fingerprint: requireString(record, "fingerprint", `policy.exceptions[${index}]`),
      owner: requireString(record, "owner", `policy.exceptions[${index}]`),
      reason: requireString(record, "reason", `policy.exceptions[${index}]`),
      mitigation: requireString(record, "mitigation", `policy.exceptions[${index}]`),
      expiresOn: requireString(record, "expiresOn", `policy.exceptions[${index}]`),
    };
  });
  return {
    schemaVersion: policyRecord.schemaVersion,
    failAtOrAbove: policyRecord.failAtOrAbove,
    maxUnexceptedAlerts: policyRecord.maxUnexceptedAlerts as number,
    exceptions,
  };
}

function securitySeverity(result: SarifResult, rule?: SarifRule): number | null {
  const raw = result.properties?.["security-severity"] ?? rule?.properties?.["security-severity"];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10 ? parsed : null;
}

export function resultFingerprint(result: SarifResult): string {
  const partials = result.partialFingerprints ?? {};
  for (const key of ["primaryLocationLineHash", "primaryLocationStartColumnFingerprint", "primaryLocationLineHash/v1"]) {
    const value = partials[key];
    if (value) return value;
  }
  const first = Object.entries(partials).sort(([left], [right]) => left.localeCompare(right))[0]?.[1];
  if (first) return first;
  const location = result.locations?.[0]?.physicalLocation;
  return `${result.ruleId ?? "unknown"}:${location?.artifactLocation?.uri ?? "unknown"}:${location?.region?.startLine ?? 0}`;
}

function exceptionErrors(policy: CodeqlPolicy, now: Date): string[] {
  const errors: string[] = [];
  const identities = new Set<string>();
  for (const exception of policy.exceptions) {
    const identity = `${exception.ruleId}\u0000${exception.fingerprint}`;
    if (identities.has(identity)) errors.push(`duplicate exception for ${exception.ruleId} ${exception.fingerprint}`);
    identities.add(identity);
    if (!isCanonicalUtcDate(exception.expiresOn)) {
      errors.push(`exception ${exception.ruleId} has invalid expiresOn ${exception.expiresOn}`);
      continue;
    }
    const expiresAt = Date.parse(`${exception.expiresOn}T23:59:59.999Z`);
    if (expiresAt < now.getTime()) errors.push(`exception ${exception.ruleId} expired on ${exception.expiresOn}`);
  }
  return errors;
}

function violationFrom(result: SarifResult, severity: number): CodeqlViolation {
  const physical = result.locations?.[0]?.physicalLocation;
  const uri = physical?.artifactLocation?.uri ?? "unknown";
  const line = physical?.region?.startLine ?? 0;
  return {
    ruleId: result.ruleId ?? "unknown",
    securitySeverity: severity,
    fingerprint: resultFingerprint(result),
    location: `${uri}:${line}`,
    message: result.message?.text ?? "CodeQL security alert",
  };
}

export function evaluateSarif(logs: SarifLog[], policy: CodeqlPolicy, now = new Date()): CodeqlGateReport {
  if (logs.length === 0) {
    return { status: "BLOCKED", scannedResults: 0, securityAlerts: 0, blockingAlerts: 0, exceptedAlerts: 0, violations: [], policyErrors: ["no SARIF logs were provided"] };
  }
  const policyErrors = exceptionErrors(policy, now);
  const exceptions = new Set(policy.exceptions.map((entry) => `${entry.ruleId}\u0000${entry.fingerprint}`));
  let scannedResults = 0;
  let securityAlerts = 0;
  let blockingAlerts = 0;
  let exceptedAlerts = 0;
  const violations: CodeqlViolation[] = [];
  for (const log of logs) {
    for (const run of log.runs ?? []) {
      const rules = new Map<string, SarifRule>();
      for (const rule of run.tool?.driver?.rules ?? []) {
        if (rule.id) rules.set(rule.id, rule);
      }
      for (const extension of run.tool?.extensions ?? []) {
        for (const rule of extension.rules ?? []) {
          if (rule.id) rules.set(rule.id, rule);
        }
      }
      for (const result of run.results ?? []) {
        scannedResults += 1;
        const severity = securitySeverity(result, result.ruleId ? rules.get(result.ruleId) : undefined);
        if (severity === null) continue;
        securityAlerts += 1;
        if (severity < policy.failAtOrAbove) continue;
        blockingAlerts += 1;
        const violation = violationFrom(result, severity);
        if (exceptions.has(`${violation.ruleId}\u0000${violation.fingerprint}`)) exceptedAlerts += 1;
        else violations.push(violation);
      }
    }
  }
  const status = policyErrors.length > 0 || violations.length > policy.maxUnexceptedAlerts ? "FAIL" : "PASS";
  return { status, scannedResults, securityAlerts, blockingAlerts, exceptedAlerts, violations, policyErrors };
}

function collectSarifFiles(path: string): string[] {
  const absolute = resolve(path);
  const stat = statSync(absolute);
  if (stat.isFile()) return absolute.endsWith(".sarif") ? [absolute] : [];
  if (!stat.isDirectory()) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(absolute, entry.name);
    return entry.isDirectory() ? collectSarifFiles(child) : entry.isFile() && entry.name.endsWith(".sarif") ? [child] : [];
  });
}

export function formatReport(report: CodeqlGateReport): string {
  const lines = [
    `CodeQL security floor: ${report.status}; ${report.scannedResults} results, ${report.securityAlerts} security alerts, ${report.blockingAlerts} at the blocking threshold, ${report.exceptedAlerts} excepted, ${report.violations.length} unexcepted.`,
  ];
  for (const error of report.policyErrors) lines.push(`policy error: ${error}`);
  for (const violation of report.violations) {
    lines.push(`${violation.location} ${violation.ruleId} security-severity=${violation.securitySeverity} fingerprint=${violation.fingerprint} ${violation.message}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] !== "--policy" || !argv[1] || argv.length < 3) throw new Error("usage: bun scripts/check-codeql-sarif.ts --policy POLICY.json SARIF_PATH...");
    const policy = parsePolicy(JSON.parse(readFileSync(resolve(argv[1]), "utf8")) as unknown);
    const files = argv.slice(2).flatMap(collectSarifFiles);
    const logs = files.map((file) => JSON.parse(readFileSync(file, "utf8")) as SarifLog);
    const report = evaluateSarif(logs, policy);
    console.log(formatReport(report));
    process.exitCode = report.status === "PASS" ? 0 : report.status === "FAIL" ? 1 : 2;
  } catch (error) {
    console.error(`CodeQL security floor: BLOCKED; ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
