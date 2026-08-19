import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSelfCheck, SELF_CHECK_EXIT_CODES } from "./self-check";

const roots: string[] = [];
const contracts = [
  "qa-board-manifest.schema.json",
  "qa-board-view.schema.json",
  "traceknot-session-board-current.schema.json",
  "traceknot-session-board-update.schema.json",
] as const;
const adapters = ["claude-code", "codex", "gajae-code", "omp", "opencode"] as const;

async function fixture(): Promise<{ root: string; executable: string }> {
  const root = await mkdtemp(join(tmpdir(), "traceknot-self-check-"));
  roots.push(root);
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "contracts"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), "---\nname: traceknot\n---\n");
  const executable = join(root, "bin", "traceknot");
  await writeFile(executable, "#!/usr/bin/env bun\n");
  await chmod(executable, 0o755);
  for (const contract of contracts) await writeFile(join(root, "contracts", contract), "{}\n");
  for (const adapter of adapters) {
    await mkdir(join(root, "adapters", adapter), { recursive: true });
    await writeFile(join(root, "adapters", adapter, "capability.json"), "{}\n");
  }
  return { root, executable };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("installed runtime self-check", () => {
  test("checks the payload, semantic parser, and renderer", async () => {
    const { root, executable } = await fixture();
    let stdout = "";
    let stderr = "";
    const exitCode = await runSelfCheck([], text => { stdout += text; }, text => { stderr += text; }, executable, "1.3.14");
    expect(exitCode).toBe(SELF_CHECK_EXIT_CODES.OK);
    expect(stdout).toContain("Traceknot self-check: PASS");
    expect(stdout).toContain(`Skill root: ${await realpath(root)}`);
    expect(stdout).toContain("Contracts: 4");
    expect(stdout).toContain("Adapters: 5");
    expect(stderr).toBe("");
  });

  test("fails closed when a required generated mirror is missing", async () => {
    const { root, executable } = await fixture();
    await rm(join(root, "contracts", "qa-board-view.schema.json"));
    let stderr = "";
    const exitCode = await runSelfCheck([], () => {}, text => { stderr += text; }, executable, "1.3.14");
    expect(exitCode).toBe(SELF_CHECK_EXIT_CODES.INTERNAL);
    expect(stderr).toContain("Traceknot self-check: FAIL");
    expect(stderr).toContain("qa-board-view.schema.json");
  });

  test("rejects unsupported Bun versions and unknown options", async () => {
    const { executable } = await fixture();
    expect(await runSelfCheck([], () => {}, () => {}, executable, "1.3.13")).toBe(SELF_CHECK_EXIT_CODES.INTERNAL);
    expect(await runSelfCheck(["--unknown"], () => {}, () => {}, executable, "1.3.14")).toBe(SELF_CHECK_EXIT_CODES.USAGE);
  });
});
