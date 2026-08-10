import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "bun:test";
import {
  buildSelfHostingInputs,
  buildCanonicalSelfHostingCommand,
  SelfHostingCliError,
  resolveSelfHostingRoot,
  runSelfHostingVerification,
} from "./self-hosting-verification";

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Traceknot Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Traceknot Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(root: string, ...args: string[]): Promise<void> {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, env: gitEnv, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw Error(result.stderr.toString());
}

describe("canonical self-hosting verification", () => {
  test("uses the caller checkout for remote action self-hosting", () => {
    expect(resolveSelfHostingRoot("/action/archive", "/caller/checkout")).toBe(
      "/caller/checkout",
    );
    expect(resolveSelfHostingRoot("/action/archive", undefined)).toBe("/action/archive");
    expect(() => resolveSelfHostingRoot("/action/archive", "relative/workspace")).toThrow(
      "self-hosting root must be absolute",
    );
  });

  test("pins Bun, GitHub CLI, and system paths without manifest environment authority", () => {
    const root = resolve(".");
    const ghExecutable = Bun.which("gh");
    if (!ghExecutable) throw Error("test requires GitHub CLI");
    const path = [...new Set([
      dirname(process.execPath),
      dirname(ghExecutable),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ])].join(":");
    expect(buildCanonicalSelfHostingCommand(root)).toEqual({
      rootDir: root,
      executable: "/usr/bin/env",
      argv: [
        `PATH=${path}`,
        "/bin/sh",
        join(root, "scripts/ci"),
        "--self-hosted-inner",
      ],
    });
  });

  test("builds closed canonical request and manifest records", () => {
    const root = resolve(".");
    const records = buildSelfHostingInputs({
      rootDir: root,
      executable: process.execPath,
      argv: ["-e", "process.exit(0)"],
    });
    expect(records.request).toEqual({
      schemaVersion: "verification-request/v1",
      requestId: "traceknot-self-hosting",
      project: { rootIdentity: "auto", snapshotId: "auto" },
      change: {
        summary: "Verify Traceknot with its canonical repository gate.",
        paths: [".github/workflows/ci.yml", "scripts/ci", "system/cli/verify.ts"],
      },
      testBasis: [{
        id: "canonical-gate",
        kind: "acceptance-criterion",
        origin: "explicit",
        text: "The canonical repository gate passes against the immutable target snapshot.",
      }],
    });
    expect(records.manifest).toEqual({
      schemaVersion: "verification-manifest/v1",
      obligations: [{
        id: "obligation:condition:canonical-gate",
        executable: process.execPath,
        argv: ["-e", "process.exit(0)"],
        cwd: root,
        timeoutMs: 600_000,
        maxOutputBytes: 4_194_304,
        toolVersion: `bun-${Bun.version}`,
      }],
    });

    const ajv = new Ajv2020({ strict: true });
    const requestSchema = JSON.parse(readFileSync(resolve("contracts/verification-request.schema.json"), "utf8"));
    const manifestSchema = JSON.parse(readFileSync(resolve("contracts/verification-manifest.schema.json"), "utf8"));
    expect(ajv.compile(requestSchema)(records.request)).toBe(true);
    expect(ajv.compile(manifestSchema)(records.manifest)).toBe(true);
  });

  test("uses the real CLI for execute and snapshot-bound report-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceknot-self-host-test."));
    try {
      await git(root, "init", "-q");
      await writeFile(join(root, "input.txt"), "self host\n");
      await git(root, "add", "input.txt");
      await git(root, "commit", "-qm", "fixture");

      const result = await runSelfHostingVerification({
        rootDir: root,
        executable: process.execPath,
        argv: ["-e", "process.exit(0)"],
      });
      expect(result.executed.run).toMatchObject({ state: "TERMINAL" });
      expect(result.executed.verdict).toMatchObject({ qaVerdict: "PASS" });
      expect(result.reportOnly.run).toMatchObject({
        runId: result.executed.run.runId,
        requestId: result.executed.run.requestId,
        rootIdentity: result.executed.run.rootIdentity,
        snapshotId: result.executed.run.snapshotId,
        state: "TERMINAL",
      });
      expect(result.reportOnly.verdict).toMatchObject({ qaVerdict: "PASS" });
      expect(result.reportOnly.snapshot).toEqual(result.executed.snapshot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a relative canonical executable", () => {
    expect(() => buildSelfHostingInputs({
      rootDir: resolve("."),
      executable: "bun",
      argv: ["run", "ci"],
    })).toThrow("absolute");
  });

  test("preserves the failed verification report in the thrown error", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceknot-self-host-failure."));
    try {
      await git(root, "init", "-q");
      await writeFile(join(root, "input.txt"), "self host failure\n");
      await git(root, "add", "input.txt");
      await git(root, "commit", "-qm", "fixture");
      try {
        await runSelfHostingVerification({
          rootDir: root,
          executable: process.execPath,
          argv: ["-e", "process.exit(1)"],
        });
        throw new Error("expected self-hosting verification to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(SelfHostingCliError);
        expect((error as SelfHostingCliError).exitCode).toBe(1);
        expect((error as SelfHostingCliError).report?.verdict).toMatchObject({
          qaVerdict: "FAIL",
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
