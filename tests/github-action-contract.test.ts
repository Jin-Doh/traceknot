import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

function git(root: string, args: readonly string[]): string {
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
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
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
      "assurance",
      "format",
      "artifact-name",
      "board",
      "artifact-retention-days",
      "board-retention-days",
      "cleanup-local-after-upload",
      "sarif-path",
    ]);
    expect(steps.map((step) => step.id ?? step.name)).toEqual([
      "setup",
      "install",
      "prepare",
      "verify",
      "summary",
      "artifact",
      "board-artifact",
      "sarif",
      "cleanup",
    ]);
    expect(steps.filter((step) => typeof step.uses === "string").every((step) =>
      /^[^@]+@[0-9a-f]{40}$/.test(String(step.uses).split(" #", 1)[0] ?? "")
    )).toBe(true);
    expect(String(steps[1]?.run)).toContain("GITHUB_WORKSPACE");
    expect(String(steps[2]?.run)).toContain("umask 077");
    expect(String(steps[2]?.run)).toContain("mktemp -d");
    expect(String(steps[2]?.run)).toContain("git -C \"$GITHUB_WORKSPACE\" cat-file blob");
    expect(String(steps[2]?.run)).toContain("report-path=");
    expect(String(steps[3]?.run)).toContain("self-verify.ts");
    expect(String(steps[3]?.run)).toContain("--expected-head");
    const verifyEnv = object(steps[3]?.env, "verification environment");
    expect(verifyEnv.TRACEKNOT_INVOCATION_ID).toBe("${{ steps.prepare.outputs.invocation-id }}");
    expect(String(steps[3]?.run)).toContain('"$TRACEKNOT_INVOCATION_ID"');
    expect(String(steps[3]?.run)).not.toContain("${{ steps.prepare.outputs.invocation-id }}");
    expect(String(steps[3]?.run)).toContain("status.txt");
    expect(steps[4]?.if).toBe("always()");
    expect(steps[5]?.if).toBe("always()");
    expect(steps[6]?.if).toBe("${{ always() && steps.prepare.outcome == 'success' && inputs.board == 'true' }}");
    expect(steps[7]?.if).toBe("${{ always() && inputs.sarif-path != '' }}");
    expect(steps[8]?.if).toBe("${{ always() && inputs.cleanup-local-after-upload == 'true' && steps.prepare.outcome == 'success' && steps.summary.outcome == 'success' && steps.artifact.outcome == 'success' && (steps['board-artifact'].outcome == 'success' || steps['board-artifact'].outcome == 'skipped') && (steps.sarif.outcome == 'success' || steps.sarif.outcome == 'skipped') }}");
    expect(object(inputs["artifact-retention-days"], "artifact retention input").default).toBe("30");
    expect(object(inputs["board-retention-days"], "Board retention input").default).toBe("14");
    expect(object(inputs.board, "Board input").default).toBe("true");
    expect(object(inputs["cleanup-local-after-upload"], "local cleanup input").default).toBe("false");
    const artifactInputs = object(steps[5]?.with, "artifact inputs");
    expect(artifactInputs.name).toContain("${{ steps.prepare.outputs.invocation-id }}");
    expect(String(artifactInputs.path)).toContain("!${{ steps.prepare.outputs.board-path }}/**/boards");
    expect(String(artifactInputs.path)).toContain("!${{ steps.prepare.outputs.board-path }}/**/boards/**");
    expect(String(artifactInputs.path)).not.toContain("!${{ steps.prepare.outputs.board-path }}\n");
    expect(artifactInputs["include-hidden-files"]).toBe(true);
    expect(artifactInputs["retention-days"]).toBe("${{ inputs.artifact-retention-days }}");
    const boardInputs = object(steps[6]?.with, "Board artifact inputs");
    expect(boardInputs.name).toContain("-board-${{ steps.prepare.outputs.invocation-id }}");
    expect(boardInputs.path).toBe("${{ steps.prepare.outputs.board-path }}/**/boards/*-${{ steps.prepare.outputs.invocation-id }}/**");
    expect(boardInputs["if-no-files-found"]).toBe("ignore");
    expect(boardInputs["retention-days"]).toBe("${{ inputs.board-retention-days }}");
    expect(String(steps[8]?.run)).toContain("rm -rf -- \"$TRACEKNOT_EVIDENCE\"");
    const verifyRun = String(steps[3]?.run);
    expect(verifyRun).toMatch(/args\+=\(--board --no-notify --invocation-id "\$TRACEKNOT_INVOCATION_ID" --session-id "\$TRACEKNOT_INVOCATION_ID" --session-host github-actions\)/);
    expect(verifyRun.match(/args\+=\(--board /g)).toHaveLength(1);
    expect(verifyRun.match(/args\+=\(--no-board\)/g)).toHaveLength(1);
  });

  test("rejects invalid retention inputs before verification", async () => {
    const runner = await mkdtemp(join(tmpdir(), "traceknot-action-invalid-retention-"));
    try {
      const action = await yaml("action.yml");
      const steps = object(action.runs, "action runs").steps as readonly YamlObject[];
      const prepare = steps[2];
      const result = Bun.spawn(["bash", "-c", String(prepare?.run)], {
        cwd: resolve("."),
        env: {
          ...process.env,
          RUNNER_TEMP: runner,
          TRACEKNOT_ARTIFACT_RETENTION_DAYS: "0",
          TRACEKNOT_BOARD_RETENTION_DAYS: "14",
          TRACEKNOT_CLEANUP_LOCAL: "false",
          TRACEKNOT_BOARD: "false",
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await result.exited).toBe(64);
    } finally {
      await rm(runner, { recursive: true, force: true });
    }
  });

  test("binds every governed input to one immutable HEAD commit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "traceknot-action-snapshot-"));
    const runner = await mkdtemp(join(tmpdir(), "traceknot-action-runner-"));
    try {
      await writeFile(join(workspace, "request.json"), '{"version":"first-request"}\n');
      await writeFile(join(workspace, "manifest.json"), '{"version":"first-manifest"}\n');
      git(workspace, ["init", "-q"]);
      git(workspace, ["add", "."]);
      git(workspace, ["commit", "-qm", "first"]);
      const firstHead = git(workspace, ["rev-parse", "HEAD"]);

      await writeFile(join(workspace, "request.json"), '{"version":"second-request"}\n');
      await writeFile(join(workspace, "manifest.json"), '{"version":"second-manifest"}\n');
      git(workspace, ["add", "."]);
      git(workspace, ["commit", "-qm", "second"]);
      const secondHead = git(workspace, ["rev-parse", "HEAD"]);
      git(workspace, ["update-ref", "HEAD", firstHead]);

      const shimDir = join(runner, "bin");
      const gitShim = join(shimDir, "git");
      const marker = join(runner, "head-switched");
      await mkdir(shimDir);
      await writeFile(gitShim, `#!/bin/sh
"$REAL_GIT" "$@"
status=$?
if test "$status" -eq 0 &&
   test "$1" = "-C" &&
   test "$3" = "cat-file" &&
   test ! -e "$GIT_SWITCH_MARKER"; then
  : > "$GIT_SWITCH_MARKER"
  "$REAL_GIT" -C "$2" update-ref HEAD "$NEXT_HEAD"
fi
exit "$status"
`);
      await chmod(gitShim, 0o700);

      const action = await yaml("action.yml");
      const prepare = (object(action.runs, "action runs").steps as readonly YamlObject[])[2];
      const outputPath = join(runner, "github-output.txt");
      const realGit = Bun.which("git");
      if (realGit === null) throw new Error("git must be available");
      const preparation = Bun.spawn(["bash", "-c", String(prepare?.run)], {
        cwd: resolve("."),
        env: {
          ...process.env,
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          REAL_GIT: realGit,
          NEXT_HEAD: secondHead,
          GIT_SWITCH_MARKER: marker,
          RUNNER_TEMP: runner,
          GITHUB_RUN_ID: "snapshot",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_ACTION_PATH: resolve("."),
          GITHUB_WORKSPACE: workspace,
          GITHUB_OUTPUT: outputPath,
          TRACEKNOT_MODE: "manifest",
          TRACEKNOT_RUN_ID: "",
          TRACEKNOT_FORMAT: "json",
          TRACEKNOT_ASSURANCE: "release",
          TRACEKNOT_REQUEST: "request.json",
          TRACEKNOT_MANIFEST: "manifest.json",
          TRACEKNOT_SARIF: "",
          TRACEKNOT_BOARD: "false",
          TRACEKNOT_ARTIFACT_RETENTION_DAYS: "30",
          TRACEKNOT_BOARD_RETENTION_DAYS: "14",
          TRACEKNOT_CLEANUP_LOCAL: "false",
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
      expect(await readFile(String(outputs["request-path"]), "utf8")).toBe(
        '{"version":"first-request"}\n',
      );
      expect(await readFile(String(outputs["manifest-path"]), "utf8")).toBe(
        '{"version":"first-manifest"}\n',
      );
    } finally {
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(runner, { recursive: true, force: true }),
      ]);
    }
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
        TRACEKNOT_ASSURANCE: "release",
        TRACEKNOT_FORMAT: "json",
        TRACEKNOT_BOARD: "false",
        TRACEKNOT_SARIF: "",
        TRACEKNOT_ARTIFACT_RETENTION_DAYS: "30",
        TRACEKNOT_BOARD_RETENTION_DAYS: "14",
        TRACEKNOT_CLEANUP_LOCAL: "false",
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
          TRACEKNOT_EXPECTED_HEAD: String(outputs["head-oid"]),
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
