import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { dlopen, FFIType, read as ffiRead } from "bun:ffi";
import type { Artifact } from "../core/qa-core";
import type { ArtifactStore, CanonicalVerificationResultArtifact, VerificationExecutionRequest } from "./verification-run";

const DIGEST = /^[0-9a-f]{64}$/;
const RECORD_PREFIX = "TRACEKNOT-ARTIFACT-V1";
const RECORD_FOOTER = Buffer.from("\n", "ascii");
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const SEEK_SET = 0;
const SEEK_END = 2;

type ArtifactContent = Uint8Array | ArrayBuffer;
type ArtifactLike = Artifact & Readonly<{ bytes?: ArtifactContent; data?: ArtifactContent; content?: ArtifactContent | string }>;
type StoredArtifact = Readonly<{ bytes: Uint8Array }>;


const POSIX = dlopen("/usr/lib/libSystem.B.dylib", {
  open: { args: [FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  fsync: { args: [FFIType.i32], returns: FFIType.i32 },
  ftruncate: { args: [FFIType.i32, FFIType.i64], returns: FFIType.i32 },
  lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },
  __error: { args: [], returns: FFIType.ptr },
});

function errno(): number {
  return ffiRead.i32(POSIX.symbols.__error()!);
}

function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
}

export type LocalArtifactStoreOptions = Readonly<{ rootDir: string; fsync?: boolean }>;

export class ArtifactStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}

export class ArtifactIntegrityError extends ArtifactStoreError {
  constructor(message: string) {
    super("ARTIFACT_INTEGRITY_FAILURE", message);
    this.name = "ArtifactIntegrityError";
  }
}

export class ArtifactCollisionError extends ArtifactStoreError {
  constructor(message: string) {
    super("ARTIFACT_COLLISION", message);
    this.name = "ArtifactCollisionError";
  }
}

export class ArtifactPathError extends ArtifactStoreError {
  constructor(message: string) {
    super("ARTIFACT_PATH_FAILURE", message);
    this.name = "ArtifactPathError";
  }
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function asBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return undefined;
}

async function readSourceBytes(artifact: ArtifactLike): Promise<Uint8Array> {
  const embedded = asBytes(artifact.bytes) ?? asBytes(artifact.data) ?? (typeof artifact.content === "string" ? new TextEncoder().encode(artifact.content) : asBytes(artifact.content));
  if (embedded) return embedded;
  if (typeof artifact.path !== "string" || artifact.path.length === 0) throw new ArtifactIntegrityError("artifact content is unavailable; provide a readable path or bytes");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(artifact.path, constants.O_RDONLY | O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ArtifactPathError("artifact source must be a regular non-symlink file");
    return await handle.readFile();
  } catch (error) {
    if (error instanceof ArtifactStoreError) throw error;
    throw new ArtifactPathError(`artifact source cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function closeFd(fd: number | undefined): void {
  if (fd !== undefined) POSIX.symbols.close(fd);
}

function checkPosix(result: number, action: string): number {
  if (result >= 0) return result;
  throw new ArtifactPathError(`${action} failed (errno ${errno()})`);
}

async function writeAll(fd: number, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const destination = fd as unknown as Parameters<typeof Bun.write>[0];
    const written = await Bun.write(destination, bytes.subarray(offset));
    if (written <= 0) throw new Error("zero-length artifact write");
    offset += written;
  }
}

async function readAll(fd: number): Promise<Uint8Array> {
  checkPosix(Number(POSIX.symbols.lseek(fd, 0, SEEK_SET)), "artifact seek");
  const descriptor = fd as unknown as Parameters<typeof Bun.file>[0];
  return new Uint8Array(await Bun.file(descriptor).arrayBuffer());
}

async function openPinnedDirectory(rootDir: string): Promise<number> {
  let absolute = resolve(rootDir);
  try {
    absolute = join(await realpath(dirname(absolute)), basename(absolute));
  } catch {
    // The final directory may not exist yet; its existing parent is still pinned below.
  }
  if (!isAbsolute(absolute)) throw new ArtifactPathError("artifact root must be absolute");
  let current = checkPosix(POSIX.symbols.open(cstring("/"), constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0), "artifact root open");
  try {
    for (const segment of absolute.split("/").filter(Boolean)) {
      const name = cstring(segment);
      let next = POSIX.symbols.openat(current, name, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0);
      if (next < 0) {
        POSIX.symbols.mkdirat(current, name, 0o700);
        next = POSIX.symbols.openat(current, name, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0);
      }
      if (next < 0) throw new ArtifactPathError(`artifact root cannot be opened (errno ${errno()})`);
      closeFd(current);
      current = next;
    }
    return current;
  } catch (error) {
    closeFd(current);
    if (error instanceof ArtifactStoreError) throw error;
    throw new ArtifactPathError(`artifact root cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Append-only, content-addressed artifact persistence for VerificationRun.
 * The configured root and object log are opened once through descriptor-relative
 * operations. Root replacement therefore cannot redirect an existing store.
 */
export class LocalArtifactStore implements ArtifactStore {
  readonly rootDir: string;
  readonly fsync: boolean;
  private rootFd?: number;
  private objectFd?: number;
  private objects?: Map<string, StoredArtifact>;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(rootDirOrOptions: string | LocalArtifactStoreOptions) {
    const rootDir = typeof rootDirOrOptions === "string" ? rootDirOrOptions : rootDirOrOptions.rootDir;
    if (typeof rootDir !== "string" || rootDir.length === 0) throw new ArtifactPathError("artifact root is required");
    this.rootDir = resolve(rootDir);
    this.fsync = typeof rootDirOrOptions === "string" ? true : rootDirOrOptions.fsync !== false;
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>(resolvePromise => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureReady(): Promise<{ root: number; objects: Map<string, StoredArtifact> }> {
    if (this.rootFd !== undefined && this.objectFd !== undefined && this.objects) return { root: this.rootFd, objects: this.objects };
    const root = await openPinnedDirectory(this.rootDir);
    let objectFd: number | undefined;
    try {
      objectFd = checkPosix(POSIX.symbols.openat(root, cstring(".objects"), constants.O_RDWR | constants.O_CREAT | O_NOFOLLOW, 0o600), "artifact object log open");
      const objects = await this.recover(objectFd);
      this.rootFd = root;
      this.objectFd = objectFd;
      this.objects = objects;
      return { root, objects };
    } catch (error) {
      closeFd(objectFd);
      closeFd(root);
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactPathError(`artifact object log cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async recover(fd: number): Promise<Map<string, StoredArtifact>> {
    const file = await readAll(fd);
    const objects = new Map<string, StoredArtifact>();
    let offset = 0;
    while (offset < file.byteLength) {
      const newline = file.indexOf(10, offset);
      if (newline < 0) break;
      const header = Buffer.from(file.subarray(offset, newline)).toString("ascii").match(new RegExp(`^${RECORD_PREFIX} ([0-9a-f]{64}) ([0-9]+)$`));
      if (!header) throw new ArtifactPathError("artifact object log is malformed");
      const digest = header[1]!;
      const length = Number(header[2]!);
      if (!Number.isSafeInteger(length) || length < 0) throw new ArtifactPathError("artifact object log length is invalid");
      const contentStart = newline + 1;
      const contentEnd = contentStart + length;
      if (contentEnd + 1 > file.byteLength) break;
      if (file[contentEnd] !== 10) throw new ArtifactPathError("artifact object log is malformed");
      const content = file.slice(contentStart, contentEnd);
      if (sha256(content) !== digest) throw new ArtifactCollisionError("artifact object log contains a digest collision or corruption");
      const existing = objects.get(digest);
      if (existing && Buffer.compare(Buffer.from(existing.bytes), content) !== 0) throw new ArtifactCollisionError("artifact object log contains a digest collision");
      objects.set(digest, { bytes: content });
      offset = contentEnd + 1;
    }
    if (offset < file.byteLength) checkPosix(POSIX.symbols.ftruncate(fd, offset), "artifact object log recovery");
    return objects;
  }

  private async legacyTarget(root: number, digest: string): Promise<Uint8Array | undefined> {
    const fd = POSIX.symbols.openat(root, cstring(digest), constants.O_RDONLY | O_NOFOLLOW, 0);
    if (fd < 0) {
      const error = errno();
      if (error === 2) return undefined;
      if (error === 62) throw new ArtifactCollisionError("content-addressed target is a symbolic link");
      throw new ArtifactPathError(`content-addressed target cannot be inspected (errno ${error})`);
    }
    try {
      return await readAll(fd);
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactCollisionError("content-addressed target is not a regular file");
    } finally {
      closeFd(fd);
    }
  }

  private async append(root: number, fd: number, objects: Map<string, StoredArtifact>, digest: string, bytes: Uint8Array): Promise<void> {
    const legacy = await this.legacyTarget(root, digest);
    if (legacy && sha256(legacy) !== digest) throw new ArtifactCollisionError("content-addressed target has a digest collision or was modified");
    const existing = objects.get(digest);
    if (existing) {
      if (Buffer.compare(Buffer.from(existing.bytes), Buffer.from(bytes)) !== 0) throw new ArtifactCollisionError("content-addressed target has a digest collision or was modified");
      return;
    }
    const header = Buffer.from(`${RECORD_PREFIX} ${digest} ${bytes.byteLength}\n`, "ascii");
    checkPosix(Number(POSIX.symbols.lseek(fd, 0, SEEK_END)), "artifact object log seek");
    const start = Number(POSIX.symbols.lseek(fd, 0, SEEK_END));
    try {
      await writeAll(fd, header);
      await writeAll(fd, bytes);
      await writeAll(fd, RECORD_FOOTER);
      if (this.fsync) checkPosix(POSIX.symbols.fsync(fd), "artifact object log sync");
    } catch (error) {
      POSIX.symbols.ftruncate(fd, start);
      throw error;
    }
    objects.set(digest, { bytes: new Uint8Array(bytes) });
  }
  private async persist(artifact: ArtifactLike): Promise<Artifact> {
    return this.serialized(async () => {
      if (!artifact || typeof artifact !== "object") throw new ArtifactIntegrityError("artifact is required");
      if (typeof artifact.type !== "string" || artifact.type.length === 0) throw new ArtifactIntegrityError("artifact type is required");
      if (typeof artifact.digest !== "string" || !DIGEST.test(artifact.digest)) throw new ArtifactIntegrityError("artifact digest must be a lowercase SHA-256 hex string");
      const { root, objects } = await this.ensureReady();
      const sourceAvailable = (typeof artifact.path === "string" && artifact.path.length > 0) || asBytes(artifact.bytes) !== undefined || asBytes(artifact.data) !== undefined || asBytes(artifact.content) !== undefined || typeof artifact.content === "string";
      if (!sourceAvailable && objects.has(artifact.digest)) return { type: artifact.type, digest: artifact.digest };
      const bytes = sourceAvailable ? await readSourceBytes(artifact) : await this.legacyTarget(root, artifact.digest);
      if (!bytes) throw new ArtifactPathError("stored artifact does not exist");
      if (sha256(bytes) !== artifact.digest) {
        if (!sourceAvailable) throw new ArtifactCollisionError("content-addressed target has a digest collision or was modified");
        throw new ArtifactIntegrityError("artifact content does not match supplied digest");
      }
      await this.append(root, this.objectFd!, objects, artifact.digest, bytes);
      return { type: artifact.type, digest: artifact.digest };
    });
  }

  async storeVerificationResultArtifact(artifact: CanonicalVerificationResultArtifact, _input: VerificationExecutionRequest): Promise<Artifact> {
    return this.persist(artifact as ArtifactLike);
  }

  async storeArtifact(artifact: Artifact, _input: VerificationExecutionRequest): Promise<Artifact> {
    return this.persist(artifact as ArtifactLike);
  }

  async putArtifact(artifact: Artifact, _input: VerificationExecutionRequest): Promise<Artifact> {
    return this.persist(artifact as ArtifactLike);
  }

  async store(artifact: Artifact, _input: VerificationExecutionRequest): Promise<Artifact> {
    return this.persist(artifact as ArtifactLike);
  }

  async readArtifact(digest: string): Promise<Uint8Array> {
    return this.serialized(async () => {
      if (!DIGEST.test(digest)) throw new ArtifactIntegrityError("artifact digest must be a lowercase SHA-256 hex string");
      const { root, objects } = await this.ensureReady();
      const stored = objects.get(digest);
      if (stored) return new Uint8Array(stored.bytes);
      const legacy = await this.legacyTarget(root, digest);
      if (!legacy) throw new ArtifactPathError("stored artifact does not exist");
      if (sha256(legacy) !== digest) throw new ArtifactCollisionError("content-addressed target has a digest collision or was modified");
      return legacy;
    });
  }

  async hasArtifact(digest: string): Promise<boolean> {
    return this.serialized(async () => {
      if (!DIGEST.test(digest)) return false;
      const { objects } = await this.ensureReady();
      return objects.has(digest);
    });
  }

  async close(): Promise<void> {
    await this.serialized(async () => {
      closeFd(this.objectFd);
      closeFd(this.rootFd);
      this.objectFd = undefined;
      this.rootFd = undefined;
      this.objects = undefined;
    });
  }
}

export type AppendOnlyArtifactStore = LocalArtifactStore;
export const createLocalArtifactStore = (rootDirOrOptions: string | LocalArtifactStoreOptions): LocalArtifactStore => new LocalArtifactStore(rootDirOrOptions);
export const createAppendOnlyArtifactStore = createLocalArtifactStore;
