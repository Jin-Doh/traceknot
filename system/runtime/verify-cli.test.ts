import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { captureGitSnapshotIdentity } from "./git-snapshot";
import { runVerify } from "../cli/verify";

type RepoFixture = Readonly<{ root: string; config: string; state: string; request: string; manifest: string; cleanup: () => Promise<void> }>;
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Traceknot Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Traceknot Test", GIT_COMMITTER_EMAIL: "test@example.com" };
function git(root: string, args: readonly string[]): string { const result = Bun.spawnSync(["git", "-C", root, ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr)); return new TextDecoder().decode(result.stdout).trim(); }
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
  test("requires the internally captured snapshot to match one clean expected HEAD", async () => {
    const fixtureValue = await fixture();
    try {
      const expectedHead = git(fixtureValue.root, ["rev-parse", "HEAD"]);
      const matching = await runVerify(
        ["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", fixtureValue.request, "--manifest", fixtureValue.manifest, "--expected-head", expectedHead],
        () => undefined,
        () => undefined,
      );
      expect(matching).toBe(0);

      await writeFile(join(fixtureValue.root, "dirty.txt"), "untracked\n");
      const stderr: string[] = [];
      const dirty = await runVerify(
        ["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", fixtureValue.request, "--manifest", fixtureValue.manifest, "--expected-head", expectedHead],
        () => undefined,
        text => stderr.push(text),
      );
      expect(dirty).toBe(64);
      expect(stderr.join("")).toContain("expected clean Git HEAD");

      await rm(join(fixtureValue.root, "dirty.txt"));
      await writeFile(join(fixtureValue.root, "input.txt"), "next commit\n");
      git(fixtureValue.root, ["add", "input.txt"]);
      git(fixtureValue.root, ["commit", "-qm", "next"]);
      const moved = await runVerify(
        ["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", fixtureValue.request, "--manifest", fixtureValue.manifest, "--expected-head", expectedHead],
        () => undefined,
        text => stderr.push(text),
      );
      expect(moved).toBe(64);
      expect(stderr.join("")).toContain("expected clean Git HEAD");
    } finally {
      await fixtureValue.cleanup();
    }
  });

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
  test("fails closed when a manifest command mutates the Git snapshot", async () => {
    const fixtureValue = await fixture();
    try {
      await writeFile(fixtureValue.manifest, JSON.stringify({ schemaVersion: "verification-manifest/v1", obligations: [{ id: "obligation:condition:command", executable: "/bin/sh", argv: ["-c", "printf 'mutated\\n' > input.txt"] }] }));
      const stdout: string[] = []; const stderr: string[] = [];
      const status = await runVerify(["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", fixtureValue.request, "--manifest", fixtureValue.manifest], text => stdout.push(text), text => stderr.push(text));
      expect(status).toBe(2); expect(stdout).toEqual([]); expect(stderr.join("")).toContain("snapshot");
    } finally { await fixtureValue.cleanup(); }
  });

  test("classifies missing and malformed JSON inputs as usage errors", async () => {
    const fixtureValue = await fixture();
    try {
      const missing = await runVerify(["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", join(fixtureValue.config, "missing.json"), "--manifest", fixtureValue.manifest], () => undefined, () => undefined);
      expect(missing).toBe(64);
      await writeFile(join(fixtureValue.config, "bad.json"), "{");
      const malformed = await runVerify(["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", join(fixtureValue.config, "bad.json"), "--manifest", fixtureValue.manifest], () => undefined, () => undefined);
      expect(malformed).toBe(64);
    } finally { await fixtureValue.cleanup(); }
  });

  test("rejects symbolic-link input files", async () => {
    const fixtureValue = await fixture();
    const aliasRoot = await mkdtemp(join(tmpdir(), "traceknot-cli-e2e-alias-"));
    try {
      const alias = join(aliasRoot, "request.json");
      await symlink(fixtureValue.request, alias);
      const stderr: string[] = [];
      const status = await runVerify(
        ["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", alias, "--manifest", fixtureValue.manifest],
        () => undefined,
        text => stderr.push(text),
      );
      expect(status).toBe(64);
      expect(stderr.join("")).toContain("invalid input file");
    } finally {
      await Promise.all([fixtureValue.cleanup(), rm(aliasRoot, { recursive: true, force: true })]);
    }
  });
});
