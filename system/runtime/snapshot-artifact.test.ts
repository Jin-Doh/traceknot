import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { ArtifactCollisionError, ArtifactIntegrityError, ArtifactPathError, LocalArtifactStore } from "./local-artifact-store";
import { captureGitSnapshotIdentity } from "./git-snapshot";
import type { VerificationExecutionRequest } from "./verification-run";

async function command(root: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  const stderr = await new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} (${code}): ${stderr}`);
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "traceknot-pr5-"));
}

async function repository(): Promise<string> {
  const root = await temporaryDirectory();
  await command(root, ["init", "-q"]);
  await command(root, ["config", "user.email", "traceknot@example.invalid"]);
  await command(root, ["config", "user.name", "Traceknot"]);
  await writeFile(join(root, "tracked.bin"), Buffer.from([0, 255, 1, 2, 0, 128]));
  await command(root, ["add", "tracked.bin"]);
  await command(root, ["commit", "-qm", "initial"]);
  return root;
}

const request = {} as VerificationExecutionRequest;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function cleanup(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

test("Git snapshot binds canonical root, HEAD, binary content, and dirty states", async () => {
  const root = await repository();
  try {
    const clean = await captureGitSnapshotIdentity(root);
    const stable = await captureGitSnapshotIdentity(root);
    expect(clean.rootIdentity).toBe(await realpath(root));
    expect(clean.snapshotId).toBe(stable.snapshotId);
    expect(clean.dirty).toBe(false);
    expect(clean.worktree.some(entry => entry.kind === "file" && entry.digest === digest(Buffer.from([0, 255, 1, 2, 0, 128])))).toBe(true);

    await writeFile(join(root, "tracked.bin"), Buffer.from([0, 255, 1, 2, 0, 129]));
    const unstaged = await captureGitSnapshotIdentity(root);
    expect(unstaged.snapshotId).not.toBe(clean.snapshotId);
    expect(unstaged.status.some(entry => entry.kind === "ordinary" && entry.y === "M")).toBe(true);

    await command(root, ["add", "tracked.bin"]);
    const staged = await captureGitSnapshotIdentity(root);
    expect(staged.snapshotId).not.toBe(unstaged.snapshotId);
    expect(staged.status.some(entry => entry.kind === "ordinary" && entry.x === "M")).toBe(true);

    const untrackedName = "untracked name\n.bin";
    await writeFile(join(root, untrackedName), Buffer.from([255, 0, 127]));
    const untracked = await captureGitSnapshotIdentity(root);
    expect(untracked.status.some(entry => entry.kind === "untracked")).toBe(true);
    expect(untracked.worktree.some(entry => entry.digest === digest(Buffer.from([255, 0, 127])))).toBe(true);

    await unlink(join(root, "tracked.bin"));
    const deleted = await captureGitSnapshotIdentity(root);
    expect(deleted.worktree.some(entry => entry.kind === "missing")).toBe(true);

    await writeFile(join(root, "renamed-source"), Buffer.from("rename me"));
    await command(root, ["add", "renamed-source"]);
    await command(root, ["commit", "-qm", "rename fixture"]);
    await command(root, ["mv", "renamed-source", "renamed-target"]);
    const renamed = await captureGitSnapshotIdentity(root);
    expect(renamed.status.some(entry => entry.kind === "rename")).toBe(true);
  } finally {
    await cleanup(root);
  }
});

test("Git snapshot root identity follows the canonical repository path", async () => {
  const root = await repository();
  const parent = await temporaryDirectory();
  const alias = join(parent, "repo-alias");
  try {
    await symlink(root, alias, "dir");
    const snapshot = await captureGitSnapshotIdentity(alias);
    expect(snapshot.rootIdentity).toBe(await realpath(root));
    expect(snapshot.repositoryRoot).toBe(await realpath(root));
  } finally {
    await cleanup(root);
    await cleanup(parent);
  }
});

test("Git snapshot ignores hostile repository and config environment overrides", async () => {
  const root = await repository();
  const alternate = await repository();
  const hostile: Record<string, string> = {
    GIT_DIR: join(alternate, ".git"),
    GIT_WORK_TREE: alternate,
    GIT_INDEX_FILE: join(alternate, ".git", "index"),
    GIT_OBJECT_DIRECTORY: join(alternate, ".git", "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(alternate, ".git", "objects"),
    GIT_COMMON_DIR: join(alternate, ".git"),
    GIT_CONFIG_GLOBAL: join(alternate, "hostile.gitconfig"),
    GIT_CONFIG_SYSTEM: join(alternate, "hostile-system.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "0",
    GIT_CONFIG_PARAMETERS: "'core.repositoryformatversion'='99'",
    GIT_SSH_COMMAND: "/bin/false",
    GIT_ASKPASS: "/bin/false",
    GIT_TERMINAL_PROMPT: "1",
  };
  const saved = new Map<string, string | undefined>();
  try {
    const baseline = await captureGitSnapshotIdentity(root);
    for (const [key, value] of Object.entries(hostile)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
    const poisoned = await captureGitSnapshotIdentity(root);
    expect(poisoned.snapshotId).toBe(baseline.snapshotId);
    expect(poisoned.canonicalState).toBe(baseline.canonicalState);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await cleanup(root);
    await cleanup(alternate);
  }
});

test("Git snapshot captures symlink identity without following an outside target", async () => {
  const root = await repository();
  const outside = join(await temporaryDirectory(), "outside.bin");
  try {
    await writeFile(outside, Buffer.from("outside secret"));
    await unlink(join(root, "tracked.bin"));
    await symlink(outside, join(root, "tracked.bin"));
    const snapshot = await captureGitSnapshotIdentity(root);
    const trackedPath = Buffer.from("tracked.bin").toString("base64");
    const entry = snapshot.worktree.find(item => item.path === trackedPath);
    expect(entry?.kind).toBe("symlink");
    expect(entry?.digest).toBe(digest(Buffer.from(outside)));
    expect(entry?.digest).not.toBe(digest(Buffer.from("outside secret")));
  } finally {
    await cleanup(root);
    await cleanup(outside);
    await cleanup(outside.slice(0, outside.lastIndexOf("/")));
  }
});

test("Git snapshot retries or fails closed while a tracked file is concurrently rewritten", async () => {
  const root = await repository();
  const tracked = join(root, "tracked.bin");
  const first = Buffer.alloc(4 * 1024 * 1024, 0x11);
  const second = Buffer.alloc(4 * 1024 * 1024, 0x22);
  try {
    await writeFile(tracked, first);
    const mutation = (async () => {
      for (let index = 0; index < 12; index += 1) {
        await writeFile(tracked, index % 2 === 0 ? second : first);
        await Bun.sleep(0);
      }
    })();
    const result = await Promise.allSettled([captureGitSnapshotIdentity(root), mutation]);
    expect(result[1]!.status).toBe("fulfilled");
    if (result[0]!.status === "fulfilled") {
      const entry = result[0]!.value.worktree.find(item => item.path === Buffer.from("tracked.bin").toString("base64"));
      expect([digest(first), digest(second)]).toContain(entry?.digest ?? "");
    } else {
      expect(result[0]!.reason).toBeInstanceOf(Error);
    }
  } finally {
    await cleanup(root);
  }
});

test("local artifact store verifies bytes, preserves the caller path, and is idempotent", async () => {
  const root = await temporaryDirectory();
  const source = join(root, "source.bin");
  const bytes = Buffer.from([0, 255, 1, 2, 0, 128]);
  const artifactDigest = digest(bytes);
  try {
    await writeFile(source, bytes);
    const store = new LocalArtifactStore({ rootDir: join(root, "artifacts") });
    const first = await store.storeVerificationResultArtifact({ type: "verification-result", digest: artifactDigest, path: source }, request);
    const second = await store.putArtifact({ type: "verification-result", digest: artifactDigest, path: source }, request);
    expect(first).toEqual({ type: "verification-result", digest: artifactDigest, path: source });
    expect(second).toEqual(first);
    expect(await store.readArtifact(artifactDigest)).toEqual(bytes);
    expect(await readdir(join(root, "artifacts"))).toEqual(expect.arrayContaining([".objects", ".artifact.lock"]));
  } finally {
    await cleanup(root);
  }
});

test("independent descriptor stores serialize same and different digest writes with immediate cross-instance reads", async () => {
  const root = await temporaryDirectory();
  const artifactRoot = join(root, "artifacts");
  const firstBytes = Buffer.from("first independent payload");
  const secondBytes = Buffer.from("second independent payload");
  const firstDigest = digest(firstBytes);
  const secondDigest = digest(secondBytes);
  const first = new LocalArtifactStore(artifactRoot);
  const second = new LocalArtifactStore(artifactRoot);
  try {
    await Promise.all([
      first.storeArtifact({ type: "result", digest: firstDigest, bytes: firstBytes } as never, request),
      second.storeArtifact({ type: "result", digest: firstDigest, bytes: firstBytes } as never, request),
      first.storeArtifact({ type: "result", digest: secondDigest, bytes: secondBytes } as never, request),
      second.storeArtifact({ type: "result", digest: secondDigest, bytes: secondBytes } as never, request),
    ]);
    expect(await first.readArtifact(firstDigest)).toEqual(firstBytes);
    expect(await second.readArtifact(firstDigest)).toEqual(firstBytes);
    expect(await first.readArtifact(secondDigest)).toEqual(secondBytes);
    expect(await second.readArtifact(secondDigest)).toEqual(secondBytes);
    expect(await first.hasArtifact(secondDigest)).toBe(true);
    expect(await second.hasArtifact(firstDigest)).toBe(true);
  } finally {
    await first.close();
    await second.close();
    await cleanup(root);
  }
});
test("cross-instance source persistence, reads, and queued close remain ordered", async () => {
  const root = await temporaryDirectory();
  const artifactRoot = join(root, "artifacts");
  const source = join(root, "large-source.bin");
  const bytes = Buffer.alloc(1024 * 1024, 0x5a);
  const artifactDigest = digest(bytes);
  const first = new LocalArtifactStore(artifactRoot);
  const second = new LocalArtifactStore(artifactRoot);
  try {
    await writeFile(source, bytes);
    const persisted = first.storeArtifact({ type: "large", digest: artifactDigest, path: source }, request);
    const observedBeforePublication = second.hasArtifact(artifactDigest);
    await expect(observedBeforePublication).resolves.toBe(false);
    await persisted;
    await expect(second.readArtifact(artifactDigest)).resolves.toEqual(bytes);

    const queuedPersist = first.storeArtifact({ type: "large", digest: artifactDigest, path: source }, request);
    const closing = first.close();
    await Promise.all([queuedPersist, closing]);
    await expect(first.hasArtifact(artifactDigest)).rejects.toBeInstanceOf(ArtifactPathError);
    await expect(second.readArtifact(artifactDigest)).resolves.toEqual(bytes);
  } finally {
    await second.close();
    await cleanup(root);
  }
});

test("local artifact store fails closed on mismatch, torn frames, corruption, and symlink sources", async () => {
  const root = await temporaryDirectory();
  const source = join(root, "source.bin");
  const artifactRoot = join(root, "artifacts");
  const bytes = Buffer.from("correct bytes");
  const wrong = Buffer.from("wrong bytes");
  const artifactDigest = digest(bytes);
  const objectPath = join(artifactRoot, ".objects", artifactDigest);
  try {
    await writeFile(source, bytes);
    const store = new LocalArtifactStore(artifactRoot);
    await expect(store.storeArtifact({ type: "result", digest: digest(wrong), path: source }, request)).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await store.storeArtifact({ type: "result", digest: artifactDigest, path: source }, request);
    const frame = await readFile(objectPath);
    await writeFile(objectPath, frame.subarray(0, 10));
    await expect(store.readArtifact(artifactDigest)).rejects.toBeInstanceOf(ArtifactCollisionError);
    await expect(store.storeArtifact({ type: "result", digest: artifactDigest, path: source }, request)).rejects.toBeInstanceOf(ArtifactCollisionError);
    await writeFile(objectPath, frame);
    expect(await store.readArtifact(artifactDigest)).toEqual(bytes);
    await writeFile(objectPath, Buffer.concat([frame.subarray(0, -1), Buffer.from([frame.at(-1)! ^ 0xff])]));
    await expect(store.hasArtifact(artifactDigest)).rejects.toBeInstanceOf(ArtifactCollisionError);
    await writeFile(objectPath, frame);
    const sourceLink = join(root, "source-link");
    await symlink(source, sourceLink);
    await expect(store.storeArtifact({ type: "result", digest: artifactDigest, path: sourceLink }, request)).rejects.toBeInstanceOf(ArtifactPathError);
    await store.close();
  } finally {
    await cleanup(root);
  }
});
test("descriptor object paths reject FIFOs without blocking and never use legacy digest paths", async () => {
  const root = await temporaryDirectory();
  const artifactRoot = join(root, "artifacts");
  const bytes = Buffer.from("descriptor only");
  const artifactDigest = digest(bytes);
  const missingDigest = "b".repeat(64);
  const fifo = join(artifactRoot, ".objects", missingDigest);
  try {
    const store = new LocalArtifactStore(artifactRoot);
    await store.store({ type: "binary", digest: artifactDigest, bytes } as never, request);
    const fifoMaker = Bun.spawnSync(["mkfifo", fifo]);
    expect(fifoMaker.exitCode).toBe(0);
    await expect(store.readArtifact(missingDigest)).rejects.toBeInstanceOf(ArtifactPathError);
    expect(await store.readArtifact(artifactDigest)).toEqual(bytes);
    await store.close();
  } finally {
    await unlink(fifo).catch(() => undefined);
    await cleanup(root);
  }
});

test("descriptor root, objects, lock, and digest symlinks fail closed", async () => {
  const root = await temporaryDirectory();
  const outside = await temporaryDirectory();
  const artifactRoot = join(root, "artifacts");
  const digestBytes = Buffer.from("symlink digest");
  const artifactDigest = digest(digestBytes);
  try {
    await mkdir(artifactRoot);
    await symlink(join(outside, "root-target"), join(root, "root-link"), "dir");
    await expect(() => new LocalArtifactStore(join(root, "root-link"))).toThrow(ArtifactPathError);

    await symlink(outside, join(artifactRoot, ".objects"), "dir");
    await expect(() => new LocalArtifactStore(artifactRoot)).toThrow(ArtifactPathError);
    await unlink(join(artifactRoot, ".objects"));
    await mkdir(join(artifactRoot, ".objects"));

    await symlink(join(outside, "lock-target"), join(artifactRoot, ".artifact.lock"));
    await expect(() => new LocalArtifactStore(artifactRoot)).toThrow(ArtifactPathError);
    await unlink(join(artifactRoot, ".artifact.lock"));

    const store = new LocalArtifactStore(artifactRoot);
    await store.store({ type: "binary", digest: artifactDigest, bytes: digestBytes } as never, request);
    await store.close();
    await unlink(join(artifactRoot, ".objects", artifactDigest));
    await symlink(join(outside, "digest-target"), join(artifactRoot, ".objects", artifactDigest));
    const reopened = new LocalArtifactStore(artifactRoot);
    await expect(reopened.readArtifact(artifactDigest)).rejects.toBeInstanceOf(ArtifactPathError);
    await expect(reopened.hasArtifact(artifactDigest)).rejects.toBeInstanceOf(ArtifactPathError);
    await reopened.close();
  } finally {
    await cleanup(root);
    await cleanup(outside);
  }
});
test("portable native dispatch covers Darwin actual bindings and Linux static bindings", async () => {
  const source = (await readFile(join(import.meta.dir, "local-artifact-store.ts"))).toString("utf8");
  expect(source).toContain('platform === "darwin"');
  expect(source).toContain('"/usr/lib/libSystem.B.dylib"');
  expect(source).toContain('platform === "linux"');
  expect(source).toContain('"libc.so.6"');
  expect(source).toContain('"__error"');
  expect(source).toContain('"__errno_location"');
  if (process.platform === "darwin") {
    const root = await temporaryDirectory();
    try {
      const store = new LocalArtifactStore(join(root, "actual-darwin"));
      await store.close();
    } finally {
      await cleanup(root);
    }
  }
});
test("artifact store preserves optional fsync configuration without pathname fallback", async () => {
  const root = await temporaryDirectory();
  const bytes = Buffer.from("fsync option");
  const artifactDigest = digest(bytes);
  try {
    const store = new LocalArtifactStore({ rootDir: join(root, "artifacts"), fsync: false });
    expect(store.fsync).toBe(false);
    await store.store({ type: "option", digest: artifactDigest, bytes } as never, request);
    expect(await store.readArtifact(artifactDigest)).toEqual(bytes);
    await store.close();
  } finally {
    await cleanup(root);
  }
});



test("local artifact store stays pinned when its configured root is renamed and replaced", async () => {
  const root = await temporaryDirectory();
  const source = join(root, "source.bin");
  const artifactRoot = join(root, "artifacts");
  const preservedRoot = join(root, "artifacts-preserved");
  const outside = join(root, "outside");
  const bytes = Buffer.from("root replacement");
  const artifactDigest = digest(bytes);
  try {
    await writeFile(source, bytes);
    await mkdir(outside);
    const store = new LocalArtifactStore(artifactRoot);
    await store.storeArtifact({ type: "result", digest: artifactDigest, path: source }, request);

    await rename(artifactRoot, preservedRoot);
    await mkdir(artifactRoot);
    const newBytes = Buffer.from("new bytes");
    const newDigest = digest(newBytes);
    await store.storeArtifact({ type: "result", digest: newDigest, bytes: newBytes } as never, request);
    expect(await store.readArtifact(newDigest)).toEqual(newBytes);
    expect(await readdir(artifactRoot)).toEqual([]);
    expect(await readdir(preservedRoot)).toEqual(expect.arrayContaining([".objects", ".artifact.lock"]));

    await rm(artifactRoot, { recursive: true, force: true });
    await symlink(outside, artifactRoot, "dir");
    expect(await store.readArtifact(artifactDigest)).toEqual(bytes);
    expect(await store.hasArtifact(artifactDigest)).toBe(true);
    expect(await readdir(outside)).toEqual([]);
    await store.close();
  } finally {
    await cleanup(root);
  }
});


test("local artifact store accepts binary embedded content and rejects traversal-shaped addresses", async () => {
  const root = await temporaryDirectory();
  const store = new LocalArtifactStore(join(root, "artifacts"));
  const bytes = new Uint8Array([0, 1, 2, 3, 255]);
  try {
    const saved = await store.store({ type: "binary", digest: digest(bytes), bytes } as never, request);
    expect(await store.readArtifact(saved.digest)).toEqual(bytes);
    await expect(store.store({ type: "binary", digest: `../${"a".repeat(62)}`, bytes } as never, request)).rejects.toBeInstanceOf(ArtifactIntegrityError);
  } finally {
    await cleanup(root);
  }
});
