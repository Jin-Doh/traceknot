import { createHash, randomUUID } from "node:crypto";
import { constants, fstatSync, futimesSync, lstatSync, readSync, realpathSync, statSync, writeSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { dlopen, FFIType, read as ffiRead } from "bun:ffi";
import type { Artifact } from "../core/qa-core";
import type { ArtifactStore, CanonicalStoredArtifact, VerificationExecutionRequest } from "./verification-run";

const DIGEST = /^[0-9a-f]{64}$/;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const O_CLOEXEC = (constants as Record<string, number | undefined>).O_CLOEXEC ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const AT_FDCWD = -2;
const LOCK_EX = 2;
const LOCK_UN = 8;
const LOCK_NB = 4;
export const ARTIFACT_CANONICAL_LOCK_FILE = ".artifact.lock";
export const STORAGE_MAINTENANCE_LOCK_FILE = ".traceknot-storage.lock";
const EPHEMERAL_LEASE_FILE = ".ephemeral.lease";
const MAX_TYPE_BYTES = 1 << 20;
const MAX_ARTIFACT_BYTES = 256 << 20;
const MAGIC = new TextEncoder().encode("TRACEKNOT-ARTIFACT-V1\0");
const TEXT = new TextDecoder("utf-8", { fatal: true });

type ArtifactContent = Uint8Array | ArrayBuffer;
type ArtifactLike = Artifact & Readonly<{ bytes?: ArtifactContent; data?: ArtifactContent; content?: ArtifactContent | string }>;
type Native = {
  symbols: {
    openat: (dirfd: number, path: Buffer, flags: number, mode: number) => number;
    faccessat: (dirfd: number, path: Buffer, mode: number, flags: number) => number;
    mkdirat: (dirfd: number, path: Buffer, mode: number) => number;
    renameat: (oldfd: number, oldpath: Buffer, newfd: number, newpath: Buffer) => number;
    linkat: (oldfd: number, oldpath: Buffer, newfd: number, newpath: Buffer, flags: number) => number;
    unlinkat: (dirfd: number, path: Buffer, flags: number) => number;
    fchmod: (fd: number, mode: number) => number;
    fsync: (fd: number) => number;
    close: (fd: number) => number;
    flock: (fd: number, operation: number) => number;
    errno: () => unknown;
  };
};
type DecodedFrame = Readonly<{ type: string; bytes: Uint8Array }>;

function loadNative(): Native | undefined {
  const platform = process.platform;
  const library = platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : platform === "linux" ? "libc.so.6" : undefined;
  const errnoSymbol = platform === "darwin" ? "__error" : platform === "linux" ? "__errno_location" : undefined;
  if (!library || !errnoSymbol) return undefined;
  try {
    const loaded = dlopen(library, {
      openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      faccessat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      renameat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring], returns: FFIType.i32 },
      unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      linkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
      fchmod: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      fsync: { args: [FFIType.i32], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      [errnoSymbol]: { args: [], returns: FFIType.ptr },
    });
    const symbols = loaded.symbols as unknown as Native["symbols"] & Record<string, () => unknown>;
    return {
      symbols: {
        openat: symbols.openat,
        faccessat: symbols.faccessat,
        mkdirat: symbols.mkdirat,
        renameat: symbols.renameat,
        linkat: symbols.linkat,
        unlinkat: symbols.unlinkat,
        fchmod: symbols.fchmod,
        fsync: symbols.fsync,
        close: symbols.close,
        flock: symbols.flock,
        errno: symbols[errnoSymbol],
      },
    };
  } catch {
    return undefined;
  }
}

const NATIVE = loadNative();

export type LocalArtifactStoreOptions = Readonly<{ rootDir: string; fsync?: boolean; ephemeral?: true }>;

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
export class ArtifactNotFoundError extends ArtifactPathError {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactNotFoundError";
  }
}

function native(): Native {
  if (!NATIVE) throw new ArtifactPathError(`artifact storage is unsupported on platform ${process.platform}`);
  return NATIVE;
}
function errnoFrom(symbols: Native["symbols"]): number {
  return ffiRead.i32(symbols.errno() as unknown as Parameters<typeof ffiRead.i32>[0]);
}
function errno(): number {
  return errnoFrom(native().symbols);
}
function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
}
function check(result: number, action: string): number {
  if (result >= 0) return result;
  const error = errno();
  if (error === 2) throw new ArtifactNotFoundError(`${action} failed (errno ${error})`);
  throw new ArtifactPathError(`${action} failed (errno ${error})`);
}
export type SecureRootDescriptor = Readonly<{
  readonly rootDir: string;
  readonly canonical: string;
  readonly fd: number;
  readonly device: number;
  readonly inode: number;
  readonly handle: FileHandle;
}>;

const DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | ((constants as Record<string, number | undefined>).O_CLOEXEC ?? 0);
const FILE_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | ((constants as Record<string, number | undefined>).O_CLOEXEC ?? 0);

export async function openSecureRoot(rootDir: string): Promise<SecureRootDescriptor> {
  if (typeof rootDir !== "string" || rootDir.length === 0) throw new ArtifactPathError("root directory is required");
  const candidate = resolve(rootDir);
  let handle: FileHandle | undefined;
  try {
    handle = await open(candidate, DIRECTORY_FLAGS);
    const descriptorStat = fstatSync(handle.fd);
    if (!descriptorStat.isDirectory()) throw new ArtifactPathError("root directory must be a directory");
    const canonical = realpathSync(candidate);
    const canonicalStat = statSync(canonical);
    if (canonicalStat.dev !== descriptorStat.dev || canonicalStat.ino !== descriptorStat.ino) throw new ArtifactPathError("root directory changed while opening");
    return { rootDir: candidate, canonical, fd: handle.fd, device: descriptorStat.dev, inode: descriptorStat.ino, handle };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof ArtifactStoreError) throw error;
    throw new ArtifactPathError(`root directory cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function assertSecureRoot(root: SecureRootDescriptor): void {
  let pathStat;
  try { pathStat = statSync(root.rootDir); } catch (error) { throw new ArtifactPathError(`root directory changed: ${error instanceof Error ? error.message : String(error)}`); }
  if (pathStat.dev !== root.device || pathStat.ino !== root.inode) throw new ArtifactPathError("root directory changed");
}

export function assertPrivateRootPath(root: SecureRootDescriptor, label = "storage"): void {
  const currentUid = process.geteuid?.();
  let current = root.canonical;
  let privateRoot = true;
  for (;;) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ArtifactPathError(`${label} path must contain only real directories`);
    if (currentUid !== undefined && info.uid !== currentUid && info.uid !== 0) {
      throw new ArtifactPathError(`${label} path must be owned by the current user or root`);
    }
    if (privateRoot && (info.mode & 0o022) !== 0) throw new ArtifactPathError(`${label} root must not be group- or world-writable`);
    if (!privateRoot && (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) {
      throw new ArtifactPathError(`${label} path must not contain group- or world-writable directories without the sticky bit`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
    privateRoot = false;
  }
}

export async function closeSecureRoot(root: SecureRootDescriptor): Promise<void> {
  await root.handle.close().catch(() => undefined);
}

function validateComponents(relativePath: string): string[] {
  if (typeof relativePath !== "string" || relativePath.length === 0 || isAbsolute(relativePath) || relativePath.includes("\0")) throw new ArtifactPathError("relative path is required");
  const components = relativePath.split("/");
  if (components.some(component => component.length === 0 || component === "." || component === "..")) throw new ArtifactPathError("relative path contains an unsafe component");
  return components;
}

export function openSecureDirectory(rootFd: number, relativePath: string): number {
  const components = relativePath === "" ? [] : validateComponents(relativePath);
  let descriptor = check(native().symbols.openat(rootFd, cstring("."), DIRECTORY_FLAGS, 0), "open root directory");
  try {
    for (const component of components) {
      const next = check(native().symbols.openat(descriptor, cstring(component), DIRECTORY_FLAGS, 0), `open directory ${component}`);
      closeFd(descriptor);
      descriptor = next;
    }
    return descriptor;
  } catch (error) {
    closeFd(descriptor);
    throw error;
  }
}
function validateName(name: string): Buffer {
  if (typeof name !== "string" || name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\0")) throw new ArtifactPathError("unsafe directory entry name");
  return cstring(name);
}
export function secureOpenAt(directoryFd: number, name: string, flags: number, mode = 0o600): number {
  const descriptor = check(native().symbols.openat(directoryFd, validateName(name), flags, mode), `open ${name}`);
  try {
    if ((flags & constants.O_CREAT) !== 0) secureChmod(descriptor, mode);
    return descriptor;
  } catch (error) {
    closeFd(descriptor);
    throw error;
  }
}
const AT_SYMLINK_NOFOLLOW = process.platform === "darwin" ? 0x20 : 0x100;

export function secureEntryExistsAt(directoryFd: number, name: string): boolean {
  const symbols = native().symbols;
  if (symbols.faccessat(directoryFd, validateName(name), constants.F_OK, AT_SYMLINK_NOFOLLOW) === 0) return true;
  const error = errnoFrom(symbols);
  if (error === 2) return false;
  throw new ArtifactPathError(`inspect ${name} failed (errno ${error})`);
}
export function secureMkdirAt(directoryFd: number, name: string, mode = 0o700): void {
  check(native().symbols.mkdirat(directoryFd, validateName(name), mode), `mkdir ${name}`);
}
export function secureRenameAt(oldDirectoryFd: number, oldName: string, newDirectoryFd: number, newName: string): void {
  check(native().symbols.renameat(oldDirectoryFd, validateName(oldName), newDirectoryFd, validateName(newName)), `rename ${oldName}`);
}
export function secureUnlinkAt(directoryFd: number, name: string): void {
  check(native().symbols.unlinkat(directoryFd, validateName(name), 0), `unlink ${name}`);
}

const AT_REMOVEDIR = process.platform === "darwin" ? 0x80 : 0x200;

export function secureRmdirAt(directoryFd: number, name: string): void {
  check(native().symbols.unlinkat(directoryFd, validateName(name), AT_REMOVEDIR), `remove directory ${name}`);
}
export function secureFsync(descriptor: number): void { check(native().symbols.fsync(descriptor), "fsync"); }
export function secureChmod(descriptor: number, mode: number): void { check(native().symbols.fchmod(descriptor, mode), "chmod"); }
export function secureFlock(descriptor: number, operation: number): void { check(native().symbols.flock(descriptor, operation), "flock"); }
function lockBusy(error: unknown): boolean {
  return error instanceof Error && (error.message.includes("errno 11") || error.message.includes("errno 35"));
}
export async function acquireSecureFlock(descriptor: number, operation: number, label = "advisory lock", timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      secureFlock(descriptor, operation | LOCK_NB);
      return;
    } catch (error) {
      if (!lockBusy(error)) throw error;
      if (Date.now() >= deadline) throw new ArtifactPathError(`timed out waiting for ${label}`);
      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 50));
    }
  }
}

export function openSecureRegularFile(rootFd: number, relativePath: string): number {
  const components = validateComponents(relativePath);
  const name = components.pop()!;
  const parent = openSecureDirectory(rootFd, components.join("/"));
  try {
    const descriptor = check(native().symbols.openat(parent, cstring(name), FILE_FLAGS, 0), `open file ${name}`);
    try {
      if (!fstatSync(descriptor).isFile()) throw new ArtifactPathError("artifact must be a regular file");
      return descriptor;
    } catch (error) {
      closeFd(descriptor);
      throw error;
    }
  } finally {
    closeFd(parent);
  }
}

export async function readSecureRegularFile(rootFd: number, relativePath: string, limit: number): Promise<Uint8Array> {
  const descriptor = openSecureRegularFile(rootFd, relativePath);
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = new Uint8Array(Math.min(64 * 1024, limit - total + 1));
      const bytesRead = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw new ArtifactPathError("artifact exceeds the configured byte bound");
      chunks.push(chunk.subarray(0, bytesRead));
      await Promise.resolve();
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    closeFd(descriptor);
  }
}

export function closeSecureDescriptor(descriptor: number): void {
  closeFd(descriptor);
}
function closeFd(fd: number | undefined): void {
  if (fd !== undefined && NATIVE) NATIVE.symbols.close(fd);
}
function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
  let handle: FileHandle | undefined;
  try {
    handle = await open(artifact.path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
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
export function openOrCreateSecureDirectoryPath(rootDir: string): number {
  let absolute = resolve(rootDir);
  try {
    absolute = join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    // The final component may not exist; all components are still opened below without following symlinks.
  }
  if (!isAbsolute(absolute)) throw new ArtifactPathError("artifact root must be absolute");
  const n = native();
  let current = check(n.symbols.openat(AT_FDCWD, cstring("/"), constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0), "artifact root open");
  try {
    for (const segment of absolute.split("/").filter(Boolean)) {
      const name = cstring(segment);
      let next = n.symbols.openat(current, name, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0);
      if (next < 0) {
        n.symbols.mkdirat(current, name, 0o700);
        next = n.symbols.openat(current, name, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0);
      }
      if (next < 0) throw new ArtifactPathError(`artifact root cannot be opened (errno ${errno()})`);
      closeFd(current);
      current = next;
    }
    return current;
  } catch (error) {
    closeFd(current);
    throw new ArtifactPathError(`artifact root cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
}
export function openOrCreateSecureDirectory(parentFd: number, name: string): number {
  const n = native();
  let fd = n.symbols.openat(parentFd, cstring(name), constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0);
  if (fd < 0) {
    n.symbols.mkdirat(parentFd, cstring(name), 0o700);
    fd = n.symbols.openat(parentFd, cstring(name), constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0);
  }
  return check(fd, `artifact ${name} directory open`);
}
function openLock(rootFd: number): number {
  const n = native();
  const fd = check(n.symbols.openat(rootFd, cstring(ARTIFACT_CANONICAL_LOCK_FILE), constants.O_RDWR | constants.O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600), "artifact lock open");
  try {
    if (!fstatSync(fd).isFile()) throw new ArtifactPathError("artifact lock must be a regular file");
    check(n.symbols.fchmod(fd, 0o600), "artifact lock permissions");
    return fd;
  } catch (error) {
    closeFd(fd);
    throw error;
  }
}
async function withLock<T>(lockFd: number, operation: () => T): Promise<T> {
  await acquireSecureFlock(lockFd, LOCK_EX, "artifact store lock");
  try {
    return operation();
  } finally {
    secureFlock(lockFd, LOCK_UN);
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);
}
function encodeFrame(digest: string, type: string, bytes: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  if (typeBytes.byteLength > MAX_TYPE_BYTES || bytes.byteLength > MAX_ARTIFACT_BYTES) throw new ArtifactIntegrityError("artifact is too large");
  const frame = new Uint8Array(MAGIC.byteLength + 64 + 4 + 8 + typeBytes.byteLength + bytes.byteLength);
  let offset = 0;
  frame.set(MAGIC, offset); offset += MAGIC.byteLength;
  frame.set(new TextEncoder().encode(digest), offset); offset += 64;
  const view = new DataView(frame.buffer);
  view.setUint32(offset, typeBytes.byteLength); offset += 4;
  view.setUint32(offset, 0); offset += 4;
  view.setUint32(offset, bytes.byteLength); offset += 4;
  frame.set(typeBytes, offset); offset += typeBytes.byteLength;
  frame.set(bytes, offset);
  return frame;
}
function decodeFrame(frame: Uint8Array, expectedDigest: string): DecodedFrame {
  const minimum = MAGIC.byteLength + 64 + 12;
  if (frame.byteLength < minimum || !compareBytes(frame.subarray(0, MAGIC.byteLength), MAGIC)) throw new ArtifactCollisionError("artifact frame is torn or malformed");
  let offset = MAGIC.byteLength;
  const digest = TEXT.decode(frame.subarray(offset, offset + 64)); offset += 64;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const typeLength = view.getUint32(offset); offset += 4;
  const high = view.getUint32(offset); offset += 4;
  const low = view.getUint32(offset); offset += 4;
  if (high !== 0 || typeLength === 0 || typeLength > MAX_TYPE_BYTES || low > MAX_ARTIFACT_BYTES || offset + typeLength + low !== frame.byteLength || digest !== expectedDigest) throw new ArtifactCollisionError("artifact frame is torn, colliding, or malformed");
  let type: string;
  try { type = TEXT.decode(frame.subarray(offset, offset + typeLength)); } catch { throw new ArtifactCollisionError("artifact type is not valid UTF-8"); }
  offset += typeLength;
  const bytes = new Uint8Array(frame.subarray(offset));
  if (digestBytes(bytes) !== expectedDigest) throw new ArtifactCollisionError("artifact frame content digest mismatch");
  return { type, bytes };
}
function readFd(fd: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = new Uint8Array(64 * 1024);
    const count = readSync(fd, chunk, 0, chunk.byteLength, null);
    if (count === 0) break;
    total += count;
    if (total > MAGIC.byteLength + 64 + 12 + MAX_TYPE_BYTES + MAX_ARTIFACT_BYTES) throw new ArtifactCollisionError("artifact frame exceeds limits");
    chunks.push(chunk.subarray(0, count));
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
function unlinkChild(dirFd: number, name: string, symbols: Native["symbols"] = native().symbols): void {
  const result = symbols.unlinkat(dirFd, cstring(name), 0);
  if (result >= 0) return;
  const error = errnoFrom(symbols);
  if (error === 2) return;
  throw new ArtifactPathError(`artifact temporary cleanup failed (errno ${error})`);
}
function cleanupChild(dirFd: number, name: string, symbols: Native["symbols"], primary?: unknown): void {
  try {
    unlinkChild(dirFd, name, symbols);
  } catch (cleanupError) {
    if (primary === undefined) throw cleanupError;
    throw new AggregateError([primary, cleanupError], "artifact temporary cleanup failed", { cause: primary });
  }
}
function readObject(objectsFd: number, digest: string): DecodedFrame | undefined {
  const n = native();
  const fd = n.symbols.openat(objectsFd, cstring(digest), constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0);
  if (fd < 0) {
    const error = errno();
    if (error === 2) return undefined;
    throw new ArtifactPathError(`artifact object open failed (errno ${error})`);
  }
  try {
    if (!fstatSync(fd).isFile()) throw new ArtifactPathError("artifact object must be a regular file");
    return decodeFrame(readFd(fd), digest);
  } finally {
    closeFd(fd);
  }
}
function touchObject(objectsFd: number, digest: string): void {
  const fd = check(native().symbols.openat(objectsFd, cstring(digest), constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0), "artifact object touch open");
  try {
    if (!fstatSync(fd).isFile()) throw new ArtifactPathError("artifact object must be a regular file");
    const touchedAt = new Date();
    futimesSync(fd, touchedAt, touchedAt);
  } finally {
    closeFd(fd);
  }
}
function publishObject(objectsFd: number, digest: string, frame: Uint8Array, fsync: boolean, symbols: Native["symbols"]): void {
  const temp = `.tmp-${digest}-${randomUUID()}`;
  const fd = check(symbols.openat(objectsFd, cstring(temp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600), "artifact temporary open");
  try {
    check(symbols.fchmod(fd, 0o600), "artifact temporary permissions");
    let offset = 0;
    while (offset < frame.byteLength) {
      const count = writeSync(fd, frame, offset, frame.byteLength - offset, null);
      if (count <= 0) throw new ArtifactPathError("artifact temporary write failed");
      offset += count;
    }
    if (fsync) check(symbols.fsync(fd), "artifact temporary fsync");
  } catch (error) {
    cleanupChild(objectsFd, temp, symbols, error);
    throw error;
  } finally {
    closeFd(fd);
  }
  const linked = symbols.linkat(objectsFd, cstring(temp), objectsFd, cstring(digest), 0);
  if (linked < 0) {
    const error = errnoFrom(symbols);
    const publicationError = error === 17 ? undefined : new ArtifactPathError(`artifact publication link failed (errno ${error})`);
    cleanupChild(objectsFd, temp, symbols, publicationError);
    if (error === 17) return;
    throw publicationError;
  }
  cleanupChild(objectsFd, temp, symbols);
  if (fsync) check(symbols.fsync(objectsFd), "artifact objects directory fsync");
}

function outputArtifact(artifact: ArtifactLike): Artifact {
  return { type: artifact.type, digest: artifact.digest, ...(artifact.path === undefined ? {} : { path: artifact.path }) };
}

/** Append-only, descriptor-pinned content-addressed artifact persistence. */
export class LocalArtifactStore implements ArtifactStore {
  readonly atomicSameKeyIdempotency = true;
  readonly rootDir: string;
  readonly fsync: boolean;
  private readonly ephemeral: boolean;
  private readonly publishedDigests = new Set<string>();
  private readonly rootFd: number;
  private readonly symbols: Native["symbols"];
  private readonly objectsFd: number;
  private readonly lockFd: number;
  private readonly leaseFd: number | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(rootDirOrOptions: string | LocalArtifactStoreOptions) {
    const n = native();
    this.symbols = n.symbols;
    const rootDir = typeof rootDirOrOptions === "string" ? rootDirOrOptions : rootDirOrOptions.rootDir;
    this.ephemeral = typeof rootDirOrOptions === "string" ? false : rootDirOrOptions.ephemeral === true;
    if (typeof rootDir !== "string" || rootDir.length === 0) throw new ArtifactPathError("artifact root is required");
    this.rootDir = resolve(rootDir);
    this.fsync = typeof rootDirOrOptions === "string" ? true : rootDirOrOptions.fsync !== false;
    const rootFd = openOrCreateSecureDirectoryPath(this.rootDir);
    let objectsFd: number | undefined;
    let lockFd: number | undefined;
    let leaseFd: number | undefined;
    try {
      objectsFd = openOrCreateSecureDirectory(rootFd, ".objects");
      lockFd = openLock(rootFd);
      if (this.ephemeral) {
        leaseFd = secureOpenAt(rootFd, EPHEMERAL_LEASE_FILE, constants.O_RDWR | constants.O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600);
        secureFlock(leaseFd, LOCK_EX | LOCK_NB);
      }
      this.rootFd = rootFd;
      this.objectsFd = objectsFd;
      this.lockFd = lockFd;
      this.leaseFd = leaseFd;
    } catch (error) {
      closeFd(leaseFd); closeFd(lockFd); closeFd(objectsFd); closeFd(rootFd);
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactPathError(`artifact store cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>(resolvePromise => { release = resolvePromise; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  private persistUnderLock(artifact: ArtifactLike, bytes: Uint8Array | undefined): Artifact {
    if (bytes && digestBytes(bytes) !== artifact.digest) throw new ArtifactIntegrityError("artifact content does not match supplied digest");
    const existing = readObject(this.objectsFd, artifact.digest);
    if (existing) {
      if (bytes && (!compareBytes(existing.bytes, bytes) || existing.type !== artifact.type)) throw new ArtifactCollisionError("content-addressed target has a digest collision or was modified");
      if (!bytes && existing.type !== artifact.type) throw new ArtifactCollisionError("content-addressed target type mismatch");
      touchObject(this.objectsFd, artifact.digest);
      return outputArtifact(artifact);
    }
    if (!bytes) throw new ArtifactPathError("stored artifact does not exist");
    publishObject(this.objectsFd, artifact.digest, encodeFrame(artifact.digest, artifact.type, bytes), this.fsync, this.symbols);
    const published = readObject(this.objectsFd, artifact.digest);
    if (!published || published.type !== artifact.type || !compareBytes(published.bytes, bytes)) throw new ArtifactCollisionError("artifact readback verification failed");
    if (this.ephemeral) this.publishedDigests.add(artifact.digest);
    return outputArtifact(artifact);
  }
  async storeVerificationResultArtifact(artifact: CanonicalStoredArtifact, _input: VerificationExecutionRequest): Promise<Artifact> { return this.persist(artifact as ArtifactLike); }
  async storeArtifact(artifact: Artifact, _input: VerificationExecutionRequest): Promise<Artifact> { return this.persist(artifact as ArtifactLike); }
  async putArtifact(artifact: Artifact, _input: VerificationExecutionRequest): Promise<Artifact> { return this.persist(artifact as ArtifactLike); }
  async store(artifact: Artifact, _input: VerificationExecutionRequest): Promise<Artifact> { return this.persist(artifact as ArtifactLike); }
  private async persist(artifact: ArtifactLike): Promise<Artifact> {
    return this.serialized(async () => {
      if (this.closed) throw new ArtifactPathError("artifact store is closed");
      if (!artifact || typeof artifact !== "object") throw new ArtifactIntegrityError("artifact is required");
      if (typeof artifact.type !== "string" || artifact.type.length === 0) throw new ArtifactIntegrityError("artifact type is required");
      if (typeof artifact.digest !== "string" || !DIGEST.test(artifact.digest)) throw new ArtifactIntegrityError("artifact digest must be a lowercase SHA-256 hex string");
      const sourceAvailable = (typeof artifact.path === "string" && artifact.path.length > 0) || asBytes(artifact.bytes) !== undefined || asBytes(artifact.data) !== undefined || asBytes(artifact.content) !== undefined || typeof artifact.content === "string";
      const bytes = sourceAvailable ? await readSourceBytes(artifact) : undefined;
      return withLock(this.lockFd, () => this.persistUnderLock(artifact, bytes));
    });
  }
  async readArtifact(digest: string): Promise<Uint8Array> {
    return this.serialized(async () => {
      if (this.closed) throw new ArtifactPathError("artifact store is closed");
      if (!DIGEST.test(digest)) throw new ArtifactIntegrityError("artifact digest must be a lowercase SHA-256 hex string");
      return withLock(this.lockFd, () => {
        const object = readObject(this.objectsFd, digest);
        if (!object) throw new ArtifactPathError("stored artifact does not exist");
        return new Uint8Array(object.bytes);
      });
    });
  }
  async hasArtifact(digest: string): Promise<boolean> {
    return this.serialized(async () => {
      if (this.closed) throw new ArtifactPathError("artifact store is closed");
      if (!DIGEST.test(digest)) return false;
      return withLock(this.lockFd, () => readObject(this.objectsFd, digest) !== undefined);
    });
  }
  async destroyContents(): Promise<void> {
    if (!this.ephemeral) throw new ArtifactPathError("destroyContents requires an ephemeral artifact store");
    await this.serialized(async () => {
      if (this.closed) return;
      const errors: unknown[] = [];
      try {
        await withLock(this.lockFd, () => {
          for (const digest of this.publishedDigests) secureUnlinkAt(this.objectsFd, digest);
          secureRmdirAt(this.rootFd, ".objects");
          secureUnlinkAt(this.rootFd, ".artifact.lock");
        });
      } catch (error) {
        errors.push(error);
      }
      if (this.leaseFd !== undefined) {
        try { secureUnlinkAt(this.rootFd, EPHEMERAL_LEASE_FILE); } catch (error) { errors.push(error); }
        try { secureFlock(this.leaseFd, LOCK_UN); } catch (error) { errors.push(error); }
        closeFd(this.leaseFd);
      }
      this.publishedDigests.clear();
      this.closed = true;
      closeFd(this.lockFd); closeFd(this.objectsFd); closeFd(this.rootFd);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "ephemeral artifact destruction failed");
    });
  }
  async close(): Promise<void> {
    await this.serialized(async () => {
      if (this.closed) return;
      const errors: unknown[] = [];
      this.closed = true;
      if (this.leaseFd !== undefined) {
        try { secureFlock(this.leaseFd, LOCK_UN); } catch (error) { errors.push(error); }
        closeFd(this.leaseFd);
      }
      closeFd(this.lockFd); closeFd(this.objectsFd); closeFd(this.rootFd);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "artifact store close failed");
    });
  }
}
export type AppendOnlyArtifactStore = LocalArtifactStore;
export const createLocalArtifactStore = (rootDirOrOptions: string | LocalArtifactStoreOptions): LocalArtifactStore => new LocalArtifactStore(rootDirOrOptions);
export const createAppendOnlyArtifactStore = createLocalArtifactStore;
