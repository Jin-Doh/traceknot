import { describe, expect, test } from "bun:test";
import {
  createCanonicalCliBoardPublisher,
  type BoardPublisherInput,
  type CanonicalCliRunner,
} from "./board-publication";

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
  test("invokes the CLI without shell interpolation and preserves the observed URI", async () => {
    let received: readonly string[] | undefined;
    const runner: CanonicalCliRunner = async (command, cwd) => {
      received = command;
      expect(cwd).toBe("/repo");
      return { exitCode: 0, stdout: "verification\nTraceknot Board: file:///state/boards/run-1/index.html\n", stderr: "" };
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
      entrypoint: "file:///state/boards/run-1/index.html",
      manifestPath: "/state/manifest.json",
      runId: "run-1",
    });
  });

  test("fails closed on a non-zero CLI exit", async () => {
    const runner: CanonicalCliRunner = async () => ({ exitCode: 2, stdout: "", stderr: "blocked" });
    await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish(request))
      .rejects.toThrow("canonical Board publisher failed (2): blocked");
  });

  test("fails closed when the CLI omits the Board URI", async () => {
    const runner: CanonicalCliRunner = async () => ({ exitCode: 0, stdout: "PASS\n", stderr: "" });
    await expect(createCanonicalCliBoardPublisher({ executable: "/bin/traceknot", runner }).publish(request))
      .rejects.toThrow("did not report a file URI");
  });
});
