import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { resolve } from "node:path";

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

async function runGit(repositoryRoot: string, args: readonly string[], allowFailure = false): Promise<Buffer> {
  const process = Bun.spawn(["git", "-C", repositoryRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...globalThis.process?.env,
      LC_ALL: "C",
      LANG: "C",
      GIT_OPTIONAL_LOCKS: "0",
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

function pathParts(path: GitPath): Buffer[] {
  assertSafeGitPath(path);
  return path.toString("binary").split("/").map(part => Buffer.from(part, "binary"));
}

async function readWorktreeEntry(repositoryRoot: string, path: GitPath): Promise<GitWorktreeEntry> {
  const parts = pathParts(path);
  let current = Buffer.from(repositoryRoot);
  let stat: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    for (let index = 0; index < parts.length; index += 1) {
      current = Buffer.concat([current, Buffer.from("/"), parts[index]!]);
      stat = await lstat(current);
      if (index < parts.length - 1 && stat.isSymbolicLink()) throw new Error("Git path traverses a symlink");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: bytesToKey(path), kind: "missing", mode: null, size: null, digest: null };
    }
    throw error;
  }
  if (!stat) return { path: bytesToKey(path), kind: "missing", mode: null, size: null, digest: null };
  const mode = Number(stat.mode) & 0o7777;
  if (stat.isSymbolicLink()) {
    const target = await readlink(current, { encoding: "buffer" });
    const targetBytes = Buffer.from(target as Uint8Array);
    return { path: bytesToKey(path), kind: "symlink", mode, size: targetBytes.byteLength, digest: digestBytes(targetBytes), linkTarget: bytesToKey(targetBytes) };
  }
  if (stat.isFile()) {
    const content = await readFile(current);
    return { path: bytesToKey(path), kind: "file", mode, size: content.byteLength, digest: digestBytes(content) };
  }
  if (stat.isDirectory()) return { path: bytesToKey(path), kind: "directory", mode, size: null, digest: null };
  return { path: bytesToKey(path), kind: "special", mode, size: null, digest: null };
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

/** Capture a deterministic Git worktree identity using machine-readable Git output. */
export async function captureGitSnapshotIdentity(repositoryPath: string): Promise<GitSnapshotIdentity> {
  if (typeof repositoryPath !== "string" || repositoryPath.length === 0) throw new Error("repository path is required");
  const requestedRoot = await realpath(resolve(repositoryPath));
  const shownRootBytes = removeOneTerminalNewline(await runGit(requestedRoot, ["rev-parse", "--show-toplevel"]));
  const repositoryRoot = await realpath(decode(shownRootBytes));
  if (repositoryRoot !== requestedRoot) throw new Error("Git repository root does not match requested path");

  const headOutput = await runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"], true);
  const head = removeOneTerminalNewline(headOutput).byteLength > 0 ? decode(removeOneTerminalNewline(headOutput)) : "UNBORN";
  const indexMap = parseIndex(await runGit(repositoryRoot, ["ls-files", "--stage", "-z"]));
  const statusResult = parseStatus(await runGit(repositoryRoot, ["status", "--porcelain=v2", "--untracked-files=all", "-z"]));
  const allPaths = new Map<string, GitPath>();
  for (const [key, item] of indexMap) allPaths.set(key, item.path);
  for (const [key, path] of statusResult.paths) allPaths.set(key, path);

  const index = [...indexMap.values()]
    .sort((left, right) => compareBytes(left.path, right.path))
    .map(item => ({ path: bytesToKey(item.path), entries: item.entries.map(entry => ({ ...entry })) }));
  const worktree = (await Promise.all([...allPaths.values()].sort(compareBytes).map(path => readWorktreeEntry(repositoryRoot, path))))
    .sort((left, right) => compareText(left.path, right.path));
  const status = statusResult.statuses.map(item => ({ ...item }));
  const canonicalState = canonicalize({
    schemaVersion: "git-snapshot/v1",
    rootIdentity: repositoryRoot,
    head,
    index,
    worktree,
    status,
  });
  const snapshotId = digestBytes(encoder.encode(canonicalState));
  return {
    schemaVersion: "git-snapshot/v1",
    rootIdentity: repositoryRoot,
    repositoryRoot,
    head,
    headCommit: head,
    dirty: status.length > 0,
    snapshotId,
    stateDigest: snapshotId,
    canonicalState,
    index,
    worktree,
    status,
  };
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
