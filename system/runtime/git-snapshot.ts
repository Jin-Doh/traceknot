import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const utf8 = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

type GitPath = Buffer;

type IndexEntry = Readonly<{
  mode: string;
  objectId: string;
  stage: number;
}>;

type StatusEntry = Readonly<{
  kind: "ordinary" | "unmerged" | "rename" | "untracked" | "ignored";
  x?: string;
  y?: string;
  path: string;
  renameFrom?: string;
  metadata?: string;
}>;

export type GitWorktreeEntry = Readonly<{
  path: string;
  kind: "file" | "symlink" | "directory" | "special" | "missing";
  mode: number | null;
  size: number | null;
  digest: string | null;
  linkTarget?: string;
}>;

export type GitSnapshotIndexEntry = Readonly<{
  path: string;
  entries: readonly IndexEntry[];
}>;

/**
 * The immutable identity of one Git repository state. `snapshotId` is a
 * SHA-256 commitment to the canonical state below; it is not a Git object id.
 */
export type GitSnapshotIdentity = Readonly<{
  schemaVersion: "git-snapshot/v1";
  rootIdentity: string;
  repositoryRoot: string;
  head: string;
  headCommit: string;
  dirty: boolean;
  snapshotId: string;
  stateDigest: string;
  canonicalState: string;
  index: readonly GitSnapshotIndexEntry[];
  worktree: readonly GitWorktreeEntry[];
  status: readonly StatusEntry[];
}>;

export type SnapshotIdentity = GitSnapshotIdentity;

const digestBytes = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const bytesToKey = (value: Uint8Array): string => Buffer.from(value).toString("base64");
const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
};
const compareText = (left: string, right: string): number => {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  return compareBytes(leftBytes, rightBytes);
};

function removeOneTerminalNewline(value: Uint8Array): Uint8Array {
  if (value.byteLength > 0 && value[value.byteLength - 1] === 10) return value.subarray(0, value.byteLength - 1);
  return value;
}

function splitNul(value: Uint8Array): Buffer[] {
  const bytes = Buffer.from(value);
  const result: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    result.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start < bytes.length) result.push(bytes.subarray(start));
  return result.filter(item => item.byteLength > 0);
}

function decode(value: Uint8Array): string {
  return utf8.decode(value);
}

function parseAsciiFields(value: Uint8Array): string[] {
  return decode(value).split(" ");
}

const SAFE_GIT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const SAFE_GIT_EXECUTABLE = ["/usr/bin/git", "/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"].find(path => existsSync(path)) ?? "git";

async function runGit(repositoryRoot: string, args: readonly string[], allowFailure = false, extraEnv: Readonly<Record<string, string>> = {}): Promise<Buffer> {
  const process = Bun.spawn([SAFE_GIT_EXECUTABLE, "-C", repositoryRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: SAFE_GIT_PATH,
      LC_ALL: "C",
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnv,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).arrayBuffer(),
    process.exited,
  ]);
  if (exitCode !== 0 && !allowFailure) {
    const detail = decode(Buffer.from(stderr)).trim();
    throw new Error(`git ${args.join(" ")} failed (${exitCode})${detail ? `: ${detail}` : ""}`);
  }
  return Buffer.from(stdout);
}

function assertSafeGitPath(path: GitPath): void {
  if (path.byteLength === 0 || path[0] === 0 || path[0] === 47) throw new Error("unsafe Git path");
  let segmentStart = 0;
  for (let index = 0; index <= path.byteLength; index += 1) {
    if (index !== path.byteLength && path[index] !== 47) continue;
    const segment = path.subarray(segmentStart, index).toString("utf8");
    if (segment === "." || segment === "..") throw new Error("unsafe Git path");
    segmentStart = index + 1;
  }
}

type WorktreeCapture = Readonly<{
  tree: string;
  entries: Map<string, { path: GitPath; entries: IndexEntry[] }>;
}>;

function gitMode(mode: string): number {
  const value = Number.parseInt(mode, 8);
  if (!Number.isSafeInteger(value)) throw new Error("malformed Git mode");
  return value;
}

async function captureWorktreeIndex(repositoryRoot: string, head: string): Promise<WorktreeCapture> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "traceknot-git-index-"));
  const indexPath = join(temporaryDirectory, "index");
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await runGit(repositoryRoot, ["read-tree", head === "UNBORN" ? "--empty" : head], false, env);
    await runGit(repositoryRoot, ["add", "-A", "--", "."], false, env);
    const tree = decode(removeOneTerminalNewline(await runGit(repositoryRoot, ["write-tree"], false, env)));
    const entries = parseIndex(await runGit(repositoryRoot, ["ls-files", "--stage", "-z"], false, env));
    return { tree, entries };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function worktreeEntry(repositoryRoot: string, item: { path: GitPath; entries: IndexEntry[] } | undefined, path: GitPath): Promise<GitWorktreeEntry> {
  const entry = item?.entries.find(candidate => candidate.stage === 0);
  if (!entry) return { path: bytesToKey(path), kind: "missing", mode: null, size: null, digest: null };
  const mode = gitMode(entry.mode);
  const type = mode & 0o170000;
  if (type === 0o160000) return { path: bytesToKey(path), kind: "directory", mode, size: null, digest: null };
  if (type !== 0o100000 && type !== 0o120000) return { path: bytesToKey(path), kind: "special", mode, size: null, digest: null };
  const content = await runGit(repositoryRoot, ["cat-file", "blob", entry.objectId]);
  if (type === 0o120000) return { path: bytesToKey(path), kind: "symlink", mode, size: content.byteLength, digest: digestBytes(content), linkTarget: bytesToKey(content) };
  return { path: bytesToKey(path), kind: "file", mode, size: content.byteLength, digest: digestBytes(content) };
}

function parseIndex(value: Uint8Array): Map<string, { path: GitPath; entries: IndexEntry[] }> {
  const entries = new Map<string, { path: GitPath; entries: IndexEntry[] }>();
  for (const record of splitNul(value)) {
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error("malformed Git index output");
    const fields = parseAsciiFields(record.subarray(0, tab));
    if (fields.length !== 3 || !/^\d+$/.test(fields[0]!) || !/^[0-9a-f]{40,64}$/i.test(fields[1]!) || !/^\d+$/.test(fields[2]!)) throw new Error("malformed Git index entry");
    const path = record.subarray(tab + 1);
    assertSafeGitPath(path);
    const key = bytesToKey(path);
    const existing = entries.get(key) ?? { path, entries: [] };
    existing.entries.push({ mode: fields[0]!, objectId: fields[1]!.toLowerCase(), stage: Number(fields[2]) });
    entries.set(key, existing);
  }
  for (const item of entries.values()) item.entries.sort((left, right) => left.stage - right.stage || compareText(left.mode, right.mode) || compareText(left.objectId, right.objectId));
  return entries;
}
function statusMetadataAndPath(record: Buffer, kind: string): { metadata: Buffer; path: Buffer } {
  const tab = record.indexOf(9);
  if (tab >= 0) return { metadata: record.subarray(0, tab), path: record.subarray(tab + 1) };
  const fieldCount = kind === "1" ? 8 : kind === "2" ? 9 : 10;
  let fields = 0;
  for (let index = 0; index < record.byteLength; index += 1) {
    if (record[index] !== 32) continue;
    fields += 1;
    if (fields === fieldCount) return { metadata: record.subarray(0, index), path: record.subarray(index + 1) };
  }
  throw new Error("malformed Git status output");
}

function parseStatus(value: Uint8Array): { statuses: StatusEntry[]; paths: Map<string, GitPath> } {
  const records = splitNul(value);
  const statuses: StatusEntry[] = [];
  const paths = new Map<string, GitPath>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const kind = String.fromCharCode(record[0]!);
    if (kind === "#") continue;
    if (kind === "?" || kind === "!") {
      const path = record.subarray(2);
      assertSafeGitPath(path);
      const encoded = bytesToKey(path);
      paths.set(encoded, path);
      statuses.push({ kind: kind === "?" ? "untracked" : "ignored", path: encoded });
      continue;
    }
    if (kind !== "1" && kind !== "2" && kind !== "u") throw new Error("malformed Git status output");
    const parsed = statusMetadataAndPath(record, kind);
    const metadata = decode(parsed.metadata);
    const fields = metadata.split(" ");
    const xy = fields[1];
    if (!xy || xy.length !== 2) throw new Error("malformed Git status state");
    const path = parsed.path;
    assertSafeGitPath(path);
    const encoded = bytesToKey(path);
    paths.set(encoded, path);
    if (kind === "2") {
      const renameFrom = records[++index];
      if (!renameFrom) throw new Error("malformed Git rename status");
      assertSafeGitPath(renameFrom);
      const oldEncoded = bytesToKey(renameFrom);
      paths.set(oldEncoded, renameFrom);
      statuses.push({ kind: "rename", x: xy[0], y: xy[1], path: encoded, renameFrom: oldEncoded, metadata });
    } else {
      statuses.push({ kind: kind === "u" ? "unmerged" : "ordinary", x: xy[0], y: xy[1], path: encoded, metadata });
    }
  }
  statuses.sort((left, right) => compareText(left.path, right.path) || compareText(left.renameFrom ?? "", right.renameFrom ?? "") || compareText(left.kind, right.kind));
  return { statuses, paths };
}

function canonicalize(value: unknown): string {
  return JSON.stringify(value);
}

const MAX_CAPTURE_ATTEMPTS = 4;

type GitSnapshotAttempt = Readonly<{
  repositoryRoot: string;
  head: string;
  index: readonly GitSnapshotIndexEntry[];
  worktree: readonly GitWorktreeEntry[];
  status: readonly StatusEntry[];
  worktreeTree: string;
  canonicalState: string;
}>;

async function captureGitSnapshotAttempt(requestedRoot: string): Promise<GitSnapshotAttempt> {
  const shownRootBytes = removeOneTerminalNewline(await runGit(requestedRoot, ["rev-parse", "--show-toplevel"]));
  const repositoryRoot = await realpath(decode(shownRootBytes));
  if (repositoryRoot !== requestedRoot) throw new Error("Git repository root does not match requested path");

  const headOutput = await runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"], true);
  const trimmedHead = removeOneTerminalNewline(headOutput);
  const head = trimmedHead.byteLength > 0 ? decode(trimmedHead) : "UNBORN";
  const indexMap = parseIndex(await runGit(repositoryRoot, ["ls-files", "--stage", "-z"]));
  const statusResult = parseStatus(await runGit(repositoryRoot, ["status", "--porcelain=v2", "--untracked-files=all", "-z"]));
  const worktreeCapture = await captureWorktreeIndex(repositoryRoot, head);
  const allPaths = new Map<string, GitPath>();
  for (const [key, item] of indexMap) allPaths.set(key, item.path);
  for (const [key, path] of statusResult.paths) allPaths.set(key, path);
  for (const [key, item] of worktreeCapture.entries) allPaths.set(key, item.path);

  const index = [...indexMap.values()]
    .sort((left, right) => compareBytes(left.path, right.path))
    .map(item => ({ path: bytesToKey(item.path), entries: item.entries.map(entry => ({ ...entry })) }));
  const worktree = (await Promise.all([...allPaths.values()].sort(compareBytes).map(path => worktreeEntry(repositoryRoot, worktreeCapture.entries.get(bytesToKey(path)), path))))
    .sort((left, right) => compareText(left.path, right.path));
  const status = statusResult.statuses.map(item => ({ ...item }));
  const canonicalState = canonicalize({
    schemaVersion: "git-snapshot/v1",
    rootIdentity: repositoryRoot,
    head,
    index,
    worktreeTree: worktreeCapture.tree,
    worktree,
    status,
  });
  return { repositoryRoot, head, index, worktree, status, worktreeTree: worktreeCapture.tree, canonicalState };
}

/** Capture a deterministic Git worktree identity using machine-readable Git output. */
export async function captureGitSnapshotIdentity(repositoryPath: string): Promise<GitSnapshotIdentity> {
  if (typeof repositoryPath !== "string" || repositoryPath.length === 0) throw new Error("repository path is required");
  const requestedRoot = await realpath(resolve(repositoryPath));
  let previous: GitSnapshotAttempt | undefined;
  for (let attempt = 0; attempt < MAX_CAPTURE_ATTEMPTS; attempt += 1) {
    const liveRootBefore = await realpath(resolve(repositoryPath));
    if (liveRootBefore !== requestedRoot) throw new Error("Git repository root changed during snapshot capture");
    const candidate = await captureGitSnapshotAttempt(requestedRoot);
    const liveRootAfter = await realpath(resolve(repositoryPath));
    if (liveRootAfter !== requestedRoot) throw new Error("Git repository root changed during snapshot capture");
    if (previous?.canonicalState === candidate.canonicalState) {
      const stateDigest = digestBytes(encoder.encode(candidate.canonicalState));
      return {
        schemaVersion: "git-snapshot/v1",
        rootIdentity: candidate.repositoryRoot,
        repositoryRoot: candidate.repositoryRoot,
        head: candidate.head,
        headCommit: candidate.head,
        dirty: candidate.status.length > 0,
        snapshotId: stateDigest,
        stateDigest,
        canonicalState: candidate.canonicalState,
        index: candidate.index,
        worktree: candidate.worktree,
        status: candidate.status,
      };
    }
    previous = candidate;
  }
  throw new Error("Git repository state changed during snapshot capture");
}

export const createGitSnapshotIdentity = captureGitSnapshotIdentity;
export const getGitSnapshotIdentity = captureGitSnapshotIdentity;
export const computeGitSnapshotIdentity = captureGitSnapshotIdentity;
export const captureGitSnapshot = captureGitSnapshotIdentity;

export function isGitSnapshotIdentity(value: unknown): value is GitSnapshotIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GitSnapshotIdentity>;
  return candidate.schemaVersion === "git-snapshot/v1" && typeof candidate.rootIdentity === "string" && typeof candidate.snapshotId === "string" && /^[0-9a-f]{64}$/.test(candidate.snapshotId) && typeof candidate.canonicalState === "string";
}
