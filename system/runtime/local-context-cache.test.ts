import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { ContextCacheIntegrityError, LocalContextCache } from "./local-context-cache";

const roots: string[] = [];
const key = `sha256:${"a".repeat(64)}` as const;

async function cache(): Promise<LocalContextCache> {
  const root = await mkdtemp(join(tmpdir(), "traceknot-context-cache-"));
  roots.push(root);
  return new LocalContextCache(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("local content-addressed context cache", () => {
  test("turns a cold miss into an integrity-checked warm hit", async () => {
    const store = await cache();
    const payload = { segments: ["protocol", "schemas"], verdictIndependent: true };
    expect(await store.get(key)).toBeUndefined();
    const stored = await store.put(key, payload);
    expect(stored.key).toBe(key);
    expect(stored.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await store.get(key)).toEqual(payload);
  });

  test("returns the same object for an idempotent write", async () => {
    const store = await cache();
    const payload = { stable: true, nested: { b: 2, a: 1 } };
    const first = await store.put(key, payload);
    const second = await store.put(key, { nested: { a: 1, b: 2 }, stable: true });
    expect(second).toEqual(first);
  });

  test("rejects a cache object whose payload digest does not match", async () => {
    const store = await cache();
    await mkdir(join(store.root, "sha256"), { recursive: true });
    await writeFile(join(store.root, "sha256", key.slice("sha256:".length)), JSON.stringify({
      schemaVersion: "context-cache-object/v1",
      key,
      payloadDigest: `sha256:${"b".repeat(64)}`,
      payload: { tampered: true },
    }));
    await expect(store.get(key)).rejects.toBeInstanceOf(ContextCacheIntegrityError);
  });

  test("rejects malformed keys before filesystem access", async () => {
    const store = await cache();
    await expect(store.get("sha256:../escape" as `sha256:${string}`)).rejects.toThrow("invalid context cache key");
  });
});
