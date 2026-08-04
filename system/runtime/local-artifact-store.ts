import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, lstat, link, unlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Artifact } from "../core/qa-core";
import type { ArtifactStore, CanonicalVerificationResultArtifact, VerificationExecutionRequest } from "./verification-run";

const DIGEST = /^[0-9a-f]{64}$/;

type ArtifactContent = Uint8Array | ArrayBuffer;
type ArtifactLike = Artifact & Readonly<{ bytes?: ArtifactContent; data?: ArtifactContent; content?: ArtifactContent | string }>;

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

function isInside(rootDir: string, candidate: string): boolean {
  const path = relative(rootDir, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${"/"}`) && !isAbsolute(path));
}

function rootFingerprint(stat: Awaited<ReturnType<typeof lstat>>): string {
  return `${String(stat.dev)}:${String(stat.ino)}`;
}

async function readSourceBytes(artifact: ArtifactLike): Promise<Uint8Array> {
  const embedded = asBytes(artifact.bytes) ?? asBytes(artifact.data) ?? (typeof artifact.content === "string" ? new TextEncoder().encode(artifact.content) : asBytes(artifact.content));
  if (embedded) return embedded;
  if (typeof artifact.path !== "string" || artifact.path.length === 0) throw new ArtifactIntegrityError("artifact content is unavailable; provide a readable path or bytes");
  let stat;
  try {
    stat = await lstat(artifact.path);
  } catch (error) {
    throw new ArtifactPathError(`artifact source cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new ArtifactPathError("artifact source must be a regular non-symlink file");
  try {
    return await readFile(artifact.path);
  } catch (error) {
    throw new ArtifactPathError(`artifact source cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function closeQuietly(handle: Awaited<ReturnType<typeof open>> | undefined): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // The original write error is more useful than a cleanup error.
  }
}

/**
 * Append-only, content-addressed artifact persistence for VerificationRun.
 * Files are published with a no-overwrite hard-link step after fsyncing a
 * temporary file, so readers see either the complete object or no object.
 */
export class LocalArtifactStore implements ArtifactStore {
  readonly rootDir: string;
  readonly fsync: boolean;
  private rootFingerprint?: string;

  constructor(rootDirOrOptions: string | LocalArtifactStoreOptions) {
    const rootDir = typeof rootDirOrOptions === "string" ? rootDirOrOptions : rootDirOrOptions.rootDir;
    if (typeof rootDir !== "string" || rootDir.length === 0) throw new ArtifactPathError("artifact root is required");
    this.rootDir = resolve(rootDir);
    this.fsync = typeof rootDirOrOptions === "string" ? true : rootDirOrOptions.fsync !== false;
  }

  private async ensureRoot(): Promise<string> {
    let stat;
    try {
      stat = await lstat(this.rootDir);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
        throw new ArtifactPathError(`artifact root cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
        stat = await lstat(this.rootDir);
      } catch (mkdirError) {
        throw new ArtifactPathError(`artifact root cannot be created: ${mkdirError instanceof Error ? mkdirError.message : String(mkdirError)}`);
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ArtifactPathError("artifact root must be a directory");
    const canonicalRoot = await realpath(this.rootDir);
    const canonicalStat = await lstat(canonicalRoot);
    if (canonicalStat.isSymbolicLink() || !canonicalStat.isDirectory() || rootFingerprint(stat) !== rootFingerprint(canonicalStat)) {
      throw new ArtifactPathError("artifact root changed during validation");
    }
    const fingerprint = rootFingerprint(canonicalStat);
    if (this.rootFingerprint && this.rootFingerprint !== fingerprint) throw new ArtifactPathError("artifact root was replaced");
    this.rootFingerprint ??= fingerprint;
    return canonicalRoot;
  }

  private async assertTarget(root: string, target: string): Promise<void> {
    const liveRoot = await this.ensureRoot();
    if (liveRoot !== root || !isInside(root, target)) throw new ArtifactPathError("artifact path escapes configured root");
  }

  private async targetForDigest(digest: string): Promise<{ root: string; target: string }> {
    if (!DIGEST.test(digest)) throw new ArtifactIntegrityError("artifact digest must be a lowercase SHA-256 hex string");
    const root = await this.ensureRoot();
    const target = join(root, digest);
    if (!isInside(root, target)) throw new ArtifactPathError("artifact path escapes configured root");
    return { root, target };
  }

  private async existingTargetBytes(root: string, target: string, digest: string): Promise<Uint8Array | undefined> {
    await this.assertTarget(root, target);
    let stat;
    try {
      stat = await lstat(target);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.assertTarget(root, target);
        return undefined;
      }
      throw new ArtifactPathError(`artifact target cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new ArtifactCollisionError("content-addressed target is not a regular file");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.isSymbolicLink()) throw new ArtifactCollisionError("content-addressed target is not a regular file");
      const bytes = await handle.readFile();
      if (sha256(bytes) !== digest) throw new ArtifactCollisionError("content-addressed target has a digest collision or was modified");
      await this.assertTarget(root, target);
      return bytes;
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new ArtifactCollisionError("content-addressed target is not a regular file");
      }
      throw new ArtifactPathError(`artifact target cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await closeQuietly(handle);
    }
  }

  private async readVerifiedTarget(root: string, target: string, digest: string): Promise<Uint8Array> {
    const bytes = await this.existingTargetBytes(root, target, digest);
    if (!bytes) throw new ArtifactPathError("stored artifact does not exist");
    return bytes;
  }

  private async cleanupTemporary(root: string, temporary: string): Promise<void> {
    try {
      await this.ensureRoot();
      await unlink(temporary);
    } catch {
      // Never follow a replaced root during cleanup; an orphaned temp is safer than an outside unlink.
    }
  }

  private async publish(root: string, target: string, digest: string, bytes: Uint8Array): Promise<void> {
    await this.assertTarget(root, target);
    const temporary = join(root, `.tmp-${digest}-${globalThis.crypto.randomUUID()}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let published = false;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.write(bytes.subarray(offset));
        offset += result.bytesWritten;
      }
      if (this.fsync) await handle.sync();
      await handle.close();
      handle = undefined;
      await this.assertTarget(root, target);
      try {
        await link(temporary, target);
        published = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
      }
      if (this.fsync && published) {
        await this.assertTarget(root, target);
        let directory;
        try {
          directory = await open(root, constants.O_RDONLY);
          await directory.sync();
        } finally {
          await closeQuietly(directory);
        }
      }
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactPathError(`artifact publication failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await closeQuietly(handle);
      await this.cleanupTemporary(root, temporary);
    }
    if (published) {
      try {
        await this.readVerifiedTarget(root, target, digest);
      } catch (error) {
        try {
          await this.assertTarget(root, target);
          await unlink(target);
        } catch {
          // Preserve the original integrity failure without following a replaced root.
        }
        throw error;
      }
    }
  }

  private async persist(artifact: ArtifactLike): Promise<Artifact> {
    if (!artifact || typeof artifact !== "object") throw new ArtifactIntegrityError("artifact is required");
    if (typeof artifact.type !== "string" || artifact.type.length === 0) throw new ArtifactIntegrityError("artifact type is required");
    if (typeof artifact.digest !== "string" || !DIGEST.test(artifact.digest)) throw new ArtifactIntegrityError("artifact digest must be a lowercase SHA-256 hex string");
    const { root, target } = await this.targetForDigest(artifact.digest);
    const sourceAvailable = (typeof artifact.path === "string" && artifact.path.length > 0) || asBytes(artifact.bytes) !== undefined || asBytes(artifact.data) !== undefined || asBytes(artifact.content) !== undefined || typeof artifact.content === "string";
    if (!sourceAvailable) {
      await this.readVerifiedTarget(root, target, artifact.digest);
      return { type: artifact.type, digest: artifact.digest, path: target };
    }
    const bytes = await readSourceBytes(artifact);
    if (sha256(bytes) !== artifact.digest) throw new ArtifactIntegrityError("artifact content does not match supplied digest");
    const existing = await this.existingTargetBytes(root, target, artifact.digest);
    if (!existing) await this.publish(root, target, artifact.digest, bytes);
    await this.readVerifiedTarget(root, target, artifact.digest);
    return { type: artifact.type, digest: artifact.digest, path: target };
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
    const { root, target } = await this.targetForDigest(digest);
    return this.readVerifiedTarget(root, target, digest);
  }

  async hasArtifact(digest: string): Promise<boolean> {
    try {
      await this.readArtifact(digest);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      if (error instanceof ArtifactPathError && error.message.includes("does not exist")) return false;
      throw error;
    }
  }
}

export type AppendOnlyArtifactStore = LocalArtifactStore;
export const createLocalArtifactStore = (rootDirOrOptions: string | LocalArtifactStoreOptions): LocalArtifactStore => new LocalArtifactStore(rootDirOrOptions);
export const createAppendOnlyArtifactStore = createLocalArtifactStore;
