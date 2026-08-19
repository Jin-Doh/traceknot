import { constants, type Dirent, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ARTIFACT_CANONICAL_LOCK_FILE, ArtifactNotFoundError, assertPrivateRootPath, assertSecureRoot, closeSecureDescriptor, closeSecureRoot, openOrCreateSecureDirectoryPath, openSecureDirectory, openSecureRoot, readSecureRegularFile, secureFlock, secureFsync, secureOpenAt, secureRenameAt, secureRmdirAt, secureUnlinkAt, STORAGE_MAINTENANCE_LOCK_FILE, type SecureRootDescriptor } from "./local-artifact-store";
import { assertCanonicalRun } from "./verification-run";

const DIGEST = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_STATE = "state.json";
const PINS_FILE = ".traceknot-pins.json";
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const GC_MARKS_FILE = ".traceknot-gc-marks.json";
const EPHEMERAL_LEASE_FILE = ".ephemeral.lease";
const ARTIFACT_WRITE_TEMP = /^\.tmp-[0-9a-f]{64}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ATOMIC_WRITE_TEMP = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_GRACE_MS = DAY;
const DEFAULT_BOARD_TTL_MS = 30 * DAY;
const DEFAULT_RUN_TTL_MS = 90 * DAY;
const DEFAULT_BOARD_QUOTA_BYTES = 1024 * 1024 * 1024;
const DEFAULT_RUN_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const ENOENT = "ENOENT";
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_CLOEXEC = (constants as Record<string, number | undefined>).O_CLOEXEC ?? 0;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW | O_CLOEXEC;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

export type StorageDirectories = Readonly<{
  stateDir: string;
  artifactDir: string;
}>;

export type StorageRetentionPolicy = Readonly<{
  boardTtlMs: number;
  boardMaxPerRun: number;
  boardMaxPerSession: number;
  boardQuotaBytes: number;
  canonicalRunTtlMs: number;
  canonicalQuotaBytes: number;
  graceMs: number;
}>;

export const DEFAULT_CACHE_RETENTION_POLICY: StorageRetentionPolicy = Object.freeze({
  boardTtlMs: DEFAULT_BOARD_TTL_MS,
  boardMaxPerRun: 10,
  boardMaxPerSession: 10,
  boardQuotaBytes: DEFAULT_BOARD_QUOTA_BYTES,
  canonicalRunTtlMs: DEFAULT_RUN_TTL_MS,
  canonicalQuotaBytes: DEFAULT_RUN_QUOTA_BYTES,
  graceMs: DEFAULT_GRACE_MS,
});

type JsonRecord = Record<string, unknown>;
type GcMarks = Readonly<Record<string, number>>;
type EntryKind = "board" | "run" | "object" | "collector" | "staging";
type StorageEntry = Readonly<{
  kind: EntryKind;
  path: string;
  relativePath: string;
  bytes: number;
  allocatedBytes: number;
  mtimeMs: number;
  logicalUpdatedAt?: number;
  runId?: string;
  sessionKey?: string;
  sourceState?: string;
  sourceRevision?: number;
  boardId?: string;
  digest?: string;
  malformed?: boolean;
  future?: boolean;
  terminal?: boolean;
  protectedReason?: string;
}>;

type RunInfo = Readonly<{
  runId: string;
  path: string;
  relativePath: string;
  bytes: number;
  allocatedBytes: number;
  mtimeMs: number;
  updatedAt?: number;
  state?: string;
  terminal: boolean;
  malformed: boolean;
  future: boolean;
  pinned: boolean;
  documents: readonly unknown[];
  digests: ReadonlySet<string>;
}>;
type BoardInfo = Readonly<{
  runId?: string;
  sessionKey?: string;
  current?: boolean;
  boardId: string;
  path: string;
  relativePath: string;
  bytes: number;
  allocatedBytes: number;
  mtimeMs: number;
  generatedAt?: number;
  sourceUpdatedAt?: number;
  sourceRevision?: number;
  sourceState?: string;
  malformed: boolean;
  future: boolean;
}>;

export type StorageInventory = Readonly<{
  schemaVersion: "traceknot-storage-inventory/v1";
  generatedAt: string;
  directories: StorageDirectories;
  logicalBytes: number;
  allocatedBytes: number;
  oldest?: string;
  newest?: string;
  counts: Readonly<{
    runs: number;
    terminalRuns: number;
    activeRuns: number;
    pinnedRuns: number;
    malformedRuns: number;
    futureRuns: number;
    boards: number;
    malformedBoards: number;
    futureBoards: number;
    canonicalObjects: number;
    malformedObjects: number;
    collector: number;
    staging: number;
    symlinks: number;
    pinFileMalformed: boolean;
  }>;
  runs: readonly StorageEntry[];
  boards: readonly StorageEntry[];
  objects: readonly StorageEntry[];
  collector: readonly StorageEntry[];
  staging: readonly StorageEntry[];
  symlinks: readonly string[];
  runReferences: Readonly<Record<string, readonly string[]>>;
}>;

export type StorageMaintenanceReport = Readonly<{
  schemaVersion: "traceknot-storage-maintenance/v1";
  generatedAt: string;
  dryRun: boolean;
  applied: boolean;
  directories: StorageDirectories;
  policy: StorageRetentionPolicy;
  inventory: StorageInventory;
  candidates: Readonly<{
    boards: readonly string[];
    runs: readonly string[];
    objects: readonly string[];
    collector: readonly string[];
    staging: readonly string[];
  }>;
  deleted: Readonly<{
    boards: readonly string[];
    runs: readonly string[];
    objects: readonly string[];
    collector: readonly string[];
    staging: readonly string[];
  }>;
  protected: Readonly<{
    newestTerminalRuns: readonly string[];
    activeRuns: readonly string[];
    pinnedRuns: readonly string[];
    currentBoards: readonly string[];
    malformed: readonly string[];
    future: readonly string[];
    grace: readonly string[];
    sharedObjects: readonly string[];
    symlinks: readonly string[];
    requestedRuns: readonly string[];
  }>;
  warnings: readonly string[];
}>;

export type StorageMaintenanceOptions = Readonly<{
  stateDir: string;
  artifactDir: string;
  now?: string | number | Date;
  policy?: Partial<StorageRetentionPolicy> & Readonly<{ boardTtlDays?: number; canonicalRunTtlDays?: number; graceHours?: number }>;
  protectedRunIds?: readonly string[];
  apply?: boolean;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeId(value: string): boolean {
  return SAFE_ID.test(value) && !value.includes("..");
}
function safeEntry(value: string): boolean {
  return safeId(value) || (/^\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes(".."));
}
const SAFE_BOARD_ENTRY = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
function safeStoragePath(relativePath: string): boolean {
  const components = relativePath.split("/");
  return components.every((component, index) => index === 3
    && ((components[0] === "runs" && components[2] === "boards") || (components[0] === "sessions" && components[2] === "boards"))
    ? SAFE_BOARD_ENTRY.test(component)
    : safeEntry(component));
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function asTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function exactKeys(value: JsonRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every(key => key in value) && keys.every(key => required.includes(key) || optional.includes(key));
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonnegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function validBoardAssurance(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["context", "requiredIndependence", "releaseStatus"])) return false;
  return (value.context === "local" || value.context === "release")
    && (value.requiredIndependence === "separate-verification-context" || value.requiredIndependence === "independent-producer")
    && (value.releaseStatus === "not-evaluated" || value.releaseStatus === "satisfied" || value.releaseStatus === "insufficient");
}

function validBoardManifest(value: unknown): value is JsonRecord {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "runId", "requestId", "rootIdentity", "snapshotId", "sourceRevision", "sourceState", "sourceUpdatedAt", "generatedAt", "entrypoint", "authoritative", "assurance", "verdict", "counts", "generatedBy", "files"], ["sessionKey"])) return false;
  if (value.schemaVersion !== "traceknot-qa-board/v1" || !nonempty(value.runId) || !nonempty(value.requestId) || !nonempty(value.rootIdentity) || !nonempty(value.snapshotId) || !nonnegativeInteger(value.sourceRevision)) return false;
  if (value.sessionKey !== undefined && (typeof value.sessionKey !== "string" || !/^s-[0-9a-f]{64}$/.test(value.sessionKey))) return false;
  if (!["CREATED", "BASIS_ESTABLISHED", "DISCOVERY_COMPLETED", "PLANNED", "EXECUTING", "EVIDENCE_EVALUATED", "VERDICT_RESOLVED", "TERMINAL"].includes(String(value.sourceState))) return false;
  if (typeof value.sourceUpdatedAt !== "string" || !ISO_UTC.test(value.sourceUpdatedAt) || typeof value.generatedAt !== "string" || !ISO_UTC.test(value.generatedAt) || value.entrypoint !== "index.html" || value.authoritative !== false || !validBoardAssurance(value.assurance) || !["PASS", "PASS_WITH_ACCEPTED_RISK", "FAIL", "BLOCKED", "INCOMPLETE"].includes(String(value.verdict))) return false;
  if (!isRecord(value.counts) || !exactKeys(value.counts, ["mandatory", "passed", "failed", "blocked", "incomplete"]) || !Object.values(value.counts).every(nonnegativeInteger)) return false;
  if (!isRecord(value.generatedBy) || !exactKeys(value.generatedBy, ["invocationId", "sessionHost", "sessionRef"]) || !nonempty(value.generatedBy.invocationId) || !safeId(value.generatedBy.invocationId) || !nonempty(value.generatedBy.sessionHost) || value.generatedBy.sessionHost.length > 128 || !nonempty(value.generatedBy.sessionRef)) return false;
  if (!Array.isArray(value.files)) return false;
  return value.files.every(file => isRecord(file)
    && exactKeys(file, ["path", "role", "sha256", "bytes"], ["artifactDigest", "observationId"])
    && typeof file.path === "string" && /^(?:index(?:\.(?:en|ko|zh-CN))?\.html|evidence\/[0-9a-f]{64}\.png)$/.test(file.path)
    && (file.role === "entrypoint" || file.role === "localized-view" || file.role === "screenshot-preview")
    && typeof file.sha256 === "string" && DIGEST.test(file.sha256)
    && nonnegativeInteger(file.bytes)
    && (file.artifactDigest === undefined || typeof file.artifactDigest === "string" && DIGEST.test(file.artifactDigest))
    && (file.observationId === undefined || nonempty(file.observationId)));
}
async function validBoardContents(boardPath: string, manifest: unknown): Promise<boolean> {
  if (!validBoardManifest(manifest) || !Array.isArray(manifest.files)) return false;
  const declared = manifest.files as readonly JsonRecord[];
  const declaredPaths = declared.map(file => String(file.path));
  if (new Set(declaredPaths).size !== declaredPaths.length || !declaredPaths.includes("index.html")) return false;
  const expectedDirs = new Set<string>();
  for (const path of declaredPaths) {
    const components = path.split("/");
    for (let index = 1; index < components.length; index += 1) expectedDirs.add(components.slice(0, index).join("/"));
  }
  const actualFiles = new Map<string, { bytes: number; sha256: string }>();
  const actualDirs = new Set<string>();
  let invalid = false;
  const visit = async (directory: string, relativePath = ""): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { invalid = true; return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { invalid = true; continue; }
      if (entry.isDirectory()) {
        actualDirs.add(child);
        await visit(path, child);
      } else if (entry.isFile()) {
        try {
          const bytes = await readFile(path);
          actualFiles.set(child, { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
        } catch { invalid = true; }
      } else {
        invalid = true;
      }
    }
  };
  await visit(boardPath);
  const metadataFiles = manifest.sessionKey === undefined ? ["manifest.json"] : ["manifest.json", "current.json"];
  if (invalid || metadataFiles.some(path => !actualFiles.has(path)) || actualFiles.size !== declaredPaths.length + metadataFiles.length || actualDirs.size !== expectedDirs.size) return false;
  for (const file of declared) {
    const path = String(file.path);
    const actual = actualFiles.get(path);
    if (!actual || actual.bytes !== file.bytes || actual.sha256 !== file.sha256) return false;
  }
  actualFiles.delete("manifest.json");
  return true;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function nowMs(value: string | number | Date | undefined): number {
  if (value === undefined) return Date.now();
  const parsed = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;
  if (Number.isFinite(parsed)) return parsed;
  throw new Error("invalid maintenance timestamp");
}

function normalizePolicy(policy: StorageMaintenanceOptions["policy"] = {}): StorageRetentionPolicy {
  const value = (key: keyof StorageRetentionPolicy, fallback: number): number => {
    const candidate = policy?.[key];
    return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : fallback;
  };
  const boardTtlMs = policy?.boardTtlDays !== undefined ? policy.boardTtlDays * DAY : value("boardTtlMs", DEFAULT_BOARD_TTL_MS);
  const canonicalRunTtlMs = policy?.canonicalRunTtlDays !== undefined ? policy.canonicalRunTtlDays * DAY : value("canonicalRunTtlMs", DEFAULT_RUN_TTL_MS);
  const graceMs = policy?.graceHours !== undefined ? policy.graceHours * 60 * 60 * 1000 : value("graceMs", DEFAULT_GRACE_MS);
  const result = {
    boardTtlMs: Math.max(0, Math.floor(Number.isFinite(boardTtlMs) ? boardTtlMs : DEFAULT_BOARD_TTL_MS)),
    boardMaxPerRun: Math.max(0, Math.floor(value("boardMaxPerRun", 10))),
    boardMaxPerSession: Math.max(0, Math.floor(value("boardMaxPerSession", 10))),
    boardQuotaBytes: Math.max(0, Math.floor(value("boardQuotaBytes", DEFAULT_BOARD_QUOTA_BYTES))),
    canonicalRunTtlMs: Math.max(0, Math.floor(Number.isFinite(canonicalRunTtlMs) ? canonicalRunTtlMs : DEFAULT_RUN_TTL_MS)),
    canonicalQuotaBytes: Math.max(0, Math.floor(value("canonicalQuotaBytes", DEFAULT_RUN_QUOTA_BYTES))),
    graceMs: Math.max(0, Math.floor(Number.isFinite(graceMs) ? graceMs : DEFAULT_GRACE_MS)),
  } satisfies StorageRetentionPolicy;
  return Object.freeze(result);
}

function stableSort<T extends { path?: string; relativePath?: string; mtimeMs?: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.relativePath ?? a.path ?? "").localeCompare(b.relativePath ?? b.path ?? "") || (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0));
}

async function rootStatus(path: string): Promise<"missing" | "directory" | "symlink" | "other"> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (errorCode(error) === ENOENT) return "missing";
    throw error;
  }
}

function assertAbsoluteRoot(path: string, label: string): string {
  if (typeof path !== "string" || path.length === 0) throw new Error(`${label} is required`);
  const absolute = resolve(path);
  if (!absolute.startsWith(sep)) throw new Error(`${label} must be absolute`);
  return absolute;
}
function isDescendantPath(parent: string, candidate: string): boolean {
  return candidate !== parent && (parent === sep ? candidate.startsWith(sep) : candidate.startsWith(`${parent}${sep}`));
}


async function safeStat(path: string): Promise<{ bytes: number; allocatedBytes: number; mtimeMs: number; isFile: boolean; isDirectory: boolean; isSymlink: boolean } | undefined> {
  try {
    const stat = await lstat(path);
    return { bytes: stat.isFile() ? stat.size : 0, allocatedBytes: stat.blocks > 0 ? stat.blocks * 512 : stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymlink: stat.isSymbolicLink() };
  } catch (error) {
    if (errorCode(error) === ENOENT) return undefined;
    throw error;
  }
}

async function walk(root: string, start = ""): Promise<{ files: StorageEntry[]; directories: StorageEntry[]; symlinks: string[] }> {
  const files: StorageEntry[] = [];
  const directories: StorageEntry[] = [];
  const symlinks: string[] = [];
  const absolute = start ? join(root, start) : root;
  let entries;
  try { entries = await readdir(absolute, { withFileTypes: true }); }
  catch (error) { if (errorCode(error) === ENOENT) return { files, directories, symlinks }; throw error; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!safeEntry(entry.name)) {
      if (entry.isSymbolicLink()) symlinks.push(start ? `${start}/${entry.name}` : entry.name);
      continue;
    }
    const childRelative = start ? `${start}/${entry.name}` : entry.name;
    const child = join(root, childRelative);
    const stat = await safeStat(child);
    if (!stat) continue;
    if (stat.isSymlink) { symlinks.push(childRelative); continue; }
    if (stat.isDirectory) {
      const directory: StorageEntry = { kind: "staging", path: child, relativePath: childRelative, bytes: 0, allocatedBytes: 0, mtimeMs: stat.mtimeMs };
      directories.push(directory);
      const nested = await walk(root, childRelative);
      files.push(...nested.files);
      directories.push(...nested.directories);
      symlinks.push(...nested.symlinks);
    } else if (stat.isFile) {
      files.push({ kind: "staging", path: child, relativePath: childRelative, bytes: stat.bytes, allocatedBytes: stat.allocatedBytes, mtimeMs: stat.mtimeMs });
    }
  }
  return { files, directories, symlinks };
}

async function directorySize(path: string, skipPrefixes: readonly string[] = []): Promise<{ bytes: number; allocatedBytes: number; mtimeMs: number; symlinks: string[] }> {
  const stat = await safeStat(path);
  if (!stat || !stat.isDirectory || stat.isSymlink) return { bytes: 0, allocatedBytes: 0, mtimeMs: stat?.mtimeMs ?? 0, symlinks: stat?.isSymlink ? [path] : [] };
  const nested = await walk(path);
  const all = [...nested.files, ...nested.directories].filter(item => !skipPrefixes.some(prefix => item.relativePath === prefix || item.relativePath.startsWith(`${prefix}/`)));
  return { bytes: all.reduce((sum, item) => sum + item.bytes, 0), allocatedBytes: all.reduce((sum, item) => sum + item.allocatedBytes, 0), mtimeMs: stat.mtimeMs, symlinks: nested.symlinks.filter(item => !skipPrefixes.some(prefix => item === prefix || item.startsWith(`${prefix}/`))) };
}

function collectDigests(value: unknown, output = new Set<string>(), keyHint = ""): ReadonlySet<string> {
  if (Array.isArray(value)) { for (const child of value) collectDigests(child, output, keyHint); return output; }
  if (!isRecord(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    const relevant = normalized === "digest" || normalized.endsWith("digest") || normalized === "artifacts" || normalized === "artifact";
    if (relevant && typeof child === "string" && DIGEST.test(child)) output.add(child);
    else if (relevant || typeof child === "object") collectDigests(child, output, key);
  }
  return output;
}

function parseRun(value: unknown, expectedRunId: string): { state?: string; updatedAt?: number; documents: unknown[]; malformed: boolean; digests: ReadonlySet<string> } {
  if (!isRecord(value) || value.schemaVersion !== "traceknot-state/v1" || !isRecord(value.documents) || !isRecord(value.dispatch)) return { documents: [], malformed: true, digests: new Set() };
  const documents = Object.values(value.documents);
  const digests = collectDigests(value);
  try {
    assertCanonicalRun(value.run, expectedRunId);
    return { state: value.run.state, updatedAt: asTimestamp(value.run.updatedAt), documents, malformed: false, digests };
  } catch {
    return { documents, malformed: true, digests };
  }
}

async function readJson(path: string): Promise<unknown | undefined> {
  const stat = await safeStat(path);
  if (!stat || !stat.isFile || stat.isSymlink) return undefined;
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch { return undefined; }
}

async function loadGcMarks(artifactDir: string, root?: SecureRootDescriptor): Promise<{ marks: GcMarks; malformed: boolean }> {
  let content: string;
  if (root) {
    try { content = Buffer.from(await readSecureRegularFile(root.fd, GC_MARKS_FILE, 4 * 1024 * 1024)).toString("utf8"); }
    catch (error) { if (error instanceof ArtifactNotFoundError || errorCode(error) === ENOENT) return { marks: {}, malformed: false }; return { marks: {}, malformed: true }; }
  } else {
    const path = join(artifactDir, GC_MARKS_FILE);
    const stat = await safeStat(path);
    if (!stat) return { marks: {}, malformed: false };
    if (!stat.isFile || stat.isSymlink) return { marks: {}, malformed: true };
    try { content = await readFile(path, "utf8"); } catch { return { marks: {}, malformed: true }; }
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== "traceknot-gc-marks/v1" || !isRecord(parsed.marks)) return { marks: {}, malformed: true };
    const marks: Record<string, number> = {};
    for (const [digest, markedAt] of Object.entries(parsed.marks)) {
      if (!DIGEST.test(digest) || typeof markedAt !== "number" || !Number.isFinite(markedAt) || markedAt < 0) return { marks: {}, malformed: true };
      marks[digest] = markedAt;
    }
    return { marks: Object.fromEntries(Object.entries(marks).sort(([a], [b]) => a.localeCompare(b))), malformed: false };
  } catch { return { marks: {}, malformed: true }; }
}

async function writeGcMarks(root: SecureRootDescriptor, marks: GcMarks): Promise<void> {
  assertSecureRoot(root);
  const temporary = `.traceknot-gc-marks-${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = secureOpenAt(root.fd, temporary, WRITE_FLAGS, 0o600);
    const ordered = Object.fromEntries(Object.entries(marks).sort(([a], [b]) => a.localeCompare(b)));
    const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: "traceknot-gc-marks/v1", marks: ordered })}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (written <= 0) throw new Error("GC mark write made no progress");
      offset += written;
    }
    secureFsync(descriptor);
    closeSecureDescriptor(descriptor);
    descriptor = undefined;
    secureRenameAt(root.fd, temporary, root.fd, GC_MARKS_FILE);
    secureFsync(root.fd);
    renamed = true;
  } finally {
    if (descriptor !== undefined) closeSecureDescriptor(descriptor);
    if (!renamed) { try { secureUnlinkAt(root.fd, temporary); } catch { /* absent */ } }
  }
}

async function loadPins(stateDir: string): Promise<{ pins: Set<string>; malformed: boolean }> {
  const path = join(stateDir, PINS_FILE);
  const stat = await safeStat(path);
  if (!stat) return { pins: new Set(), malformed: false };
  if (!stat.isFile || stat.isSymlink) return { pins: new Set(), malformed: true };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string" || !safeId(item))) return { pins: new Set(), malformed: true };
    return { pins: new Set(parsed), malformed: false };
  } catch { return { pins: new Set(), malformed: true }; }
}

async function inspectRuns(stateDir: string, pins: ReadonlySet<string>, pinsMalformed: boolean, now: number): Promise<{ runs: RunInfo[]; boards: BoardInfo[]; staging: StorageEntry[]; symlinks: string[]; references: Record<string, readonly string[]> }> {
  const runsRoot = join(stateDir, "runs");
  const root = await rootStatus(runsRoot);
  if (root === "missing") return { runs: [], boards: [], staging: [], symlinks: [], references: {} };
  if (root !== "directory") throw new Error(`runs directory is not a non-symlink directory: ${runsRoot}`);
  const symlinks: string[] = [];
  const runs: RunInfo[] = [];
  const boards: BoardInfo[] = [];
  const staging: StorageEntry[] = [];
  const references: Record<string, readonly string[]> = {};
  const entries = await readdir(runsRoot, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const runId = entry.name;
    const runPath = join(runsRoot, runId);
    if (!safeId(runId)) { if (entry.isSymbolicLink()) symlinks.push(`runs/${runId}`); continue; }
    const stat = await safeStat(runPath);
    if (!stat) continue;
    if (stat.isSymlink) { symlinks.push(`runs/${runId}`); continue; }
    if (!stat.isDirectory) continue;
    const stateStat = await safeStat(join(runPath, RUN_STATE));
    const stateValue = stateStat?.isSymlink ? undefined : await readJson(join(runPath, RUN_STATE));
    const parsed = parseRun(stateValue, runId);
    const size = await directorySize(runPath, ["boards"]);
    symlinks.push(...size.symlinks.map(item => `runs/${runId}/${item}`));
    const boardsPath = join(runPath, "boards");
    const boardsRoot = await rootStatus(boardsPath);
    let boardEntries: Dirent[] = [];
    if (boardsRoot === "directory") boardEntries = await readdir(boardsPath, { withFileTypes: true });
    else if (boardsRoot === "symlink") symlinks.push(`runs/${runId}/boards`);
    for (const boardEntry of boardEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      const boardId = boardEntry.name;
      const boardPath = join(boardsPath, boardId);
      if (!SAFE_BOARD_ENTRY.test(boardId)) {
        if (boardEntry.isSymbolicLink()) { symlinks.push(`runs/${runId}/boards/${boardId}`); continue; }
        if (!boardId.startsWith(".pending-") && !boardId.startsWith(".staging-")) continue;
        const pendingStat = await safeStat(boardPath);
        if (!pendingStat) continue;
        if (pendingStat.isSymlink) { symlinks.push(`runs/${runId}/boards/${boardId}`); continue; }
        if (pendingStat.isDirectory) {
          const pendingSize = await directorySize(boardPath);
          staging.push({ kind: "staging", path: boardPath, relativePath: `runs/${runId}/boards/${boardId}`, bytes: pendingSize.bytes, allocatedBytes: pendingSize.allocatedBytes, mtimeMs: Math.max(pendingStat.mtimeMs, pendingSize.mtimeMs) });
          symlinks.push(...pendingSize.symlinks.map(item => `runs/${runId}/boards/${boardId}/${item}`));
        }
        continue;
      }
      const boardStat = await safeStat(boardPath);
      if (!boardStat) continue;
      if (boardStat.isSymlink) { symlinks.push(`runs/${runId}/boards/${boardId}`); continue; }
      const boardSize = await directorySize(boardPath);
      const manifest = await readJson(join(boardPath, "manifest.json"));
      const generatedAt = isRecord(manifest) ? asTimestamp(manifest.generatedAt) : undefined;
      const sourceUpdatedAt = isRecord(manifest) ? asTimestamp(manifest.sourceUpdatedAt) : undefined;
      const malformed = !(await validBoardContents(boardPath, manifest));
      boards.push({ runId, boardId, path: boardPath, relativePath: `runs/${runId}/boards/${boardId}`, bytes: boardSize.bytes, allocatedBytes: boardSize.allocatedBytes, mtimeMs: Math.max(boardStat.mtimeMs, boardSize.mtimeMs), generatedAt, sourceUpdatedAt, sourceState: isRecord(manifest) && typeof manifest.sourceState === "string" ? manifest.sourceState : undefined, malformed, future: generatedAt !== undefined && generatedAt > now });
      symlinks.push(...boardSize.symlinks.map(item => `runs/${runId}/boards/${boardId}/${item}`));
    }
    if (stateStat !== undefined) {
      references[runId] = [...parsed.digests].sort();
      runs.push({ runId, path: runPath, relativePath: `runs/${runId}`, bytes: size.bytes, allocatedBytes: size.allocatedBytes, mtimeMs: Math.max(stat.mtimeMs, size.mtimeMs), updatedAt: parsed.updatedAt, state: parsed.state, terminal: parsed.state === "TERMINAL", malformed: parsed.malformed, future: parsed.updatedAt !== undefined && parsed.updatedAt > now, pinned: pins.has(runId) || pinsMalformed, documents: parsed.documents, digests: parsed.digests });
    } else if (size.bytes > 0 || size.allocatedBytes > 0) {
      staging.push({ kind: "staging", path: runPath, relativePath: `runs/${runId}`, bytes: size.bytes, allocatedBytes: size.allocatedBytes, mtimeMs: Math.max(stat.mtimeMs, size.mtimeMs), runId, malformed: true });
    }
  }
  return { runs, boards, staging, symlinks, references };
}
async function inspectSessionBoards(stateDir: string, now: number): Promise<{ boards: BoardInfo[]; symlinks: string[] }> {
  const sessionsRoot = join(stateDir, "sessions");
  const root = await rootStatus(sessionsRoot);
  if (root === "missing") return { boards: [], symlinks: [] };
  if (root !== "directory") throw new Error(`sessions directory is not a non-symlink directory: ${sessionsRoot}`);
  const boards: BoardInfo[] = [];
  const symlinks: string[] = [];
  const sessions = await readdir(sessionsRoot, { withFileTypes: true });
  for (const session of sessions.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^s-[0-9a-f]{64}$/.test(session.name)) {
      if (session.isSymbolicLink()) symlinks.push(`sessions/${session.name}`);
      continue;
    }
    const sessionRoot = join(sessionsRoot, session.name);
    if (session.isSymbolicLink()) {
      symlinks.push(`sessions/${session.name}`);
      continue;
    }
    if (!session.isDirectory()) continue;
    const currentSelector = join(sessionRoot, "current");
    const currentStat = await safeStat(currentSelector);
    let currentPath: string | undefined;
    let currentMalformed = false;
    if (currentStat?.isSymlink) {
      const target = await readlink(currentSelector).catch(() => undefined);
      if (target !== undefined && /^boards\/(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(target) && await rootStatus(join(sessionRoot, target)) === "directory") {
        currentPath = target;
      } else {
        currentMalformed = true;
        symlinks.push(`sessions/${session.name}/current`);
      }
    } else if (currentStat !== undefined) {
      currentMalformed = true;
      symlinks.push(`sessions/${session.name}/current`);
    }
    const boardsRoot = join(sessionRoot, "boards");
    const boardsStatus = await rootStatus(boardsRoot);
    if (boardsStatus === "symlink") {
      symlinks.push(`sessions/${session.name}/boards`);
      continue;
    }
    if (boardsStatus !== "directory") continue;
    const entries = await readdir(boardsRoot, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = `sessions/${session.name}/boards/${entry.name}`;
      const boardPath = join(boardsRoot, entry.name);
      if (!SAFE_BOARD_ENTRY.test(entry.name)) {
        if (entry.isSymbolicLink()) symlinks.push(relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        symlinks.push(relativePath);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const boardSize = await directorySize(boardPath);
      const manifest = await readJson(join(boardPath, "manifest.json"));
      const generatedAt = isRecord(manifest) ? asTimestamp(manifest.generatedAt) : undefined;
      const sourceUpdatedAt = isRecord(manifest) ? asTimestamp(manifest.sourceUpdatedAt) : undefined;
      const sourceState = isRecord(manifest) && typeof manifest.sourceState === "string" ? manifest.sourceState : undefined;
      const valid = await validBoardContents(boardPath, manifest);
      const malformed = currentMalformed || !valid || !isRecord(manifest) || manifest.sessionKey !== session.name;
      const runId = valid && isRecord(manifest) && typeof manifest.runId === "string" && safeId(manifest.runId) ? manifest.runId : undefined;
      const sourceRevision = valid && isRecord(manifest) && typeof manifest.sourceRevision === "number" && nonnegativeInteger(manifest.sourceRevision) ? manifest.sourceRevision : undefined;
      boards.push({ sessionKey: session.name, current: currentPath === `boards/${entry.name}`, boardId: entry.name, path: boardPath, relativePath, bytes: boardSize.bytes, allocatedBytes: boardSize.allocatedBytes, mtimeMs: Math.max((await safeStat(boardPath))?.mtimeMs ?? 0, boardSize.mtimeMs), generatedAt, sourceUpdatedAt, sourceRevision, sourceState, runId, malformed, future: generatedAt !== undefined && generatedAt > now });
      symlinks.push(...boardSize.symlinks.map(item => `${relativePath}/${item}`));
    }
  }
  return { boards, symlinks };
}

async function inspectObjects(artifactDir: string, now: number): Promise<{ objects: StorageEntry[]; collector: StorageEntry[]; staging: StorageEntry[]; symlinks: string[] }> {
  const objectsPath = join(artifactDir, ".objects");
  const objects: StorageEntry[] = [];
  const collector: StorageEntry[] = [];
  const staging: StorageEntry[] = [];
  const symlinks: string[] = [];
  const objectsRoot = await rootStatus(objectsPath);
  if (objectsRoot === "directory") {
    const entries = await readdir(objectsPath, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(objectsPath, entry.name);
      const stat = await safeStat(path);
      if (!stat) continue;
      const rel = `.objects/${entry.name}`;
      if (stat.isFile) {
        if (ARTIFACT_WRITE_TEMP.test(entry.name)) {
          staging.push({ kind: "staging", path, relativePath: rel, bytes: stat.bytes, allocatedBytes: stat.allocatedBytes, mtimeMs: stat.mtimeMs, logicalUpdatedAt: stat.mtimeMs, future: stat.mtimeMs > now });
          continue;
        }
        const malformed = !DIGEST.test(entry.name);
        objects.push({ kind: "object", path, relativePath: rel, digest: DIGEST.test(entry.name) ? entry.name : undefined, bytes: stat.bytes, allocatedBytes: stat.allocatedBytes, mtimeMs: stat.mtimeMs, logicalUpdatedAt: stat.mtimeMs, malformed, future: stat.mtimeMs > now });
      } else if (stat.isDirectory) {
        const nested = await walk(artifactDir, `.objects/${entry.name}`);
        symlinks.push(...nested.symlinks);
        for (const file of nested.files) staging.push({ ...file, kind: "staging" });
      }
    }
  } else if (objectsRoot === "symlink") symlinks.push(".objects");
  for (const name of [".collector", "collector", ".staging", "staging"]) {
    const path = join(artifactDir, name);
    const status = await rootStatus(path);
    if (status === "symlink") { symlinks.push(name); continue; }
    if (status !== "directory") continue;
    const walked = await walk(artifactDir, name);
    symlinks.push(...walked.symlinks);
    for (const item of [...walked.files, ...walked.directories]) {
      const kind: EntryKind = name.toLowerCase().includes("collector") ? "collector" : "staging";
      (kind === "collector" ? collector : staging).push({ ...item, kind });
    }
  }
  const rootEntries = await readdir(artifactDir, { withFileTypes: true }).catch(error => errorCode(error) === ENOENT ? [] : Promise.reject(error));
  for (const entry of rootEntries) {
    if (!entry.name.startsWith(".tmp-") && !entry.name.startsWith(".collector-") && !entry.name.startsWith(".staging-")) continue;
    const path = join(artifactDir, entry.name);
    const stat = await safeStat(path);
    if (!stat) continue;
    if (stat.isSymlink) { symlinks.push(entry.name); continue; }
    const walked = stat.isDirectory ? await walk(artifactDir, entry.name) : { files: stat.isFile ? [{ kind: "staging" as const, path, relativePath: entry.name, bytes: stat.bytes, allocatedBytes: stat.allocatedBytes, mtimeMs: stat.mtimeMs }] : [], directories: [], symlinks: [] };
    symlinks.push(...walked.symlinks);
    const target = entry.name.includes("collector") ? collector : staging;
    if (stat.isDirectory) target.push({ kind: entry.name.includes("collector") ? "collector" : "staging", path, relativePath: entry.name, bytes: stat.bytes, allocatedBytes: stat.allocatedBytes, mtimeMs: stat.mtimeMs });
    target.push(...walked.files, ...walked.directories);
  }
  return { objects: stableSort(objects), collector: stableSort(collector), staging: stableSort(staging), symlinks: [...new Set(symlinks)].sort() };
}
function toEntry(run: RunInfo): StorageEntry {
  return { kind: "run", path: run.path, relativePath: run.relativePath, bytes: run.bytes, allocatedBytes: run.allocatedBytes, mtimeMs: run.mtimeMs, logicalUpdatedAt: run.updatedAt, runId: run.runId, malformed: run.malformed, terminal: run.terminal, protectedReason: run.pinned ? "pinned" : run.terminal ? undefined : "active" };
}
function boardEntry(board: BoardInfo): StorageEntry {
  return { kind: "board", path: board.path, relativePath: board.relativePath, bytes: board.bytes, allocatedBytes: board.allocatedBytes, mtimeMs: board.mtimeMs, logicalUpdatedAt: board.generatedAt, runId: board.runId, sessionKey: board.sessionKey, sourceRevision: board.sourceRevision, boardId: board.boardId, sourceState: board.sourceState, malformed: board.malformed, protectedReason: board.current ? "current" : board.malformed ? "malformed" : undefined };
}

export async function inspectStorage(input: StorageMaintenanceOptions): Promise<StorageInventory> {
  let stateDir = assertAbsoluteRoot(input.stateDir, "state directory");
  let artifactDir = assertAbsoluteRoot(input.artifactDir, "artifact directory");
  if (stateDir === artifactDir) throw new Error("state and artifact directories must be distinct");
  if (isDescendantPath(artifactDir, stateDir)) throw new Error("state directory must not be nested beneath artifact directory");
  const runsRoot = join(stateDir, "runs");
  if (artifactDir === runsRoot || isDescendantPath(runsRoot, artifactDir)) throw new Error("artifact directory must not be nested beneath state runs directory");
  const state = await rootStatus(stateDir);
  const artifact = await rootStatus(artifactDir);
  if (state === "symlink" || state === "other") throw new Error("state directory must not be a symlink and must be a directory");
  if (artifact === "symlink" || artifact === "other") throw new Error("artifact directory must not be a symlink and must be a directory");
  if (state === "directory" && artifact === "directory") {
    stateDir = await realpath(stateDir);
    artifactDir = await realpath(artifactDir);
    if (stateDir === artifactDir) throw new Error("state and artifact directories must be distinct");
    if (isDescendantPath(artifactDir, stateDir)) throw new Error("state directory must not be nested beneath artifact directory");
    const canonicalRunsRoot = join(stateDir, "runs");
    if (artifactDir === canonicalRunsRoot || isDescendantPath(canonicalRunsRoot, artifactDir)) throw new Error("artifact directory must not be nested beneath state runs directory");
  }
  const now = nowMs(input.now);
  const pins = state === "directory" ? await loadPins(stateDir) : { pins: new Set<string>(), malformed: false };
  const runData = state === "directory" ? await inspectRuns(stateDir, pins.pins, pins.malformed, now) : { runs: [], boards: [], staging: [], symlinks: [], references: {} };
  const sessionData = state === "directory" ? await inspectSessionBoards(stateDir, now) : { boards: [], symlinks: [] };
  const objectData = artifact === "directory" ? await inspectObjects(artifactDir, now) : { objects: [], collector: [], staging: [], symlinks: [] };
  const symlinks = [...new Set([...runData.symlinks, ...sessionData.symlinks, ...objectData.symlinks])].sort();
  const runs = stableSort(runData.runs.map(toEntry));
  const boards = stableSort([...runData.boards, ...sessionData.boards].map(boardEntry));
  const objects = stableSort(objectData.objects);
  const collector = stableSort(objectData.collector);
  const staging = stableSort([...runData.staging, ...objectData.staging]);
  const allTimes = [...runs, ...boards, ...objects, ...collector, ...staging].map(item => item.logicalUpdatedAt ?? item.mtimeMs).filter(Number.isFinite);
  const logicalBytes = [...runs, ...boards, ...objects, ...collector, ...staging].reduce((sum, item) => sum + item.bytes, 0);
  const allocatedBytes = [...runs, ...boards, ...objects, ...collector, ...staging].reduce((sum, item) => sum + item.allocatedBytes, 0);
  const generatedAt = iso(now);
  const result: StorageInventory = {
    schemaVersion: "traceknot-storage-inventory/v1",
    generatedAt,
    directories: { stateDir, artifactDir },
    logicalBytes,
    allocatedBytes,
    ...(allTimes.length ? { oldest: iso(Math.min(...allTimes)), newest: iso(Math.max(...allTimes)) } : {}),
    counts: {
      runs: runData.runs.length,
      terminalRuns: runData.runs.filter(item => item.terminal).length,
      activeRuns: runData.runs.filter(item => !item.terminal).length,
      pinnedRuns: runData.runs.filter(item => item.pinned).length,
      malformedRuns: runData.runs.filter(item => item.malformed).length,
      futureRuns: runData.runs.filter(item => item.future).length,
      boards: boards.length,
      malformedBoards: boards.filter(item => item.malformed).length,
      futureBoards: boards.filter(item => item.logicalUpdatedAt !== undefined && item.logicalUpdatedAt > now).length,
      canonicalObjects: objects.filter(item => !item.malformed).length,
      malformedObjects: objects.filter(item => item.malformed).length,
      collector: collector.length,
      staging: staging.length,
      symlinks: symlinks.length,
      pinFileMalformed: pins.malformed,
    },
    runs,
    boards,
    objects,
    collector,
    staging,
    symlinks,
    runReferences: Object.fromEntries(Object.entries(runData.references).sort(([a], [b]) => a.localeCompare(b))),
  };
  return result;
}

function compareBoardEntries(a: StorageEntry, b: StorageEntry): number {
  const revisionOrder = (a.sourceRevision ?? -1) - (b.sourceRevision ?? -1);
  if (revisionOrder !== 0) return revisionOrder;
  const generatedOrder = (a.logicalUpdatedAt ?? a.mtimeMs) - (b.logicalUpdatedAt ?? b.mtimeMs);
  if (generatedOrder !== 0) return generatedOrder;
  return (a.boardId ?? a.relativePath).localeCompare(b.boardId ?? b.relativePath);
}

function compareSessionBoardEntries(a: StorageEntry, b: StorageEntry): number {
  const sameRun = a.runId !== undefined && a.runId === b.runId;
  const revisionOrder = (a.sourceRevision ?? -1) - (b.sourceRevision ?? -1);
  const generatedOrder = (a.logicalUpdatedAt ?? a.mtimeMs) - (b.logicalUpdatedAt ?? b.mtimeMs);
  if (sameRun && revisionOrder !== 0) return revisionOrder;
  if (generatedOrder !== 0) return generatedOrder;
  if (revisionOrder !== 0) return revisionOrder;
  return (a.boardId ?? a.relativePath).localeCompare(b.boardId ?? b.relativePath);
}

function compareNewestSessionTerminalEntries(a: StorageEntry, b: StorageEntry): number {
  const sameRun = a.runId !== undefined && a.runId === b.runId;
  const revisionOrder = (b.sourceRevision ?? -1) - (a.sourceRevision ?? -1);
  const generatedOrder = (b.logicalUpdatedAt ?? b.mtimeMs) - (a.logicalUpdatedAt ?? a.mtimeMs);
  if (sameRun && revisionOrder !== 0) return revisionOrder;
  if (generatedOrder !== 0) return generatedOrder;
  if (revisionOrder !== 0) return revisionOrder;
  return (a.boardId ?? a.relativePath).localeCompare(b.boardId ?? b.relativePath);
}


function compareBoardQuotaEntries(a: StorageEntry, b: StorageEntry): number {
  const updatedOrder = (a.logicalUpdatedAt ?? a.mtimeMs) - (b.logicalUpdatedAt ?? b.mtimeMs);
  if (updatedOrder !== 0) return updatedOrder;
  const revisionOrder = (a.sourceRevision ?? -1) - (b.sourceRevision ?? -1);
  if (revisionOrder !== 0) return revisionOrder;
  return (a.boardId ?? a.relativePath).localeCompare(b.boardId ?? b.relativePath);
}


function candidatePlan(inventory: StorageInventory, policy: StorageRetentionPolicy, now: number, gcMarks: GcMarks = {}, gcMarksMalformed = false, protectedRunIds: ReadonlySet<string> = new Set(), pinState: { pins: ReadonlySet<string>; malformed: boolean } = { pins: new Set(), malformed: false }): { candidates: StorageMaintenanceReport["candidates"]; protected: StorageMaintenanceReport["protected"] } {
  const boardEntries = inventory.boards;
  const runInfo = inventory.runs;
  const newestTerminal = [...runInfo].filter(entry => entry.terminal === true && !entry.malformed && entry.logicalUpdatedAt !== undefined).sort((a, b) => (b.logicalUpdatedAt! - a.logicalUpdatedAt!) || a.relativePath.localeCompare(b.relativePath))[0];
  const newestTerminalId = newestTerminal?.runId;
  const active = runInfo.filter(entry => entry.protectedReason === "active").map(entry => entry.relativePath);
  const pinned = runInfo.filter(entry => entry.protectedReason === "pinned").map(entry => entry.relativePath);
  const malformed = [...runInfo.filter(entry => entry.malformed), ...boardEntries.filter(entry => entry.malformed), ...inventory.objects.filter(entry => entry.malformed)].map(entry => entry.relativePath);
  const future = [...runInfo, ...boardEntries, ...inventory.objects].filter(entry => entry.logicalUpdatedAt !== undefined && entry.logicalUpdatedAt > now).map(entry => entry.relativePath);
  const boardsByScope = new Map<string, StorageEntry[]>();
  for (const board of boardEntries) {
    const scope = board.sessionKey === undefined ? `run:${board.runId ?? "unknown"}` : `session:${board.sessionKey}`;
    const list = boardsByScope.get(scope) ?? [];
    list.push(board);
    boardsByScope.set(scope, list);
  }
  const currentBoards = boardEntries.filter(board => board.protectedReason === "current").map(board => board.relativePath);
  const protectedBoards = new Set(currentBoards);
  const boardCandidates: StorageEntry[] = [];
  for (const [scope, list] of boardsByScope) {
    const ordered = [...list].sort(scope.startsWith("session:") ? compareSessionBoardEntries : compareBoardEntries);
    const maxPerScope = scope.startsWith("session:") ? policy.boardMaxPerSession ?? policy.boardMaxPerRun : policy.boardMaxPerRun;
    const newestTerminalBoard = [...list].filter(board => board.sourceState === "TERMINAL" && !board.malformed).sort(compareNewestSessionTerminalEntries)[0]?.relativePath;
    const keepForCount = new Set(maxPerScope === 0 ? [] : ordered.slice(-maxPerScope).map(item => item.relativePath));
    for (const board of ordered) {
      if (board.protectedReason === "current"
        || (board.sessionKey !== undefined && board.relativePath === newestTerminalBoard)
        || (board.sessionKey !== undefined && board.runId !== undefined && (pinState.malformed || pinState.pins.has(board.runId)))) {
        protectedBoards.add(board.relativePath);
      }
    }
    for (const board of ordered) {
      if (board.malformed || protectedBoards.has(board.relativePath) || (board.logicalUpdatedAt !== undefined && board.logicalUpdatedAt > now)) continue;
      const age = now - (board.logicalUpdatedAt ?? board.mtimeMs);
      if (age >= policy.boardTtlMs || !keepForCount.has(board.relativePath)) boardCandidates.push(board);
    }
  }
  let boardBytes = boardEntries.reduce((sum, item) => sum + item.bytes, 0);
  for (const board of boardCandidates) boardBytes -= board.bytes;
  if (boardBytes > policy.boardQuotaBytes) {
    for (const board of [...boardEntries].sort(compareBoardQuotaEntries)) {
      if (boardCandidates.some(item => item.relativePath === board.relativePath) || board.malformed || protectedBoards.has(board.relativePath) || board.logicalUpdatedAt === undefined || board.logicalUpdatedAt > now) continue;
      boardCandidates.push(board);
      boardBytes -= board.bytes;
      if (boardBytes <= policy.boardQuotaBytes) break;
    }
  }
  const runCandidates: StorageEntry[] = [];
  const sharedDigests = new Set(Object.values(inventory.runReferences).flatMap(digests => digests));
  const objectBytesByDigest = new Map(inventory.objects.filter(object => object.digest !== undefined && !object.malformed).map(object => [object.digest!, object.bytes] as const));
  const digestReferenceCounts = new Map<string, number>();
  for (const digests of Object.values(inventory.runReferences)) {
    for (const digest of digests) digestReferenceCounts.set(digest, (digestReferenceCounts.get(digest) ?? 0) + 1);
  }
  let remainingCanonicalBytes = runInfo.reduce((sum, item) => sum + item.bytes, 0)
    + [...digestReferenceCounts].reduce((sum, [digest, count]) => sum + (count > 0 ? objectBytesByDigest.get(digest) ?? 0 : 0), 0);
  const releaseRun = (run: StorageEntry): void => {
    remainingCanonicalBytes -= run.bytes;
    for (const digest of inventory.runReferences[run.runId!] ?? []) {
      const count = (digestReferenceCounts.get(digest) ?? 0) - 1;
      if (count <= 0) {
        digestReferenceCounts.delete(digest);
        remainingCanonicalBytes -= objectBytesByDigest.get(digest) ?? 0;
      } else digestReferenceCounts.set(digest, count);
    }
  };
  const runOrder = [...runInfo].sort((a, b) => (a.logicalUpdatedAt ?? a.mtimeMs) - (b.logicalUpdatedAt ?? b.mtimeMs) || a.relativePath.localeCompare(b.relativePath));
  for (const run of runOrder) {
    if (run.malformed || run.protectedReason || protectedRunIds.has(run.runId!) || run.runId === newestTerminalId || run.logicalUpdatedAt === undefined || run.logicalUpdatedAt > now) continue;
    if (now - run.logicalUpdatedAt >= policy.canonicalRunTtlMs) { runCandidates.push(run); releaseRun(run); }
  }
  if (remainingCanonicalBytes > policy.canonicalQuotaBytes) {
    for (const run of runOrder) {
      if (runCandidates.some(item => item.relativePath === run.relativePath) || run.malformed || run.protectedReason || protectedRunIds.has(run.runId!) || run.runId === newestTerminalId || run.logicalUpdatedAt === undefined || run.logicalUpdatedAt > now) continue;
      runCandidates.push(run);
      releaseRun(run);
      if (remainingCanonicalBytes <= policy.canonicalQuotaBytes) break;
    }
  }
  const matureMarks = new Map(Object.entries(gcMarks).filter(([digest, markedAt]) => DIGEST.test(digest) && Number.isFinite(markedAt) && markedAt <= now - policy.graceMs));
  const objectCandidates = gcMarksMalformed || inventory.counts.malformedRuns > 0 ? [] : inventory.objects.filter(object => {
    if (object.malformed || object.digest === undefined || sharedDigests.has(object.digest)) return false;
    const markedAt = matureMarks.get(object.digest);
    return markedAt !== undefined && object.mtimeMs <= markedAt;
  });
  const grace = inventory.objects.filter(object => object.digest !== undefined && Number.isFinite(gcMarks[object.digest]) && gcMarks[object.digest]! > now - policy.graceMs).map(object => object.relativePath);
  const ephemeral = (entries: readonly StorageEntry[]): string[] => {
    const groups = new Map<string, { newest: number; malformed: boolean }>();
    for (const entry of entries) {
      const components = entry.relativePath.split("/");
      const pendingIndex = components.findIndex(component => component.startsWith(".pending-") || component.startsWith(".staging-"));
      const candidate = components[0]?.startsWith(".collector-") || components[0]?.startsWith(".staging-") || components[0]?.startsWith(".tmp-")
        ? components[0]!
        : pendingIndex >= 0
          ? components.slice(0, pendingIndex + 1).join("/")
          : components.length > 1 ? components.slice(0, 2).join("/") : components[0]!;
      const previous = groups.get(candidate);
      groups.set(candidate, { newest: Math.max(previous?.newest ?? 0, entry.mtimeMs), malformed: (previous?.malformed ?? false) || entry.malformed === true });
    }
    return [...groups].filter(([, group]) => !group.malformed && group.newest <= now - policy.graceMs).map(([candidate]) => candidate).sort();
  };
  const collectorCandidates = ephemeral(inventory.collector);
  const stagingCandidates = ephemeral(inventory.staging);
  return {
    candidates: { boards: [...new Set(boardCandidates.map(item => item.relativePath))].sort(), runs: [...new Set(runCandidates.map(item => `${item.relativePath}/${RUN_STATE}`))].sort(), objects: objectCandidates.map(item => item.relativePath).sort(), collector: collectorCandidates, staging: stagingCandidates },
    protected: { newestTerminalRuns: newestTerminalId ? [`runs/${newestTerminalId}`] : [], activeRuns: active.sort(), pinnedRuns: pinned.sort(), currentBoards: currentBoards.sort(), malformed: malformed.sort(), future: future.sort(), grace: grace.sort(), sharedObjects: [...sharedDigests].sort(), symlinks: inventory.symlinks, requestedRuns: runInfo.filter(run => run.runId !== undefined && protectedRunIds.has(run.runId)).map(run => run.relativePath).sort() },
  };
}
function entryDepth(relativePath: string): number {
  return relativePath.split("/").length;
}

function removeKnownEntry(root: SecureRootDescriptor, relativePath: string, directory: boolean): void {
  const components = relativePath.split("/");
  if (!safeStoragePath(relativePath)) throw new Error("storage entry contains unsafe characters");
  const name = components.pop();
  if (!name) throw new Error("storage entry is empty");
  const parentFd = openSecureDirectory(root.fd, components.join("/"));
  try {
    if (directory) secureRmdirAt(parentFd, name);
    else secureUnlinkAt(parentFd, name);
  } finally {
    closeSecureDescriptor(parentFd);
  }
}

async function removeSnapshottedTree(root: SecureRootDescriptor, relativePath: string): Promise<boolean> {
  const snapshot = await walk(root.rootDir, relativePath);
  if (snapshot.symlinks.length > 0) return false;
  let complete = true;
  for (const file of [...snapshot.files].sort((a, b) => entryDepth(b.relativePath) - entryDepth(a.relativePath) || a.relativePath.localeCompare(b.relativePath))) {
    try { removeKnownEntry(root, file.relativePath, false); } catch { complete = false; }
  }
  for (const directory of [...snapshot.directories].sort((a, b) => entryDepth(b.relativePath) - entryDepth(a.relativePath) || a.relativePath.localeCompare(b.relativePath))) {
    try { removeKnownEntry(root, directory.relativePath, true); } catch { complete = false; }
  }
  if (!complete) return false;
  try { removeKnownEntry(root, relativePath, true); return true; } catch { return false; }
}
async function removeLeasedEphemeralRoot(root: SecureRootDescriptor, relativePath: string): Promise<boolean> {
  let directoryFd: number | undefined;
  let leaseFd: number | undefined;
  try {
    directoryFd = openSecureDirectory(root.fd, relativePath);
    leaseFd = secureOpenAt(directoryFd, EPHEMERAL_LEASE_FILE, constants.O_RDWR | constants.O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600);
    secureFlock(leaseFd, LOCK_EX | LOCK_NB);
    return await removeSnapshottedTree(root, relativePath);
  } catch {
    return false;
  } finally {
    if (leaseFd !== undefined) {
      try { secureFlock(leaseFd, LOCK_UN); } catch { /* Lock acquisition may have failed */ }
      closeSecureDescriptor(leaseFd);
    }
    if (directoryFd !== undefined) closeSecureDescriptor(directoryFd);
  }
}


async function removeRelative(root: SecureRootDescriptor, relativePath: string): Promise<boolean> {
  const components = relativePath.split("/");
  if (!safeStoragePath(relativePath)) return false;
  const name = components.pop();
  if (!name) return false;
  const parentFd = openSecureDirectory(root.fd, components.join("/"));
  try {
    const stat = await safeStat(join(root.rootDir, relativePath));
    if (!stat || stat.isSymlink) return false;
    if (stat.isFile) { secureUnlinkAt(parentFd, name); return true; }
    if (!stat.isDirectory) return false;
    return removeSnapshottedTree(root, relativePath);
  } finally { closeSecureDescriptor(parentFd); }
}
async function removeEmptyBoardParents(root: SecureRootDescriptor, relativePath: string): Promise<void> {
  const components = relativePath.split("/");
  if (components.length !== 4 || components[0] !== "runs" || components[2] !== "boards" || !safeStoragePath(relativePath)) return;
  const runRelativePath = components.slice(0, 2).join("/");
  let runsFd: number | undefined;
  let runFd: number | undefined;
  try {
    runsFd = openSecureDirectory(root.fd, "runs");
    runFd = openSecureDirectory(runsFd, components[1]!);
    const boardsPath = join(root.rootDir, runRelativePath, "boards");
    if ((await readdir(boardsPath)).length === 0) secureRmdirAt(runFd, "boards");
    if ((await readdir(join(root.rootDir, runRelativePath))).length === 0) secureRmdirAt(runsFd, components[1]!);
  } catch {
    // A retained Board or concurrent writer keeps the parent container.
  } finally {
    if (runFd !== undefined) closeSecureDescriptor(runFd);
    if (runsFd !== undefined) closeSecureDescriptor(runsFd);
  }
}

async function removeCanonicalRun(root: SecureRootDescriptor, statePath: string): Promise<boolean> {
  const components = statePath.split("/");
  if (components.length < 3 || components.at(-1) !== RUN_STATE || components.some(component => !safeEntry(component))) return false;
  const runName = components.at(-2)!;
  const runRelativePath = components.slice(0, -1).join("/");
  const parentFd = openSecureDirectory(root.fd, components.slice(0, -2).join("/"));
  let complete = false;
  try {
    const runFd = openSecureDirectory(parentFd, runName);
    let runLockFd: number | undefined;
    try {
      try {
        runLockFd = secureOpenAt(runFd, ".state.lock", constants.O_RDWR | constants.O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600);
        secureFlock(runLockFd, LOCK_EX | LOCK_NB);
      } catch {
        if (runLockFd !== undefined) closeSecureDescriptor(runLockFd);
        runLockFd = undefined;
        return false;
      }
      const entries = await readdir(join(root.rootDir, runRelativePath), { withFileTypes: true });
      for (const entry of entries) {
        if (ATOMIC_WRITE_TEMP.test(entry.name)) {
          if (!entry.isFile() || entry.isSymbolicLink()) return false;
          try { secureUnlinkAt(runFd, entry.name); } catch { return false; }
          continue;
        }
        const knownFile = (entry.name === "metadata.json" || entry.name === RUN_STATE || entry.name === ".state.lock") && entry.isFile() && !entry.isSymbolicLink();
        const boardsDirectory = entry.name === "boards" && entry.isDirectory() && !entry.isSymbolicLink();
        if (!knownFile && !boardsDirectory) return false;
        if (boardsDirectory) {
          const boardEntries = await readdir(join(root.rootDir, runRelativePath, "boards"));
          if (boardEntries.length === 0) secureRmdirAt(runFd, "boards");
        }
      }
      for (const file of ["metadata.json", RUN_STATE]) {
        const stat = await safeStat(join(root.rootDir, runRelativePath, file));
        if (!stat) {
          if (file === RUN_STATE) return false;
          continue;
        }
        if (!stat.isFile || stat.isSymlink) return false;
        secureUnlinkAt(runFd, file);
      }
      secureFsync(runFd);
      const remaining = await readdir(join(root.rootDir, runRelativePath), { withFileTypes: true });
      complete = remaining.every(entry =>
        (entry.name === ".state.lock" && entry.isFile() && !entry.isSymbolicLink())
        || (entry.name === "boards" && entry.isDirectory() && !entry.isSymbolicLink()));
    } catch {
      return false;
    } finally {
      if (runLockFd !== undefined) {
        try { secureFlock(runLockFd, LOCK_UN); }
        finally { closeSecureDescriptor(runLockFd); }
        try { secureUnlinkAt(runFd, ".state.lock"); } catch { complete = false; }
      }
      closeSecureDescriptor(runFd);
    }
    if (complete) {
      try { secureRmdirAt(parentFd, runName); } catch { /* Verified retained Boards keep the run container */ }
    }
    return complete;
  } finally {
    closeSecureDescriptor(parentFd);
  }
}

type RootLock = Readonly<{ root: SecureRootDescriptor; release: () => Promise<void> }>;
async function assertPrivateRootIfPresent(rootPath: string, label: string): Promise<void> {
  const status = await rootStatus(rootPath);
  if (status === "missing") return;
  if (status !== "directory") throw new Error(`${label} must be a non-symlink directory: ${rootPath}`);
  const root = await openSecureRoot(rootPath);
  try {
    assertPrivateRootPath(root);
    assertSecureRoot(root);
  } finally {
    await closeSecureRoot(root);
  }
}

async function acquireLock(rootPath: string, coordinateArtifactStore = false): Promise<RootLock | undefined> {
  const status = await rootStatus(rootPath);
  if (status === "missing") return undefined;
  if (status !== "directory") throw new Error(`storage root is not a non-symlink directory: ${rootPath}`);
  const root = await openSecureRoot(rootPath);
  let lockFd: number | undefined;
  let artifactLockFd: number | undefined;
  try {
    assertPrivateRootPath(root);
    assertSecureRoot(root);
    const acquiredFd = secureOpenAt(root.fd, STORAGE_MAINTENANCE_LOCK_FILE, constants.O_RDWR | constants.O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600);
    lockFd = acquiredFd;
    secureFlock(acquiredFd, LOCK_EX | LOCK_NB);
    if (coordinateArtifactStore) {
      artifactLockFd = secureOpenAt(root.fd, ARTIFACT_CANONICAL_LOCK_FILE, constants.O_RDWR | constants.O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600);
      secureFlock(artifactLockFd, LOCK_EX | LOCK_NB);
    }
    const coordinatedFd = artifactLockFd;
    return {
      root,
      release: async () => {
        try {
          if (coordinatedFd !== undefined) secureFlock(coordinatedFd, LOCK_UN);
          secureFlock(acquiredFd, LOCK_UN);
        } finally {
          if (coordinatedFd !== undefined) closeSecureDescriptor(coordinatedFd);
          closeSecureDescriptor(acquiredFd);
          await closeSecureRoot(root);
        }
      },
    };
  } catch (error) {
    if (artifactLockFd !== undefined) closeSecureDescriptor(artifactLockFd);
    if (lockFd !== undefined) closeSecureDescriptor(lockFd);
    await closeSecureRoot(root);
    throw error;
  }
}

async function applyCandidates(inventory: StorageInventory, candidates: StorageMaintenanceReport["candidates"], stateLock: RootLock | undefined, artifactLock: RootLock | undefined): Promise<StorageMaintenanceReport["deleted"]> {
  const deleted = { boards: [] as string[], runs: [] as string[], objects: [] as string[], collector: [] as string[], staging: [] as string[] };
  for (const [key, paths] of Object.entries(candidates) as [keyof typeof deleted, readonly string[]][]) {
    for (const relativePath of paths) {
      const useArtifactRoot = key === "objects" || key === "collector" || key === "staging" && !relativePath.startsWith("runs/");
      const lock = useArtifactRoot ? artifactLock : stateLock;
      if (!lock) continue;
      const leasedEphemeralRoot = (key === "collector" || key === "staging") && !relativePath.includes("/") && (relativePath.startsWith(".collector-") || relativePath.startsWith(".staging-"));
      const removed = key === "runs"
        ? await removeCanonicalRun(lock.root, relativePath)
        : leasedEphemeralRoot
          ? await removeLeasedEphemeralRoot(lock.root, relativePath)
          : await removeRelative(lock.root, relativePath);
      if (removed) {
        deleted[key].push(relativePath);
        if (key === "boards") await removeEmptyBoardParents(lock.root, relativePath);
      }
    }
  }
  for (const key of Object.keys(deleted) as (keyof typeof deleted)[]) deleted[key].sort();
  return deleted;
}

function reconcileGcMarks(inventory: StorageInventory, previous: GcMarks, now: number, resetDigests: ReadonlySet<string> = new Set()): GcMarks {
  const referenced = new Set(Object.values(inventory.runReferences).flatMap(digests => digests));
  const available = new Map(inventory.objects.filter(object => !object.malformed && object.digest !== undefined).map(object => [object.digest!, object] as const));
  const next: Record<string, number> = {};
  for (const [digest, markedAt] of Object.entries(previous)) {
    const object = available.get(digest);
    if (!referenced.has(digest) && object !== undefined) next[digest] = resetDigests.has(digest) || object.mtimeMs > markedAt ? now : markedAt;
  }
  for (const digest of available.keys()) {
    if (!referenced.has(digest) && next[digest] === undefined) next[digest] = now;
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
}

function mergeDeleted(a: StorageMaintenanceReport["deleted"], b: StorageMaintenanceReport["deleted"]): StorageMaintenanceReport["deleted"] {
  return {
    boards: [...a.boards, ...b.boards].sort(),
    runs: [...a.runs, ...b.runs].sort(),
    objects: [...a.objects, ...b.objects].sort(),
    collector: [...a.collector, ...b.collector].sort(),
    staging: [...a.staging, ...b.staging].sort(),
  };
}

export async function pruneStorage(input: StorageMaintenanceOptions): Promise<StorageMaintenanceReport> {
  const policy = normalizePolicy(input.policy);
  const now = nowMs(input.now);
  const protectedRunIds = new Set(input.protectedRunIds ?? []);
  if ([...protectedRunIds].some(runId => !safeId(runId))) throw new Error("protected run ID contains unsafe characters");
  const dryRun = input.apply !== true;
  if (!dryRun) {
    await assertPrivateRootIfPresent(input.stateDir, "state storage root");
    await assertPrivateRootIfPresent(input.artifactDir, "artifact storage root");
  }
  let inventory = await inspectStorage({ ...input, policy });
  let pinState = await loadPins(inventory.directories.stateDir);
  let gcMarksState = await loadGcMarks(inventory.directories.artifactDir);
  let plan = candidatePlan(inventory, policy, now, gcMarksState.marks, gcMarksState.malformed, protectedRunIds, pinState);
  let deleted: StorageMaintenanceReport["deleted"] = { boards: [], runs: [], objects: [], collector: [], staging: [] };
  let stateLock: RootLock | undefined;
  let artifactLock: RootLock | undefined;
  const warnings: string[] = [];
  if (gcMarksState.malformed) warnings.push("GC marks are malformed; object deletion is disabled until they are repaired");
  if (!dryRun) {
    if (inventory.counts.pinFileMalformed) throw new Error("pin file is malformed; refusing apply until it is repaired");
    stateLock = await acquireLock(inventory.directories.stateDir);
    try { artifactLock = await acquireLock(inventory.directories.artifactDir, true); }
    catch (error) { await stateLock?.release(); throw error; }
    try {
      if (stateLock) assertSecureRoot(stateLock.root);
      if (artifactLock) assertSecureRoot(artifactLock.root);
      inventory = await inspectStorage({ ...input, policy });
      pinState = await loadPins(inventory.directories.stateDir);
      if (inventory.counts.pinFileMalformed) throw new Error("pin file became malformed; refusing apply");
      const referencedBeforeRunPrune = new Set(Object.values(inventory.runReferences).flatMap(digests => digests));
      gcMarksState = artifactLock ? await loadGcMarks(inventory.directories.artifactDir, artifactLock.root) : { marks: {}, malformed: false };
      if (gcMarksState.malformed) warnings.push("GC marks are malformed; object deletion is disabled until they are repaired");
      plan = candidatePlan(inventory, policy, now, {}, gcMarksState.malformed, protectedRunIds, pinState);
      if (stateLock) assertSecureRoot(stateLock.root);
      if (artifactLock) assertSecureRoot(artifactLock.root);
      const phaseDeleted = await applyCandidates(inventory, plan.candidates, stateLock, artifactLock);
      deleted = mergeDeleted(deleted, phaseDeleted);
      if (stateLock) assertSecureRoot(stateLock.root);
      if (artifactLock) assertSecureRoot(artifactLock.root);
      inventory = await inspectStorage({ ...input, policy });
      pinState = await loadPins(inventory.directories.stateDir);
      if (inventory.counts.pinFileMalformed) throw new Error("pin file became malformed; refusing apply");
      if (artifactLock && !gcMarksState.malformed) {
        const referencedAfterRunPrune = new Set(Object.values(inventory.runReferences).flatMap(digests => digests));
        const newlyUnreferenced = new Set([...referencedBeforeRunPrune].filter(digest => !referencedAfterRunPrune.has(digest)));
        const marks = reconcileGcMarks(inventory, gcMarksState.marks, now, newlyUnreferenced);
        await writeGcMarks(artifactLock.root, marks);
        const objectPlan = candidatePlan(inventory, policy, now, marks, false, protectedRunIds, pinState);
        if (stateLock) assertSecureRoot(stateLock.root);
        assertSecureRoot(artifactLock.root);
        const objectDeleted = await applyCandidates(inventory, { boards: [], runs: [], objects: objectPlan.candidates.objects, collector: [], staging: [] }, stateLock, artifactLock);
        deleted = mergeDeleted(deleted, objectDeleted);
        plan = { candidates: { ...plan.candidates, objects: objectPlan.candidates.objects }, protected: objectPlan.protected };
        if (stateLock) assertSecureRoot(stateLock.root);
        assertSecureRoot(artifactLock.root);
        inventory = await inspectStorage({ ...input, policy });
        if (inventory.counts.pinFileMalformed) throw new Error("pin file became malformed; refusing apply");
        await writeGcMarks(artifactLock.root, reconcileGcMarks(inventory, marks, now));
      }
    } finally {
      await artifactLock?.release();
      await stateLock?.release();
    }
  }
  const incompleteDeletion = Object.entries(plan.candidates).some(([key, paths]) => paths.some(path => !deleted[key as keyof typeof deleted].includes(path)));
  return {
    schemaVersion: "traceknot-storage-maintenance/v1",
    generatedAt: inventory.generatedAt,
    dryRun,
    applied: !dryRun,
    directories: inventory.directories,
    policy,
    inventory,
    candidates: plan.candidates,
    deleted,
    protected: { ...plan.protected, symlinks: inventory.symlinks },
    warnings: [...new Set([...warnings, ...(inventory.counts.malformedRuns > 0 ? ["malformed run state disables canonical object deletion"] : []), ...(inventory.counts.symlinks > 0 ? ["symlink entries were inspected but never followed or removed"] : []), ...(incompleteDeletion && !dryRun ? ["secure descriptor-relative deletion skipped one or more candidates because entries were replaced, symlinks, unknown types, or non-empty"] : [])])],
  };
}

async function updatePins(stateDir: string, runId: string, pin: boolean): Promise<readonly string[]> {
  if (!safeId(runId)) throw new Error("run ID contains unsafe characters");
  const absolute = assertAbsoluteRoot(stateDir, "state directory");
  const status = await rootStatus(absolute);
  if (status === "symlink" || status === "other") throw new Error("state directory must not be a symlink");
  if (status === "missing") {
    const fd = openOrCreateSecureDirectoryPath(absolute);
    closeSecureDescriptor(fd);
  }
  const lock = await acquireLock(absolute);
  if (!lock) throw new Error("state directory could not be opened");
  let temporaryFd: number | undefined;
  const temporary = `.traceknot-pins-${randomUUID()}.tmp`;
  let renamed = false;
  try {
    assertSecureRoot(lock.root);
    const current = await loadPins(absolute);
    assertSecureRoot(lock.root);
    if (current.malformed) throw new Error("pin file is malformed");
    if (pin) current.pins.add(runId); else current.pins.delete(runId);
    const pins = [...current.pins].sort();
    temporaryFd = secureOpenAt(lock.root.fd, temporary, WRITE_FLAGS, 0o600);
    const bytes = Buffer.from(`${JSON.stringify(pins)}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(temporaryFd, bytes, offset, bytes.byteLength - offset, null);
      if (written <= 0) throw new Error("pin file write made no progress");
      offset += written;
    }
    secureFsync(temporaryFd);
    closeSecureDescriptor(temporaryFd);
    temporaryFd = undefined;
    secureRenameAt(lock.root.fd, temporary, lock.root.fd, PINS_FILE);
    secureFsync(lock.root.fd);
    renamed = true;
    return pins;
  } finally {
    if (temporaryFd !== undefined) closeSecureDescriptor(temporaryFd);
    if (!renamed) { try { secureUnlinkAt(lock.root.fd, temporary); } catch { /* absent */ } }
    await lock.release();
  }
}

export async function pinRun(stateDir: string, runId: string): Promise<readonly string[]> { return updatePins(stateDir, runId, true); }
export async function unpinRun(stateDir: string, runId: string): Promise<readonly string[]> { return updatePins(stateDir, runId, false); }
export async function listPinnedRuns(stateDir: string): Promise<readonly string[]> {
  const absolute = assertAbsoluteRoot(stateDir, "state directory");
  const pins = await loadPins(absolute);
  if (pins.malformed) throw new Error("pin file is malformed");
  return [...pins.pins].sort();
}

export const STORAGE_RETENTION_POLICY = DEFAULT_CACHE_RETENTION_POLICY;
