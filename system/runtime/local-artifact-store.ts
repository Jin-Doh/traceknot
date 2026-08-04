import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { dlopen, FFIType, read as ffiRead } from "bun:ffi";
import { Database } from "bun:sqlite";
import type { Artifact } from "../core/qa-core";
import type { ArtifactStore, CanonicalVerificationResultArtifact, VerificationExecutionRequest } from "./verification-run";

const DIGEST = /^[0-9a-f]{64}$/;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;

type ArtifactContent = Uint8Array | ArrayBuffer;
type ArtifactLike = Artifact & Readonly<{ bytes?: ArtifactContent; data?: ArtifactContent; content?: ArtifactContent | string }>;
type StoredRow = Readonly<{ digest: string; bytes: Uint8Array; type: string; metadata: string }>;

const POSIX = dlopen("/usr/lib/libSystem.B.dylib", {
  open: { args: [FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
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

function openPinnedDirectory(rootDir: string): number {
  let absolute = resolve(rootDir);
  try {
    absolute = join(realpathSync(dirname(absolute)), basename(absolute));
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

function outputArtifact(artifact: ArtifactLike): Artifact {
  return { type: artifact.type, digest: artifact.digest, ...(artifact.path === undefined ? {} : { path: artifact.path }) };
}


/** Content-addressed artifact persistence backed by SQLite. */
export class LocalArtifactStore implements ArtifactStore {
  readonly rootDir: string;
  readonly fsync: boolean;
  private readonly rootFd: number;
  private readonly database: Database;
  private operationTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(rootDirOrOptions: string | LocalArtifactStoreOptions) {
    const rootDir = typeof rootDirOrOptions === "string" ? rootDirOrOptions : rootDirOrOptions.rootDir;
    if (typeof rootDir !== "string" || rootDir.length === 0) throw new ArtifactPathError("artifact root is required");
    this.rootDir = resolve(rootDir);
    this.fsync = typeof rootDirOrOptions === "string" ? true : rootDirOrOptions.fsync !== false;
    const rootFd = openPinnedDirectory(this.rootDir);
    this.rootFd = rootFd;
    try {
      const databasePath = join(this.rootDir, ".traceknot.sqlite");
      this.database = new Database(databasePath, { create: true, readwrite: true });
      this.database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = ${this.fsync ? "FULL" : "NORMAL"};
        CREATE TABLE IF NOT EXISTS artifacts (
          digest TEXT PRIMARY KEY NOT NULL,
          bytes BLOB NOT NULL,
          type TEXT NOT NULL,
          metadata TEXT NOT NULL
        ) STRICT;
      `);
    } catch (error) {
      closeFd(rootFd);
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactPathError(`artifact database cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
    }
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

  private row(digest: string): StoredRow | undefined {
    const row = this.database.query("SELECT digest, bytes, type, metadata FROM artifacts WHERE digest = ?").get(digest) as StoredRow | undefined;
    if (!row) return undefined;
    if (typeof row.digest !== "string" || typeof row.type !== "string" || typeof row.metadata !== "string" || !(row.bytes instanceof Uint8Array)) throw new ArtifactCollisionError("artifact database row is malformed");
    return { digest: row.digest, bytes: new Uint8Array(row.bytes), type: row.type, metadata: row.metadata };
  }

  private verifyRow(row: StoredRow, digest: string): Uint8Array {
    if (row.digest !== digest || sha256(row.bytes) !== digest) throw new ArtifactCollisionError("artifact database contains a digest collision or corruption");
    let metadata: unknown;
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      throw new ArtifactCollisionError("artifact database metadata is malformed");
    }
    if (!metadata || typeof metadata !== "object" || (metadata as { type?: unknown }).type !== row.type) throw new ArtifactCollisionError("artifact database metadata is inconsistent");
    return row.bytes;
  }

  private transact<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original integrity or SQLite error.
      }
      throw error;
    }
  }

  private async persist(artifact: ArtifactLike): Promise<Artifact> {
    return this.serialized(async () => {
      if (this.closed) throw new ArtifactPathError("artifact store is closed");
      if (!artifact || typeof artifact !== "object") throw new ArtifactIntegrityError("artifact is required");
      if (typeof artifact.type !== "string" || artifact.type.length === 0) throw new ArtifactIntegrityError("artifact type is required");
      if (typeof artifact.digest !== "string" || !DIGEST.test(artifact.digest)) throw new ArtifactIntegrityError("artifact digest must be a lowercase SHA-256 hex string");
      const sourceAvailable = (typeof artifact.path === "string" && artifact.path.length > 0) || asBytes(artifact.bytes) !== undefined || asBytes(artifact.data) !== undefined || asBytes(artifact.content) !== undefined || typeof artifact.content === "string";
      const bytes = sourceAvailable ? await readSourceBytes(artifact) : undefined;
      if (bytes && sha256(bytes) !== artifact.digest) throw new ArtifactIntegrityError("artifact content does not match supplied digest");
      this.transact(() => {
        if (bytes) {
          const metadata = JSON.stringify({ type: artifact.type });
          this.database.query("INSERT OR IGNORE INTO artifacts (digest, bytes, type, metadata) VALUES (?, ?, ?, ?)").run(artifact.digest, bytes, artifact.type, metadata);
        }
        const row = this.row(artifact.digest);
        if (!row) throw new ArtifactPathError("stored artifact does not exist");
        const stored = this.verifyRow(row, artifact.digest);
        if (bytes && Buffer.compare(Buffer.from(stored), Buffer.from(bytes)) !== 0) throw new ArtifactCollisionError("content-addressed target has a digest collision or was modified");
      });
      return outputArtifact(artifact);
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
      if (this.closed) throw new ArtifactPathError("artifact store is closed");
      if (!DIGEST.test(digest)) throw new ArtifactIntegrityError("artifact digest must be a lowercase SHA-256 hex string");
      return new Uint8Array(this.transact(() => {
        const row = this.row(digest);
        if (!row) throw new ArtifactPathError("stored artifact does not exist");
        return this.verifyRow(row, digest);
      }));
    });
  }

  async hasArtifact(digest: string): Promise<boolean> {
    return this.serialized(async () => {
      if (this.closed || !DIGEST.test(digest)) return false;
      return this.transact(() => {
        const row = this.row(digest);
        if (!row) return false;
        this.verifyRow(row, digest);
        return true;
      });
    });
  }

  async close(): Promise<void> {
    await this.serialized(async () => {
      if (this.closed) return;
      this.closed = true;
      this.database.close();
      closeFd(this.rootFd);
    });
  }
}

export type AppendOnlyArtifactStore = LocalArtifactStore;
export const createLocalArtifactStore = (rootDirOrOptions: string | LocalArtifactStoreOptions): LocalArtifactStore => new LocalArtifactStore(rootDirOrOptions);
export const createAppendOnlyArtifactStore = createLocalArtifactStore;
