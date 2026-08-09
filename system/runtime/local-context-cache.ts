import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson, isSha256Digest, sha256Digest, type JsonValue, type Sha256Digest } from "./context-plan";
import {
  ArtifactPathError,
  assertSecureRoot,
  closeSecureRoot,
  openSecureRoot,
  readSecureRegularFile,
  secureFlock,
  secureFsync,
  secureOpenAt,
  secureRenameAt,
  secureUnlinkAt,
  type SecureRootDescriptor,
} from "./local-artifact-store";

export type ContextCacheObject = Readonly<{
  schemaVersion: "context-cache-object/v1";
  key: Sha256Digest;
  payloadDigest: Sha256Digest;
  payload: JsonValue;
}>;

export class ContextCacheIntegrityError extends Error {}
export class ContextCacheCollisionError extends Error {}
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_CLOEXEC = (constants as Record<string, number | undefined>).O_CLOEXEC ?? 0;
const LOCK_EX = 2;
const LOCK_UN = 8;
const MAX_CACHE_OBJECT_BYTES = 64 << 20;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
}

function parseObject(raw: string, expectedKey: Sha256Digest): ContextCacheObject {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ContextCacheIntegrityError("context cache object is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContextCacheIntegrityError("invalid context cache object");
  const object = value as Record<string, unknown>;
  if (!exactKeys(object, ["key", "payload", "payloadDigest", "schemaVersion"])) throw new ContextCacheIntegrityError("invalid context cache object schema");
  if (object.schemaVersion !== "context-cache-object/v1" || object.key !== expectedKey || !isSha256Digest(object.payloadDigest)) {
    throw new ContextCacheIntegrityError("invalid context cache object identity");
  }
  let canonicalPayload: string;
  try {
    canonicalPayload = canonicalJson(object.payload as JsonValue);
  } catch {
    throw new ContextCacheIntegrityError("invalid context cache payload");
  }
  if (sha256Digest(canonicalPayload) !== object.payloadDigest) throw new ContextCacheIntegrityError("context cache payload digest mismatch");
  return Object.freeze({
    schemaVersion: "context-cache-object/v1",
    key: expectedKey,
    payloadDigest: object.payloadDigest,
    payload: structuredClone(object.payload as JsonValue),
  });
}

export class LocalContextCache {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private name(key: Sha256Digest): string {
    if (!isSha256Digest(key)) throw Error("invalid context cache key");
    return key.slice("sha256:".length);
  }

  async get<T extends JsonValue = JsonValue>(key: Sha256Digest): Promise<T | undefined> {
    const name = this.name(key);
    const directory = await openSecureRoot(join(this.root, "sha256"));
    try {
      assertSecureRoot(directory);
      const object = await readObject(directory, name, key);
      if (!object) return undefined;
      return structuredClone(object.payload) as T;
    } finally {
      await closeSecureRoot(directory);
    }
  }

  async put<T extends JsonValue>(key: Sha256Digest, payload: T): Promise<ContextCacheObject> {
    const name = this.name(key);
    const canonicalPayload = canonicalJson(payload);
    const object = Object.freeze({
      schemaVersion: "context-cache-object/v1" as const,
      key,
      payloadDigest: sha256Digest(canonicalPayload),
      payload: structuredClone(payload),
    });
    const directory = await openSecureRoot(join(this.root, "sha256"));
    const temporary = `.${name}.${process.pid}.${randomUUID()}.tmp`;
    let lock: number | undefined;
    let locked = false;
    let temporaryExists = false;
    try {
      lock = secureOpenAt(directory.fd, ".context-cache.lock", constants.O_RDWR | constants.O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600);
      if (!fstatSync(lock).isFile()) throw new ContextCacheIntegrityError("context cache lock must be a regular file");
      secureFlock(lock, LOCK_EX);
      locked = true;
      assertSecureRoot(directory);
      const existing = await readObject(directory, name, key);
      if (existing) {
        if (canonicalJson(existing.payload) !== canonicalPayload) throw new ContextCacheCollisionError("context cache key collision");
        return object;
      }
      const descriptor = secureOpenAt(directory.fd, temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600);
      temporaryExists = true;
      try {
        const bytes = Buffer.from(`${canonicalJson(object)}\n`, "utf8");
        for (let offset = 0; offset < bytes.byteLength;) {
          const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
          if (written <= 0) throw new ContextCacheIntegrityError("context cache write made no progress");
          offset += written;
        }
        secureFsync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      assertSecureRoot(directory);
      secureRenameAt(directory.fd, temporary, directory.fd, name);
      temporaryExists = false;
      secureFsync(directory.fd);
      return object;
    } finally {
      try {
        if (temporaryExists) secureUnlinkAt(directory.fd, temporary);
      } finally {
        try {
          if (locked && lock !== undefined) secureFlock(lock, LOCK_UN);
        } finally {
          if (lock !== undefined) closeSync(lock);
          await closeSecureRoot(directory);
        }
      }
    }
  }
}

async function readObject(directory: SecureRootDescriptor, name: string, key: Sha256Digest): Promise<ContextCacheObject | undefined> {
  try {
    const bytes = await readSecureRegularFile(directory.fd, name, MAX_CACHE_OBJECT_BYTES);
    return parseObject(new TextDecoder("utf-8", { fatal: true }).decode(bytes), key);
  } catch (error) {
    if (error instanceof ArtifactPathError && error.message.includes("(errno 2)")) return undefined;
    throw error;
  }
}
