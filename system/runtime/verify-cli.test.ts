import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { captureGitSnapshotIdentity } from "./git-snapshot";
import { runVerify } from "../cli/verify";

type RepoFixture = Readonly<{ root: string; config: string; state: string; request: string; manifest: string; cleanup: () => Promise<void> }>;
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Traceknot Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Traceknot Test", GIT_COMMITTER_EMAIL: "test@example.com" };
function git(root: string, args: readonly string[]): string { const result = Bun.spawnSync(["git", "-C", root, ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr)); return new TextDecoder().decode(result.stdout).trim(); }
function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}
function png(width: number, height: number): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const pixels = Buffer.alloc((width + 1) * height);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", new Uint8Array())]);
}
function indexedPng(width: number, height: number, palette: Uint8Array, pixelIndex = 0): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 3;
  const pixels = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row++) pixels[row * (width + 1) + 1] = pixelIndex;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("PLTE", palette), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", new Uint8Array())]);
}
function fractionalViewportPng(): Uint8Array { return png(Math.round(390 * 1.25), Math.round(844 * 1.25)); }
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

  test("ingests a visual oracle and distinct screenshot artifacts for significant UI verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceknot-cli-visual-repo-"));
    const config = await mkdtemp(join(tmpdir(), "traceknot-cli-visual-config-"));
    const state = await mkdtemp(join(tmpdir(), "traceknot-cli-visual-state-"));
    try {
      const fullPath = join(root, "full-page.png");
      const focusedPath = join(root, "focused-region.png");
      const fullBytes = png(1440, 900);
      const focusedBytes = png(600, 400);
      const fullDigest = new Bun.CryptoHasher("sha256").update(fullBytes).digest("hex");
      const focusedDigest = new Bun.CryptoHasher("sha256").update(focusedBytes).digest("hex");
      await writeFile(join(root, "input.txt"), "clean\n");
      await writeFile(fullPath, fullBytes);
      await writeFile(focusedPath, focusedBytes);
      git(root, ["init", "-q"]); git(root, ["add", "."]); git(root, ["commit", "-qm", "visual fixture"]);
      const snapshot = await captureGitSnapshotIdentity(root);
      const request = {
        schemaVersion: "verification-request/v1",
        requestId: "cli-visual-e2e",
        project: { rootIdentity: snapshot.rootIdentity, snapshotId: snapshot.snapshotId },
        change: { summary: "Adjust responsive frontend layout spacing.", paths: ["input.txt"], uiImpact: "significant" },
        testBasis: [{ id: "basis-layout", kind: "acceptance-criterion", origin: "explicit", text: "The responsive layout preserves section spacing." }],
        visualComposition: {
          schemaVersion: "visual-composition-scope/v1",
          decision: "required",
          basisIds: ["basis-layout"],
          rationale: "The responsive layout geometry changes.",
          surfaces: [{ surfaceId: "surface-catalog", stateIds: ["populated"], viewportIds: ["desktop"] }],
          viewports: [{ id: "desktop", width: 1440, height: 900 }],
        },
      };
      const oracle = {
        schemaVersion: "visual-composition-oracle/v1",
        oracleId: "oracle:cli-visual-e2e",
        requestId: request.requestId,
        snapshotId: snapshot.snapshotId,
        conditionId: "condition:request-visual-composition",
        producer: { kind: "ci", identity: "traceknot-cli", independence: "independent-producer" },
        captures: [{
          captureId: "capture:catalog:populated:desktop",
          surfaceId: "surface-catalog",
          stateId: "populated",
          viewportId: "desktop",
          viewport: { id: "desktop", width: 1440, height: 900 },
          screenshots: [
            { evidenceId: "evidence:catalog:populated:desktop:full-page", role: "full-page", digest: fullDigest },
            { evidenceId: "evidence:catalog:populated:desktop:focused-region", role: "focused-region", digest: focusedDigest },
          ],
          regions: [
            { regionId: "main", role: "primary", x: 0, y: 0, width: 900, height: 500 },
            { regionId: "supporting", role: "supporting", x: 0, y: 532, width: 900, height: 200 },
          ],
          assertions: [{ assertionId: "section-gap", relation: "separation", regionIds: ["main", "supporting"], operator: "greater-than-or-equal", expected: 32, actual: 32, unit: "css-px", source: { kind: "explicit-basis", basisId: "basis-layout" } }],
        }],
        representativeStateLimitations: [],
        blockingReasons: [],
      };
      const requestPath = join(config, "request.json");
      const oraclePath = join(config, "oracle.json");
      const manifestPath = join(config, "manifest.json");
      const command = (id: string) => ({ id, executable: "/usr/bin/true" });
      const visualCommand = {
        ...command("obligation:condition:request-visual-composition"),
        visualCompositionOraclePath: oraclePath,
        declaredArtifacts: [
          { type: "screenshot", digest: fullDigest, path: "full-page.png" },
          { type: "screenshot", digest: focusedDigest, path: "focused-region.png" },
        ],
      };
      const manifest = { schemaVersion: "verification-manifest/v1", obligations: [command("obligation:condition:basis-layout"), command("obligation:condition:request-browser"), visualCommand] };
      await writeFile(requestPath, JSON.stringify(request));
      await writeFile(oraclePath, JSON.stringify(oracle));
      await writeFile(manifestPath, JSON.stringify(manifest));
      const stdout: string[] = [];
      const stderr: string[] = [];
      const status = await runVerify(["--root", root, "--state-dir", state, "--request", requestPath, "--manifest", manifestPath], text => stdout.push(text), text => stderr.push(text));
      expect({ status, stderr }).toEqual({ status: 0, stderr: [] });
      const report = JSON.parse(stdout.join("")) as { verdict: { qaVerdict: string }; documents: { execution: { observations: Array<{ observationId: string; artifacts: Array<{ type: string; digest: string; path?: string }> }>; evidence: Array<{ obligationId: string; visualCompositionOracleDigest?: string }> } } };
      expect(report.verdict.qaVerdict).toBe("PASS");
      const visualObservation = report.documents.execution.observations.find(item => item.observationId.includes("visual-composition"));
      expect(visualObservation?.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "screenshot", digest: fullDigest }), expect.objectContaining({ type: "screenshot", digest: focusedDigest })]));
      expect(report.documents.execution.evidence.find(item => item.obligationId.includes("visual-composition"))?.visualCompositionOracleDigest).toMatch(/^[a-f0-9]{64}$/);
      const invalidBytes = new TextEncoder().encode("not an image\n");
      const invalidDigest = new Bun.CryptoHasher("sha256").update(invalidBytes).digest("hex");
      await writeFile(focusedPath, invalidBytes);
      git(root, ["add", "focused-region.png"]);
      git(root, ["commit", "-qm", "invalid screenshot fixture"]);
      const invalidSnapshot = await captureGitSnapshotIdentity(root);
      const invalidRequest = { ...request, requestId: "cli-visual-invalid", project: { rootIdentity: invalidSnapshot.rootIdentity, snapshotId: invalidSnapshot.snapshotId } };
      const invalidOracle = {
        ...oracle,
        oracleId: "oracle:cli-visual-invalid",
        requestId: invalidRequest.requestId,
        snapshotId: invalidSnapshot.snapshotId,
        captures: oracle.captures.map(capture => ({ ...capture, screenshots: capture.screenshots.map(screenshot => screenshot.role === "focused-region" ? { ...screenshot, digest: invalidDigest } : screenshot) })),
      };
      const invalidManifest = {
        ...manifest,
        obligations: manifest.obligations.map(obligation => obligation.id === visualCommand.id ? { ...visualCommand, declaredArtifacts: [{ type: "screenshot", digest: fullDigest, path: "full-page.png" }, { type: "screenshot", digest: invalidDigest, path: "focused-region.png" }] } : obligation),
      };
      await writeFile(requestPath, JSON.stringify(invalidRequest));
      await writeFile(oraclePath, JSON.stringify(invalidOracle));
      await writeFile(manifestPath, JSON.stringify(invalidManifest));
      const invalidStdout: string[] = [];
      const invalidStderr: string[] = [];
      const invalidStatus = await runVerify(["--root", root, "--state-dir", state, "--request", requestPath, "--manifest", manifestPath], text => invalidStdout.push(text), text => invalidStderr.push(text));
      expect({ status: invalidStatus, stdout: invalidStdout, stderr: invalidStderr }).toEqual({ status: 64, stdout: [], stderr: ["invalid screenshot artifact is not a supported PNG\n"] });
      const wrongSizeBytes = png(800, 600);
      const wrongSizeDigest = new Bun.CryptoHasher("sha256").update(wrongSizeBytes).digest("hex");
      await writeFile(fullPath, wrongSizeBytes);
      await writeFile(focusedPath, focusedBytes);
      git(root, ["add", "full-page.png", "focused-region.png"]);
      git(root, ["commit", "-qm", "wrong screenshot dimensions"]);
      const mismatchSnapshot = await captureGitSnapshotIdentity(root);
      const mismatchRequest = { ...request, requestId: "cli-visual-dimension-mismatch", project: { rootIdentity: mismatchSnapshot.rootIdentity, snapshotId: mismatchSnapshot.snapshotId } };
      const mismatchOracle = {
        ...oracle,
        oracleId: "oracle:cli-visual-dimension-mismatch",
        requestId: mismatchRequest.requestId,
        snapshotId: mismatchSnapshot.snapshotId,
        captures: oracle.captures.map(capture => ({ ...capture, screenshots: capture.screenshots.map(screenshot => screenshot.role === "full-page" ? { ...screenshot, digest: wrongSizeDigest } : screenshot) })),
      };
      const mismatchManifest = {
        ...manifest,
        obligations: manifest.obligations.map(obligation => obligation.id === visualCommand.id ? { ...visualCommand, declaredArtifacts: [{ type: "screenshot", digest: wrongSizeDigest, path: "full-page.png" }, { type: "screenshot", digest: focusedDigest, path: "focused-region.png" }] } : obligation),
      };
      await writeFile(requestPath, JSON.stringify(mismatchRequest));
      await writeFile(oraclePath, JSON.stringify(mismatchOracle));
      await writeFile(manifestPath, JSON.stringify(mismatchManifest));
      const mismatchStdout: string[] = [];
      const mismatchStderr: string[] = [];
      const mismatchStatus = await runVerify(["--root", root, "--state-dir", state, "--request", requestPath, "--manifest", manifestPath], text => mismatchStdout.push(text), text => mismatchStderr.push(text));
      expect({ status: mismatchStatus, stdout: mismatchStdout, stderr: mismatchStderr }).toEqual({ status: 64, stdout: [], stderr: [`invalid screenshot artifact ${wrongSizeDigest}: dimensions do not match capture capture:catalog:populated:desktop\n`] });
      const invalidPaletteBytes = indexedPng(1440, 900, new Uint8Array());
      const invalidPaletteDigest = new Bun.CryptoHasher("sha256").update(invalidPaletteBytes).digest("hex");
      await writeFile(fullPath, invalidPaletteBytes);
      git(root, ["add", "full-page.png"]);
      git(root, ["commit", "-qm", "invalid indexed PNG palette"]);
      const paletteSnapshot = await captureGitSnapshotIdentity(root);
      const paletteRequest = { ...request, requestId: "cli-visual-invalid-palette", project: { rootIdentity: paletteSnapshot.rootIdentity, snapshotId: paletteSnapshot.snapshotId } };
      const paletteOracle = {
        ...oracle,
        oracleId: "oracle:cli-visual-invalid-palette",
        requestId: paletteRequest.requestId,
        snapshotId: paletteSnapshot.snapshotId,
        captures: oracle.captures.map(capture => ({ ...capture, screenshots: capture.screenshots.map(screenshot => screenshot.role === "full-page" ? { ...screenshot, digest: invalidPaletteDigest } : screenshot) })),
      };
      const paletteManifest = {
        ...manifest,
        obligations: manifest.obligations.map(obligation => obligation.id === visualCommand.id ? { ...visualCommand, declaredArtifacts: [{ type: "screenshot", digest: invalidPaletteDigest, path: "full-page.png" }, { type: "screenshot", digest: focusedDigest, path: "focused-region.png" }] } : obligation),
      };
      await writeFile(requestPath, JSON.stringify(paletteRequest));
      await writeFile(oraclePath, JSON.stringify(paletteOracle));
      await writeFile(manifestPath, JSON.stringify(paletteManifest));
      const paletteStderr: string[] = [];
      const paletteStatus = await runVerify(["--root", root, "--state-dir", state, "--request", requestPath, "--manifest", manifestPath], () => undefined, text => paletteStderr.push(text));
      expect({ status: paletteStatus, stderr: paletteStderr }).toEqual({ status: 64, stderr: ["invalid screenshot PNG has an invalid palette\n"] });
      const fractionalBytes = fractionalViewportPng();
      const fractionalDigest = new Bun.CryptoHasher("sha256").update(fractionalBytes).digest("hex");
      await writeFile(fullPath, fractionalBytes);
      git(root, ["add", "full-page.png"]);
      git(root, ["commit", "-qm", "fractional viewport screenshot"]);
      const fractionalSnapshot = await captureGitSnapshotIdentity(root);
      const fractionalRequest = {
        ...request,
        requestId: "cli-visual-fractional-viewport",
        project: { rootIdentity: fractionalSnapshot.rootIdentity, snapshotId: fractionalSnapshot.snapshotId },
        visualComposition: { ...request.visualComposition, viewports: [{ id: "desktop", width: 390, height: 844, devicePixelRatio: 1.25 }] },
      };
      const fractionalOracle = {
        ...oracle,
        oracleId: "oracle:cli-visual-fractional-viewport",
        requestId: fractionalRequest.requestId,
        snapshotId: fractionalSnapshot.snapshotId,
        captures: oracle.captures.map(capture => ({
          ...capture,
          viewport: { id: "desktop", width: 390, height: 844, devicePixelRatio: 1.25 },
          screenshots: capture.screenshots.map(screenshot => screenshot.role === "full-page" ? { ...screenshot, digest: fractionalDigest } : screenshot),
        })),
      };
      const fractionalManifest = {
        ...manifest,
        obligations: manifest.obligations.map(obligation => obligation.id === visualCommand.id ? { ...visualCommand, declaredArtifacts: [{ type: "screenshot", digest: fractionalDigest, path: "full-page.png" }, { type: "screenshot", digest: focusedDigest, path: "focused-region.png" }] } : obligation),
      };
      await writeFile(requestPath, JSON.stringify(fractionalRequest));
      await writeFile(oraclePath, JSON.stringify(fractionalOracle));
      await writeFile(manifestPath, JSON.stringify(fractionalManifest));
      const fractionalStdout: string[] = [];
      const fractionalStderr: string[] = [];
      const fractionalStatus = await runVerify(["--root", root, "--state-dir", state, "--request", requestPath, "--manifest", manifestPath], text => fractionalStdout.push(text), text => fractionalStderr.push(text));
      expect({ status: fractionalStatus, stderr: fractionalStderr, verdict: JSON.parse(fractionalStdout.join("")).verdict.qaVerdict }).toEqual({ status: 0, stderr: [], verdict: "PASS" });
      const failedRequest = { ...request, requestId: "cli-visual-command-failed", project: { rootIdentity: fractionalSnapshot.rootIdentity, snapshotId: fractionalSnapshot.snapshotId } };
      const failedManifest = {
        ...manifest,
        obligations: manifest.obligations.map(obligation => obligation.id === visualCommand.id ? { id: visualCommand.id, executable: "/usr/bin/false" } : obligation),
      };
      await writeFile(requestPath, JSON.stringify(failedRequest));
      await writeFile(manifestPath, JSON.stringify(failedManifest));
      const failedStdout: string[] = [];
      const failedStderr: string[] = [];
      const failedStatus = await runVerify(["--root", root, "--state-dir", state, "--request", requestPath, "--manifest", manifestPath], text => failedStdout.push(text), text => failedStderr.push(text));
      const failedReport = JSON.parse(failedStdout.join("")) as { verdict: { qaVerdict: string } };
      expect({ status: failedStatus, stderr: failedStderr, verdict: failedReport.verdict.qaVerdict }).toEqual({ status: 1, stderr: [], verdict: "FAIL" });
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(config, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]);
    }
  });
});
