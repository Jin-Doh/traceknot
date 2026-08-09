import { describe, expect, test } from "bun:test";
import {
  evaluateSarif,
  parsePolicy,
  resultFingerprint,
  type CodeqlPolicy,
  type SarifLog,
} from "../scripts/check-codeql-sarif";

const policy: CodeqlPolicy = {
  schemaVersion: "traceknot-codeql-policy/v1",
  failAtOrAbove: 7,
  maxUnexceptedAlerts: 0,
  exceptions: [],
};

function sarif(severity: number, fingerprint: string, ruleId = "js/test-rule", component: "driver" | "extension" = "driver"): SarifLog {
  const rule = { id: ruleId, properties: { "security-severity": String(severity) } };
  return {
    runs: [{
      tool: component === "driver" ? { driver: { rules: [rule] } } : { driver: {}, extensions: [{ rules: [rule] }] },
      results: [{
        ruleId,
        partialFingerprints: { primaryLocationLineHash: fingerprint },
        locations: [{ physicalLocation: { artifactLocation: { uri: "scripts/example.ts" }, region: { startLine: 12 } } }],
        message: { text: "representative CodeQL finding" },
      }],
    }],
  };
}

describe("CodeQL SARIF security floor", () => {
  test("passes when security findings remain below the blocking threshold", () => {
    const report = evaluateSarif([sarif(6.9, "medium-fingerprint")], policy);
    expect(report.status).toBe("PASS");
    expect(report.securityAlerts).toBe(1);
    expect(report.blockingAlerts).toBe(0);
  });

  test("fails on an unexcepted high-severity finding", () => {
    const report = evaluateSarif([sarif(7, "high-fingerprint")], policy);
    expect(report.status).toBe("FAIL");
    expect(report.violations).toEqual([expect.objectContaining({
      ruleId: "js/test-rule",
      securitySeverity: 7,
      fingerprint: "high-fingerprint",
      location: "scripts/example.ts:12",
    })]);
  });

  test("fails on high-severity metadata stored in a CodeQL tool extension", () => {
    const report = evaluateSarif([sarif(7.7, "extension-fingerprint", "js/file-system-race", "extension")], policy);
    expect(report.status).toBe("FAIL");
    expect(report.securityAlerts).toBe(1);
    expect(report.violations).toEqual([expect.objectContaining({
      ruleId: "js/file-system-race",
      securitySeverity: 7.7,
      fingerprint: "extension-fingerprint",
    })]);
  });

  test("accepts a matching, unexpired governed exception", () => {
    const report = evaluateSarif([sarif(9.1, "accepted-fingerprint")], {
      ...policy,
      exceptions: [{
        ruleId: "js/test-rule",
        fingerprint: "accepted-fingerprint",
        owner: "security-maintainers",
        reason: "Upstream remediation is not yet available",
        mitigation: "Affected input path is disabled",
        expiresOn: "2026-09-01",
      }],
    }, new Date("2026-08-03T00:00:00Z"));
    expect(report.status).toBe("PASS");
    expect(report.exceptedAlerts).toBe(1);
    expect(report.violations).toHaveLength(0);
  });

  test("fails closed when an exception expires", () => {
    const report = evaluateSarif([sarif(9.1, "expired-fingerprint")], {
      ...policy,
      exceptions: [{
        ruleId: "js/test-rule",
        fingerprint: "expired-fingerprint",
        owner: "security-maintainers",
        reason: "Temporary compatibility constraint",
        mitigation: "Input is restricted to trusted maintainers",
        expiresOn: "2026-08-02",
      }],
    }, new Date("2026-08-03T00:00:00Z"));
    expect(report.status).toBe("FAIL");
    expect(report.policyErrors).toContain("exception js/test-rule expired on 2026-08-02");
  });

  test("rejects calendar-invalid exception dates", () => {
    const report = evaluateSarif([sarif(9.1, "invalid-date-fingerprint")], {
      ...policy,
      exceptions: [{
        ruleId: "js/test-rule",
        fingerprint: "invalid-date-fingerprint",
        owner: "security-maintainers",
        reason: "Temporary compatibility constraint",
        mitigation: "Input is restricted to trusted maintainers",
        expiresOn: "2026-02-30",
      }],
    }, new Date("2026-02-01T00:00:00Z"));
    expect(report.status).toBe("FAIL");
    expect(report.policyErrors).toContain("exception js/test-rule has invalid expiresOn 2026-02-30");
  });

  test("blocks when no SARIF evidence is supplied", () => {
    expect(evaluateSarif([], policy).status).toBe("BLOCKED");
  });

  test("rejects incomplete exception governance", () => {
    expect(() => parsePolicy({
      ...policy,
      exceptions: [{ ruleId: "js/test-rule", fingerprint: "fingerprint" }],
    })).toThrow("owner must be a non-empty string");
  });

  test("derives a deterministic fallback fingerprint", () => {
    expect(resultFingerprint({
      ruleId: "js/fallback",
      locations: [{ physicalLocation: { artifactLocation: { uri: "src/file.ts" }, region: { startLine: 7 } } }],
    })).toBe("js/fallback:src/file.ts:7");
  });
});
