import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { canonicalRequestDigest, type VerificationRequest } from "../system/runtime/verification-run";
import { isCanonicalUtcDate, isCanonicalUtcTimestamp } from "../system/core/canonical-time";
type ContractCase = {
  name: string;
  schema: string;
  positive: string;
  negatives: readonly string[];
};

describe("canonical UTC time validation", () => {
  test("rejects normalized calendar overflow and noncanonical timestamps", () => {
    for (const value of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-01-00"]) {
      expect(isCanonicalUtcDate(value)).toBe(false);
    }
    for (const value of ["2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:60Z", "2026-01-01T00:00:00+00:00"]) {
      expect(isCanonicalUtcTimestamp(value)).toBe(false);
    }
  });

  test("accepts real leap days and canonical fractional UTC timestamps", () => {
    expect(isCanonicalUtcDate("2024-02-29")).toBe(true);
    expect(isCanonicalUtcTimestamp("2024-02-29T23:59:59.123456Z")).toBe(true);
  });
});

const contractCases: readonly ContractCase[] = [
  {
    name: "Observation",
    schema: "observation.schema.json",
    positive: "canonical-observation.valid.json",
    negatives: [
      "canonical-observation.invalid-verdict.json",
      "canonical-observation.invalid-digest.json",
      "canonical-observation.invalid-self-external-approval.json",
      "canonical-observation.invalid-actual-values.json",
      "canonical-observation.invalid-duplicate-actual-values.json",
    ],
  },
  {
    name: "Verification evidence",
    schema: "evidence.schema.json",
    positive: "canonical-evidence.valid-runtime.json",
    negatives: [
      "canonical-evidence.invalid-legacy-host.json",
      "canonical-evidence.invalid-missing-timestamp.json",
    ],
  },
  {
    name: "Structured observation",
    schema: "observation.schema.json",
    positive: "canonical-observation.valid-structured.json",
    negatives: [],
  },
  {
    name: "SuccessCriterion",
    schema: "success-criterion.schema.json",
    positive: "canonical-success-criterion.valid.json",
    negatives: [],
  },
  {
    name: "TraceabilityLink",
    schema: "traceability-link.schema.json",
    positive: "canonical-traceability-link.valid.json",
    negatives: [
      "canonical-traceability-link.invalid-empty-basis.json",
      "canonical-traceability-link.invalid-empty-condition.json",
    ],
  },
  {
    name: "EvidenceClaim",
    schema: "evidence-claim.schema.json",
    positive: "canonical-evidence-claim.valid.json",
    negatives: ["canonical-evidence-claim.invalid-no-observations.json"],
  },
  {
    name: "EvidenceEvaluation",
    schema: "evidence-evaluation.schema.json",
    positive: "canonical-evidence-evaluation.valid.json",
    negatives: [
      "canonical-evidence-evaluation.invalid-accepted-failed-check.json",
      "canonical-evidence-evaluation.invalid-accepted-reason.json",
      "canonical-evidence-evaluation.invalid-accepted-violated-check.json",
      "canonical-evidence-evaluation.invalid-rejected-no-reason.json",
    ],
  },
  {
    name: "EvidenceEvaluationDocument",
    schema: "evidence-evaluation-document.schema.json",
    positive: "canonical-evidence-evaluation-document.valid.json",
    negatives: [],
  },
  {
    name: "Rejected EvidenceEvaluation",
    schema: "evidence-evaluation.schema.json",
    positive: "canonical-evidence-evaluation.valid-rejected-stale.json",
    negatives: [],
  },
  {
    name: "VerificationRun",
    schema: "verification-run.schema.json",
    positive: "canonical-verification-run.valid.json",
    negatives: ["canonical-verification-run.invalid-state.json", "canonical-verification-run.invalid-missing-root-identity.json", "canonical-verification-run.invalid-additional-property.json"],
  },
];

const contractRoot = resolve(import.meta.dir, "../contracts");
const fixtureRoot = join(contractRoot, "fixtures");

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function loadValidator(schemaFile: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  if (schemaFile === "evidence-evaluation-document.schema.json") ajv.addSchema(loadJson(join(contractRoot, "evidence-evaluation.schema.json")) as object);
  return ajv.compile(loadJson(join(contractRoot, schemaFile)) as object);
}

type EvaluationCheckName =
  | "snapshotBound"
  | "fresh"
  | "scopeComplete"
  | "producerAllowed"
  | "independenceSatisfied"
  | "expectedResultDemonstrated"
  | "expectedResultViolated"
  | "integrityVerified"
  | "artifactRequirementsSatisfied";

type ReasonCheckCase = {
  name: string;
  checks: Partial<Record<EvaluationCheckName, boolean>>;
  rejectionReasons: readonly string[];
  valid: boolean;
};

const reasonCheckCases: readonly ReasonCheckCase[] = [
  {
    name: "SNAPSHOT_MISMATCH with snapshotBound false",
    checks: { snapshotBound: false },
    rejectionReasons: ["SNAPSHOT_MISMATCH"],
    valid: true,
  },
  {
    name: "STALE_EVIDENCE with fresh false",
    checks: { fresh: false },
    rejectionReasons: ["STALE_EVIDENCE"],
    valid: true,
  },
  {
    name: "MISSING_ARTIFACT with artifact requirements unsatisfied",
    checks: { artifactRequirementsSatisfied: false },
    rejectionReasons: ["MISSING_ARTIFACT"],
    valid: true,
  },
  {
    name: "INSUFFICIENT_SCOPE with scope incomplete",
    checks: { scopeComplete: false },
    rejectionReasons: ["INSUFFICIENT_SCOPE"],
    valid: true,
  },
  {
    name: "UNTRUSTED_PRODUCER with producer disallowed",
    checks: { producerAllowed: false },
    rejectionReasons: ["UNTRUSTED_PRODUCER"],
    valid: true,
  },
  {
    name: "INDEPENDENCE_NOT_MET with independence unsatisfied",
    checks: { independenceSatisfied: false },
    rejectionReasons: ["INDEPENDENCE_NOT_MET"],
    valid: true,
  },
  {
    name: "EXPECTED_RESULT_NOT_DEMONSTRATED with demonstration false",
    checks: { expectedResultDemonstrated: false },
    rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    valid: true,
  },
  {
    name: "EXPECTED_RESULT_NOT_DEMONSTRATED with violation true",
    checks: { expectedResultViolated: true },
    rejectionReasons: ["EXPECTED_RESULT_NOT_DEMONSTRATED"],
    valid: true,
  },
  {
    name: "INTEGRITY_FAILURE with integrity unverified",
    checks: { integrityVerified: false },
    rejectionReasons: ["INTEGRITY_FAILURE"],
    valid: true,
  },
  {
    name: "all checks true with stale reason",
    checks: {},
    rejectionReasons: ["STALE_EVIDENCE"],
    valid: false,
  },
  {
    name: "fresh false with missing stale reason",
    checks: { fresh: false },
    rejectionReasons: [],
    valid: false,
  },
  {
    name: "snapshot failure with extraneous stale reason",
    checks: { snapshotBound: false },
    rejectionReasons: ["STALE_EVIDENCE"],
    valid: false,
  },
  {
    name: "expected violation with missing expected-result reason",
    checks: { expectedResultViolated: true },
    rejectionReasons: [],
    valid: false,
  },
  {
    name: "artifact failure with missing artifact reason",
    checks: { artifactRequirementsSatisfied: false },
    rejectionReasons: [],
    valid: false,
  },
];

function makeEvaluationFixture(reasonCheckCase: ReasonCheckCase): Record<string, unknown> {
  const base = loadJson(join(fixtureRoot, "canonical-evidence-evaluation.valid.json")) as Record<string, unknown>;
  return {
    ...base,
    status: "REJECTED",
    checks: {
      ...(base.checks as Record<string, boolean>),
      ...reasonCheckCase.checks,
    },
    rejectionReasons: reasonCheckCase.rejectionReasons,
  };
}

describe("canonical evidence contracts", () => {
  for (const contract of contractCases) {
    test(`accepts a valid ${contract.name} fixture`, () => {
      const validate = loadValidator(contract.schema);
      const fixture = loadJson(join(fixtureRoot, contract.positive));

      expect(validate(fixture), validate.errors ? JSON.stringify(validate.errors) : undefined).toBe(true);
    });

    for (const negative of contract.negatives) {
      test(`rejects ${negative}`, () => {
        const validate = loadValidator(contract.schema);
        const fixture = loadJson(join(fixtureRoot, negative));

        expect(validate(fixture)).toBe(false);
        expect(validate.errors?.length).toBeGreaterThan(0);
      });
    }
  }
  for (const reasonCheckCase of reasonCheckCases) {
    test(`${reasonCheckCase.valid ? "accepts" : "rejects"} ${reasonCheckCase.name}`, () => {
      const validate = loadValidator("evidence-evaluation.schema.json");
      const fixture = makeEvaluationFixture(reasonCheckCase);

      expect(validate(fixture), validate.errors ? JSON.stringify(validate.errors) : undefined).toBe(reasonCheckCase.valid);
    });
  }
  test("rejects legacy array-shaped actualValues", () => {
    const validate = loadValidator("observation.schema.json");
    const fixture = loadJson(join(fixtureRoot, "canonical-observation.valid-structured.json")) as Record<string, unknown>;
    fixture.actualValues = [{ field: "passed", value: true }];

    expect(validate(fixture)).toBe(false);
    expect(validate.errors?.length).toBeGreaterThan(0);
  });
  test("keeps verification request paths non-empty in AJV and runtime", () => {
    const validate = loadValidator("verification-request.schema.json");
    const request: VerificationRequest = {
      schemaVersion: "verification-request/v1",
      requestId: "request-contract",
      project: { rootIdentity: "repository", snapshotId: "snapshot-contract" },
      change: { summary: "validate published request contract", paths: ["system/runtime/verification-run.ts"] },
      testBasis: [{ id: "basis-contract", kind: "contract", origin: "explicit", text: "The request schema matches runtime validation." }],
    };
    const invalid = { ...request, change: { ...request.change, paths: [] } };

    expect(validate(request), validate.errors ? JSON.stringify(validate.errors) : undefined).toBe(true);
    expect(() => canonicalRequestDigest(request)).not.toThrow();
    expect(validate(invalid)).toBe(false);
    expect(validate.errors?.length).toBeGreaterThan(0);
    expect(() => canonicalRequestDigest(invalid)).toThrow("invalid verification request");
  });
});
