import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type MutationOperation = {
  operation: "replace" | "remove" | "add";
  path: Array<string | number>;
  value?: unknown;
};

type Mutation = MutationOperation & {
  base: string;
  expectedKeyword: string;
  operations?: MutationOperation[];
  fields?: string[];
};

const fixtureRoot = resolve(import.meta.dir, "../contracts/fixtures");
const schema = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../contracts/risk-discovery-report.schema.json"), "utf8"),
) as object;
const validReport = JSON.parse(
  readFileSync(join(fixtureRoot, "risk-discovery-report.valid.json"), "utf8"),
) as unknown;

const completedMultiContextReport = JSON.parse(
  readFileSync(join(fixtureRoot, "risk-discovery-report.valid-completed-multi-context.json"), "utf8"),
) as unknown;
const capabilityLimitedReport = JSON.parse(
  readFileSync(join(fixtureRoot, "risk-discovery-report.valid-capability-limited.json"), "utf8"),
) as unknown;
const nonmaterialNotRequiredReport = JSON.parse(
  readFileSync(join(fixtureRoot, "risk-discovery-report.valid-nonmaterial-not-required.json"), "utf8"),
) as unknown;
const singleContextCompletedReport = JSON.parse(
  readFileSync(join(fixtureRoot, "risk-discovery-report.valid-single-context-completed.json"), "utf8"),
) as unknown;
const completedAcceptedRiskReport = JSON.parse(
  readFileSync(join(fixtureRoot, "risk-discovery-report.valid-completed-accepted-risk.json"), "utf8"),
) as unknown;
const acceptedSourceCandidateReport = JSON.parse(
  readFileSync(join(fixtureRoot, "risk-discovery-report.valid-source-candidate-accepted-risk.json"), "utf8"),
) as unknown;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);


function applyMutation(value: unknown, mutation: Mutation): unknown {
  const mutated = JSON.parse(JSON.stringify(value)) as unknown;
  const operations: MutationOperation[] = mutation.operations ?? [mutation];
  for (const operation of operations) {
    if (typeof mutated !== "object" || mutated === null) throw new Error("mutation base must be an object");
    let parent: Record<string, unknown> | unknown[] = Array.isArray(mutated)
      ? mutated
      : (mutated as Record<string, unknown>);
    for (const segment of operation.path.slice(0, -1)) {
      const child = Array.isArray(parent)
        ? typeof segment === "number"
          ? parent[segment]
          : undefined
        : parent[String(segment)];
      if (typeof child !== "object" || child === null) throw new Error("mutation path does not address an object");
      parent = Array.isArray(child) ? child : (child as Record<string, unknown>);
    }
    const key = operation.path.at(-1);
    if (key === undefined) throw new Error("mutation path must not be empty");
    if (Array.isArray(parent)) {
      if (typeof key !== "number") throw new Error("array mutation key must be numeric");
      if (operation.operation === "remove") parent.splice(key, 1);
      else parent[key] = operation.value;
    } else if (operation.operation === "remove") {
      delete parent[String(key)];
    } else {
      parent[String(key)] = operation.value;
    }
  }
  return mutated;
}


function loadBaseReport(base: string): unknown {
  if (base === "risk-discovery-report.valid.json") return validReport;
  return JSON.parse(readFileSync(join(fixtureRoot, base), "utf8")) as unknown;
}

describe("risk discovery report contract", () => {
  test("accepts the representative snapshot-bound report", () => {
    expect(validate(validReport)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test("accepts a completed Codex multi-context report", () => {
    expect(validate(completedMultiContextReport)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test("accepts a capability-limited report with an inline limitation", () => {
    expect(validate(capabilityLimitedReport)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test("accepts a nonmaterial NOT_REQUIRED report", () => {
    expect(validate(nonmaterialNotRequiredReport)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test("accepts a completed single-context report with profile resolution", () => {
    expect(validate(singleContextCompletedReport)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test("accepts a completed profile with an accepted-risk resolution", () => {
    expect(validate(completedAcceptedRiskReport)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test("accepts a material source candidate with an accepted-risk disposition", () => {
    expect(validate(acceptedSourceCandidateReport)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  const negativeFixtures = [
    ["risk-discovery-report.invalid-scan-bypass.json", "scan bypass"],
    ["risk-discovery-report.invalid-synthetic-boundary-no-challenge.json", "synthetic boundary challenge bypass"],
    ["risk-discovery-report.invalid-recurring-cluster-no-challenge.json", "recurring defect cluster challenge bypass"],
    ["risk-discovery-report.invalid-source-candidate.json", "incomplete source candidate"],
    ["risk-discovery-report.invalid-unaccepted-material-risk.json", "unaccepted material risk"],
    ["risk-discovery-report.invalid-accepted-risk-missing-approval.json", "missing accepted-risk approval"],
    ["risk-discovery-report.invalid-accepted-risk-missing-owner.json", "missing accountable approval owner"],
    ["risk-discovery-report.invalid-accepted-risk-incomplete-approval.json", "incomplete accepted-risk approval"],
    ["risk-discovery-report.invalid-legacy-approval-evidence-id.json", "legacy accepted-risk evidence ID"],
    ["risk-discovery-report.invalid-accepted-risk-missing-evidence.json", "missing accepted-risk evidence"],
    ["risk-discovery-report.invalid-approval-artifact-hash.json", "malformed accepted-risk artifact hash"],
    ["risk-discovery-report.invalid-approval-foreign-snapshot.json", "foreign accepted-risk evidence snapshot"],
    ["risk-discovery-report.invalid-promoted-foreign-approval.json", "promoted foreign approval field"],
    ["risk-discovery-report.invalid-accepted-foreign-obligation.json", "accepted foreign obligation field"],
    ["risk-discovery-report.invalid-blocked-foreign-approval.json", "blocked foreign approval field"],
    ["risk-discovery-report.invalid-deleted-material-disposition.json", "deleted material finding disposition"],
    ["risk-discovery-report.invalid-invented-capability.json", "invented capability"],
    ["risk-discovery-report.invalid-empty-trigger-evidence.json", "empty trigger evidence"],
    ["risk-discovery-report.invalid-r2-no-challenge.json", "R2 challenge bypass"],
    ["risk-discovery-report.invalid-r3-no-challenge.json", "R3 challenge bypass"],
    ["risk-discovery-report.invalid-unknown-scope-no-challenge.json", "unknown scope challenge bypass"],
    ["risk-discovery-report.invalid-material-trigger-no-challenge.json", "material trigger challenge bypass"],
    ["risk-discovery-report.invalid-material-profile-no-challenge.json", "material profile challenge bypass"],
    ["risk-discovery-report.invalid-material-findings-not-required.json", "material aggregate with NOT_REQUIRED challenge"],
    ["risk-discovery-report.invalid-nested-material-not-required.json", "nested material finding with NOT_REQUIRED challenge"],
    ["risk-discovery-report.invalid-empty-positive-trigger.json", "empty keyed profile for material trigger"],
    ["risk-discovery-report.invalid-artifact-capability-with-output.json", "reviewer output without artifact capability"],
    ["risk-discovery-report.invalid-triggered-profiles-array.json", "legacy positional triggered profiles"],
    ["risk-discovery-report.invalid-omp-profile-missing-capability.json", "OMP profile capability bypass"],
    ["risk-discovery-report.invalid-omp-completed-current-context.json", "OMP completed current-context challenge"],
    ["risk-discovery-report.invalid-single-context-profile-multi-context.json", "single-context profile multi-context contradiction"],
    ["risk-discovery-report.invalid-single-context-profile-separate-context.json", "single-context profile separate-context contradiction"],
    ["risk-discovery-report.invalid-codex-profile-missing-capability.json", "Codex profile capability bypass"],
    ["risk-discovery-report.invalid-separate-context-single-context.json", "single-context separate challenge contradiction"],
    ["risk-discovery-report.invalid-completed-capability-limited.json", "completed capability-limited contradiction"],
    ["risk-discovery-report.invalid-capability-limited-current-context.json", "capability-limited current-context contradiction"],
    ["risk-discovery-report.invalid-not-required-capability-limited.json", "NOT_REQUIRED capability-limited mode contradiction"],
    ["risk-discovery-report.invalid-capability-limited-missing-limitation.json", "missing capability-limited limitation"],
    ["risk-discovery-report.invalid-non-capability-challenge-limitation.json", "limitation on non-capability outcome"],
    ["risk-discovery-report.invalid-completed-resolution-missing.json", "missing completed profile resolution"],
    ["risk-discovery-report.invalid-completed-resolution-empty-detail.json", "empty completed profile resolution detail"],
    ["risk-discovery-report.invalid-completed-resolution-empty-evidence.json", "empty completed profile resolution evidence"],
    ["risk-discovery-report.invalid-completed-resolution-blocked-status.json", "blocked completed profile resolution"],
    ["risk-discovery-report.invalid-completed-resolution-capability-status.json", "capability-limited completed profile resolution"],
    ["risk-discovery-report.invalid-profile-accepted-risk-missing-approval.json", "accepted-risk profile resolution without approval"],
    ["risk-discovery-report.invalid-profile-no-findings-foreign-approval.json", "NO_FINDINGS profile resolution with foreign approval"],
    ["risk-discovery-report.invalid-profile-promoted-foreign-approval.json", "PROMOTED profile resolution with foreign approval"],
    ["risk-discovery-report.invalid-material-source-candidate-blocked.json", "blocked material source candidate disposition"],
    ["risk-discovery-report.invalid-nested-material-source-candidate-blocked.json", "blocked nested material source candidate disposition"],
    ["risk-discovery-report.invalid-duplicate-material-summary.json", "duplicate material summary"],
    ["risk-discovery-report.invalid-material-finding-no-risk-id.json", "material finding without risk ID"],
    ["risk-discovery-report.invalid-nonmaterial-risk-id.json", "nonmaterial finding risk ID"],
    ["risk-discovery-report.invalid-nonmaterial-disposition.json", "nonmaterial finding disposition"],
    ["risk-discovery-report.invalid-deferred-summary.json", "legacy deferred summary"],
    ["risk-discovery-report.invalid-material-finding-deferred-risk.json", "material finding deferred risk"],
    ["risk-discovery-report.invalid-legacy-cluster-member-ids.json", "legacy cluster member IDs"],
    ["risk-discovery-report.invalid-source-candidate-defect-details.json", "source candidate defect details"],
    ["risk-discovery-report.invalid-legacy-anchor-end-line.json", "legacy anchor end line"],
    ["risk-discovery-report.invalid-anchor-zero-line-count.json", "non-positive anchor line count"],
    ["risk-discovery-report.invalid-legacy-approval-timestamp.json", "legacy approval timestamp"],
    ["risk-discovery-report.invalid-impossible-approval-expiry.json", "impossible approval expiry"],
    ["risk-discovery-report.invalid-cluster-member-evidence.json", "cluster member evidence"],
    ["risk-discovery-report.invalid-reviewer-output-missing.json", "missing reviewer output"],
    ["risk-discovery-report.invalid-reviewer-output-profile-missing.json", "triggered profile without reviewer output"],
    ["risk-discovery-report.invalid-reviewer-output-generic.json", "generic reviewer result"],
    ["risk-discovery-report.invalid-reviewer-output-no-finding-keys.json", "no-finding result with findings field"],
    ["risk-discovery-report.invalid-reviewer-output-foreign-field.json", "foreign reviewer output field"],
    ["risk-discovery-report.invalid-codex-current-context.json", "Codex current-context completion"],
    ["risk-discovery-report.invalid-codex-completed-self-check.json", "Codex completed self-check producer"],
    ["risk-discovery-report.invalid-single-context-reviewer-independence.json", "single-context non-self-check producer"],
    ["risk-discovery-report.invalid-independent-producer-without-capability.json", "independent producer without capability"],
    ["risk-discovery-report.invalid-advertised-capability-limited.json", "advertised capability limitation"],
  ] as const;

  for (const [fileName, description] of negativeFixtures) {
    test(`rejects ${description}`, () => {
      const mutation = JSON.parse(readFileSync(join(fixtureRoot, fileName), "utf8")) as Mutation;
      const mutated = applyMutation(loadBaseReport(mutation.base), mutation);
      expect(validate(mutated)).toBe(false);
      expect(validate.errors?.some((error) => error.keyword === mutation.expectedKeyword)).toBe(true);
    });
  }

  const analysisFieldsFixture = JSON.parse(
    readFileSync(join(fixtureRoot, "risk-discovery-report.invalid-reviewer-analysis-fields.json"), "utf8"),
  ) as Mutation & { fields: string[] };
  for (const field of analysisFieldsFixture.fields) {
    test(`rejects reviewer analysis without ${field}`, () => {
      const mutated = applyMutation(loadBaseReport(analysisFieldsFixture.base), {
        ...analysisFieldsFixture,
        path: [...analysisFieldsFixture.path, field],
      });
      expect(validate(mutated)).toBe(false);
      expect(validate.errors?.some((error) => error.keyword === analysisFieldsFixture.expectedKeyword)).toBe(true);
    });
  }
  const capabilityNames = [
    "executeCommands",
    "executeBrowser",
    "captureArtifacts",
    "bindSnapshot",
    "provideIndependentEvidence",
    "persistEvidence",
    "approveExceptions",
    "isolatedReadOnlyReview",
    "enforcedStructuredOutput",
  ] as const;
  for (const capabilityName of capabilityNames) {
    test(`rejects an inline limitation when ${capabilityName} is advertised`, () => {
      const operations: MutationOperation[] = capabilityNames.map((name) => ({
        operation: "replace",
        path: ["runtime", "capabilities", name],
        value: true,
      }));
      operations.push({
        operation: "replace",
        path: ["triggerScan", "challenge", "limitation", "details", "capability"],
        value: capabilityName,
      });
      const mutated = applyMutation(capabilityLimitedReport, {
        base: "risk-discovery-report.valid-capability-limited.json",
        operation: "replace",
        path: ["runtime", "capabilities", capabilityNames[0]],
        expectedKeyword: "not",
        operations,
      });
      expect(validate(mutated)).toBe(false);
      expect(validate.errors?.some((error) => error.keyword === "not")).toBe(true);
    });
  }

});
