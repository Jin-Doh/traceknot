import { createHash, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import type { Artifact, Producer } from "../core/qa-core";
import { isVisualCompositionOracle, type VisualCompositionOracle } from "../core/visual-composition";
import {
  isUiFullTextAccessArtifact,
  isUiResilienceOracle,
  uiApplicabilityApprovalReceiptPayload,
  uiVisualReviewApprovalPayloadDigest,
  type UiApplicabilityApprovalSubject,
  type UiFullTextAccessEvidence,
  type UiResilienceOracle,
  type UiVisualReview,
} from "../core/ui-resilience";
import {
  buildVerificationPlan,
  canonicalizeJson,
  type ExecutionAuthority,
  type FreshnessAuthority,
  type VerificationExecutionAuthorityBinding,
  type VerificationExecutionCompletionEnvelope,
  type VerificationExecutionOutput,
  type VerificationRunDependencies,
  type RunVerificationResult,
  type VerificationRequest,
  runVerification,
  establishTestBasis,
  validatePersistedVerificationRun,
  performRiskDiscovery,
} from "../runtime/verification-run";
import { captureGitSnapshotIdentity } from "../runtime/git-snapshot";
import { ArtifactNotFoundError, closeSecureRoot, LocalArtifactStore, openSecureRoot, readSecureRegularFile, secureMkdirAt, secureRmdirAt } from "../runtime/local-artifact-store";
import { LocalShellCollector, type ShellArtifactDeclaration } from "../runtime/local-shell-collector";
import { pruneStorage } from "../runtime/storage-retention";
import { FileVerificationRepository } from "../runtime/file-repository";
import { buildQaBoardView } from "../presentation/qa-board";
import { openBoard } from "../presentation/board-opener";
import { writeQaBoardBundle } from "../presentation/qa-board-store";
import { notifyBoard } from "../presentation/user-notifier";

export const VERIFY_EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, BLOCKED: 2, INCOMPLETE: 3, USAGE: 64, INTERNAL: 70 });
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const SAFE_ID = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_ENV = new Set(["HOME", "TMPDIR", "LANG", "LC_ALL"]);
const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const TRUSTED_PRODUCER_POLICY_PATH = "/etc/traceknot/trusted-producer.json";

type ManifestCommand = Readonly<{
  id: string;
  executable?: string;
  argv?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxArtifactBytes?: number;
  declaredArtifacts?: readonly ShellArtifactDeclaration[];
  visualCompositionOraclePath?: string;
  uiResilienceOraclePath?: string;
  executionCompletionPath?: string;
  executionCompletionArtifacts?: readonly ShellArtifactDeclaration[];
  toolVersion?: string;
}>;
type VerifyManifest = Readonly<{ schemaVersion: "verification-manifest/v1"; obligations: readonly ManifestCommand[] }>;
type CliOptions = Readonly<{ requestPath?: string; manifestPath?: string; rootDir: string; stateDir: string; artifactDir: string; automaticCacheMaintenance: boolean; runId?: string; invocationId?: string; expectedHead?: string; format: "json" | "markdown"; reportOnly: boolean; board: boolean; noNotify: boolean; openBoard: boolean; sessionId?: string; sessionHost: string; help: boolean }>;
type CliReport = Readonly<{ schemaVersion: "traceknot-cli-report/v1"; run: unknown; verdict: unknown; snapshot: Readonly<{ rootIdentity: string; snapshotId: string; head: string; dirty: boolean }>; documents?: unknown }>;
export type TrustedProducerPolicy = Readonly<{
  schemaVersion: "trusted-producer-policy/v1";
  issuer: string;
  keyId: string;
  publicKeyPem: string;
}>;

function usage(): string {
  return [
    "traceknot verify --request REQUEST.json --manifest MANIFEST.json [options]",
    "traceknot verify --run-id ID --report-only [options]",
    "",
    "Options:",
    "  --root DIR              Git repository root (default: current directory)",
    "  --state-dir DIR         Durable run state outside the repository",
    "  --artifact-dir DIR      Content-addressed artifact root",
    "  --invocation-id ID      Durable Board invocation identifier",
    "  --board                 Generate a static QA Board bundle",
    "  --no-notify             Suppress desktop notification after Board generation",
    "  --open-board            Open the generated Board in the desktop browser",
    "  --session-id ID         Hash this agent session identifier in the Board manifest",
    "  --session-host HOST     Record the agent session host in the Board manifest",
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
  let paletteEntries = 0;
  let transparencyEntries = 0;
  let sawEnd = false;
  let dataEnded = false;
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
    if (type !== "IDAT" && compressed.length > 0) dataEnded = true;
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
      if (paletteEntries > 0 || compressed.length > 0 || length === 0 || length % 3 !== 0 || length > 768 || (colorType === 3 && length / 3 > 2 ** bitDepth) || colorType === 0 || colorType === 4) fail("screenshot PNG has an invalid palette");
      paletteEntries = length / 3;
    } else if (type === "tRNS") {
      if (compressed.length > 0 || transparencyEntries > 0 || ![0, 2, 3].includes(colorType) || (colorType === 0 && length !== 2) || (colorType === 2 && length !== 6) || (colorType === 3 && (paletteEntries === 0 || length === 0 || length > paletteEntries))) fail("screenshot PNG has invalid transparency metadata");
      transparencyEntries = length;
    } else if (type === "IDAT") {
      if (dataEnded) fail("screenshot PNG has non-consecutive image data");
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
  if (!sawHeader || !sawEnd || offset !== bytes.length || compressed.length === 0 || (colorType === 3 && paletteEntries === 0)) fail("screenshot PNG structure is incomplete");
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
  let previousRow = new Uint8Array(rowBytes);
  const bytesPerPixel = Math.max(1, Math.ceil(channels * bitDepth / 8));
  for (let row = 0; row < height; row++) {
    const rowOffset = row * (rowBytes + 1);
    const filter = decoded[rowOffset]!;
    if (filter > 4) fail("screenshot PNG uses an invalid row filter");
    const reconstructed = new Uint8Array(rowBytes);
    for (let column = 0; column < rowBytes; column++) {
      const encoded = decoded[rowOffset + 1 + column]!;
      const left = column >= bytesPerPixel ? reconstructed[column - bytesPerPixel]! : 0;
      const above = previousRow[column]!;
      const upperLeft = column >= bytesPerPixel ? previousRow[column - bytesPerPixel]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) {
        const estimate = left + above - upperLeft;
        const leftDistance = Math.abs(estimate - left);
        const aboveDistance = Math.abs(estimate - above);
        const upperLeftDistance = Math.abs(estimate - upperLeft);
        predictor = leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft;
      }
      reconstructed[column] = (encoded + predictor) & 0xff;
    }
    if (colorType === 3) for (let pixel = 0; pixel < width; pixel++) {
      const byte = reconstructed[Math.floor(pixel * bitDepth / 8)]!;
      const shift = 8 - bitDepth - (pixel * bitDepth % 8);
      if (((byte >>> shift) & (2 ** bitDepth - 1)) >= paletteEntries) fail("screenshot PNG references an invalid palette entry");
    }
    previousRow = reconstructed;
  }
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
function parseJsonBytes(bytes: Uint8Array, path: string): unknown {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    assertPlain(value);
    return value;
  } catch (error) {
    if (error instanceof Error && /^(invalid input file|unsafe input key)/.test(error.message)) throw error;
    throw new Error(`invalid input file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function readBoundedHandle(handle: FileHandle, path: string): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(MAX_INPUT_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, null);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > MAX_INPUT_BYTES) fail(`invalid input file ${path}: exceeds ${MAX_INPUT_BYTES} bytes`);
  return bytes.subarray(0, offset);
}
async function readBoundedJson(path: string): Promise<unknown>;
async function readBoundedJson(path: string, allowMissing: true): Promise<unknown | undefined>;
async function readBoundedJson(path: string, allowMissing = false): Promise<unknown | undefined> {
  let root;
  try {
    const absolute = resolve(path);
    root = await openSecureRoot(dirname(absolute));
    const bytes = await readSecureRegularFile(root.fd, basename(absolute), MAX_INPUT_BYTES);
    return parseJsonBytes(bytes, path);
  } catch (error) {
    if (allowMissing && error instanceof ArtifactNotFoundError) return undefined;
    if (error instanceof Error && /^(invalid input file|unsafe input key)/.test(error.message)) throw error;
    throw new Error(`invalid input file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (root) await closeSecureRoot(root);
  }
}
async function readBoundedFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const absolute = resolve(path);
  let root;
  try {
    root = await openSecureRoot(dirname(absolute));
    return await readSecureRegularFile(root.fd, basename(absolute), maxBytes);
  } finally {
    if (root) await closeSecureRoot(root);
  }
}
function validateTrustedProducerPolicy(value: unknown): TrustedProducerPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("trusted producer policy must be an object");
  const policy = value as Record<string, unknown>;
  if (Object.keys(policy).sort().join(",") !== ["issuer", "keyId", "publicKeyPem", "schemaVersion"].sort().join(",") || policy.schemaVersion !== "trusted-producer-policy/v1") fail("trusted producer policy fields are invalid");
  const issuer = requireString(policy.issuer, "trusted producer issuer");
  const keyId = requireString(policy.keyId, "trusted producer keyId");
  if (!DIGEST.test(keyId)) fail("trusted producer keyId must be a lowercase SHA-256 digest");
  const publicKeyPem = requireString(policy.publicKeyPem, "trusted producer public key");
  const publicKey = (() => {
    try {
      return createPublicKey(publicKeyPem);
    } catch {
      return fail("trusted producer public key is invalid");
    }
  })();
  if (publicKey.asymmetricKeyType !== "ed25519") fail("trusted producer public key must be Ed25519");
  const actualKeyId = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  if (actualKeyId !== keyId) fail("trusted producer keyId does not match public key");
  return { schemaVersion: "trusted-producer-policy/v1", issuer, keyId, publicKeyPem };
}
async function loadTrustedProducerPolicy(): Promise<TrustedProducerPolicy | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(TRUSTED_PRODUCER_POLICY_PATH, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) fail("trusted producer policy must be a root-owned, non-writable regular file");
    return validateTrustedProducerPolicy(parseJsonBytes(await readBoundedHandle(handle, TRUSTED_PRODUCER_POLICY_PATH), TRUSTED_PRODUCER_POLICY_PATH));
  } finally {
    await handle.close();
  }
}
function parseArgs(argv: readonly string[]): CliOptions {
  let rootDir = process.cwd();
  let stateDir = "";
  let artifactDir = "";
  let requestPath: string | undefined;
  let manifestPath: string | undefined;
  let runId: string | undefined;
  let invocationId: string | undefined;
  let expectedHead: string | undefined;
  let format: "json" | "markdown" = "json";
  let reportOnly = false;
  let board = false;
  let noNotify = false;
  let openBoard = false;
  let sessionId: string | undefined;
  let sessionHost = "unavailable";
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
    else if (arg === "--invocation-id") invocationId = next();
    else if (arg === "--run-id") runId = next();
    else if (arg === "--expected-head") expectedHead = next();
    else if (arg === "--format") { const value = next(); if (value !== "json" && value !== "markdown") fail("--format must be json or markdown"); format = value; }
    else if (arg === "--report-only") reportOnly = true;
    else if (arg === "--board") board = true;
    else if (arg === "--no-notify") noNotify = true;
    else if (arg === "--open-board") { openBoard = true; board = true; }
    else if (arg === "--session-id") sessionId = next();
    else if (arg === "--session-host") sessionHost = next();
    else fail(`unknown option: ${arg}`);
  }
  const automaticCacheMaintenance = stateDir.length === 0 && artifactDir.length === 0;
  const absoluteRoot = resolve(rootDir);
  if (!stateDir) stateDir = join(homedir(), ".cache", "traceknot", "runs", createHash("sha256").update(absoluteRoot).digest("hex").slice(0, 24));
  if (!artifactDir) artifactDir = join(stateDir, "artifacts");
  if (runId !== undefined && !SAFE_ID.test(runId)) fail("run-id contains unsafe characters");
  if (invocationId !== undefined && !SAFE_ID.test(invocationId)) fail("invocation-id contains unsafe characters");
  if (sessionId !== undefined && sessionId.includes("\0")) fail("session-id must be NUL-free");
  if (sessionHost.includes("\0") || sessionHost.length > 128) fail("session-host must be NUL-free and at most 128 characters");
  if (expectedHead !== undefined && !GIT_OBJECT_ID.test(expectedHead)) fail("expected-head must be a lowercase Git object ID");
  return { requestPath, manifestPath, rootDir: absoluteRoot, stateDir: resolve(stateDir), artifactDir: resolve(artifactDir), automaticCacheMaintenance, runId, invocationId, expectedHead, format, reportOnly, board, noNotify, openBoard, sessionId, sessionHost, help };
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
    const allowedKeys = new Set(["id", "executable", "argv", "cwd", "env", "timeoutMs", "maxOutputBytes", "maxArtifactBytes", "declaredArtifacts", "visualCompositionOraclePath", "uiResilienceOraclePath", "executionCompletionPath", "executionCompletionArtifacts", "toolVersion"]);
    const unknownKeys = Object.keys(item).filter(key => !allowedKeys.has(key));
    if (unknownKeys.length > 0) fail(`manifest obligations[${index}] has unknown fields: ${unknownKeys.sort().join(", ")}`);
    const id = requireString(item.id, `manifest obligations[${index}].id`);
    if (ids.has(id)) fail(`manifest has duplicate obligation: ${id}`); ids.add(id);
    const executable = item.executable === undefined ? undefined : requireString(item.executable, `manifest obligations[${index}].executable`);
    if (executable !== undefined && !isAbsolute(executable)) fail(`manifest executable must be absolute: ${executable}`);
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
    const uiResilienceOraclePath = item.uiResilienceOraclePath === undefined ? undefined : requireString(item.uiResilienceOraclePath, "manifest uiResilienceOraclePath");
    if (uiResilienceOraclePath !== undefined && !isAbsolute(uiResilienceOraclePath)) fail("manifest uiResilienceOraclePath must be absolute");
    const executionCompletionPath = item.executionCompletionPath === undefined ? undefined : requireString(item.executionCompletionPath, "manifest executionCompletionPath");
    const completionArtifactValue = item.executionCompletionArtifacts;
    let executionCompletionArtifacts: ShellArtifactDeclaration[] | undefined;
    if (completionArtifactValue !== undefined) {
      if (!Array.isArray(completionArtifactValue)) fail("manifest executionCompletionArtifacts must be an array");
      executionCompletionArtifacts = completionArtifactValue.map((rawDeclaration, n) => {
        if (!rawDeclaration || typeof rawDeclaration !== "object" || Array.isArray(rawDeclaration)) fail(`executionCompletionArtifacts[${n}] must be an object`);
        const declaration = rawDeclaration as Record<string, unknown>;
        const type = requireString(declaration.type, "execution completion artifact type");
        const path = requireString(declaration.path, "execution completion artifact path");
        if (!isAbsolute(path)) fail("execution completion artifact path must be absolute");
        const digest = requireString(declaration.digest, "execution completion artifact digest");
        if (!DIGEST.test(digest)) fail("execution completion artifact digest must be lowercase SHA-256");
        return { type, digest, path };
      });
    }
    if (executionCompletionPath !== undefined && !isAbsolute(executionCompletionPath)) fail("manifest executionCompletionPath must be absolute");
    if (executable === undefined && executionCompletionPath === undefined) fail(`manifest obligations[${index}] requires executable or executionCompletionPath`);
    const localOnlyKeys = ["argv", "cwd", "env", "timeoutMs", "maxOutputBytes", "declaredArtifacts", "visualCompositionOraclePath", "uiResilienceOraclePath", "toolVersion"];
    if (executable === undefined && localOnlyKeys.some(key => item[key] !== undefined)) fail(`manifest obligations[${index}] local execution fields require executable`);
    if (executionCompletionPath === undefined && executionCompletionArtifacts !== undefined) fail(`manifest obligations[${index}] executionCompletionArtifacts require executionCompletionPath`);
    obligations.push({ id, ...(executable ? { executable } : {}), ...(argv ? { argv } : {}), ...(cwd ? { cwd } : {}), ...(env ? { env } : {}), ...(bounded("timeoutMs", 600_000) ? { timeoutMs: bounded("timeoutMs", 600_000) } : {}), ...(bounded("maxOutputBytes", 256 * 1024 * 1024) ? { maxOutputBytes: bounded("maxOutputBytes", 256 * 1024 * 1024) } : {}), ...(bounded("maxArtifactBytes", 256 * 1024 * 1024) ? { maxArtifactBytes: bounded("maxArtifactBytes", 256 * 1024 * 1024) } : {}), ...(declaredArtifacts ? { declaredArtifacts } : {}), ...(visualCompositionOraclePath ? { visualCompositionOraclePath } : {}), ...(uiResilienceOraclePath ? { uiResilienceOraclePath } : {}), ...(executionCompletionPath ? { executionCompletionPath } : {}), ...(executionCompletionArtifacts ? { executionCompletionArtifacts } : {}), ...(item.toolVersion === undefined ? {} : { toolVersion: requireString(item.toolVersion, "manifest toolVersion") }) });
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
const INVOCATION_COLLECTOR_PREFIX = ".collector-";
type InvocationCollector = Readonly<{ store: LocalArtifactStore; close: () => Promise<void> }>;
async function openInvocationCollector(artifactDir: string): Promise<InvocationCollector> {
  const parent = await openSecureRoot(artifactDir);
  const name = `${INVOCATION_COLLECTOR_PREFIX}${randomUUID()}`;
  let created = false;
  let store: LocalArtifactStore | undefined;
  try {
    secureMkdirAt(parent.fd, name, 0o700);
    created = true;
    store = new LocalArtifactStore({ rootDir: join(parent.rootDir, name), ephemeral: true });
    const openedStore = store;
    let closePromise: Promise<void> | undefined;
    return {
      store: openedStore,
      close: () => closePromise ??= (async () => {
        const errors: unknown[] = [];
        let destroyed = false;
        try { await openedStore.destroyContents(); destroyed = true; } catch (error) { errors.push(error); }
        try { await openedStore.close(); } catch (error) { errors.push(error); }
        if (destroyed) {
          try { secureRmdirAt(parent.fd, name); } catch (error) { errors.push(error); }
        }
        try { await closeSecureRoot(parent); } catch (error) { errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "collector cleanup failed");
      })(),
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    let destroyed = false;
    if (store) {
      try { await store.destroyContents(); destroyed = true; } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      try { await store.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (created && (!store || destroyed)) {
      try { secureRmdirAt(parent.fd, name); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    try { await closeSecureRoot(parent); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "invocation collector setup failed", { cause: error });
    throw error;
  }
}
function digest(value: unknown): string { return createHash("sha256").update(canonicalizeJson(value)).digest("hex"); }
function localProducer(): Producer {
  return { kind: "harness-managed", identity: "traceknot-cli", independence: "separate-verification-context" };
}
function authorityFor(binding: Parameters<NonNullable<VerificationRunDependencies["executionAuthority"]["issueExecutionAuthority"]>>[0]): ExecutionAuthority {
  return { schemaVersion: "verification-execution-authority/v1", authorityId: `authority:${digest(binding).slice(0, 48)}`, issuer: "traceknot-cli", binding };
}
function isUnsignedLocalAuthority(authority: ExecutionAuthority, binding: VerificationExecutionAuthorityBinding): boolean {
  return authority.keyId === undefined
    && authority.signature === undefined
    && canonicalizeJson(authority) === canonicalizeJson(authorityFor(binding))
    && binding.producer.kind === "harness-managed"
    && binding.producer.identity === "traceknot-cli"
    && binding.producer.independence === "separate-verification-context";
}
export function verifyTrustedAuthority(policy: TrustedProducerPolicy, authority: ExecutionAuthority, binding: VerificationExecutionAuthorityBinding): boolean {
  if (authority.issuer !== policy.issuer || authority.keyId !== policy.keyId || typeof authority.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(authority.signature) || canonicalizeJson(authority.binding) !== canonicalizeJson(binding)) return false;
  const expectedId = `ed25519:${policy.keyId}:${createHash("sha256").update(authority.signature).digest("hex")}`;
  if (authority.authorityId !== expectedId) return false;
  try {
    return verifySignature(null, Buffer.from(canonicalizeJson(binding)), createPublicKey(policy.publicKeyPem), Buffer.from(authority.signature, "base64url"));
  } catch {
    return false;
  }
}
export function verifyTrustedUiApplicabilityApproval(policy: TrustedProducerPolicy, subject: UiApplicabilityApprovalSubject): boolean {
  const receipt = subject.approvalReceipt;
  if (receipt.issuer !== policy.issuer || receipt.keyId !== policy.keyId) return false;
  try {
    return verifySignature(null, Buffer.from(canonicalizeJson(uiApplicabilityApprovalReceiptPayload(receipt))), createPublicKey(policy.publicKeyPem), Buffer.from(receipt.signature, "base64url"));
  } catch {
    return false;
  }
}

export function verifyTrustedUiVisualReview(policy: TrustedProducerPolicy, review: UiVisualReview): boolean {
  const receipt = review.approvalReceipt;
  if (receipt.issuer !== policy.issuer || receipt.keyId !== policy.keyId || receipt.payloadDigest !== uiVisualReviewApprovalPayloadDigest(review)) return false;
  try {
    return verifySignature(null, Buffer.from(receipt.payloadDigest, "hex"), createPublicKey(policy.publicKeyPem), Buffer.from(receipt.signature, "base64url"));
  } catch {
    return false;
  }
}
function validateExecutionCompletion(value: unknown): VerificationExecutionCompletionEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("execution completion must be an object");
  const completion = value as Record<string, unknown>;
  if (completion.schemaVersion !== "verification-execution-completion/v1" || !completion.output || typeof completion.output !== "object" || Array.isArray(completion.output) || !completion.authority || typeof completion.authority !== "object" || Array.isArray(completion.authority)) fail("execution completion fields are invalid");
  return completion as VerificationExecutionCompletionEnvelope;
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

export function validateFullTextAccessArtifact(bytes: Uint8Array, artifactDigest: string, oracle: UiResilienceOracle | undefined): void {
  if (createHash("sha256").update(bytes).digest("hex") !== artifactDigest) throw new Error(`invalid UI full-text access artifact ${artifactDigest}: byte digest mismatch`);
  const bindings = oracle?.runs.flatMap(run => run.observations.flatMap(observation => observation.fullTextAccess?.digest === artifactDigest ? [observation.fullTextAccess] : [])) ?? [];
  if (bindings.length !== 1) throw new Error(`invalid UI full-text access artifact ${artifactDigest}: expected exactly one observation binding`);
  const candidate = parseJsonBytes(bytes, `ui-full-text-access:${artifactDigest}`);
  if (!isUiFullTextAccessArtifact(candidate, bindings[0] as UiFullTextAccessEvidence)) throw new Error(`invalid UI full-text access artifact ${artifactDigest}: payload does not match observation`);
}

export function validateScreenshotArtifact(bytes: Uint8Array, artifactDigest: string, visualOracle: VisualCompositionOracle | undefined, resilienceOracle: UiResilienceOracle | undefined): void {
  let dimensions: Readonly<{ width: number; height: number }>;
  try {
    dimensions = decodePngDimensions(bytes);
  } catch (error) {
    throw new Error(`invalid ${error instanceof Error ? error.message : String(error)}`);
  }
  const visualBindings = visualOracle?.captures.flatMap(capture => capture.screenshots
    .filter(screenshot => screenshot.digest === artifactDigest)
    .map(screenshot => ({ capture, screenshot }))) ?? [];
  const resilienceBindings = resilienceOracle?.runs.flatMap(run => run.observations
    .filter(observation => observation.screenshotDigest === artifactDigest)
    .map(observation => ({ run, observation }))) ?? [];
  if (visualBindings.length === 0 && resilienceBindings.length === 0) {
    throw new Error(`invalid screenshot artifact ${artifactDigest}: not bound to a visual oracle`);
  }
  for (const { capture, screenshot } of visualBindings) {
    const scale = capture.viewport.devicePixelRatio ?? 1;
    if (screenshot.role === "full-page") {
      const expectedWidth = Math.round(capture.viewport.width * scale);
      const minimumHeight = Math.round(capture.viewport.height * scale);
      if (dimensions.width !== expectedWidth || dimensions.height < minimumHeight) throw new Error(`invalid screenshot artifact ${artifactDigest}: dimensions do not match capture ${capture.captureId}`);
      continue;
    }
    const region = capture.regions.find(candidate => candidate.regionId === screenshot.regionId)!;
    const minimumWidth = Math.ceil(region.width * scale);
    const minimumHeight = Math.ceil(region.height * scale);
    if (dimensions.width < minimumWidth || dimensions.height < minimumHeight) throw new Error(`invalid screenshot artifact ${artifactDigest}: dimensions do not cover focused region ${screenshot.regionId}`);
  }
  for (const { run, observation } of resilienceBindings) {
    const scale = run.viewport.devicePixelRatio ?? 1;
    const captureViewport = run.profileEvidence.profile === "reflow-320"
      ? { width: run.profileEvidence.innerWidth, height: run.profileEvidence.innerHeight }
      : run.viewport;
    const expectedWidth = Math.round(captureViewport.width * scale);
    const minimumHeight = Math.round(captureViewport.height * scale);
    if (dimensions.width !== expectedWidth || dimensions.height < minimumHeight) {
      throw new Error(`invalid UI resilience screenshot artifact ${artifactDigest}: dimensions do not match observation ${observation.observationId}`);
    }
  }
}
async function makeDependencies(options: CliOptions, request: VerificationRequest, manifest: VerifyManifest | undefined, repository: FileVerificationRepository, snapshotId: string, trustedPolicy: TrustedProducerPolicy | undefined): Promise<{ dependencies: VerificationRunDependencies; close: () => Promise<void> }> {
  const mainStore = new LocalArtifactStore(options.artifactDir);
  let invocationCollector: InvocationCollector;
  try {
    invocationCollector = await openInvocationCollector(options.artifactDir);
  } catch (error) {
    await mainStore.close().catch(() => undefined);
    await repository.close().catch(() => undefined);
    throw error;
  }
  const collectorStore = invocationCollector.store;
  let collector: LocalShellCollector;
  try {
    collector = new LocalShellCollector({ rootDir: options.rootDir, rootIdentity: request.project.rootIdentity, snapshotId, artifactStore: collectorStore, toolVersion: "traceknot-cli", envAllowlist: ["HOME", "TMPDIR", "LANG", "LC_ALL"] });
  } catch (error) {
    await Promise.allSettled([invocationCollector.close(), mainStore.close(), repository.close()]);
    throw error;
  }
  const commands = new Map((manifest?.obligations ?? []).map(command => [command.id, command]));
  const executionAuthority = {
    atomicCanonicalBindingIdempotency: true as const,
    issueExecutionAuthority: async (binding: VerificationExecutionAuthorityBinding) => authorityFor(binding),
    verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: VerificationExecutionAuthorityBinding) => {
      if (authority.keyId !== undefined || authority.signature !== undefined || authority.issuer !== "traceknot-cli") return trustedPolicy !== undefined && verifyTrustedAuthority(trustedPolicy, authority, binding);
      return isUnsignedLocalAuthority(authority, binding);
    },
  };
  const freshnessAuthority = { atomicSameKeyIdempotency: true as const, issueFreshnessAuthority: async (binding: Parameters<NonNullable<VerificationRunDependencies["freshnessAuthority"]["issueFreshnessAuthority"]>>[0]) => freshnessAuthorityFor(binding), verifyFreshnessAuthority: async (authority: FreshnessAuthority, binding: Parameters<NonNullable<VerificationRunDependencies["freshnessAuthority"]["verifyFreshnessAuthority"]>>[1]) => authority.issuer === "traceknot-cli" && canonicalizeJson(authority.binding) === canonicalizeJson(binding) };
  type ManifestExecutionInput = Parameters<NonNullable<VerificationRunDependencies["executor"]["executeObligation"]>>[0];
  const completionProvider = {
    loadExecutionCompletion: async (input: ManifestExecutionInput): Promise<VerificationExecutionCompletionEnvelope | undefined> => {
      const command = commands.get(input.obligation.id);
      if (!command?.executionCompletionPath) return undefined;
      const rawCompletion = await readBoundedJson(command.executionCompletionPath, true);
      if (rawCompletion === undefined) return undefined;
      if (!trustedPolicy) throw new Error(`manifest obligation ${input.obligation.id} requires the administrator-installed trusted producer policy`);
      const completion = validateExecutionCompletion(rawCompletion);
      const signedBinding = completion.authority.binding;
      if (!verifyTrustedAuthority(trustedPolicy, completion.authority, signedBinding)
        || signedBinding.producer.kind !== "external-system"
        || signedBinding.producer.identity !== trustedPolicy.issuer
        || signedBinding.producer.independence !== "independent-producer"
        || canonicalizeJson(completion.output.artifacts ?? []) !== canonicalizeJson(signedBinding.artifacts)) {
        throw new Error(`manifest obligation ${input.obligation.id} has invalid execution completion authentication`);
      }
      if (completion.runId !== input.runId || completion.requestId !== input.requestId || completion.rootIdentity !== input.rootIdentity || completion.snapshotId !== input.snapshotId || completion.planDigest !== input.planDigest || completion.obligationId !== input.obligation.id || completion.idempotencyKey !== input.idempotencyKey
        || signedBinding.runId !== input.runId || signedBinding.requestId !== input.requestId || signedBinding.requestDigest !== input.requestDigest || signedBinding.planDigest !== input.planDigest || signedBinding.obligationDigest !== input.obligationDigest || signedBinding.rootIdentity !== input.rootIdentity || signedBinding.snapshotId !== input.snapshotId || signedBinding.obligationId !== input.obligation.id || signedBinding.idempotencyKey !== input.idempotencyKey
        || completion.output.runId !== input.runId || completion.output.requestId !== input.requestId || completion.output.snapshotId !== input.snapshotId || completion.output.idempotencyKey !== input.idempotencyKey) {
        throw new Error(`manifest obligation ${input.obligation.id} execution completion does not match the current request`);
      }
      const artifacts = signedBinding.artifacts;
      const declarations = command.executionCompletionArtifacts ?? [];
      const artifactKeys = [...new Set(artifacts.map(artifact => `${artifact.type}\u0000${artifact.digest}`))].sort();
      const declarationKeys = declarations.map(artifact => `${artifact.type}\u0000${artifact.digest}`).sort();
      if (canonicalizeJson(artifactKeys) !== canonicalizeJson(declarationKeys) || new Set(declarationKeys).size !== declarationKeys.length) throw new Error(`manifest obligation ${input.obligation.id} execution completion artifacts do not match the signed output: signed=${canonicalizeJson(artifactKeys)} declared=${canonicalizeJson(declarationKeys)}`);
      for (const declaration of declarations) {
        if (isInside(options.rootDir, resolve(declaration.path))) throw new Error(`execution completion artifact must be outside the Git repository root: ${declaration.path}`);
        const bytes = await readBoundedFile(declaration.path, command.maxArtifactBytes ?? 256 * 1024 * 1024);
        if (createHash("sha256").update(bytes).digest("hex") !== declaration.digest) throw new Error(`execution completion artifact digest does not match: ${declaration.path}`);
        if (declaration.type === "screenshot") validateScreenshotArtifact(bytes, declaration.digest, completion.output.visualCompositionOracle, completion.output.uiResilienceOracle);
        if (declaration.type === "ui-full-text-access") validateFullTextAccessArtifact(bytes, declaration.digest, completion.output.uiResilienceOracle);
        await mainStore.storeArtifact({ type: declaration.type, digest: declaration.digest, bytes } as Artifact & { bytes: Uint8Array }, input);
      }
      return completion;
    },
  };
  const executeManifestCommand = async (input: ManifestExecutionInput, executionKind: "command" | "browser"): Promise<VerificationExecutionOutput> => {
    const command = commands.get(input.obligation.id);
    if (!command) throw new Error(`manifest has no command for obligation ${input.obligation.id}`);
    if (!command.executable) throw new Error(`manifest obligation ${command.id} external completion is unavailable and no executable fallback is configured`);
    const observation = await collector.collect({ requestId: input.requestId, snapshotId: input.snapshotId, rootIdentity: input.rootIdentity, observationId: `observation:${input.obligation.id}`, executable: command.executable, ...(command.argv ? { argv: command.argv } : {}), ...(command.cwd ? { cwd: command.cwd } : {}), ...(command.env ? { env: command.env } : {}), ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}), ...(command.maxOutputBytes ? { maxOutputBytes: command.maxOutputBytes } : {}), ...(command.maxArtifactBytes ? { maxArtifactBytes: command.maxArtifactBytes } : {}), ...(command.declaredArtifacts ? { declaredArtifacts: command.declaredArtifacts, bestEffortDeclaredArtifactsOnFailure: true } : {}), ...(command.toolVersion ? { toolVersion: command.toolVersion } : {}), producer: localProducer() });
    const status = observation.execution.exitStatus === "passed" ? "passed" : observation.execution.exitStatus === "blocked" ? "blocked" : "failed";
    let visualCompositionOracle: VisualCompositionOracle | undefined;
    if (input.obligation.visualCompositionRequirement) {
      if (status === "passed") {
        if (!command.visualCompositionOraclePath) throw new Error(`manifest obligation ${command.id} requires visualCompositionOraclePath`);
        const candidate = await readBoundedJson(command.visualCompositionOraclePath);
        if (!isVisualCompositionOracle(candidate)) throw new Error(`manifest obligation ${command.id} visual composition oracle is invalid`);
        visualCompositionOracle = candidate;
      }
    } else if (command.visualCompositionOraclePath) {
      throw new Error(`manifest obligation ${command.id} supplies a visual oracle for a non-visual obligation`);
    }
    let uiResilienceOracle: UiResilienceOracle | undefined;
    if (input.obligation.uiResilienceRequirement) {
      if (status === "passed") {
        if (!command.uiResilienceOraclePath) throw new Error(`manifest obligation ${command.id} requires uiResilienceOraclePath`);
        const candidate = await readBoundedJson(command.uiResilienceOraclePath);
        if (!isUiResilienceOracle(candidate)) throw new Error(`manifest obligation ${command.id} UI resilience oracle is invalid`);
        uiResilienceOracle = candidate;
      }
    } else if (command.uiResilienceOraclePath) {
      throw new Error(`manifest obligation ${command.id} supplies a UI resilience oracle for a non-resilience obligation`);
    }
    const artifacts: Artifact[] = [];
    for (const artifact of observation.artifacts) {
      const bytes = await collectorStore.readArtifact(artifact.digest);
      const type = status === "passed" && (artifact.type === "screenshot" || artifact.type === "design-token-resolution" || artifact.type === "approved-visual-reference" || artifact.type === "ui-applicability-approval" || artifact.type === "ui-full-text-access" || artifact.type === "ui-visual-review-approval-receipt") ? artifact.type : "verification-result";
      if (type === "screenshot") validateScreenshotArtifact(bytes, artifact.digest, visualCompositionOracle, uiResilienceOracle);
      if (type === "ui-full-text-access") validateFullTextAccessArtifact(bytes, artifact.digest, uiResilienceOracle);
      artifacts.push(await mainStore.storeArtifact({ type, digest: artifact.digest, path: artifact.path, bytes } as Artifact & { bytes: Uint8Array }, input));
    }
    return { status, runId: input.runId, requestId: input.requestId, snapshotId: input.snapshotId, idempotencyKey: input.idempotencyKey, producer: observation.producer, summary: `Command ${command.executable} completed with ${observation.execution.exitStatus}.`, artifacts, executionKind, identity: observation.execution.identity, ...(observation.execution.exitCode === undefined ? {} : { exitCode: observation.execution.exitCode }), ...(visualCompositionOracle ? { visualCompositionOracle } : {}), ...(uiResilienceOracle ? { uiResilienceOracle } : {}) };
  };
  const executor = { atomicSameKeyIdempotency: true as const, executeObligation: (input: ManifestExecutionInput) => executeManifestCommand(input, "command") };
  const browserExecutor = { atomicSameKeyIdempotency: true as const, executeBrowser: (input: ManifestExecutionInput) => executeManifestCommand(input, "browser") };
  const artifactStore = { atomicSameKeyIdempotency: true as const, storeArtifact: async (artifact: Artifact, input: ManifestExecutionInput) => { const content = (artifact as Artifact & { bytes?: Uint8Array }).bytes; if (!content) { if (!await mainStore.hasArtifact(artifact.digest)) throw new Error(`artifact ${artifact.digest} was not published`); return artifact; } return mainStore.storeArtifact(artifact as Artifact & { bytes: Uint8Array }, input); } };
  const dependencies: VerificationRunDependencies = {
    repository,
    executor,
    browserExecutor,
    artifactStore,
    capabilityProvider: { has: () => true },
    executionAuthority,
    freshnessPolicy: { evaluateFreshness: () => "fresh" },
    freshnessAuthority,
    completionProvider,
    ...(trustedPolicy ? {
      uiVisualReviewApprovalVerifier: { independentAuthentication: true as const, verifyApproval: (review: UiVisualReview) => verifyTrustedUiVisualReview(trustedPolicy, review) },
      uiApplicabilityApprovalVerifier: { independentAuthentication: true as const, verifyApproval: (subject: UiApplicabilityApprovalSubject) => verifyTrustedUiApplicabilityApproval(trustedPolicy, subject) },
    } : {}),
    snapshotVerifier: async () => {
      const current = await captureGitSnapshotIdentity(options.rootDir);
      return current.rootIdentity === request.project.rootIdentity && current.snapshotId === request.project.snapshotId;
    },

    now: () => new Date(),
  };
  return {
    dependencies,
    close: async () => {
      const errors: unknown[] = [];
      try { await invocationCollector.close(); } catch (error) { errors.push(error); }
      try { await mainStore.close(); } catch (error) { errors.push(error); }
      try { await repository.close(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "verification resource cleanup failed");
    },
  };
}

async function maintainDefaultCache(options: CliOptions, stderr: (text: string) => void, protectedRunIds: readonly string[] = []): Promise<void> {
  if (!options.automaticCacheMaintenance) return;
  try {
    const report = await pruneStorage({ stateDir: options.stateDir, artifactDir: options.artifactDir, protectedRunIds, apply: true });
    const deleted = Object.values(report.deleted).reduce((count, paths) => count + paths.length, 0);
    if (deleted > 0) stderr(`Traceknot storage maintenance: deleted ${deleted} expired cache entries\n`);
    for (const warning of report.warnings) stderr(`Traceknot storage maintenance: ${warning}\n`);
  } catch (error) {
    stderr(`Traceknot storage maintenance unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function generateBoardForResult(options: CliOptions, result: RunVerificationResult, stderr: (text: string) => void): Promise<void> {
  if (!options.board) return;
  await maintainDefaultCache(options, stderr, [result.run.runId]);
  let published = false;
  let artifactStore: LocalArtifactStore | undefined;
  try {
    artifactStore = new LocalArtifactStore(options.artifactDir);
    const board = await writeQaBoardBundle({
      view: buildQaBoardView({ run: result.run, verdict: result.verdict, documents: result.documents }),
      invocationId: options.invocationId,
      stateDir: options.stateDir,
      sessionHost: options.sessionHost,
      sessionId: options.sessionId,
      generatedAt: new Date().toISOString(),
      artifactReader: artifactStore,
    });
    published = true;
    const boardUri = pathToFileURL(board.entrypoint).href;
    stderr(`Traceknot Board: ${boardUri}\n`);
    if (!options.noNotify) {
      const notification = await notifyBoard({ title: "Traceknot QA finished", message: `${result.verdict.qaVerdict}: ${result.verdict.obligationSummary.failed} failed`, boardUri });
      if (notification === "failed") stderr("Traceknot Board: desktop notification failed\n");
    }
    if (options.openBoard) {
      const opened = await openBoard(boardUri);
      if (opened === "failed") stderr("Traceknot Board: browser opener failed\n");
    }
  } catch (error) {
    stderr(`Traceknot Board unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    await artifactStore?.close().catch(error => stderr(`Traceknot Board cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`));
  }
  if (published) await maintainDefaultCache(options, stderr, [result.run.runId]);
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
    stores = repository;
    const requestInput = options.requestPath ? validateRequest(await readBoundedJson(options.requestPath)) : undefined;
    const trustedPolicy = await loadTrustedProducerPolicy();
    const runId = options.runId ?? requestInput?.requestId;
    if (!runId || !SAFE_ID.test(runId)) fail("--run-id or request.requestId is required");
    if (options.reportOnly) {
      if (requestInput || options.manifestPath) fail("--report-only cannot be combined with --request or --manifest");
      const persistedRequestValue = await repository.loadStageDocument(runId, "request");
      if (persistedRequestValue === undefined) fail("run is missing persisted request");
      const metadata = await repository.readMetadata(runId);
      if (!metadata) fail("run is missing persisted metadata");
      const persistedRequest = validateRequest(persistedRequestValue);
      if (metadata.rootIdentity !== snapshot.rootIdentity || metadata.snapshotId !== snapshot.snapshotId || persistedRequest.project.rootIdentity !== snapshot.rootIdentity || persistedRequest.project.snapshotId !== snapshot.snapshotId) fail("current Git snapshot or persisted run metadata does not match the persisted run");
      const executionAuthority = {
        atomicCanonicalBindingIdempotency: true as const,
        issueExecutionAuthority: async (binding: VerificationExecutionAuthorityBinding) => authorityFor(binding),
        verifyExecutionAuthority: async (authority: ExecutionAuthority, binding: VerificationExecutionAuthorityBinding) => {
          if (authority.keyId !== undefined || authority.signature !== undefined || authority.issuer !== "traceknot-cli") return trustedPolicy !== undefined && verifyTrustedAuthority(trustedPolicy, authority, binding);
          return isUnsignedLocalAuthority(authority, binding);
        },
      };
      const freshnessAuthority = { atomicSameKeyIdempotency: true as const, issueFreshnessAuthority: async (binding: Parameters<NonNullable<VerificationRunDependencies["freshnessAuthority"]["issueFreshnessAuthority"]>>[0]) => freshnessAuthorityFor(binding), verifyFreshnessAuthority: async (authority: FreshnessAuthority, binding: Parameters<NonNullable<VerificationRunDependencies["freshnessAuthority"]["verifyFreshnessAuthority"]>>[1]) => authority.issuer === "traceknot-cli" && canonicalizeJson(authority.binding) === canonicalizeJson(binding) };
      const dependencies: VerificationRunDependencies = { repository, executor: {}, artifactStore: {}, capabilityProvider: { has: () => false }, executionAuthority, freshnessPolicy: { evaluateFreshness: () => "unknown" }, freshnessAuthority, snapshotVerifier: async () => { const current = await captureGitSnapshotIdentity(options.rootDir); return current.rootIdentity === persistedRequest.project.rootIdentity && current.snapshotId === persistedRequest.project.snapshotId; }, now: () => new Date() };
      const result = await validatePersistedVerificationRun({ runId, request: persistedRequest, dependencies });
      await generateBoardForResult(options, result, stderr);
      const report: CliReport = { schemaVersion: "traceknot-cli-report/v1", run: result.run, verdict: result.verdict, snapshot: { rootIdentity: snapshot.rootIdentity, snapshotId: snapshot.snapshotId, head: snapshot.headCommit, dirty: snapshot.dirty }, documents: result.documents };
      stdout(reportOutput(report, options.format));
      return exitForVerdict(result.verdict);
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
      await repository.writeMetadata(runId, { schemaVersion: "traceknot-cli-state/v1", rootIdentity: snapshot.rootIdentity, snapshotId: snapshot.snapshotId, manifestDigest, capabilities: ["authenticated-execution-authority", "command", "browser-execution", "visual-composition", "test-result", "experiment", "review", "static-analysis", "build-result", "scenario-result"] });
    }
    const dependenciesResult = await makeDependencies(options, request, manifest, repository, snapshot.snapshotId, trustedPolicy); stores = dependenciesResult;
    const result = await runVerification({ runId, request, dependencies: dependenciesResult.dependencies });
    await generateBoardForResult(options, result, stderr);
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
