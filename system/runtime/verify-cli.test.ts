import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "bun:test";
import { captureGitSnapshotIdentity } from "./git-snapshot";
import { runVerify, validateFullTextAccessArtifact, validateScreenshotArtifact, verifyTrustedAuthority, verifyTrustedUiApplicabilityApproval, verifyTrustedUiVisualReview, type TrustedProducerPolicy } from "../cli/verify";
import { canonicalizeJson, type ExecutionAuthority, type VerificationExecutionAuthorityBinding, type VerificationExecutionCompletionEnvelope, type VerificationExecutionOutput } from "./verification-run";
import { LocalArtifactStore } from "./local-artifact-store";
import { uiFullTextAccessPayload, uiFullTextAccessPayloadDigest, uiVisualReviewApprovalPayloadDigest, type UiApplicabilityApprovalSubject, type UiResilienceOracle, type UiResilienceProfile, type UiVisualReview } from "../core/ui-resilience";

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
test("trusted UI approval verifiers treat malformed key material as unauthenticated", () => {
  const digest = "a".repeat(64);
  const policy: TrustedProducerPolicy = { schemaVersion: "trusted-producer-policy/v1", issuer: "trusted-ui", keyId: digest, publicKeyPem: "not-a-public-key" };
  const approvalReceipt = {
    schemaVersion: "ui-applicability-approval-receipt/v1" as const,
    receiptId: "receipt:applicability",
    issuer: policy.issuer,
    keyId: policy.keyId,
    requestId: "request",
    snapshotId: "snapshot",
    conditionId: "condition",
    surfaceId: "surface",
    profile: "rtl" as const,
    basisIds: ["basis"],
    rationale: "not applicable",
    signature: "malformed",
  };
  const subject: UiApplicabilityApprovalSubject = {
    requestId: approvalReceipt.requestId,
    snapshotId: approvalReceipt.snapshotId,
    conditionId: approvalReceipt.conditionId,
    surfaceId: approvalReceipt.surfaceId,
    profile: approvalReceipt.profile,
    basisIds: approvalReceipt.basisIds,
    rationale: approvalReceipt.rationale,
    approvalReceipt,
    approvalArtifactDigest: digest,
  };
  const reviewPayload = {
    reviewId: "review",
    requestId: "request",
    snapshotId: "snapshot",
    conditionId: "condition",
    observationId: "observation",
    surfaceId: "surface",
    stateId: "state",
    viewportId: "viewport",
    profile: "text-overflow" as const,
    fixtureId: "fixture",
    outcome: "PASS" as const,
    rationale: "approved",
    producer: { kind: "human", identity: "reviewer", independence: "independent-producer" } as const,
    screenshotDigest: digest,
  };
  const review: UiVisualReview = {
    ...reviewPayload,
    approvalReceipt: { schemaVersion: "ui-visual-review-approval-receipt/v1", receiptId: "receipt:review", issuer: policy.issuer, keyId: policy.keyId, payloadDigest: uiVisualReviewApprovalPayloadDigest(reviewPayload), signature: "malformed" },
    approvalArtifactDigest: digest,
  };
  expect(verifyTrustedUiApplicabilityApproval(policy, subject)).toBe(false);
  expect(verifyTrustedUiVisualReview(policy, review)).toBe(false);
});

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}
function png(width: number, height: number, marker = 0): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const pixels = Buffer.alloc((width + 1) * height);
  pixels[1] = marker;
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
test("CLI PNG decoder rejects transparency entries beyond the indexed palette", () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 3;
  const invalid = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("PLTE", new Uint8Array([0, 0, 0])),
    pngChunk("tRNS", new Uint8Array([255, 255])),
    pngChunk("IDAT", deflateSync(new Uint8Array([0, 0]))),
    pngChunk("IEND", new Uint8Array()),
  ]);
  const digest = new Bun.CryptoHasher("sha256").update(invalid).digest("hex");
  expect(() => validateScreenshotArtifact(invalid, digest, undefined, undefined)).toThrow("invalid transparency metadata");
});

test("CLI authenticates full-text access bytes, content, and observation subject", () => {
  const text = "Complete accessible catalog label";
  const contentDigest = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const payload = {
    schemaVersion: "ui-full-text-access/v1" as const,
    evidenceId: "full-text:one",
    requestId: "request",
    snapshotId: "snapshot",
    conditionId: "condition",
    observationId: "observation:one",
    regionId: "main",
    surfaceId: "surface",
    stateId: "state",
    viewportId: "desktop",
    profile: "text-overflow" as const,
    fixtureId: "fixture",
    kind: "focus" as const,
    contentDigest,
    producer: { kind: "ci", identity: "trusted-ci", independence: "independent-producer" } as const,
  };
  const payloadDigest = uiFullTextAccessPayloadDigest(payload);
  const artifact = { schemaVersion: "ui-full-text-access-artifact/v1", payload: uiFullTextAccessPayload(payload), payloadDigest, text };
  const bytes = Buffer.from(JSON.stringify(artifact));
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const observation = { observationId: "observation:one", regionId: "main", policy: "truncate-with-access" as const, clientWidth: 320, clientHeight: 40, scrollWidth: 420, scrollHeight: 40, fragmentRects: [{ x: 0, y: 0, width: 320, height: 40 }], clippingAncestors: [], paintFeatures: [], renderedLineCount: 2, contentTruncated: true, truncationIndicatorVisible: true, screenshotDigest: "a".repeat(64), fullTextAccess: { ...payload, payloadDigest, digest } };
  const oracle: UiResilienceOracle = { schemaVersion: "ui-resilience-oracle/v1", oracleId: "oracle", requestId: "request", snapshotId: "snapshot", conditionId: "condition", producer: payload.producer, runs: [{ runId: "run", surfaceId: "surface", stateId: "state", viewportId: "desktop", viewport: { id: "desktop", width: 1440, height: 900 }, fixtureContentDigest: "c".repeat(64), profile: "text-overflow", fixtureId: "fixture", browser: "Chromium", userAgent: "test", profileEvidence: { profile: "text-overflow" }, observations: [observation] }], blockingReasons: [] };
  expect(() => validateFullTextAccessArtifact(bytes, digest, oracle)).not.toThrow();
  const tampered = Buffer.from(JSON.stringify({ ...artifact, text: "Different text" }));
  const tamperedDigest = new Bun.CryptoHasher("sha256").update(tampered).digest("hex");
  const reversedPayload = Object.fromEntries(Object.entries(artifact.payload).reverse());
  const reorderedBytes = Buffer.from(JSON.stringify({ ...artifact, payload: reversedPayload }));
  const reorderedDigest = new Bun.CryptoHasher("sha256").update(reorderedBytes).digest("hex");
  const reorderedOracle = { ...oracle, runs: oracle.runs.map(run => ({ ...run, observations: run.observations.map(item => ({ ...item, fullTextAccess: { ...item.fullTextAccess!, digest: reorderedDigest } })) })) };
  expect(() => validateFullTextAccessArtifact(reorderedBytes, reorderedDigest, reorderedOracle)).not.toThrow();
  const tamperedOracle = { ...oracle, runs: oracle.runs.map(run => ({ ...run, observations: run.observations.map(item => ({ ...item, fullTextAccess: { ...item.fullTextAccess!, digest: tamperedDigest } })) })) };
  expect(() => validateFullTextAccessArtifact(tampered, tamperedDigest, tamperedOracle)).toThrow("payload does not match observation");
});

test("CLI screenshot trust boundary rejects cross-run replay and undersized resilience captures", () => {
  const bytes = png(900, 500);
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const observation = {
    observationId: "observation:one",
    regionId: "main",
    policy: "no-overflow" as const,
    clientWidth: 900,
    clientHeight: 500,
    scrollWidth: 900,
    scrollHeight: 500,
    fragmentRects: [{ x: 0, y: 0, width: 900, height: 500 }],
    clippingAncestors: [],
    paintFeatures: [],
    renderedLineCount: 1,
    contentTruncated: false,
    truncationIndicatorVisible: false,
    screenshotDigest: digest,
  };
  const oracle: UiResilienceOracle = {
    schemaVersion: "ui-resilience-oracle/v1",
    oracleId: "oracle",
    requestId: "request",
    snapshotId: "snapshot",
    conditionId: "condition",
    producer: { kind: "ci", identity: "trusted-ci", independence: "independent-producer" },
    runs: [
      { runId: "run:one", surfaceId: "surface", stateId: "state", viewportId: "desktop", viewport: { id: "desktop", width: 1440, height: 900 }, fixtureContentDigest: "a".repeat(64), profile: "text-overflow", fixtureId: "fixture-one", browser: "Chromium", userAgent: "test", profileEvidence: { profile: "text-overflow" }, observations: [observation] },
      { runId: "run:two", surfaceId: "surface", stateId: "state", viewportId: "desktop", viewport: { id: "desktop", width: 1440, height: 900 }, fixtureContentDigest: "b".repeat(64), profile: "resize-text-200", fixtureId: "fixture-two", browser: "Chromium", userAgent: "test", profileEvidence: { profile: "resize-text-200", textScalePercent: 200 }, observations: [{ ...observation, observationId: "observation:two" }] },
    ],
    blockingReasons: [],
  };
  expect(() => validateScreenshotArtifact(bytes, digest, undefined, oracle)).toThrow("reused across distinct runs");
  const singleRunOracle = { ...oracle, runs: [oracle.runs[0]!] };
  expect(() => validateScreenshotArtifact(bytes, digest, undefined, singleRunOracle)).toThrow("dimensions do not cover observation");
  const fullBytes = png(1440, 900);
  const fullDigest = new Bun.CryptoHasher("sha256").update(fullBytes).digest("hex");
  const fullOracle = { ...singleRunOracle, runs: singleRunOracle.runs.map(run => ({ ...run, observations: run.observations.map(item => ({ ...item, screenshotDigest: fullDigest })) })) };
  expect(() => validateScreenshotArtifact(fullBytes, fullDigest, undefined, fullOracle)).not.toThrow();
  const tinyBytes = png(1, 1);
  const tinyDigest = new Bun.CryptoHasher("sha256").update(tinyBytes).digest("hex");
  const reflowOracle: UiResilienceOracle = {
    ...singleRunOracle,
    runs: [{
      ...singleRunOracle.runs[0]!,
      profile: "reflow-320",
      profileEvidence: { profile: "reflow-320", innerWidth: 320, innerHeight: 900, writingMode: "horizontal" },
      observations: [{ ...observation, clientWidth: 1, clientHeight: 1, scrollWidth: 1, scrollHeight: 1, fragmentRects: [{ x: 0, y: 0, width: 1, height: 1 }], screenshotDigest: tinyDigest }],
    }],
  };
  expect(() => validateScreenshotArtifact(tinyBytes, tinyDigest, undefined, reflowOracle)).toThrow("dimensions do not cover observation");
  const reflowBytes = png(320, 900);
  const reflowDigest = new Bun.CryptoHasher("sha256").update(reflowBytes).digest("hex");
  const validReflowOracle = { ...reflowOracle, runs: reflowOracle.runs.map(run => ({ ...run, observations: run.observations.map(item => ({ ...item, screenshotDigest: reflowDigest })) })) };
  expect(() => validateScreenshotArtifact(reflowBytes, reflowDigest, undefined, validReflowOracle)).not.toThrow();
});

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
  test("publishes manifest completion and trusted producer policy schema fields", async () => {
    const ajv = new Ajv2020({ strict: true });
    const manifestSchema = JSON.parse(await Bun.file(`${import.meta.dir}/../../contracts/verification-manifest.schema.json`).text()) as object;
    const policySchema = JSON.parse(await Bun.file(`${import.meta.dir}/../../contracts/trusted-producer-policy.schema.json`).text()) as object;
    const planSchema = JSON.parse(await Bun.file(`${import.meta.dir}/../../contracts/verification-plan.schema.json`).text()) as object;
    const validateManifest = ajv.compile(manifestSchema);
    const validatePolicy = ajv.compile(policySchema);
    expect(validateManifest({
      schemaVersion: "verification-manifest/v1",
      obligations: [{ id: "obligation:condition:command", executionCompletionPath: "/secure/completion.json" }],
    })).toBe(true);
    expect(validateManifest({
      schemaVersion: "verification-manifest/v1",
      obligations: [{ id: "obligation:condition:command", executable: "/usr/bin/true", executionCompletionPath: "relative.json" }],
    })).toBe(false);
    expect(validateManifest({
      schemaVersion: "verification-manifest/v1",
      obligations: [{ id: "obligation:condition:command" }],
    })).toBe(false);
    expect(validateManifest({
      schemaVersion: "verification-manifest/v1",
      obligations: [{ id: "obligation:condition:command", executionCompletionPath: "/secure/completion.json", argv: ["--caller-local"] }],
    })).toBe(false);
    expect(validateManifest({
      schemaVersion: "verification-manifest/v1",
      obligations: [{ id: "obligation:condition:command", executable: "/usr/bin/true", executionCompletionArtifacts: [] }],
    })).toBe(false);
    expect(validateManifest({
      schemaVersion: "verification-manifest/v1",
      obligations: [{ id: "obligation:condition:command", executable: "/usr/bin/true", unknownField: true }],
    })).toBe(false);
    const policy = { schemaVersion: "trusted-producer-policy/v1", issuer: "trusted-ci", keyId: "a".repeat(64), publicKeyPem: "PUBLIC KEY" };
    expect(validatePolicy(policy)).toBe(true);
    expect(validatePolicy({ ...policy, signer: "/tmp/caller-controlled" })).toBe(false);
    const regionSchema = (planSchema as { properties: { obligations: { items: { properties: { uiResilienceRequirement: { properties: { requiredRuns: { items: { properties: { regions: { items: object } } } } } } } } } } }).properties.obligations.items.properties.uiResilienceRequirement.properties.requiredRuns.items.properties.regions.items;
    const validateRegion = ajv.compile(regionSchema);
    expect(validateRegion({ regionId: "region:label", policy: "truncate-with-access", basisIds: ["basis:layout"], maxLines: 2 })).toBe(true);
    expect(validateRegion({ regionId: "region:label", policy: "truncate-with-access", basisIds: ["basis:layout"] })).toBe(false);
    expect(validateRegion({ regionId: "region:label", policy: "wrap", basisIds: ["basis:layout"], maxLines: 2 })).toBe(false);
  });
  test("rejects unknown and contradictory manifest field combinations", async () => {
    const fixtureValue = await fixture();
    try {
      const original = JSON.parse(await readFile(fixtureValue.manifest, "utf8")) as { schemaVersion: string; obligations: Array<Record<string, unknown>> };
      const command = original.obligations[0]!;
      const variants = [
        { ...command, unknownField: true },
        { id: command.id, executionCompletionPath: join(fixtureValue.config, "completion.json"), argv: ["--local-only"] },
        { ...command, executionCompletionArtifacts: [] },
      ];
      for (const obligation of variants) {
        await writeFile(fixtureValue.manifest, JSON.stringify({ ...original, obligations: [obligation] }));
        const stderr: string[] = [];
        expect(await runVerify(
          ["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", fixtureValue.request, "--manifest", fixtureValue.manifest],
          () => undefined,
          text => stderr.push(text),
        )).toBe(64);
        expect(stderr.join("")).toMatch(/unknown fields|local execution fields require executable|executionCompletionArtifacts require executionCompletionPath/);
      }
    } finally {
      await fixtureValue.cleanup();
    }
  });
  test("falls back to a configured executable when an optional completion is absent", async () => {
    const fixtureValue = await fixture();
    try {
      const manifest = JSON.parse(await readFile(fixtureValue.manifest, "utf8")) as { schemaVersion: string; obligations: Array<Record<string, unknown>> };
      manifest.obligations[0]!.executionCompletionPath = join(fixtureValue.config, "not-published.json");
      manifest.obligations[0]!.executionCompletionArtifacts = [];
      await writeFile(fixtureValue.manifest, JSON.stringify(manifest));
      const stderr: string[] = [];
      const status = await runVerify(
        ["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", fixtureValue.request, "--manifest", fixtureValue.manifest],
        () => undefined,
        text => stderr.push(text),
      );
      expect({ status, stderr }).toEqual({ status: 0, stderr: [] });
    } finally {
      await fixtureValue.cleanup();
    }
  });
  test("keeps local command provenance below independent-producer", async () => {
    const fixtureValue = await fixture();
    try {
      const stdout: string[] = [];
      expect(await runVerify(
        ["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", fixtureValue.request, "--manifest", fixtureValue.manifest],
        text => stdout.push(text),
        () => undefined,
      )).toBe(0);
      const report = JSON.parse(stdout.join("")) as { documents: { execution: { observations: Array<{ producer: { kind: string; identity: string; independence: string } }> } } };
      expect(report.documents.execution.observations[0]!.producer).toEqual({ kind: "harness-managed", identity: "traceknot-cli", independence: "separate-verification-context" });
    } finally {
      await fixtureValue.cleanup();
    }
  });

  test("rejects a present external completion when no trusted policy is installed", async () => {
    const fixtureValue = await fixture();
    try {
      const completionPath = join(fixtureValue.config, "present-completion.json");
      await writeFile(completionPath, "{}");
      const manifest = JSON.parse(await readFile(fixtureValue.manifest, "utf8")) as { schemaVersion: string; obligations: Array<Record<string, unknown>> };
      manifest.obligations[0]!.executionCompletionPath = completionPath;
      manifest.obligations[0]!.executionCompletionArtifacts = [];
      await writeFile(fixtureValue.manifest, JSON.stringify(manifest));
      const stderr: string[] = [];
      expect(await runVerify(
        ["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", fixtureValue.request, "--manifest", fixtureValue.manifest],
        () => undefined,
        text => stderr.push(text),
      )).toBe(64);
      expect(stderr.join("")).toContain("trusted producer policy");
    } finally {
      await fixtureValue.cleanup();
    }
  });



  test("validates a real Ed25519 completion and fails closed without an installed trust policy", async () => {
    const fixtureValue = await fixture();
    const tamperedState = await mkdtemp(join(tmpdir(), "traceknot-cli-tampered-state-"));
    const externalState = await mkdtemp(join(tmpdir(), "traceknot-cli-external-state-"));
    try {
      const baselineStdout: string[] = [];
      expect(await runVerify(
        ["--root", fixtureValue.root, "--state-dir", fixtureValue.state, "--request", fixtureValue.request, "--manifest", fixtureValue.manifest],
        text => baselineStdout.push(text),
        () => undefined,
      )).toBe(0);
      const baseline = JSON.parse(baselineStdout.join("")) as {
        documents: { execution: { authorities: Array<{ binding: VerificationExecutionAuthorityBinding }> } };
      };
      const localBinding = baseline.documents.execution.authorities[0]?.binding;
      if (!localBinding) throw new Error("missing baseline authority binding");
      const baselineArtifactStore = new LocalArtifactStore(join(fixtureValue.state, "artifacts"));
      const executionCompletionArtifacts: Array<{ type: string; digest: string; path: string }> = [];
      try {
        const seen = new Set<string>();
        for (const [index, artifact] of localBinding.artifacts.entries()) {
          const key = `${artifact.type}\u0000${artifact.digest}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const bytes = await baselineArtifactStore.readArtifact(artifact.digest);
          if (!bytes) throw new Error(`missing baseline artifact ${artifact.digest}`);
          const path = join(fixtureValue.config, `external-artifact-${index}.bin`);
          await writeFile(path, bytes);
          executionCompletionArtifacts.push({ type: artifact.type, digest: artifact.digest, path });
        }
      } finally {
        await baselineArtifactStore.close();
      }
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const keyId = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
      const producer = { kind: "external-system", identity: "trusted-ci", independence: "independent-producer" } as const;
      const execution: VerificationExecutionAuthorityBinding["execution"] = { ...localBinding.execution, identity: producer.identity };
      const binding: VerificationExecutionAuthorityBinding = { ...localBinding, producer, execution };
      const signature = sign(null, Buffer.from(canonicalizeJson(binding)), privateKey).toString("base64url");
      const authority = {
        schemaVersion: "verification-execution-authority/v1" as const,
        authorityId: `ed25519:${keyId}:${createHash("sha256").update(signature).digest("hex")}`,
        issuer: producer.identity,
        binding,
        keyId,
        signature,
      };
      const policy: TrustedProducerPolicy = { schemaVersion: "trusted-producer-policy/v1", issuer: producer.identity, keyId, publicKeyPem };
      expect(verifyTrustedAuthority(policy, authority, binding)).toBe(true);
      const output: VerificationExecutionOutput = {
        status: "PASS",
        runId: binding.runId,
        requestId: binding.requestId,
        snapshotId: binding.snapshotId,
        idempotencyKey: binding.idempotencyKey,
        producer,
        summary: binding.result.summary,
        artifacts: binding.artifacts,
        executionKind: execution.kind,
        identity: execution.identity,
        ...(execution.exitCode === undefined ? {} : { exitCode: execution.exitCode }),
      };
      const completion: VerificationExecutionCompletionEnvelope = {
        schemaVersion: "verification-execution-completion/v1",
        runId: binding.runId,
        requestId: binding.requestId,
        rootIdentity: binding.rootIdentity,
        snapshotId: binding.snapshotId,
        planDigest: binding.planDigest,
        obligationId: binding.obligationId,
        idempotencyKey: binding.idempotencyKey,
        output,
        authority,
      };
      const completionPath = join(fixtureValue.config, "completion.json");
      const externalManifestPath = join(fixtureValue.config, "external-manifest.json");
      await writeFile(completionPath, JSON.stringify(completion));
      await writeFile(externalManifestPath, JSON.stringify({
        schemaVersion: "verification-manifest/v1",
        obligations: [{ id: binding.obligationId, executionCompletionPath: completionPath, executionCompletionArtifacts }],
      }));
      const tamperedCompletionPath = join(fixtureValue.config, "tampered-completion.json");
      const tamperedManifestPath = join(fixtureValue.config, "tampered-manifest.json");
      const tamperedAuthority = { ...authority, signature: `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}` };
      expect(verifyTrustedAuthority(policy, tamperedAuthority, binding)).toBe(false);
      await writeFile(tamperedCompletionPath, JSON.stringify({ ...completion, authority: tamperedAuthority }));
      await writeFile(tamperedManifestPath, JSON.stringify({
        schemaVersion: "verification-manifest/v1",
        obligations: [{
          id: binding.obligationId,
          executionCompletionPath: tamperedCompletionPath,
          executionCompletionArtifacts: executionCompletionArtifacts.map(artifact => ({ ...artifact, path: join(fixtureValue.config, "must-not-be-read.bin") })),
        }],
      }));
      const tamperedErrors: string[] = [];
      expect(await runVerify(
        ["--root", fixtureValue.root, "--state-dir", tamperedState, "--request", fixtureValue.request, "--manifest", tamperedManifestPath],
        () => undefined,
        text => tamperedErrors.push(text),
      )).toBe(64);
      expect(tamperedErrors.join("")).toContain("trusted producer policy");
      expect(tamperedErrors.join("")).not.toContain("must-not-be-read");
      const stderr: string[] = [];
      expect(await runVerify(
        ["--root", fixtureValue.root, "--state-dir", externalState, "--request", fixtureValue.request, "--manifest", externalManifestPath],
        () => undefined,
        text => stderr.push(text),
      )).toBe(64);
      expect(stderr.join("")).toContain("trusted producer policy");
    } finally {
      await Promise.all([fixtureValue.cleanup(), rm(externalState, { recursive: true, force: true }), rm(tamperedState, { recursive: true, force: true })]);
    }
  });


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
      expect(status).toBe(1);
      const failedCommandReport = JSON.parse(stdout.join("")) as { verdict: { qaVerdict: string } };
      expect(failedCommandReport.verdict.qaVerdict).toBe("FAIL");
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

  test("ingests self-authored visual evidence without elevating it to independent-producer PASS", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceknot-cli-visual-repo-"));
    const config = await mkdtemp(join(tmpdir(), "traceknot-cli-visual-config-"));
    const state = await mkdtemp(join(tmpdir(), "traceknot-cli-visual-state-"));
    try {
      const fullPath = join(root, "full-page.png");
      const focusedPath = join(root, "focused-region.png");
      const fullBytes = png(1440, 900);
      const focusedBytes = png(900, 500);
      const resilienceBytes = png(900, 500);
      const resilienceDigest = new Bun.CryptoHasher("sha256").update(resilienceBytes).digest("hex");
      const fullDigest = new Bun.CryptoHasher("sha256").update(fullBytes).digest("hex");
      const focusedDigest = new Bun.CryptoHasher("sha256").update(focusedBytes).digest("hex");
      const resilienceFixtureKinds = {
        "text-overflow": ["representative", "long-natural-language", "long-unbroken-token"],
        "resize-text-200": ["representative", "long-natural-language"],
        "reflow-320": ["representative", "long-natural-language", "long-unbroken-token"],
        "text-spacing-wcag": ["representative", "long-natural-language"],
        "pseudo-localization": ["pseudo-expanded"],
        rtl: ["rtl"],
        "reduced-motion": ["representative"],
        "hover-focus-content": ["representative"],
      } as const satisfies Readonly<Record<UiResilienceProfile, readonly string[]>>;
      const resilienceProfiles = Object.keys(resilienceFixtureKinds) as UiResilienceProfile[];
      const profileEvidence = (profile: UiResilienceProfile) => {
        if (profile === "text-overflow") return { profile };
        if (profile === "resize-text-200") return { profile, textScalePercent: 200 };
        if (profile === "reflow-320") return { profile, innerWidth: 320, innerHeight: 900, writingMode: "horizontal" };
        if (profile === "text-spacing-wcag") return { profile, lineHeightRatio: 1.5, paragraphSpacingRatio: 2, letterSpacingRatio: 0.12, wordSpacingRatio: 0.16, onlySpacingPropertiesChanged: true };
        if (profile === "pseudo-localization") return { profile, locale: "en-XA", expansionRatio: 1.4, pseudoLocale: true };
        if (profile === "rtl") return { profile, direction: "rtl", locale: "ar" };
        if (profile === "reduced-motion") return { profile, preference: "reduce", nonEssentialMotionDisabled: true };
        return { profile, dismissible: true, hoverable: true, persistent: true };
      };
      let resilienceMarker = 0;
      const resilienceScreenshots = new Map(resilienceProfiles.flatMap(profile => resilienceFixtureKinds[profile].map(fixtureKind => {
        const bytes = profile === "reflow-320" ? png(320, 900, ++resilienceMarker) : png(1440, 900, ++resilienceMarker);
        const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        return [`${profile}\u0000${fixtureKind}`, { bytes, digest, path: `ui-resilience-${resilienceMarker}.png` }] as const;
      })));
      await writeFile(join(root, "input.txt"), "clean\n");
      await writeFile(fullPath, fullBytes);
      await writeFile(focusedPath, focusedBytes);
      await Promise.all([...resilienceScreenshots.values()].map(screenshot => writeFile(join(root, screenshot.path), screenshot.bytes)));
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
        uiResilience: {
          schemaVersion: "ui-resilience-scope/v1",
          decision: "required",
          basisIds: ["basis-layout"],
          rationale: "The responsive surface exercises every adaptive UI profile.",
          viewports: [{ id: "desktop", width: 1440, height: 900 }],
          surfaces: [{
            surfaceId: "surface-catalog",
            stateIds: ["populated"],
            viewportIds: ["desktop"],
            capabilities: ["rendered-text", "responsive-layout", "localized-content", "rtl-content", "animation", "hover-focus-content"],
            fixtures: [
              { fixtureId: "representative", kind: "representative", contentDigest: resilienceDigest },
              { fixtureId: "natural", kind: "long-natural-language", contentDigest: resilienceDigest },
              { fixtureId: "token", kind: "long-unbroken-token", contentDigest: resilienceDigest },
              { fixtureId: "pseudo", kind: "pseudo-expanded", contentDigest: resilienceDigest },
              { fixtureId: "rtl", kind: "rtl", contentDigest: resilienceDigest },
            ],
            regions: [{ regionId: "main", policy: "no-overflow", basisIds: ["basis-layout"] }],
            profileApplicability: resilienceProfiles.map(profile => ({ profile, status: "required" as const, basisIds: ["basis-layout"], rationale: `${profile} applies to the exercised surface.` })),
          }],
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
            { evidenceId: "evidence:catalog:populated:desktop:focused-region", role: "focused-region", regionId: "main", digest: focusedDigest },
          ],
          regions: [
            { regionId: "main", role: "primary", x: 0, y: 0, width: 900, height: 500 },
            { regionId: "supporting", role: "supporting", x: 0, y: 532, width: 900, height: 200 },
          ],
          assertions: [{ assertionId: "section-gap", relation: "separation", axis: "vertical", regionIds: ["main", "supporting"], operator: "greater-than-or-equal", expected: 32, actual: 32, unit: "css-px", source: { kind: "explicit-basis", basisId: "basis-layout" } }],
        }],
        representativeStateLimitations: [],
        blockingReasons: [],
      };
      const uiOracle = {
        schemaVersion: "ui-resilience-oracle/v1",
        oracleId: "oracle:cli-ui-resilience",
        requestId: request.requestId,
        snapshotId: snapshot.snapshotId,
        conditionId: "condition:request-ui-resilience",
        producer: { kind: "ci", identity: "traceknot-cli", independence: "independent-producer" },
        runs: resilienceProfiles.flatMap(profile => resilienceFixtureKinds[profile].map((fixtureKind, index) => ({
          runId: `run:catalog:${profile}:${fixtureKind}`,
          surfaceId: "surface-catalog",
          stateId: "populated",
          viewportId: "desktop",
          viewport: { id: "desktop", width: 1440, height: 900 },
          profile,
          fixtureId: fixtureKind === "long-natural-language" ? "natural" : fixtureKind === "long-unbroken-token" ? "token" : fixtureKind === "pseudo-expanded" ? "pseudo" : fixtureKind,
          fixtureContentDigest: resilienceDigest,
          browser: "Chromium 140",
          userAgent: "cli-test",
          profileEvidence: profileEvidence(profile),
          observations: [{ observationId: `observation:catalog:main:${profile}:${index}`, regionId: "main", policy: "no-overflow", clientWidth: 900, clientHeight: 500, scrollWidth: 900, scrollHeight: 500, fragmentRects: [{ x: 0, y: 0, width: 900, height: 500 }], clippingAncestors: [], paintFeatures: [], renderedLineCount: 1, contentTruncated: false, truncationIndicatorVisible: false, screenshotDigest: resilienceScreenshots.get(`${profile}\u0000${fixtureKind}`)!.digest }],
        }))),
        blockingReasons: [],
      };
      const requestPath = join(config, "request.json");
      const oraclePath = join(config, "oracle.json");
      const manifestPath = join(config, "manifest.json");
      const uiOraclePath = join(config, "ui-oracle.json");
      const command = (id: string) => ({ id, executable: "/usr/bin/true" });
      const visualCommand = {
        ...command("obligation:condition:request-visual-composition"),
        visualCompositionOraclePath: oraclePath,
        declaredArtifacts: [
          { type: "screenshot", digest: fullDigest, path: "full-page.png" },
          { type: "screenshot", digest: focusedDigest, path: "focused-region.png" },
        ],
      };
      const uiCommand = {
        ...command("obligation:condition:request-ui-resilience"),
        uiResilienceOraclePath: uiOraclePath,
        declaredArtifacts: [...resilienceScreenshots.values()].map(screenshot => ({ type: "screenshot", digest: screenshot.digest, path: screenshot.path })),
      };
      const manifest = { schemaVersion: "verification-manifest/v1", obligations: [command("obligation:condition:basis-layout"), command("obligation:condition:request-browser"), visualCommand, uiCommand] };
      await writeFile(requestPath, JSON.stringify(request));
      await writeFile(oraclePath, JSON.stringify(oracle));
      await writeFile(uiOraclePath, JSON.stringify(uiOracle));
      await writeFile(manifestPath, JSON.stringify(manifest));
      const stdout: string[] = [];
      const stderr: string[] = [];
      const status = await runVerify(["--root", root, "--state-dir", state, "--request", requestPath, "--manifest", manifestPath], text => stdout.push(text), text => stderr.push(text));
      expect({ status, stderr }).toEqual({ status: 3, stderr: [] });
      const report = JSON.parse(stdout.join("")) as { verdict: { qaVerdict: string }; documents: { execution: { observations: Array<{ observationId: string; artifacts: Array<{ type: string; digest: string; path?: string }> }>; evidence: Array<{ obligationId: string; visualCompositionOracleDigest?: string }> } } };
      expect(report.verdict.qaVerdict).toBe("INCOMPLETE");
      const visualObservation = report.documents.execution.observations.find(item => item.observationId.includes("visual-composition"));
      expect(visualObservation?.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "screenshot", digest: fullDigest }), expect.objectContaining({ type: "screenshot", digest: focusedDigest })]));
      expect(report.documents.execution.evidence.find(item => item.obligationId.includes("visual-composition"))?.visualCompositionOracleDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(stdout.join("")).toContain("ORACLE_PRODUCER_MISMATCH");
      const undersizedBytes = png(900, 501);
      const undersizedDigest = new Bun.CryptoHasher("sha256").update(undersizedBytes).digest("hex");
      await writeFile(focusedPath, undersizedBytes);
      git(root, ["add", "focused-region.png"]);
      git(root, ["commit", "-qm", "undersized focused screenshot"]);
      const undersizedSnapshot = await captureGitSnapshotIdentity(root);
      const undersizedRequest = { ...request, requestId: "cli-visual-undersized-focus", project: { rootIdentity: undersizedSnapshot.rootIdentity, snapshotId: undersizedSnapshot.snapshotId } };
      const undersizedOracle = {
        ...oracle,
        oracleId: "oracle:cli-visual-undersized-focus",
        requestId: undersizedRequest.requestId,
        snapshotId: undersizedSnapshot.snapshotId,
        captures: oracle.captures.map(capture => ({ ...capture, screenshots: capture.screenshots.map(screenshot => screenshot.role === "focused-region" ? { ...screenshot, digest: undersizedDigest } : screenshot), regions: capture.regions.map(region => region.regionId === "main" ? { ...region, width: 900.1 } : region) })),
      };
      const undersizedManifest = {
        ...manifest,
        obligations: manifest.obligations.map(obligation => obligation.id === visualCommand.id ? { ...visualCommand, declaredArtifacts: [{ type: "screenshot", digest: fullDigest, path: "full-page.png" }, { type: "screenshot", digest: undersizedDigest, path: "focused-region.png" }] } : obligation),
      };
      await writeFile(requestPath, JSON.stringify(undersizedRequest));
      await writeFile(oraclePath, JSON.stringify(undersizedOracle));
      await writeFile(manifestPath, JSON.stringify(undersizedManifest));
      const undersizedStderr: string[] = [];
      const undersizedStatus = await runVerify(["--root", root, "--state-dir", state, "--request", requestPath, "--manifest", manifestPath], () => undefined, text => undersizedStderr.push(text));
      expect({ status: undersizedStatus, stderr: undersizedStderr }).toEqual({ status: 64, stderr: [`invalid screenshot artifact ${undersizedDigest}: dimensions do not cover focused region main\n`] });
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
          regions: capture.regions.map(region => region.regionId === "main" ? { ...region, width: 390, height: 400 } : { ...region, y: 432, width: 390, height: 160 }),
        })),
      };
      const fractionalUiOracle = { ...uiOracle, oracleId: "oracle:cli-ui-resilience-fractional", requestId: fractionalRequest.requestId, snapshotId: fractionalSnapshot.snapshotId };
      const fractionalManifest = {
        ...manifest,
        obligations: manifest.obligations.map(obligation => obligation.id === visualCommand.id ? { ...visualCommand, declaredArtifacts: [{ type: "screenshot", digest: fractionalDigest, path: "full-page.png" }, { type: "screenshot", digest: focusedDigest, path: "focused-region.png" }] } : obligation),
      };
      await writeFile(requestPath, JSON.stringify(fractionalRequest));
      await writeFile(oraclePath, JSON.stringify(fractionalOracle));
      await writeFile(uiOraclePath, JSON.stringify(fractionalUiOracle));
      await writeFile(manifestPath, JSON.stringify(fractionalManifest));
      const fractionalStdout: string[] = [];
      const fractionalStderr: string[] = [];
      const fractionalStatus = await runVerify(["--root", root, "--state-dir", state, "--request", requestPath, "--manifest", manifestPath], text => fractionalStdout.push(text), text => fractionalStderr.push(text));
      expect({ status: fractionalStatus, stderr: fractionalStderr, verdict: JSON.parse(fractionalStdout.join("")).verdict.qaVerdict }).toEqual({ status: 3, stderr: [], verdict: "INCOMPLETE" });
      const failedArtifactBytes = new TextEncoder().encode("not a screenshot\n");
      const failedArtifactDigest = new Bun.CryptoHasher("sha256").update(failedArtifactBytes).digest("hex");
      await writeFile(join(root, "failed-artifact.bin"), failedArtifactBytes);
      git(root, ["add", "failed-artifact.bin"]);
      git(root, ["commit", "-qm", "failed command diagnostic artifact"]);
      const failedSnapshot = await captureGitSnapshotIdentity(root);
      const failedRequest = { ...request, requestId: "cli-visual-command-failed", project: { rootIdentity: failedSnapshot.rootIdentity, snapshotId: failedSnapshot.snapshotId } };
      const failedManifest = {
        ...manifest,
        obligations: manifest.obligations.map(obligation => obligation.id === visualCommand.id ? { id: visualCommand.id, executable: "/usr/bin/false", visualCompositionOraclePath: join(config, "missing-oracle.json"), declaredArtifacts: [{ type: "screenshot", digest: failedArtifactDigest, path: "failed-artifact.bin" }, { type: "screenshot", digest: "f".repeat(64), path: "missing-screenshot.png" }] } : obligation),
      };
      await writeFile(requestPath, JSON.stringify(failedRequest));
      await writeFile(manifestPath, JSON.stringify(failedManifest));
      const failedStdout: string[] = [];
      const failedStderr: string[] = [];
      const failedStatus = await runVerify(["--root", root, "--state-dir", state, "--request", requestPath, "--manifest", manifestPath], text => failedStdout.push(text), text => failedStderr.push(text));
      const failedReport = JSON.parse(failedStdout.join("")) as { verdict: { qaVerdict: string }; documents: { execution: { observations: Array<{ observationId: string; artifacts: Array<{ type: string; digest: string }> }> } } };
      const failedVisualObservation = failedReport.documents.execution.observations.find(item => item.observationId.includes("visual-composition"));
      expect({ status: failedStatus, stderr: failedStderr, verdict: failedReport.verdict.qaVerdict }).toEqual({ status: 2, stderr: [], verdict: "BLOCKED" });
      expect(failedVisualObservation?.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "verification-result", digest: failedArtifactDigest })]));
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(config, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]);
    }
  }, 30_000);
});
