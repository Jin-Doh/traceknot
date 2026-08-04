import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Artifact, Execution, Observation, Producer } from "../core/qa-core";
import type { ArtifactStore, VerificationExecutionRequest } from "./verification-run";

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
  declaredArtifacts?: readonly ShellArtifactDeclaration[];
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
const within = (root: string, target: string): boolean => {
  const relativePath = relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
};
const validDigest = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);

async function checkedRoot(rootDir: string): Promise<string> {
  if (!rootDir || typeof rootDir !== "string") throw new ShellCollectorError("ROOT_INVALID", "collector root is required");
  const candidate = resolve(rootDir);
  const info = await lstat(candidate).catch(error => { throw new ShellCollectorError("ROOT_INVALID", `collector root cannot be read: ${String(error)}`, { cause: error }); });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ShellCollectorError("ROOT_INVALID", "collector root must be a regular directory");
  const canonical = await realpath(candidate).catch(error => { throw new ShellCollectorError("ROOT_INVALID", `collector root cannot be resolved: ${String(error)}`, { cause: error }); });
  return canonical;
}

async function checkedPath(root: string, requested: string | undefined, label: string, directory: boolean): Promise<string> {
  const absoluteRequest = requested !== undefined && isAbsolute(requested);
  const candidate = resolve(root, requested ?? ".");
  const info = await lstat(candidate).catch(error => { throw new ShellCollectorError("PATH_INVALID", `${label} cannot be read: ${String(error)}`, { cause: error }); });
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new ShellCollectorError("PATH_INVALID", `${label} must be a non-symlink ${directory ? "directory" : "regular file"}`);
  const canonical = await realpath(candidate).catch(error => { throw new ShellCollectorError("PATH_INVALID", `${label} cannot be resolved: ${String(error)}`, { cause: error }); });
  if (!within(root, canonical) || (!absoluteRequest && canonical !== candidate)) throw new ShellCollectorError("PATH_INVALID", `${label} must remain inside the snapshot root`);
  return canonical;
}

async function readBoundedFile(path: string, limit: number): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => { throw new ShellCollectorError("ARTIFACT_READ_FAILED", `artifact cannot be opened: ${String(error)}`, { cause: error }); });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ShellCollectorError("ARTIFACT_READ_FAILED", "declared artifact must be a regular non-symlink file");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = new Uint8Array(Math.min(64 * 1024, limit - total + 1));
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > limit) throw new ShellCollectorError("ARTIFACT_TOO_LARGE", "declared artifact exceeds the configured byte bound");
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    await handle.close().catch(() => undefined);
  }
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
  if (!method) throw new ShellCollectorError("ARTIFACT_STORE_UNAVAILABLE", "artifact store does not implement a storage port");
  let saved: Artifact | undefined;
  try {
    saved = await method.call(store, artifact, storeInput(request));
  } catch (error) {
    throw new ShellCollectorError("ARTIFACT_STORE_FAILED", `artifact publication failed: ${String(error)}`, { cause: error });
  }
  if (!saved || saved.type !== artifact.type || saved.digest !== artifact.digest) throw new ShellCollectorError("ARTIFACT_STORE_FAILED", "artifact store returned an unverified artifact");
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
  private rootReady: Promise<string>;

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
    this.rootReady = checkedRoot(this.rootDir);
  }

  async collect(request: ShellObservationRequest): Promise<LocalShellObservation> {
    const root = await this.rootReady;
    if (!request || request.snapshotId !== this.snapshotId) throw new ShellCollectorError("SNAPSHOT_MISMATCH", "shell observation is not bound to the configured snapshot");
    if (this.rootIdentity !== undefined && request.rootIdentity !== undefined && request.rootIdentity !== this.rootIdentity) throw new ShellCollectorError("ROOT_IDENTITY_MISMATCH", "shell observation root identity does not match the configured snapshot");
    if (!request.requestId || !request.executable || request.executable.includes("\0")) throw new ShellCollectorError("REQUEST_INVALID", "requestId and executable are required and executable cannot contain NUL");
    const argv = [...(request.argv ?? [])];
    if (argv.some(value => typeof value !== "string" || value.includes("\0"))) throw new ShellCollectorError("REQUEST_INVALID", "argv values must be NUL-free strings");
    const cwd = await checkedPath(root, request.cwd, "cwd", true);
    const timeoutMs = boundedNumber(request.timeoutMs, this.defaultTimeoutMs, MAX_TIMEOUT_MS, "timeoutMs");
    const maxOutputBytes = boundedNumber(request.maxOutputBytes, this.defaultOutputBytes, DEFAULT_ARTIFACT_BYTES, "maxOutputBytes");
    const executable = request.executable;
    const env: Record<string, string> = { PATH: SAFE_PATH };
    for (const name of this.envAllowlist) {
      if (SECRET_NAME.test(name)) continue;
      const value = request.env?.[name] ?? (name === "PATH" ? SAFE_PATH : process.env[name]);
      if (value !== undefined) env[name] = value;
    }
    for (const [name, value] of Object.entries(request.env ?? {})) {
      if (SECRET_NAME.test(name) || !this.envAllowlist.has(name)) continue;
      env[name] = value;
    }
    const producer = request.producer ?? { kind: "self", identity: "traceknot-local-shell", independence: "self-check" } satisfies Producer;
    if (producer.kind === "self" && producer.independence !== "self-check") throw new ShellCollectorError("PRODUCER_INVALID", "self producer must use self-check independence");
    const startedAt = asDateString(this.clock);
    const executionIdentity = `local-shell:${JSON.stringify([executable, argv])}`;
    let child: Bun.Subprocess;
    try {
      child = Bun.spawn([executable, ...argv], { cwd, env, stdout: "pipe", stderr: "pipe", detached: true });
    } catch (error) {
      const finishedAt = asDateString(this.clock);
      return { schemaVersion: "observation/v1", observationId: request.observationId ?? randomUUID(), requestId: request.requestId, snapshotId: request.snapshotId, producer, execution: { kind: "command", identity: executionIdentity, startedAt, finishedAt, exitStatus: "failed" }, artifacts: [], actualValues: { toolVersion: request.toolVersion ?? this.toolVersion, executable, argv: JSON.stringify(argv), cwd, spawnError: String(error) } };
    }
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
      if (!declaration.type || !validDigest(declaration.digest)) throw new ShellCollectorError("DECLARED_ARTIFACT_INVALID", "declared artifact type/digest is invalid");
      const path = await checkedPath(root, declaration.path, "declared artifact", false);
      const bytes = await readBoundedFile(path, this.maxArtifactBytes);
      if (digest(bytes) !== declaration.digest) throw new ShellCollectorError("DECLARED_ARTIFACT_MISMATCH", `declared artifact digest mismatch for ${declaration.path}`);
      artifacts.push(await saveArtifact(this.artifactStore, { ...declaration, path, bytes } as Artifact & { bytes: Uint8Array }, request));
    }
    const observation: Observation = { schemaVersion: "observation/v1", observationId: request.observationId ?? randomUUID(), requestId: request.requestId, snapshotId: request.snapshotId, producer, execution: { kind: "command", identity: executionIdentity, startedAt, finishedAt, exitStatus: status, ...(typeof exitCode === "number" && !timedOut ? { exitCode } : {}) }, artifacts, actualValues };
    return observation;
  }

  async execute(request: ShellObservationRequest): Promise<LocalShellObservation> { return this.collect(request); }
  async capture(request: ShellObservationRequest): Promise<LocalShellObservation> { return this.collect(request); }
}

export const createLocalShellCollector = (options: LocalShellCollectorOptions): LocalShellCollector => new LocalShellCollector(options);
