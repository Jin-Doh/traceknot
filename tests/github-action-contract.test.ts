import { describe, expect, test } from "bun:test";

type YamlObject = Record<string, unknown>;

async function yaml(path: string): Promise<YamlObject> {
  const value: unknown = Bun.YAML.parse(await Bun.file(path).text());
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a YAML object`);
  }
  return value as YamlObject;
}

function object(value: unknown, label: string): YamlObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as YamlObject;
}

describe("reusable governed GitHub Action", () => {
  test("publishes a pinned composite action with fail-closed evidence retention", async () => {
    const action = await yaml("action.yml");
    const inputs = object(action.inputs, "action inputs");
    const runs = object(action.runs, "action runs");
    const steps = runs.steps as readonly YamlObject[];

    expect(runs.using).toBe("composite");
    expect(Object.keys(inputs)).toEqual([
      "mode",
      "request",
      "manifest",
      "run-id",
      "format",
      "artifact-name",
      "sarif-path",
    ]);
    expect(steps.map((step) => step.id ?? step.name)).toEqual([
      "setup",
      "install",
      "verify",
      "summary",
      "artifact",
      "sarif",
    ]);
    expect(steps.filter((step) => typeof step.uses === "string").every((step) =>
      /^[^@]+@[0-9a-f]{40}$/.test(String(step.uses).split(" #", 1)[0] ?? "")
    )).toBe(true);
    expect(String(steps[2]?.run)).toContain("set -euo pipefail");
    expect(String(steps[2]?.run)).toContain("self-verify.ts");
    expect(steps[3]?.if).toBe("always()");
    expect(steps[4]?.if).toBe("always()");
  });

  test("exposes separate lifecycle and fail-closed verdict checks", async () => {
    const workflow = await yaml(".github/workflows/traceknot-governed.yml");
    const jobs = object(workflow.jobs, "workflow jobs");
    const lifecycle = object(jobs.lifecycle, "lifecycle job");
    const verdict = object(jobs.verdict, "verdict job");
    const required = object(jobs.required, "required job");

    expect(lifecycle.name).toBe("Traceknot lifecycle");
    expect(verdict.name).toBe("Traceknot verdict");
    expect(required.name).toBe("Traceknot governed");
    expect(required.if).toBe("always()");
    expect(required.needs).toEqual(["lifecycle", "verdict"]);
    expect(object(workflow.permissions, "workflow permissions")).toEqual({ contents: "read" });
    expect(object(verdict.permissions, "verdict permissions")).toEqual({
      contents: "read",
      "security-events": "write",
    });
    expect(JSON.stringify(workflow)).not.toContain("pull_request_target");
  });
});
