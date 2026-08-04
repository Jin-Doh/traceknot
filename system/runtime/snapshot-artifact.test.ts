import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
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

test("local artifact store verifies bytes, publishes atomically, and is idempotent", async () => {
  const root = await temporaryDirectory();
  const source = join(root, "source.bin");
  const bytes = Buffer.from([0, 255, 1, 2, 0, 128]);
  const artifactDigest = digest(bytes);
  try {
    await writeFile(source, bytes);
    const store = new LocalArtifactStore({ rootDir: join(root, "artifacts") });
    const first = await store.storeVerificationResultArtifact({ type: "verification-result", digest: artifactDigest, path: source }, request);
    const second = await store.putArtifact({ type: "verification-result", digest: artifactDigest, path: source }, request);
    expect(first).toEqual(second);
    expect(await store.readArtifact(artifactDigest)).toEqual(bytes);
    expect((await readdir(join(root, "artifacts"))).filter(name => !name.startsWith(".tmp-")).length).toBe(1);
  } finally {
    await cleanup(root);
  }
});

test("local artifact store fails closed on mismatch, collision, and symlink targets", async () => {
  const root = await temporaryDirectory();
  const source = join(root, "source.bin");
  const outside = join(root, "outside.bin");
  const bytes = Buffer.from("correct bytes");
  const wrong = Buffer.from("wrong bytes");
  const artifactDigest = digest(bytes);
  try {
    await writeFile(source, bytes);
    await writeFile(outside, Buffer.from("outside"));
    const store = new LocalArtifactStore(join(root, "artifacts"));
    await expect(store.storeArtifact({ type: "result", digest: digest(wrong), path: source }, request)).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await mkdir(join(root, "artifacts"), { recursive: true });
    await writeFile(join(root, "artifacts", artifactDigest), wrong);
    await expect(store.storeArtifact({ type: "result", digest: artifactDigest, path: source }, request)).rejects.toBeInstanceOf(ArtifactCollisionError);

    await unlink(join(root, "artifacts", artifactDigest));
    await symlink(outside, join(root, "artifacts", artifactDigest));
    await expect(store.storeArtifact({ type: "result", digest: artifactDigest, path: source }, request)).rejects.toBeInstanceOf(ArtifactCollisionError);
    expect(await readFile(outside, "utf8")).toBe("outside");

    const sourceLink = join(root, "source-link");
    await symlink(source, sourceLink);
    await expect(store.storeArtifact({ type: "result", digest: artifactDigest, path: sourceLink }, request)).rejects.toBeInstanceOf(ArtifactPathError);
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
