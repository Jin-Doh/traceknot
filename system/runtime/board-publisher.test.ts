import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createCanonicalCliBoardPublisher,
  type BoardPublisherInput,
  type CanonicalCliRunner,
} from "./board-publication";

async function boardFixture(): Promise<Readonly<{ root: string; entrypoint: string; manifestPath: string }>> {
  const root = await mkdtemp(join(tmpdir(), "traceknot-board-publisher-"));
  const directory = join(root, "runs", "run-1", "boards", "11-invocation");
  await mkdir(directory, { recursive: true });
  const entrypointPath = join(directory, "index.html");
  const manifestPath = join(directory, "manifest.json");
  await writeFile(entrypointPath, "<!doctype html>");
  await writeFile(manifestPath, "{}");
  return Object.freeze({ root, entrypoint: pathToFileURL(entrypointPath).href, manifestPath });
}

const request: BoardPublisherInput = {
  rootDir: "/repo",
  requestPath: "/state/request.json",
  manifestPath: "/state/manifest.json",
  stateDir: "/state",
  artifactDir: "/state/artifacts",
  runId: "run-1",
  sessionId: "session-1",
  snapshotId: "snapshot-1",
  sessionHost: "codex",
};

describe("canonical Board publisher", () => {
  test("invokes the CLI without shell interpolation and preserves observed Board files", async () => {
    const fixture = await boardFixture();
    try {
      let received: readonly string[] | undefined;
      const runner: CanonicalCliRunner = async (command, cwd) => {
        received = command;
        expect(cwd).toBe("/repo");
        return { exitCode: 0, stdout: "verification\n", stderr: `Traceknot Board: ${fixture.entrypoint}\n` };
      };
      const result = await createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish(request);
      expect(received).toEqual([
        "/bin/traceknot",
        "verify",
        "--root",
        "/repo",
        "--request",
        "/state/request.json",
        "--manifest",
        "/state/manifest.json",
        "--state-dir",
        "/state",
        "--artifact-dir",
        "/state/artifacts",
        "--run-id",
        "run-1",
        "--session-id",
        "session-1",
        "--session-host",
        "codex",
        "--board",
      ]);
      expect(result).toEqual({
        status: "generated",
        publisher: "canonical-cli",
        entrypoint: fixture.entrypoint,
        manifestPath: fixture.manifestPath,
        runId: "run-1",
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("fails closed when the reported Board manifest is missing", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "traceknot-board-publisher-missing-"));
    const directory = join(fixture, "runs", "run-1", "boards", "11-invocation");
    const entrypointPath = join(directory, "index.html");
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(entrypointPath, "<!doctype html>");
      const runner: CanonicalCliRunner = async () => ({
        exitCode: 0,
        stdout: "",
        stderr: `Traceknot Board: ${pathToFileURL(entrypointPath).href}\n`,
      });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish(request))
        .rejects.toThrow("Board manifest that does not exist");
      await rm(entrypointPath);
      await writeFile(join(directory, "manifest.json"), "{}");
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish(request))
        .rejects.toThrow("Board entrypoint that does not exist");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("accepts a verdict exit code after validating the published Board", async () => {
    const fixture = await boardFixture();
    try {
      const runner: CanonicalCliRunner = async () => ({ exitCode: 1, stdout: "", stderr: `Traceknot Board: ${fixture.entrypoint}\n` });
      await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish(request)).resolves.toMatchObject({
        status: "generated",
        entrypoint: fixture.entrypoint,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("fails closed on an unsupported non-zero CLI exit", async () => {
    const runner: CanonicalCliRunner = async () => ({ exitCode: 64, stdout: "", stderr: "usage" });
    await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish(request))
      .rejects.toThrow("canonical Board publisher failed (64): usage");
  });

  test("fails closed when the CLI omits the Board URI", async () => {
    const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "PASS\n", stderr: "" });
    await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish(request))
      .rejects.toThrow("did not report a file URI");
  });
});
