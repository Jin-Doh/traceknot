import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

function git(root: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Traceknot Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Traceknot Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
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
      "prepare",
      "verify",
      "summary",
      "artifact",
      "sarif",
    ]);
    expect(steps.filter((step) => typeof step.uses === "string").every((step) =>
      /^[^@]+@[0-9a-f]{40}$/.test(String(step.uses).split(" #", 1)[0] ?? "")
    )).toBe(true);
    expect(String(steps[2]?.run)).toContain("umask 077");
    expect(String(steps[2]?.run)).toContain("mktemp -d");
    expect(String(steps[2]?.run)).toContain("git -C \"$GITHUB_WORKSPACE\" cat-file blob");
    expect(String(steps[2]?.run)).toContain("report-path=");
    expect(String(steps[3]?.run)).toContain("self-verify.ts");
    expect(String(steps[3]?.run)).toContain("status.txt");
    expect(steps[4]?.if).toBe("always()");
    expect(steps[5]?.if).toBe("always()");
    expect(object(steps[5]?.with, "artifact inputs")["include-hidden-files"]).toBe(true);
  });

  test("retains report and evidence paths when verification fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "traceknot-action-workspace-"));
    const runner = await mkdtemp(join(tmpdir(), "traceknot-action-runner-"));
    try {
      await writeFile(join(workspace, "input.txt"), "clean\n");
      const request = {
        schemaVersion: "verification-request/v1",
        requestId: "governed-failure",
        project: { rootIdentity: "auto", snapshotId: "auto" },
        change: { summary: "exercise governed failure retention", paths: ["input.txt"] },
        testBasis: [{
          id: "failure",
          kind: "acceptance-criterion",
          origin: "explicit",
          text: "the failing command remains a retained non-PASS verdict",
        }],
      };
      const manifest = {
        schemaVersion: "verification-manifest/v1",
        obligations: [{ id: "obligation:condition:failure", executable: "/usr/bin/false" }],
      };
      await writeFile(join(workspace, "request.json"), JSON.stringify(request));
      await writeFile(join(workspace, "manifest.json"), JSON.stringify(manifest));
      git(workspace, ["init", "-q"]);
      git(workspace, ["add", "."]);
      git(workspace, ["commit", "-qm", "fixture"]);

      const action = await yaml("action.yml");
      const actionSteps = object(action.runs, "action runs").steps as readonly YamlObject[];
      const prepare = actionSteps[2];
      const verify = actionSteps[3];
      const outputPath = join(runner, "github-output.txt");
      const commonEnv = {
        ...process.env,
        RUNNER_TEMP: runner,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_ACTION_PATH: resolve("."),
        GITHUB_WORKSPACE: workspace,
        TRACEKNOT_MODE: "manifest",
        TRACEKNOT_RUN_ID: "",
        TRACEKNOT_FORMAT: "json",
        TRACEKNOT_SARIF: "",
      };
      const preparation = Bun.spawn(["bash", "-c", String(prepare?.run)], {
        cwd: resolve("."),
        env: {
          ...commonEnv,
          GITHUB_RUN_ID: "1",
          GITHUB_OUTPUT: outputPath,
          TRACEKNOT_REQUEST: "request.json",
          TRACEKNOT_MANIFEST: "manifest.json",
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await preparation.exited).toBe(0);
      const outputs = Object.fromEntries(
        (await readFile(outputPath, "utf8")).trim().split("\n").map(
          (line: string) => line.split("=", 2),
        ),
      );
      const result = Bun.spawn(["bash", "-c", String(verify?.run)], {
        cwd: resolve("."),
        env: {
          ...commonEnv,
          GITHUB_RUN_ID: "1",
          TRACEKNOT_REPORT: String(outputs["report-path"]),
          TRACEKNOT_EVIDENCE: String(outputs["evidence-path"]),
          TRACEKNOT_STATE: String(outputs["state-path"]),
          TRACEKNOT_ARTIFACTS: String(outputs["artifact-path"]),
          TRACEKNOT_REQUEST: String(outputs["request-path"]),
          TRACEKNOT_MANIFEST: String(outputs["manifest-path"]),
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      const exitCode = await result.exited;
      const report = JSON.parse(await readFile(String(outputs["report-path"]), "utf8")) as {
        verdict: { qaVerdict: string };
      };

      expect(exitCode).toBe(1);
      expect(report.verdict.qaVerdict).toBe("FAIL");
      expect(await readFile(join(String(outputs["evidence-path"]), "status.txt"), "utf8")).toBe(
        "exit=1\n",
      );
      expect(outputs["evidence-path"]).toContain("traceknot-governed.");
      expect((await stat(String(outputs["evidence-path"]))).mode & 0o077).toBe(0);
      expect((await readdir(join(String(outputs["artifact-path"]), ".objects"))).length).toBeGreaterThan(0);

      const traversal = Bun.spawn(["bash", "-c", String(prepare?.run)], {
        cwd: resolve("."),
        env: {
          ...commonEnv,
          GITHUB_RUN_ID: "2",
          GITHUB_OUTPUT: join(runner, "traversal-output.txt"),
          TRACEKNOT_REQUEST: "../outside.json",
          TRACEKNOT_MANIFEST: "manifest.json",
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await traversal.exited).toBe(64);
    } finally {
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(runner, { recursive: true, force: true }),
      ]);
    }
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
    expect(object(lifecycle.permissions, "lifecycle permissions")).toEqual({});
    expect(object(verdict.permissions, "verdict permissions")).toEqual({ contents: "read" });
    expect(object(required.permissions, "required permissions")).toEqual({});
    expect(JSON.stringify(workflow)).not.toContain("pull_request_target");
  });
});
