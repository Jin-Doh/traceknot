import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { Artifact, Execution, Observation, Producer } from "../core/qa-core";
import type { ArtifactStore, VerificationExecutionRequest } from "./verification-run";
import {
  ArtifactNotFoundError,
  assertSecureRoot,
  closeSecureRoot,
  closeSecureDescriptor,
  openSecureDirectory,
  openSecureRoot,
  readSecureRegularFile,
  type SecureRootDescriptor,
} from "./local-artifact-store";

const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const SECRET_NAME = /(pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|auth)/i;

type ByteSource = Uint8Array | ArrayBuffer;

export type ShellArtifactDeclaration = Readonly<{
  type: string;
  digest: string;
  path: string;
}>;

export type ShellObservationRequest = Readonly<{
  requestId: string;
  snapshotId: string;
  rootIdentity?: string;
  observationId?: string;
  executable: string;
  argv?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxArtifactBytes?: number;
  declaredArtifacts?: readonly ShellArtifactDeclaration[];
  bestEffortDeclaredArtifactsOnFailure?: boolean;
  toolVersion?: string;
  producer?: Producer;
}>;

export type LocalShellCollectorOptions = Readonly<{
  rootDir: string;
  snapshotId: string;
  rootIdentity?: string;
  artifactStore: ArtifactStore;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxArtifactBytes?: number;
  envAllowlist?: readonly string[];
  toolVersion?: string;
  now?: () => string | Date;
}>;

export class ShellCollectorError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ShellCollectorError";
    this.code = code;
  }
}

export type LocalShellObservation = Observation;

const asBuffer = (value: ByteSource): Uint8Array => value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value.slice(0));
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const asDateString = (clock: () => string | Date): string => {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new ShellCollectorError("CLOCK_INVALID", "collector clock returned an invalid date");
  return date.toISOString();
};
const sleep = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
};
const validDigest = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
const DANGEROUS_ENV = /^(?:LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|NODE_OPTIONS|BUN_OPTIONS|PYTHONINSPECT|PYTHONPATH|RUBYOPT|PERL5OPT|GODEBUG|JAVA_TOOL_OPTIONS|CLASSPATH|COMPlus_[A-Z0-9_]*)$/i;
const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);

const SPAWN_WRAPPER = `
const fs = require("node:fs");
const { dlopen, FFIType } = require("bun:ffi");
const library = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : process.platform === "linux" ? "libc.so.6" : undefined;
if (!library) process.exit(126);
const symbols = dlopen(library, { fchdir: { args: [FFIType.i32], returns: FFIType.i32 } }).symbols;
if (symbols.fchdir(0) !== 0) process.exit(126);
let pinnedPath;
if (process.platform === "darwin") {
  pinnedPath = fs.realpathSync("/dev/fd/0");
} else {
  pinnedPath = fs.readlinkSync("/proc/self/fd/0");
}
try {
  process.chdir(pinnedPath);
  const descriptor = fs.fstatSync(0);
  const current = fs.statSync(".");
  if (descriptor.dev !== current.dev || descriptor.ino !== current.ino) process.exit(126);
} catch {
  process.exit(126);
}
const target = JSON.parse(process.argv[1]);
let child;
try {
  child = Bun.spawn(target, { env: process.env, stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true });
} catch (error) {
  process.stderr.write("__TRACEKNOT_SPAWN_FAILURE__" + String(error));
  process.exit(125);
}
const status = await child.exited;
process.exit(typeof status === "number" ? status : 1);
`;

async function spawnInDirectory(directory: number, executable: string, argv: readonly string[], env: Record<string, string>): Promise<Bun.Subprocess> {
  return Bun.spawn([process.execPath, "-e", SPAWN_WRAPPER, JSON.stringify([executable, ...argv])], {
    env,
    stdio: [directory, "pipe", "pipe"],
    detached: true,
  });
}

function relativePath(root: string, alias: string, requested: string | undefined, label: string): string {
  const bases = [root, alias];
  for (const base of bases) {
    const target = requested === undefined ? base : isAbsolute(requested) ? resolve(requested) : resolve(base, requested);
    const result = relative(base, target);
    if (result === "" || (!result.startsWith("..") && !isAbsolute(result))) return result;
  }
  throw new ShellCollectorError("PATH_INVALID", `${label} must remain inside the snapshot root`);
}

type Capture = Readonly<{ bytes: Uint8Array; overflow: boolean }>;
async function readBounded(stream: ReadableStream<Uint8Array> | number | undefined, limit: number, onOverflow: () => void): Promise<Capture> {
  if (!stream || typeof stream === "number") return { bytes: new Uint8Array(), overflow: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = asBuffer(next.value);
      if (total + chunk.byteLength > limit) {
        overflow = true;
        const remaining = Math.max(0, limit - total);
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        total = limit;
        onOverflow();
      } else {
        chunks.push(chunk);
        total += chunk.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, overflow };
}

async function descendantPids(rootPid: number): Promise<number[]> {
  try {
    const ps = Bun.spawn(["/bin/ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
    const output = await readBounded(ps.stdout, 4 * 1024 * 1024, () => undefined);
    await ps.exited;
    const children = new Map<number, number[]>();
    for (const line of new TextDecoder().decode(output.bytes).split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const parent = Number(match[2]);
      const siblings = children.get(parent) ?? [];
      siblings.push(pid);
      children.set(parent, siblings);
    }
    const result: number[] = [];
    const pending = [rootPid];
    const seen = new Set<number>([rootPid]);
    while (pending.length > 0) {
      const parent = pending.shift()!;
      for (const pid of children.get(parent) ?? []) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        result.push(pid);
        pending.push(pid);
      }
    }
    return result.reverse();
  } catch {
    return [];
  }
}

async function terminateTree(child: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  const pid = child.pid;
  if (typeof pid === "number" && pid > 1) {
    for (const descendant of await descendantPids(pid)) {
      try { process.kill(descendant, signal); } catch { /* descendant may already have exited */ }
    }
    try { process.kill(-pid, signal); } catch { /* process groups are unavailable on some hosts */ }
  }
  try { child.kill(signal); } catch { /* child may already have exited */ }
}

async function stopTree(child: Bun.Subprocess): Promise<void> {
  await terminateTree(child, "SIGTERM");
  const finished = await Promise.race([child.exited.then(() => true), sleep(250).then(() => false)]);
  if (!finished) {
    await terminateTree(child, "SIGKILL");
    await child.exited;
  }
}

function storeInput(request: ShellObservationRequest): VerificationExecutionRequest {
  return {
    runId: request.requestId,
    requestId: request.requestId,
    requestDigest: digest(new TextEncoder().encode(request.requestId)),
    planDigest: digest(new TextEncoder().encode("local-shell-plan")),
    obligationDigest: digest(new TextEncoder().encode("local-shell-obligation")),
    rootIdentity: request.rootIdentity ?? "local-shell",
    snapshotId: request.snapshotId,
    obligation: { id: "local-shell", conditionIds: [], evidenceType: "scenario-result", mandatory: true, independence: "self-check", entryCriteria: [], completionCriteria: [] },
    conditionIds: [],
    idempotencyKey: `${request.requestId}:${request.snapshotId}`,
  } as VerificationExecutionRequest;
}

async function saveArtifact(store: ArtifactStore, artifact: Artifact & Readonly<{ bytes?: Uint8Array }>, request: ShellObservationRequest): Promise<Artifact> {
  const method = store.storeArtifact ?? store.putArtifact ?? store.store;
  const readback = (store as ArtifactStore & Readonly<{ readArtifact?: (digest: string) => Promise<Uint8Array> }>).readArtifact;
  if (!method || typeof readback !== "function") throw new ShellCollectorError("ARTIFACT_STORE_UNAVAILABLE", "artifact store must provide storage and readback ports");
  let saved: Artifact | undefined;
  try {
    saved = await method.call(store, artifact, storeInput(request));
    const bytes = await readback.call(store, artifact.digest);
    if (digest(bytes) !== artifact.digest || (artifact.bytes && !equalBytes(bytes, artifact.bytes))) throw new ShellCollectorError("ARTIFACT_STORE_FAILED", "artifact store readback failed integrity verification");
  } catch (error) {
    if (error instanceof ShellCollectorError) throw error;
    throw new ShellCollectorError("ARTIFACT_STORE_FAILED", `artifact publication failed: ${String(error)}`, { cause: error });
  }
  if (!saved || saved.type !== artifact.type || saved.digest !== artifact.digest || (artifact.path !== undefined && saved.path !== artifact.path)) throw new ShellCollectorError("ARTIFACT_STORE_FAILED", "artifact store returned an unverified artifact");
  return saved;
}

function boundedNumber(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0 || result > maximum) throw new ShellCollectorError("LIMIT_INVALID", `${label} must be a positive bounded integer`);
  return result;
}

export class LocalShellCollector {
  readonly rootDir: string;
  readonly snapshotId: string;
  readonly rootIdentity?: string;
  private readonly artifactStore: ArtifactStore;
  private readonly defaultTimeoutMs: number;
  private readonly defaultOutputBytes: number;
  private readonly maxArtifactBytes: number;
  private readonly envAllowlist: ReadonlySet<string>;
  private readonly toolVersion: string;
  private readonly clock: () => string | Date;

  constructor(options: LocalShellCollectorOptions) {
    this.rootDir = resolve(options.rootDir);
    this.snapshotId = options.snapshotId;
    this.rootIdentity = options.rootIdentity;
    this.artifactStore = options.artifactStore;
    this.defaultTimeoutMs = boundedNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeoutMs");
    this.defaultOutputBytes = boundedNumber(options.maxOutputBytes, DEFAULT_OUTPUT_BYTES, DEFAULT_ARTIFACT_BYTES, "maxOutputBytes");
    this.maxArtifactBytes = boundedNumber(options.maxArtifactBytes, DEFAULT_ARTIFACT_BYTES, DEFAULT_ARTIFACT_BYTES, "maxArtifactBytes");
    this.envAllowlist = new Set(options.envAllowlist ?? ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]);
    this.toolVersion = options.toolVersion ?? "unknown";
    this.clock = options.now ?? (() => new Date());
  }

  async collect(request: ShellObservationRequest): Promise<LocalShellObservation> {
    let root: SecureRootDescriptor;
    try {
      root = await openSecureRoot(this.rootDir);
      assertSecureRoot(root);
    } catch (error) {
      throw new ShellCollectorError("ROOT_INVALID", `collector root cannot be securely opened: ${String(error)}`, { cause: error });
    }
    try {
      return await this.collectAtRoot(root, request);
    } finally {
      await closeSecureRoot(root);
    }
  }

  private async collectAtRoot(root: SecureRootDescriptor, request: ShellObservationRequest): Promise<LocalShellObservation> {
    if (!request || typeof request !== "object" || typeof request.snapshotId !== "string" || request.snapshotId !== this.snapshotId) throw new ShellCollectorError("SNAPSHOT_MISMATCH", "shell observation is not bound to the configured snapshot");
    if (this.rootIdentity !== undefined && request.rootIdentity !== undefined && request.rootIdentity !== this.rootIdentity) throw new ShellCollectorError("ROOT_IDENTITY_MISMATCH", "shell observation root identity does not match the configured snapshot");
    if (typeof request.requestId !== "string" || !request.requestId || typeof request.executable !== "string" || !request.executable || request.executable.includes("\0")) throw new ShellCollectorError("REQUEST_INVALID", "requestId and executable are required and executable cannot contain NUL");
    if (request.argv !== undefined && !Array.isArray(request.argv)) throw new ShellCollectorError("REQUEST_INVALID", "argv must be an array");
    if (request.cwd !== undefined && (typeof request.cwd !== "string" || request.cwd.includes("\0"))) throw new ShellCollectorError("REQUEST_INVALID", "cwd must be a NUL-free string");
    if (request.observationId !== undefined && (typeof request.observationId !== "string" || !request.observationId)) throw new ShellCollectorError("REQUEST_INVALID", "observationId must be a non-empty string");
    if (request.toolVersion !== undefined && typeof request.toolVersion !== "string") throw new ShellCollectorError("REQUEST_INVALID", "toolVersion must be a string");
    if (request.declaredArtifacts !== undefined && !Array.isArray(request.declaredArtifacts)) throw new ShellCollectorError("REQUEST_INVALID", "declaredArtifacts must be an array");
    if (request.bestEffortDeclaredArtifactsOnFailure !== undefined && typeof request.bestEffortDeclaredArtifactsOnFailure !== "boolean") throw new ShellCollectorError("REQUEST_INVALID", "bestEffortDeclaredArtifactsOnFailure must be a boolean");
    if (request.env !== undefined && (typeof request.env !== "object" || request.env === null || Object.entries(request.env).some(([name, value]) => name.includes("\0") || typeof value !== "string" || value.includes("\0")))) throw new ShellCollectorError("REQUEST_INVALID", "env must contain only NUL-free string values");
    const argv = [...(request.argv ?? [])];
    if (argv.some(value => typeof value !== "string" || value.includes("\0"))) throw new ShellCollectorError("REQUEST_INVALID", "argv values must be NUL-free strings");
    const cwdRelative = relativePath(root.canonical, root.rootDir, request.cwd, "cwd");
    const cwd = resolve(root.canonical, cwdRelative);
    let cwdDescriptor: number;
    try {
      cwdDescriptor = openSecureDirectory(root.fd, cwdRelative);
    } catch (error) {
      throw new ShellCollectorError("PATH_INVALID", `cwd cannot be securely opened: ${String(error)}`, { cause: error });
    }
    const timeoutMs = boundedNumber(request.timeoutMs, this.defaultTimeoutMs, MAX_TIMEOUT_MS, "timeoutMs");
    const maxOutputBytes = boundedNumber(request.maxOutputBytes, this.defaultOutputBytes, DEFAULT_ARTIFACT_BYTES, "maxOutputBytes");
    const maxArtifactBytes = boundedNumber(request.maxArtifactBytes, this.maxArtifactBytes, this.maxArtifactBytes, "maxArtifactBytes");
    const executable = request.executable;
    const env: Record<string, string> = { PATH: SAFE_PATH };
    for (const name of this.envAllowlist) {
      if (name === "PATH" || SECRET_NAME.test(name) || DANGEROUS_ENV.test(name)) continue;
      const value = request.env?.[name] ?? process.env[name];
      if (typeof value === "string" && !value.includes("\0")) env[name] = value;
    }
    for (const [name, value] of Object.entries(request.env ?? {})) {
      if (name === "PATH" || SECRET_NAME.test(name) || DANGEROUS_ENV.test(name) || !this.envAllowlist.has(name)) continue;
      env[name] = value;
    }
    env.PATH = SAFE_PATH;
    const producer = request.producer ?? { kind: "self", identity: "traceknot-local-shell", independence: "self-check" } satisfies Producer;
    if (!producer || typeof producer !== "object" || typeof producer.kind !== "string" || typeof producer.identity !== "string" || typeof producer.independence !== "string") {
      closeSecureDescriptor(cwdDescriptor);
      throw new ShellCollectorError("PRODUCER_INVALID", "producer must be a valid producer object");
    }
    if (producer.kind === "self" && producer.independence !== "self-check") {
      closeSecureDescriptor(cwdDescriptor);
      throw new ShellCollectorError("PRODUCER_INVALID", "self producer must use self-check independence");
    }
    const startedAt = asDateString(this.clock);
    const executionIdentity = `local-shell:${JSON.stringify([executable, argv])}`;
    let child: Bun.Subprocess;
    try {
      child = await spawnInDirectory(cwdDescriptor, executable, argv, env);
    } catch (error) {
      closeSecureDescriptor(cwdDescriptor);
      const finishedAt = asDateString(this.clock);
      return { schemaVersion: "observation/v1", observationId: request.observationId ?? randomUUID(), requestId: request.requestId, snapshotId: request.snapshotId, producer, execution: { kind: "command", identity: executionIdentity, startedAt, finishedAt, exitStatus: "failed" }, artifacts: [], actualValues: { toolVersion: request.toolVersion ?? this.toolVersion, executable, argv: JSON.stringify(argv), cwd, spawnError: String(error) } };
    }
    closeSecureDescriptor(cwdDescriptor);
    let overflow = false;
    let overflowStop: Promise<void> | undefined;
    const triggerOverflow = (): void => {
      overflow = true;
      overflowStop ??= stopTree(child);
    };
    const stdoutPromise = readBounded(child.stdout, maxOutputBytes, triggerOverflow);
    const stderrPromise = readBounded(child.stderr, maxOutputBytes, triggerOverflow);
    const exitPromise = child.exited;
    let timedOut = false;
    const timeoutResult = await Promise.race([exitPromise.then(() => false), sleep(timeoutMs).then(() => true)]);
    if (timeoutResult) {
      timedOut = true;
      await stopTree(child);
    }
    const [exitCode, stdout, stderr] = await Promise.all([exitPromise, stdoutPromise, stderrPromise]);
    if (overflowStop) await overflowStop;
    try { assertSecureRoot(root); } catch (error) { throw new ShellCollectorError("ROOT_CHANGED", `snapshot root changed during command execution: ${String(error)}`, { cause: error }); }
    const spawnFailurePrefix = "__TRACEKNOT_SPAWN_FAILURE__";
    const spawnFailure = new TextDecoder().decode(stderr.bytes);
    if (!timedOut && !overflow && exitCode === 125 && spawnFailure.startsWith(spawnFailurePrefix)) {
      const finishedAt = asDateString(this.clock);
      return { schemaVersion: "observation/v1", observationId: request.observationId ?? randomUUID(), requestId: request.requestId, snapshotId: request.snapshotId, producer, execution: { kind: "command", identity: executionIdentity, startedAt, finishedAt, exitStatus: "failed" }, artifacts: [], actualValues: { toolVersion: request.toolVersion ?? this.toolVersion, executable, argv: JSON.stringify(argv), cwd, spawnError: spawnFailure.slice(spawnFailurePrefix.length) } };
    }
    const finishedAt = asDateString(this.clock);
    const actualValues: Record<string, string | number | boolean | null> = {
      toolVersion: request.toolVersion ?? this.toolVersion,
      executable,
      argv: JSON.stringify(argv),
      cwd,
      stdoutBytes: stdout.bytes.byteLength,
      stderrBytes: stderr.bytes.byteLength,
      outputLimitExceeded: overflow || stdout.overflow || stderr.overflow,
      timedOut,
    };
    const status: Execution["exitStatus"] = timedOut ? "timed-out" : overflow ? "failed" : exitCode === 0 ? "passed" : "failed";
    if (exitCode !== 0) actualValues.exitCode = exitCode;
    const signal = (child as unknown as { signalCode?: string | number }).signalCode;
    if (signal !== undefined) actualValues.signal = String(signal);
    const artifacts: Artifact[] = [];
    artifacts.push(await saveArtifact(this.artifactStore, { type: "shell-output", path: "stdout", digest: digest(stdout.bytes), bytes: stdout.bytes } as Artifact & { bytes: Uint8Array }, request));
    artifacts.push(await saveArtifact(this.artifactStore, { type: "shell-output", path: "stderr", digest: digest(stderr.bytes), bytes: stderr.bytes } as Artifact & { bytes: Uint8Array }, request));
    for (const declaration of request.declaredArtifacts ?? []) {
      if (!declaration || typeof declaration.type !== "string" || !declaration.type || typeof declaration.digest !== "string" || !validDigest(declaration.digest) || typeof declaration.path !== "string" || !declaration.path) throw new ShellCollectorError("DECLARED_ARTIFACT_INVALID", "declared artifact type/digest/path is invalid");
      const artifactRelative = relativePath(root.canonical, root.rootDir, declaration.path, "declared artifact");
      let bytes: Uint8Array;
      try {
        bytes = await readSecureRegularFile(root.fd, artifactRelative, maxArtifactBytes);
      } catch (error) {
        if (status !== "passed" && request.bestEffortDeclaredArtifactsOnFailure === true && error instanceof ArtifactNotFoundError) continue;
        const code = String(error).includes("byte bound") ? "ARTIFACT_TOO_LARGE" : "ARTIFACT_READ_FAILED";
        throw new ShellCollectorError(code, `declared artifact cannot be securely read: ${String(error)}`, { cause: error });
      }
      if (digest(bytes) !== declaration.digest) throw new ShellCollectorError("DECLARED_ARTIFACT_MISMATCH", `declared artifact digest mismatch for ${declaration.path}`);
      const path = resolve(root.canonical, artifactRelative);
      artifacts.push(await saveArtifact(this.artifactStore, { ...declaration, path, bytes } as Artifact & { bytes: Uint8Array }, request));
    }
    try { assertSecureRoot(root); } catch (error) { throw new ShellCollectorError("ROOT_CHANGED", `snapshot root changed before observation publication: ${String(error)}`, { cause: error }); }
    return { schemaVersion: "observation/v1", observationId: request.observationId ?? randomUUID(), requestId: request.requestId, snapshotId: request.snapshotId, producer, execution: { kind: "command", identity: executionIdentity, startedAt, finishedAt, exitStatus: status, ...(typeof exitCode === "number" && !timedOut ? { exitCode } : {}) }, artifacts, actualValues };
  }

  async execute(request: ShellObservationRequest): Promise<LocalShellObservation> { return this.collect(request); }
  async capture(request: ShellObservationRequest): Promise<LocalShellObservation> { return this.collect(request); }
}

export const createLocalShellCollector = (options: LocalShellCollectorOptions): LocalShellCollector => new LocalShellCollector(options);
