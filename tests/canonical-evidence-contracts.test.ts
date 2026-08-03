import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type ContractCase = {
  name: string;
  schema: string;
  positive: string;
  negatives: readonly string[];
};

const contractCases: readonly ContractCase[] = [
  {
    name: "Observation",
    schema: "observation.schema.json",
    positive: "canonical-observation.valid.json",
    negatives: [
      "canonical-observation.invalid-verdict.json",
      "canonical-observation.invalid-digest.json",
      "canonical-observation.invalid-self-external-approval.json",
    ],
  },
  {
    name: "SuccessCriterion",
    schema: "success-criterion.schema.json",
    positive: "canonical-success-criterion.valid.json",
    negatives: [],
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
    name: "VerificationRun",
    schema: "verification-run.schema.json",
    positive: "canonical-verification-run.valid.json",
    negatives: ["canonical-verification-run.invalid-state.json"],
  },
];

const contractRoot = resolve(import.meta.dir, "../contracts");
const fixtureRoot = join(contractRoot, "fixtures");

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function loadValidator(schemaFile: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(loadJson(join(contractRoot, schemaFile)) as object);
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
});
