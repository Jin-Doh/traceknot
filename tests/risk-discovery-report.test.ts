import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Mutation = {
  base: string;
  operation: "replace" | "remove" | "add";
  path: Array<string | number>;
  value?: unknown;
  expectedKeyword: string;
};

const fixtureRoot = resolve(import.meta.dir, "../contracts/fixtures");
const schema = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../contracts/risk-discovery-report.schema.json"), "utf8"),
) as object;
const validReport = JSON.parse(
  readFileSync(join(fixtureRoot, "risk-discovery-report.valid.json"), "utf8"),
) as unknown;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);


function applyMutation(value: unknown, mutation: Mutation): unknown {
  const mutated = JSON.parse(JSON.stringify(value)) as unknown;
  if (typeof mutated !== "object" || mutated === null) throw new Error("mutation base must be an object");
  let parent: Record<string, unknown> | unknown[] = Array.isArray(mutated)
    ? mutated
    : (mutated as Record<string, unknown>);
  for (const segment of mutation.path.slice(0, -1)) {
    const child = Array.isArray(parent)
      ? typeof segment === "number"
        ? parent[segment]
        : undefined
      : parent[String(segment)];
    if (typeof child !== "object" || child === null) throw new Error("mutation path does not address an object");
    parent = Array.isArray(child) ? child : (child as Record<string, unknown>);
  }
  const key = mutation.path.at(-1);
  if (key === undefined) throw new Error("mutation path must not be empty");
  if (Array.isArray(parent)) {
    if (typeof key !== "number") throw new Error("array mutation key must be numeric");
    if (mutation.operation === "remove") parent.splice(key, 1);
    else parent[key] = mutation.value;
  } else if (mutation.operation === "remove") {
    delete parent[String(key)];
  } else {
    parent[String(key)] = mutation.value;
  }
  return mutated;
}

describe("risk discovery report contract", () => {
  test("accepts the representative snapshot-bound report", () => {
    expect(validate(validReport)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  const negativeFixtures = [
    ["risk-discovery-report.invalid-scan-bypass.json", "scan bypass"],
    ["risk-discovery-report.invalid-source-candidate.json", "incomplete source candidate"],
    ["risk-discovery-report.invalid-unaccepted-material-risk.json", "unaccepted material risk"],
    ["risk-discovery-report.invalid-invented-capability.json", "invented capability"],
    ["risk-discovery-report.invalid-empty-trigger-evidence.json", "empty trigger evidence"],
  ] as const;

  for (const [fileName, description] of negativeFixtures) {
    test(`rejects ${description}`, () => {
      const mutation = JSON.parse(readFileSync(join(fixtureRoot, fileName), "utf8")) as Mutation;
      const mutated = applyMutation(validReport, mutation);
      expect(validate(mutated)).toBe(false);
      expect(validate.errors?.some((error) => error.keyword === mutation.expectedKeyword)).toBe(true);
    });
  }
});
