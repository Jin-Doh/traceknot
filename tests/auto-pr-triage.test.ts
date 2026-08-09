import { describe, expect, test } from "bun:test";
import { apiError, run, runScript, setup, workflow } from "./support/auto-pr-triage-harness";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function pullRequestTargetTypes(source: string): string[] {
  const parsed: unknown = Bun.YAML.parse(source);
  if (!isRecord(parsed) || !isRecord(parsed.on)) throw new Error("workflow trigger mapping is missing");
  const trigger = parsed.on.pull_request_target;
  if (!isRecord(trigger) || !isStringArray(trigger.types)) throw new Error("pull_request_target types are missing");
  return trigger.types;
}

function workflowConcurrency(source: string): Record<string, unknown> {
  const parsed: unknown = Bun.YAML.parse(source);
  if (!isRecord(parsed) || !isRecord(parsed.concurrency)) throw new Error("workflow concurrency is missing");
  return parsed.concurrency;
}

describe("auto PR triage workflow", () => {
  test("runs again when PR metadata or changed files can alter triage", () => {
    expect(pullRequestTargetTypes(workflow)).toEqual(expect.arrayContaining(["edited", "synchronize"]));
  });

  test("serializes overlapping runs for the same pull request", () => {
    expect(workflowConcurrency(workflow)).toEqual({
      group: "auto-pr-triage-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
  });

  test("converges managed labels while preserving unrelated labels", async () => {
    const calls = await run({
      title: "Fix tracing crash",
      labels: ["enhancement", "documentation", "community"],
      assignees: ["external-contributor"],
    });

    expect(calls.addLabels.map((call) => call.labels)).toEqual([["bug"]]);
    expect(calls.removeLabel.map((call) => call.name)).toEqual(["enhancement", "documentation"]);
    expect(calls.removeLabel.some((call) => call.name === "community")).toBe(false);
  });

  test("uses token-aware text matching instead of substring matches", async () => {
    const calls = await run({
      title: "Docker prefix support",
      body: "Updates a fixture without changing behavior",
      labels: ["enhancement"],
      assignees: ["external-contributor"],
    });

    expect(calls.addLabels).toHaveLength(0);
    expect(calls.removeLabel).toHaveLength(0);
  });

  test("recognizes common compound fixes and documentation verb forms", async () => {
    const scenarios = [
      ["Bugfix: prevent a crash", "bug"],
      ["Hotfix release", "bug"],
      ["Document the API", "documentation"],
      ["Documenting configuration", "documentation"],
    ] as const;

    for (const [title, expectedLabel] of scenarios) {
      const calls = await run({ title, labels: [], assignees: ["external-contributor"] });
      expect(calls.addLabels.map((call) => call.labels)).toEqual([[expectedLabel]]);
    }
  });

  test("recognizes singular GitHub Action wording", async () => {
    const calls = await run({
      title: "Add GitHub Action validation",
      labels: [],
      assignees: ["external-contributor"],
    });

    expect(calls.addLabels.map((call) => call.labels)).toEqual([["github_actions"]]);
  });

  test("uses the paginated file result for classification", async () => {
    const files = Array.from({ length: 100 }, (_, index) => `src/file-${index}.ts`);
    files.push("docs/page-after-first-page.txt");
    const calls = await run({ files, assignees: ["external-contributor"] });

    expect(calls.paginate).toEqual([expect.objectContaining({ pull_number: 42, per_page: 100 })]);
    expect(calls.addLabels.map((call) => call.labels)).toEqual([["documentation"]]);
  });

  test("checks assignability before assigning an external author", async () => {
    const calls = await run({ labels: ["enhancement"] });

    expect(calls.checkAssignable).toEqual([expect.objectContaining({ assignee: "external-contributor" })]);
    expect(calls.addAssignees.map((call) => call.assignees)).toEqual([["external-contributor"]]);
  });

  test("skips a confirmed unassignable external author", async () => {
    const calls = await run({
      labels: ["enhancement"],
      assignabilityError: apiError(404, "Not Found"),
    });

    expect(calls.checkAssignable).toHaveLength(1);
    expect(calls.addAssignees).toHaveLength(0);
  });

  test("does not attempt to assign bot authors", async () => {
    const calls = await run({ labels: ["enhancement"], authorType: "Bot", author: "dependabot[bot]" });

    expect(calls.checkAssignable).toHaveLength(0);
    expect(calls.addAssignees).toHaveLength(0);
  });

  test("is idempotent when labels and assignment already converge", async () => {
    const calls = await run({ labels: ["enhancement", "community"], assignees: ["external-contributor"] });

    expect(calls.addLabels).toHaveLength(0);
    expect(calls.removeLabel).toHaveLength(0);
    expect(calls.checkAssignable).toHaveLength(0);
    expect(calls.addAssignees).toHaveLength(0);
  });

  test("rethrows unexpected assignability API failures", async () => {
    const failure = apiError(500, "GitHub unavailable");
    const { github, context } = setup({ labels: ["enhancement"], assignabilityError: failure });

    await expect(runScript(github, context)).rejects.toBe(failure);
  });

  test("fails hard when a required GitHub API call fails", async () => {
    const failure = new Error("issues.get failed");
    const { github, context } = setup({ getError: failure });

    await expect(runScript(github, context)).rejects.toBe(failure);
  });
});
