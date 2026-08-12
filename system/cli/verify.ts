import { createHash } from "node:crypto";
import { mkdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import type { Artifact, Producer } from "../core/qa-core";
import { isVisualCompositionOracle, type VisualCompositionOracle } from "../core/visual-composition";
import {
  buildVerificationPlan,
  canonicalizeJson,
  type ExecutionAuthority,
  type FreshnessAuthority,
  type VerificationExecutionOutput,
  type VerificationRequest,
  type VerificationRunDependencies,
  runVerification,
  establishTestBasis,
  performRiskDiscovery,
} from "../runtime/verification-run";
import { captureGitSnapshotIdentity } from "../runtime/git-snapshot";
import { LocalArtifactStore } from "../runtime/local-artifact-store";
import { LocalShellCollector, type ShellArtifactDeclaration } from "../runtime/local-shell-collector";
import { FileVerificationRepository } from "../runtime/file-repository";
import { closeSecureRoot, openSecureRoot, readSecureRegularFile } from "../runtime/local-artifact-store";

export const VERIFY_EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, BLOCKED: 2, INCOMPLETE: 3, USAGE: 64, INTERNAL: 70 });
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_ENV = new Set(["HOME", "TMPDIR", "LANG", "LC_ALL"]);

type ManifestCommand = Readonly<{
  id: string;
  executable: string;
  argv?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxArtifactBytes?: number;
  declaredArtifacts?: readonly ShellArtifactDeclaration[];
  visualCompositionOraclePath?: string;
  toolVersion?: string;
}>;
type VerifyManifest = Readonly<{ schemaVersion: "verification-manifest/v1"; obligations: readonly ManifestCommand[] }>;
type CliOptions = Readonly<{ requestPath?: string; manifestPath?: string; rootDir: string; stateDir: string; artifactDir: string; runId?: string; expectedHead?: string; format: "json" | "markdown"; reportOnly: boolean; help: boolean }>;
type CliReport = Readonly<{ schemaVersion: "traceknot-cli-report/v1"; run: unknown; verdict: unknown; snapshot: Readonly<{ rootIdentity: string; snapshotId: string; head: string; dirty: boolean }>; documents?: unknown }>;

function usage(): string {
  return [
    "traceknot verify --request REQUEST.json --manifest MANIFEST.json [options]",
    "traceknot verify --run-id ID --report-only [options]",
    "",
    "Options:",
    "  --root DIR              Git repository root (default: current directory)",
    "  --state-dir DIR         Durable run state outside the repository",
    "  --artifact-dir DIR      Content-addressed artifact root",
    "  --run-id ID             Durable run identifier (default: requestId)",
    "  --expected-head OID      Require this clean Git HEAD commit",
    "  --format json|markdown   Report format (default: json)",
    "  --report-only           Read an existing run without executing commands",
    "  --help                  Show this message",
  ].join("\n");
}

function fail(message: string): never { throw new Error(message); }
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodePngDimensions(bytes: Uint8Array): Readonly<{ width: number; height: number }> {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((byte, index) => bytes[index] !== byte)) fail("screenshot artifact is not a supported PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let sawHeader = false;
  let sawPalette = false;
  let sawEnd = false;
  const compressed: Uint8Array[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail("screenshot PNG is truncated");
    const length = view.getUint32(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) fail("screenshot PNG chunk is truncated");
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = new TextDecoder("ascii", { fatal: true }).decode(typeBytes);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const crcInput = bytes.subarray(offset + 4, offset + 8 + length);
    if (crc32(crcInput) !== view.getUint32(offset + 8 + length)) fail("screenshot PNG checksum is invalid");
    if (!sawHeader && type !== "IHDR") fail("screenshot PNG is missing its leading IHDR");
    if (type === "IHDR") {
      if (sawHeader || length !== 13) fail("screenshot PNG has an invalid IHDR");
      width = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (!width || !height || width * height > 50_000_000 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) fail("screenshot PNG dimensions or encoding are unsupported");
      const depths: Readonly<Record<number, readonly number[]>> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[colorType]?.includes(bitDepth)) fail("screenshot PNG color format is unsupported");
      sawHeader = true;
    } else if (type === "PLTE") {
      sawPalette = true;
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      if (length !== 0) fail("screenshot PNG has an invalid IEND");
      sawEnd = true;
      offset = chunkEnd;
      break;
    } else if ((typeBytes[0]! & 0x20) === 0) {
      fail(`screenshot PNG contains unsupported critical chunk ${type}`);
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawEnd || offset !== bytes.length || compressed.length === 0 || (colorType === 3 && !sawPalette)) fail("screenshot PNG structure is incomplete");
  const channels = colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const rowBytes = Math.ceil(width * channels * bitDepth / 8);
  const expectedBytes = (rowBytes + 1) * height;
  if (expectedBytes > 256 * 1024 * 1024) fail("screenshot PNG decoded payload is too large");
  let decoded: Uint8Array;
  try {
    decoded = inflateSync(Buffer.concat(compressed.map(chunk => Buffer.from(chunk))), { maxOutputLength: expectedBytes });
  } catch {
    fail("screenshot PNG pixel data cannot be decoded");
  }
  if (decoded.length !== expectedBytes) fail("screenshot PNG pixel dimensions do not match IHDR");
  for (let row = 0; row < height; row++) if (decoded[row * (rowBytes + 1)]! > 4) fail("screenshot PNG uses an invalid row filter");
  return { width, height };
}
function assertPlain(value: unknown, path = "$"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((child, index) => assertPlain(child, `${path}[${index}]`)); return; }
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) fail(`unsafe input key at ${path}.${key}`);
    assertPlain(child, `${path}.${key}`);
  }
}
async function readBoundedJson(path: string): Promise<unknown> {
  let root;
  try {
    const absolute = resolve(path);
    root = await openSecureRoot(dirname(absolute));
    const bytes = await readSecureRegularFile(root.fd, basename(absolute), MAX_INPUT_BYTES);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    assertPlain(value);
    return value;
  } catch (error) {
    if (error instanceof Error && /^(invalid input file|unsafe input key)/.test(error.message)) throw error;
    throw new Error(`invalid input file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (root) await closeSecureRoot(root);
  }
}
function parseArgs(argv: readonly string[]): CliOptions {
  let rootDir = process.cwd();
  let stateDir = "";
  let artifactDir = "";
  let requestPath: string | undefined;
  let manifestPath: string | undefined;
  let runId: string | undefined;
  let expectedHead: string | undefined;
  let format: "json" | "markdown" = "json";
  let reportOnly = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => { const value = argv[++i]; if (!value || value.startsWith("--")) fail(`missing value for ${arg}`); return value; };
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--root") rootDir = next();
    else if (arg === "--state-dir") stateDir = next();
    else if (arg === "--artifact-dir") artifactDir = next();
    else if (arg === "--request") requestPath = next();
    else if (arg === "--manifest" || arg === "--config") manifestPath = next();
    else if (arg === "--run-id") runId = next();
    else if (arg === "--expected-head") expectedHead = next();
    else if (arg === "--format") { const value = next(); if (value !== "json" && value !== "markdown") fail("--format must be json or markdown"); format = value; }
    else if (arg === "--report-only") reportOnly = true;
    else fail(`unknown option: ${arg}`);
  }
  const absoluteRoot = resolve(rootDir);
  if (!stateDir) stateDir = join(homedir(), ".cache", "traceknot", "runs", createHash("sha256").update(absoluteRoot).digest("hex").slice(0, 24));
  if (!artifactDir) artifactDir = join(stateDir, "artifacts");
  if (runId !== undefined && !SAFE_ID.test(runId)) fail("run-id contains unsafe characters");
  if (expectedHead !== undefined && !GIT_OBJECT_ID.test(expectedHead)) fail("expected-head must be a lowercase Git object ID");
  return { requestPath, manifestPath, rootDir: absoluteRoot, stateDir: resolve(stateDir), artifactDir: resolve(artifactDir), runId, expectedHead, format, reportOnly, help };
}
function requireString(value: unknown, label: string): string { if (typeof value !== "string" || !value || value.includes("\0")) fail(`${label} must be a non-empty NUL-free string`); return value; }
function validateManifest(value: unknown): VerifyManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("manifest must be an object");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== "verification-manifest/v1" || !Array.isArray(input.obligations) || input.obligations.length === 0) fail("manifest schemaVersion/obligations are invalid");
  const obligations: ManifestCommand[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of input.obligations.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`manifest obligations[${index}] must be an object`);
    const item = raw as Record<string, unknown>;
    const id = requireString(item.id, `manifest obligations[${index}].id`);
    if (ids.has(id)) fail(`manifest has duplicate obligation: ${id}`); ids.add(id);
    const executable = requireString(item.executable, `manifest obligations[${index}].executable`);
    if (!isAbsolute(executable)) fail(`manifest executable must be absolute: ${executable}`);
    const argv = item.argv === undefined ? undefined : Array.isArray(item.argv) ? item.argv.map((arg, n) => requireString(arg, `manifest argv[${n}]`)) : fail("manifest argv must be an array");
    const cwd = item.cwd === undefined ? undefined : requireString(item.cwd, "manifest cwd");
    const envValue = item.env;
    let env: Record<string, string> | undefined;
    if (envValue !== undefined) {
      if (!envValue || typeof envValue !== "object" || Array.isArray(envValue)) fail("manifest env must be an object");
      env = {};
      for (const [name, rawValue] of Object.entries(envValue)) {
        if (!SAFE_ENV.has(name)) fail(`manifest env key is not allowed: ${name}`);
        env[name] = requireString(rawValue, `manifest env.${name}`);
      }
    }
    const bounded = (key: string, max: number): number | undefined => {
      const rawValue = item[key];
      if (rawValue === undefined) return undefined;
      if (typeof rawValue !== "number" || !Number.isInteger(rawValue) || rawValue <= 0 || rawValue > max) fail(`manifest ${key} is outside its bound`);
      return rawValue;
    };
    const declared = item.declaredArtifacts;
    let declaredArtifacts: ShellArtifactDeclaration[] | undefined;
    if (declared !== undefined) {
      if (!Array.isArray(declared)) fail("manifest declaredArtifacts must be an array");
      declaredArtifacts = declared.map((rawDeclaration, n) => {
        if (!rawDeclaration || typeof rawDeclaration !== "object" || Array.isArray(rawDeclaration)) fail(`declaredArtifacts[${n}] must be an object`);
        const declaration = rawDeclaration as Record<string, unknown>;
        const type = requireString(declaration.type, "declared artifact type");
        const digest = requireString(declaration.digest, "declared artifact digest");
        if (!DIGEST.test(digest)) fail("declared artifact digest must be lowercase SHA-256");
        return { type, digest, path: requireString(declaration.path, "declared artifact path") };
      });
    }
    const visualCompositionOraclePath = item.visualCompositionOraclePath === undefined ? undefined : requireString(item.visualCompositionOraclePath, "manifest visualCompositionOraclePath");
    if (visualCompositionOraclePath !== undefined && !isAbsolute(visualCompositionOraclePath)) fail("manifest visualCompositionOraclePath must be absolute");
    obligations.push({ id, executable, ...(argv ? { argv } : {}), ...(cwd ? { cwd } : {}), ...(env ? { env } : {}), ...(bounded("timeoutMs", 600_000) ? { timeoutMs: bounded("timeoutMs", 600_000) } : {}), ...(bounded("maxOutputBytes", 256 * 1024 * 1024) ? { maxOutputBytes: bounded("maxOutputBytes", 256 * 1024 * 1024) } : {}), ...(bounded("maxArtifactBytes", 256 * 1024 * 1024) ? { maxArtifactBytes: bounded("maxArtifactBytes", 256 * 1024 * 1024) } : {}), ...(declaredArtifacts ? { declaredArtifacts } : {}), ...(visualCompositionOraclePath ? { visualCompositionOraclePath } : {}), ...(item.toolVersion === undefined ? {} : { toolVersion: requireString(item.toolVersion, "manifest toolVersion") }) });
  }
  obligations.sort((left, right) => left.id.localeCompare(right.id));
  return { schemaVersion: "verification-manifest/v1", obligations };
}
function validateRequest(value: unknown): VerificationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("request must be an object");
  const request = value as VerificationRequest;
  if (request.schemaVersion !== "verification-request/v1") fail("request schemaVersion is invalid");
  requireString(request.requestId, "request.requestId");
  if (!request.project || typeof request.project !== "object") fail("request.project is invalid");
  requireString(request.project.rootIdentity, "request.project.rootIdentity");
  requireString(request.project.snapshotId, "request.project.snapshotId");
  if (!request.change || typeof request.change !== "object" || !Array.isArray(request.change.paths) || request.change.paths.length === 0) fail("request.change is invalid");
  requireString(request.change.summary, "request.change.summary");
  request.change.paths.forEach(path => requireString(path, "request.change.paths"));
  if (!Array.isArray(request.testBasis) || request.testBasis.length === 0) fail("request.testBasis must not be empty");
  return request;
}
function isInside(base: string, candidate: string): boolean { const rel = relative(base, candidate); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
async function assertExternalDirectory(rootDir: string, directory: string, label: string): Promise<void> {
  if (isInside(rootDir, directory)) fail(`${label} must be outside the Git repository root to keep snapshots stable`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a real directory`);
}
async function assertExistingExternalDirectory(rootDir: string, directory: string, label: string): Promise<void> {
  if (isInside(rootDir, directory)) fail(`${label} must be outside the Git repository root to keep snapshots stable`);
  const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a real directory`);
}
function digest(value: unknown): string { return createHash("sha256").update(canonicalizeJson(value)).digest("hex"); }
function producer(): Producer { return { kind: "ci", identity: "traceknot-cli", independence: "independent-producer" }; }
function authorityFor(binding: Parameters<NonNullable<VerificationRunDependencies["executionAuthority"]["issueExecutionAuthority"]>>[0]): ExecutionAuthority {
  return { schemaVersion: "verification-execution-authority/v1", authorityId: `authority:${digest(binding).slice(0, 48)}`, issuer: "traceknot-cli", binding };
}
function freshnessAuthorityFor(binding: Parameters<NonNullable<VerificationRunDependencies["freshnessAuthority"]["issueFreshnessAuthority"]>>[0]): FreshnessAuthority {
  return { schemaVersion: "verification-freshness-authority/v1", authorityId: `freshness:${digest(binding).slice(0, 48)}`, issuer: "traceknot-cli", binding };
}
function renderMarkdown(report: CliReport): string {
  const verdict = report.verdict as Record<string, unknown>;
  const run = report.run as Record<string, unknown>;
  const lines = [`# Traceknot verification`, ``, `- Verdict: **${String(verdict.qaVerdict ?? "UNKNOWN")}**`, `- Run: \`${String(run.runId ?? "unknown")}\``, `- State: \`${String(run.state ?? "unknown")}\``, `- Snapshot: \`${report.snapshot.snapshotId}\``, `- Repository: \`${report.snapshot.rootIdentity}\``, ``, `## Rationale`, ``, String(verdict.rationale ?? "No rationale was persisted.")];
  return lines.join("\n") + "\n";
}
function reportOutput(report: CliReport, format: "json" | "markdown"): string { return format === "markdown" ? renderMarkdown(report) : JSON.stringify(report, null, 2) + "\n"; }
function exitForVerdict(value: unknown): number {
  const verdict = value && typeof value === "object" ? (value as Record<string, unknown>).qaVerdict : undefined;
  if (verdict === "PASS" || verdict === "PASS_WITH_ACCEPTED_RISK") return VERIFY_EXIT_CODES.PASS;
  if (verdict === "FAIL") return VERIFY_EXIT_CODES.FAIL;
  if (verdict === "BLOCKED") return VERIFY_EXIT_CODES.BLOCKED;
  return VERIFY_EXIT_CODES.INCOMPLETE;
}

async function makeDependencies(options: CliOptions, request: VerificationRequest, manifest: VerifyManifest | undefined, repository: FileVerificationRepository, snapshotId: string): Promise<{ dependencies: VerificationRunDependencies; close: () => Promise<void> }> {
  const mainStore = new LocalArtifactStore(options.artifactDir);
  const collectorStore = new LocalArtifactStore(join(options.artifactDir, "collector"));
  const collector = new LocalShellCollector({ rootDir: options.rootDir, rootIdentity: request.project.rootIdentity, snapshotId, artifactStore: collectorStore, toolVersion: "traceknot-cli", envAllowlist: ["HOME", "TMPDIR", "LANG", "LC_ALL"] });
  const commands = new Map((manifest?.obligations ?? []).map(command => [command.id, command]));
  const executionAuthority = { atomicCanonicalBindingIdempotency: true as const, issueExecutionAuthority: async (binding: Parameters<NonNullable<VerificationRunDependencies["executionAuthority"]["issueExecutionAuthority"]>>[0]) => authorityFor(binding), verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: Parameters<NonNullable<VerificationRunDependencies["executionAuthority"]["verifyExecutionAuthority"]>>[1]) => authority.issuer === "traceknot-cli" && canonicalizeJson(authority.binding) === canonicalizeJson(binding) };
  const freshnessAuthority = { atomicSameKeyIdempotency: true as const, issueFreshnessAuthority: async (binding: Parameters<NonNullable<VerificationRunDependencies["freshnessAuthority"]["issueFreshnessAuthority"]>>[0]) => freshnessAuthorityFor(binding), verifyFreshnessAuthority: async (authority: FreshnessAuthority, binding: Parameters<NonNullable<VerificationRunDependencies["freshnessAuthority"]["verifyFreshnessAuthority"]>>[1]) => authority.issuer === "traceknot-cli" && canonicalizeJson(authority.binding) === canonicalizeJson(binding) };
  type ManifestExecutionInput = Parameters<NonNullable<VerificationRunDependencies["executor"]["executeObligation"]>>[0];
  const executeManifestCommand = async (input: ManifestExecutionInput, executionKind: "command" | "browser"): Promise<VerificationExecutionOutput> => {
    const command = commands.get(input.obligation.id);
    if (!command) throw new Error(`manifest has no command for obligation ${input.obligation.id}`);
    const observation = await collector.collect({ requestId: input.requestId, snapshotId: input.snapshotId, rootIdentity: input.rootIdentity, observationId: `observation:${input.obligation.id}`, executable: command.executable, ...(command.argv ? { argv: command.argv } : {}), ...(command.cwd ? { cwd: command.cwd } : {}), ...(command.env ? { env: command.env } : {}), ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}), ...(command.maxOutputBytes ? { maxOutputBytes: command.maxOutputBytes } : {}), ...(command.declaredArtifacts ? { declaredArtifacts: command.declaredArtifacts } : {}), ...(command.toolVersion ? { toolVersion: command.toolVersion } : {}), producer: producer() });
    const status = observation.execution.exitStatus === "passed" ? "passed" : observation.execution.exitStatus === "blocked" ? "blocked" : "failed";
    let visualCompositionOracle: VisualCompositionOracle | undefined;
    if (input.obligation.visualCompositionRequirement) {
      if (command.visualCompositionOraclePath) {
        const candidate = await readBoundedJson(command.visualCompositionOraclePath);
        if (!isVisualCompositionOracle(candidate)) throw new Error(`manifest obligation ${command.id} visual composition oracle is invalid`);
        visualCompositionOracle = candidate;
      } else if (status === "passed") {
        throw new Error(`manifest obligation ${command.id} requires visualCompositionOraclePath`);
      }
    } else if (command.visualCompositionOraclePath) {
      throw new Error(`manifest obligation ${command.id} supplies a visual oracle for a non-visual obligation`);
    }
    const artifacts: Artifact[] = [];
    for (const artifact of observation.artifacts) {
      const bytes = await collectorStore.readArtifact(artifact.digest);
      const type = artifact.type === "screenshot" || artifact.type === "design-token-resolution" ? artifact.type : "verification-result";
      if (type === "screenshot") {
        let dimensions: Readonly<{ width: number; height: number }>;
        try {
          dimensions = decodePngDimensions(bytes);
        } catch (error) {
          throw new Error(`invalid ${error instanceof Error ? error.message : String(error)}`);
        }
        if (visualCompositionOracle) {
          const bindings = visualCompositionOracle.captures.flatMap(capture => capture.screenshots.filter(screenshot => screenshot.digest === artifact.digest).map(screenshot => ({ capture, screenshot })));
          if (bindings.length === 0) throw new Error(`invalid screenshot artifact ${artifact.digest}: not bound to a visual composition capture`);
          for (const { capture, screenshot } of bindings) {
            if (screenshot.role !== "full-page") continue;
            const scale = capture.viewport.devicePixelRatio ?? 1;
            const expectedWidth = capture.viewport.width * scale;
            const minimumHeight = capture.viewport.height * scale;
            if (!Number.isInteger(expectedWidth) || !Number.isInteger(minimumHeight) || dimensions.width !== expectedWidth || dimensions.height < minimumHeight) throw new Error(`invalid screenshot artifact ${artifact.digest}: dimensions do not match capture ${capture.captureId}`);
          }
        }
      }
      artifacts.push(await mainStore.storeArtifact({ type, digest: artifact.digest, path: artifact.path, bytes } as Artifact & { bytes: Uint8Array }, input));
    }
    return { status, runId: input.runId, requestId: input.requestId, snapshotId: input.snapshotId, idempotencyKey: input.idempotencyKey, producer: observation.producer, summary: `Command ${command.executable} completed with ${observation.execution.exitStatus}.`, artifacts, executionKind, identity: observation.execution.identity, ...(observation.execution.exitCode === undefined ? {} : { exitCode: observation.execution.exitCode }), ...(visualCompositionOracle ? { visualCompositionOracle } : {}) };
  };
  const executor = { atomicSameKeyIdempotency: true as const, executeObligation: (input: ManifestExecutionInput) => executeManifestCommand(input, "command") };
  const browserExecutor = { atomicSameKeyIdempotency: true as const, executeBrowser: (input: ManifestExecutionInput) => executeManifestCommand(input, "browser") };
  const artifactStore = { atomicSameKeyIdempotency: true as const, storeArtifact: async (artifact: Artifact, input: ManifestExecutionInput) => { const content = (artifact as Artifact & { bytes?: Uint8Array }).bytes; if (!content) { if (!await mainStore.hasArtifact(artifact.digest)) throw new Error(`artifact ${artifact.digest} was not published`); return artifact; } return mainStore.storeArtifact(artifact as Artifact & { bytes: Uint8Array }, input); } };
  const dependencies: VerificationRunDependencies = { repository, executor, browserExecutor, artifactStore, capabilityProvider: { has: () => true }, executionAuthority, freshnessPolicy: { evaluateFreshness: () => "fresh" }, freshnessAuthority, snapshotVerifier: async () => { const current = await captureGitSnapshotIdentity(options.rootDir); return current.rootIdentity === request.project.rootIdentity && current.snapshotId === request.project.snapshotId; }, now: () => new Date() };
  return { dependencies, close: async () => { await collectorStore.close(); await mainStore.close(); await repository.close(); } };
}

async function loadReport(repository: FileVerificationRepository, runId: string, snapshot: Awaited<ReturnType<typeof captureGitSnapshotIdentity>>): Promise<CliReport> {
  const run = await repository.loadRun(runId); if (!run) fail(`run does not exist: ${runId}`);
  const metadata = await repository.readMetadata(runId);
  const request = await repository.loadStageDocument(runId, "request");
  const verdict = await repository.loadStageDocument(runId, "verdict");
  if (!request || !verdict) fail("run is missing persisted request or verdict");
  if (!metadata || metadata.rootIdentity !== snapshot.rootIdentity || metadata.snapshotId !== snapshot.snapshotId || run.rootIdentity !== snapshot.rootIdentity || run.snapshotId !== snapshot.snapshotId) fail("current Git snapshot or persisted run metadata does not match the persisted run");
  return { schemaVersion: "traceknot-cli-report/v1", run, verdict, snapshot: { rootIdentity: snapshot.rootIdentity, snapshotId: snapshot.snapshotId, head: snapshot.headCommit, dirty: snapshot.dirty }, documents: { request, basis: await repository.loadStageDocument(runId, "basis"), discovery: await repository.loadStageDocument(runId, "discovery"), plan: await repository.loadStageDocument(runId, "plan"), execution: await repository.loadStageDocument(runId, "execution"), evidence: await repository.loadStageDocument(runId, "evidence"), residualRisk: await repository.loadStageDocument(runId, "residual-risk"), verdict } };
}

export async function runVerify(argv: readonly string[], stdout: (text: string) => void = text => process.stdout.write(text), stderr: (text: string) => void = text => process.stderr.write(text)): Promise<number> {
  let options: CliOptions;
  try { options = parseArgs(argv); } catch (error) { stderr(`${String(error instanceof Error ? error.message : error)}\n${usage()}\n`); return VERIFY_EXIT_CODES.USAGE; }
  if (options.help) { stdout(`${usage()}\n`); return VERIFY_EXIT_CODES.PASS; }
  let stores: { close: () => Promise<void> } | undefined;
  try {
    const snapshot = await captureGitSnapshotIdentity(options.rootDir);
    if (
      options.expectedHead !== undefined
      && (snapshot.headCommit !== options.expectedHead || snapshot.dirty)
    ) {
      fail(`current snapshot must match expected clean Git HEAD ${options.expectedHead}`);
    }
    if (options.reportOnly) {
      await assertExistingExternalDirectory(options.rootDir, options.stateDir, "state-dir");
    } else {
      await assertExternalDirectory(options.rootDir, options.stateDir, "state-dir");
      await assertExternalDirectory(options.rootDir, options.artifactDir, "artifact-dir");
    }
    const repository = new FileVerificationRepository(options.stateDir);
    const requestInput = options.requestPath ? validateRequest(await readBoundedJson(options.requestPath)) : undefined;
    const runId = options.runId ?? requestInput?.requestId;
    if (!runId || !SAFE_ID.test(runId)) fail("--run-id or request.requestId is required");
    if (options.reportOnly) {
      if (requestInput || options.manifestPath) fail("--report-only cannot be combined with --request or --manifest");
      const report = await loadReport(repository, runId, snapshot);
      stdout(reportOutput(report, options.format));
      return exitForVerdict(report.verdict);
    }
    if (!requestInput || !options.manifestPath) fail("--request and --manifest are required unless --report-only is used");
    const request = { ...requestInput, project: { ...requestInput.project, rootIdentity: requestInput.project.rootIdentity === "auto" ? snapshot.rootIdentity : requestInput.project.rootIdentity, snapshotId: requestInput.project.snapshotId === "auto" ? snapshot.snapshotId : requestInput.project.snapshotId } } satisfies VerificationRequest;
    if (request.project.rootIdentity !== snapshot.rootIdentity || request.project.snapshotId !== snapshot.snapshotId) fail("request project identity does not match current Git snapshot");
    const manifest = validateManifest(await readBoundedJson(options.manifestPath));
    const placeholder = {} as VerificationRunDependencies;
    const basis = await establishTestBasis({ request, dependencies: placeholder });
    const discovery = await performRiskDiscovery({ request, basis, dependencies: placeholder });
    const plan = await buildVerificationPlan({ request, basis, discovery, dependencies: placeholder });
    const expected = new Set(plan.obligations.map(item => item.id));
    const provided = new Set(manifest.obligations.map(item => item.id));
    if (expected.size !== provided.size || [...expected].some(id => !provided.has(id))) fail(`manifest obligation IDs must exactly match verification plan: expected ${[...expected].join(", ")}`);
    const manifestDigest = digest(manifest);
    const existingRun = await repository.loadRun(runId);
    const existingMetadata = await repository.readMetadata(runId);
    if (existingRun) {
      if (!existingMetadata || existingMetadata.rootIdentity !== snapshot.rootIdentity || existingMetadata.snapshotId !== snapshot.snapshotId || existingMetadata.manifestDigest !== manifestDigest) fail("resume configuration or Git snapshot does not match the persisted run");
    } else {
      await repository.writeMetadata(runId, { schemaVersion: "traceknot-cli-state/v1", rootIdentity: snapshot.rootIdentity, snapshotId: snapshot.snapshotId, manifestDigest, capabilities: ["command", "browser-execution", "visual-composition", "test-result", "experiment", "review", "static-analysis", "build-result", "scenario-result"] });
    }
    const dependenciesResult = await makeDependencies(options, request, manifest, repository, snapshot.snapshotId); stores = dependenciesResult;
    const result = await runVerification({ runId, request, dependencies: dependenciesResult.dependencies });
    const report: CliReport = { schemaVersion: "traceknot-cli-report/v1", run: result.run, verdict: result.verdict, snapshot: { rootIdentity: snapshot.rootIdentity, snapshotId: snapshot.snapshotId, head: snapshot.headCommit, dirty: snapshot.dirty }, documents: result.documents };
    stdout(reportOutput(report, options.format));
    return exitForVerdict(result.verdict);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`${message}\n`);
    if (/Git snapshot changed during verification/.test(message)) return VERIFY_EXIT_CODES.BLOCKED;
    return error instanceof Error && /required|invalid|unknown|missing|must|unsafe|identity|snapshot|manifest|format|run-id|outside/.test(message) ? VERIFY_EXIT_CODES.USAGE : VERIFY_EXIT_CODES.INTERNAL;
  } finally { await stores?.close().catch(error => stderr(`artifact cleanup failed: ${String(error)}\n`)); }
}

export async function main(argv = process.argv.slice(2)): Promise<number> { return runVerify(argv); }

if (import.meta.main) process.exit(await main());
