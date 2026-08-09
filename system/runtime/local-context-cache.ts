import { randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, isSha256Digest, sha256Digest, type JsonValue, type Sha256Digest } from "./context-plan";

export type ContextCacheObject = Readonly<{
  schemaVersion: "context-cache-object/v1";
  key: Sha256Digest;
  payloadDigest: Sha256Digest;
  payload: JsonValue;
}>;

export class ContextCacheIntegrityError extends Error {}
export class ContextCacheCollisionError extends Error {}

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

  private path(key: Sha256Digest): string {
    if (!isSha256Digest(key)) throw Error("invalid context cache key");
    return join(this.root, "sha256", key.slice("sha256:".length));
  }

  async get<T extends JsonValue = JsonValue>(key: Sha256Digest): Promise<T | undefined> {
    const path = this.path(key);
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new ContextCacheIntegrityError("context cache object cannot be a symbolic link");
      const object = parseObject(await readFile(path, "utf8"), key);
      return structuredClone(object.payload) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async put<T extends JsonValue>(key: Sha256Digest, payload: T): Promise<ContextCacheObject> {
    const path = this.path(key);
    const canonicalPayload = canonicalJson(payload);
    const object = Object.freeze({
      schemaVersion: "context-cache-object/v1" as const,
      key,
      payloadDigest: sha256Digest(canonicalPayload),
      payload: structuredClone(payload),
    });
    const existing = await this.get(key);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalPayload) throw new ContextCacheCollisionError("context cache key collision");
      return object;
    }
    const directory = join(this.root, "sha256");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${key.slice("sha256:".length)}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(object)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await this.get(key);
      if (raced === undefined || canonicalJson(raced) !== canonicalPayload) throw new ContextCacheCollisionError("context cache key collision");
    } finally {
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    return object;
  }
}
