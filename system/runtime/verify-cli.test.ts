import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { captureGitSnapshotIdentity } from "./git-snapshot";
import { runVerify } from "../cli/verify";

type RepoFixture = Readonly<{ root: string; config: string; state: string; request: string; manifest: string; cleanup: () => Promise<void> }>;
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Traceknot Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Traceknot Test", GIT_COMMITTER_EMAIL: "test@example.com" };
function git(root: string, args: readonly string[]): void { const result = Bun.spawnSync(["git", "-C", root, ...args], { env: gitEnv, stdout: "ignore", stderr: "pipe" }); if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr)); }
async function fixture(executable = "/usr/bin/true"): Promise<RepoFixture> {
  const root = await mkdtemp(join(tmpdir(), "traceknot-cli-e2e-repo-"));
  const config = await mkdtemp(join(tmpdir(), "traceknot-cli-e2e-config-"));
  const state = await mkdtemp(join(tmpdir(), "traceknot-cli-e2e-state-"));
  await writeFile(join(root, "input.txt"), "clean\n");
  git(root, ["init", "-q"]); git(root, ["add", "input.txt"]); git(root, ["commit", "-qm", "initial"]);
  const snapshot = await captureGitSnapshotIdentity(root);
  const request = { schemaVersion: "verification-request/v1", requestId: "cli-e2e", project: { rootIdentity: snapshot.rootIdentity, snapshotId: snapshot.snapshotId }, change: { summary: "exercise the real collector", paths: ["input.txt"] }, testBasis: [{ id: "command", kind: "acceptance-criterion", origin: "explicit", text: "the explicit command passes" }] };
  const manifest = { schemaVersion: "verification-manifest/v1", obligations: [{ id: "obligation:condition:command", executable }] };
  const requestPath = join(config, "request.json"); const manifestPath = join(config, "manifest.json");
  await writeFile(requestPath, JSON.stringify(request)); await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, config, state, request: requestPath, manifest: manifestPath, cleanup: async () => { await Promise.all([rm(root, { recursive: true, force: true }), rm(config, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]); } };
}

describe("traceknot verify CLI", () => {
  test("runs a real Git repository command, persists, and supports report-only", async () => {
    const fixtureValue = await fixture();
    try {
      const stdout: string[] = []; const stderr: string[] = [];
      const status = await runVerify(["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", fixtureValue.request, "--manifest", fixtureValue.manifest], text => stdout.push(text), text => stderr.push(text));
      expect(status).toBe(0); expect(stderr).toEqual([]);
      const report = JSON.parse(stdout.join("")) as { verdict: { qaVerdict: string }; run: { state: string } };
      expect(report.verdict.qaVerdict).toBe("PASS"); expect(report.run.state).toBe("TERMINAL");
      const markdown: string[] = [];
      const reportStatus = await runVerify(["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--run-id", "cli-e2e", "--report-only", "--format", "markdown"], text => markdown.push(text), text => stderr.push(text));
      expect(reportStatus).toBe(0); expect(markdown.join("")).toContain("**PASS**");
    } finally { await fixtureValue.cleanup(); }
  });

  test("returns verdict exit codes and rejects a changed snapshot on report-only", async () => {
    const fixtureValue = await fixture("/usr/bin/false");
    try {
      const stdout: string[] = []; const stderr: string[] = [];
      const status = await runVerify(["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", fixtureValue.request, "--manifest", fixtureValue.manifest], text => stdout.push(text), text => stderr.push(text));
      expect(status).toBe(1); expect((JSON.parse(stdout.join("")) as { verdict: { qaVerdict: string } }).verdict.qaVerdict).toBe("FAIL");
      await writeFile(join(fixtureValue.root, "new.txt"), "dirty\n");
      const reportStatus = await runVerify(["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--run-id", "cli-e2e", "--report-only"], () => undefined, text => stderr.push(text));
      expect(reportStatus).toBe(64); expect(stderr.join("")).toContain("snapshot");
    } finally { await fixtureValue.cleanup(); }
  });

  test("rejects shell-shaped environment input before execution", async () => {
    const fixtureValue = await fixture();
    try {
      const manifest = JSON.parse(await readFile(fixtureValue.manifest, "utf8")) as Record<string, unknown>;
      (manifest.obligations as Array<Record<string, unknown>>)[0]!.env = { PATH: "$(touch /tmp/pwned)" };
      await writeFile(fixtureValue.manifest, JSON.stringify(manifest));
      const status = await runVerify(["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", fixtureValue.request, "--manifest", fixtureValue.manifest], () => undefined, () => undefined);
      expect(status).toBe(64);
    } finally { await fixtureValue.cleanup(); }
  });
});
