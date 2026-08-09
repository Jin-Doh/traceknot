import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "bun:test";
import { runSelfHostingCacheParity } from "./self-hosting-parity";

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

describe("self-hosting cache parity and usage report", () => {
  test("proves cold-to-warm parity without fabricating unavailable usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceknot-parity-repo."));
    const cacheRoot = await mkdtemp(join(tmpdir(), "traceknot-parity-cache."));
    try {
      await git(root, "init", "-q");
      await writeFile(join(root, "input.txt"), "cache parity\n");
      await git(root, "add", "input.txt");
      await git(root, "commit", "-qm", "fixture");

      const report = await runSelfHostingCacheParity({
        rootDir: root,
        executable: process.execPath,
        argv: ["-e", "process.exit(0)"],
      }, cacheRoot);
      expect(report).toMatchObject({
        schemaVersion: "self-hosting-parity-report/v1",
        runId: "traceknot-self-hosting",
        requestId: "traceknot-self-hosting",
        verification: { state: "TERMINAL", qaVerdict: "PASS" },
        cache: { cold: "MISS", warm: "HIT", equal: true },
        usage: {
          inputTokens: "unavailable",
          cachedInputTokens: "unavailable",
          cacheWriteTokens: "unavailable",
          outputTokens: "unavailable",
          reasoningTokens: "unavailable",
          modelCalls: 0,
          cacheHitRate: "unavailable",
          estimatedCost: { status: "unavailable" },
        },
      });
      expect(report.cache.key).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(report.cache.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(report.snapshotId).toMatch(/^[0-9a-f]{64}$/);

      const schema = JSON.parse(await readFile(resolve("contracts/self-hosting-parity-report.schema.json"), "utf8"));
      const validate = new Ajv2020({ strict: true }).compile(schema);
      expect(validate(report)).toBe(true);
      expect(validate({ ...report, extra: true })).toBe(false);

      await expect(runSelfHostingCacheParity({
        rootDir: root,
        executable: process.execPath,
        argv: ["-e", "process.exit(0)"],
      }, cacheRoot)).rejects.toThrow("cold cache");
      await expect(runSelfHostingCacheParity({
        rootDir: root,
        executable: process.execPath,
        argv: ["-e", "process.exit(0)"],
      }, join(root, "cache"))).rejects.toThrow("outside");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(cacheRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
