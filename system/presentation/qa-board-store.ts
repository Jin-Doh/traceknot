import { constants, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readFile, readlink, readdir, stat as statPath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireSecureFlock,
  assertPrivateRootPath,
  assertSecureRoot,
  closeSecureDescriptor,
  closeSecureRoot,
  openOrCreateSecureDirectory,
  secureEntryExistsAt,
  openSecureDirectory,
  openSecureRoot,
  readSecureRegularFile,
  secureFsync,
  secureMkdirAt,
  secureOpenAt,
  secureRenameAt,
  secureSymlinkAt,
  secureRmdirAt,
  secureFlock,
  secureUnlinkAt,
  type SecureRootDescriptor,
  STORAGE_MAINTENANCE_LOCK_FILE,
} from "../runtime/local-artifact-store";
import {
  QA_BOARD_LOCALES,
  buildQaBoardManifest,
  renderQaBoardHtml,
  sessionReference,
  sha256,
  type QaBoardLocale,
  type QaBoardManifest,
  type QaBoardManifestFile,
  type QaBoardRenderOptions,
  type QaBoardView,

} from "./qa-board";
export type BoardArtifactReader = Readonly<{
  readArtifact: (digest: string) => Promise<Uint8Array>;
}>;

export type BoardBundleInput = Readonly<{
  view: QaBoardView;
  stateDir: string;
  invocationId?: string;
  sessionHost?: string;
  sessionId?: string;
  locale?: QaBoardLocale;
  generatedAt: string;
  artifactReader: BoardArtifactReader;
}>;

export type BoardBundleResult = Readonly<{
  directory: string;
  entrypoint: string;
  manifest: QaBoardManifest;
  projectSupportIncluded: boolean;
}>;

export async function verifyQaBoardBundleForOpen(stateDir: string, bundle: BoardBundleResult): Promise<void> {
  const root = await openSecureRoot(resolve(stateDir));
  try {
    assertPrivateRootPath(root, "Board state");
    const directory = relative(root.canonical, bundle.directory);
    for (const file of bundle.manifest.files) {
      const bytes = await readSecureRegularFile(root.fd, join(directory, file.path), file.bytes);
      if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
        throw new Error(`Board file changed before open: ${file.path}`);
      }
    }
    const manifestBytes = await readSecureRegularFile(root.fd, join(directory, "manifest.json"), 1024 * 1024);
    const persistedManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
    if (JSON.stringify(persistedManifest) !== JSON.stringify(bundle.manifest)) {
      throw new Error("Board manifest changed before open");
    }
    assertSecureRoot(root);
  } finally {
    await closeSecureRoot(root);
  }
}

export const QA_BOARD_LIMITS = Object.freeze({
  maxScreenshotCount: 20,
  maxScreenshotBytes: 10 * 1024 * 1024,
  maxTotalPreviewBytes: 100 * 1024 * 1024,
});
const DIGEST = /^[0-9a-f]{64}$/;
const SAFE_ENTRY = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_BOARD_NAME = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0) | ((constants as Record<string, number | undefined>).O_CLOEXEC ?? 0);
const LOCK_FLAGS = constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | ((constants as Record<string, number | undefined>).O_CLOEXEC ?? 0);
const PROJECT_SUPPORT_DIRECTORY = "presentation";
const PROJECT_SUPPORT_MARKER = "star-cta-v1.seen";
const MARKER_DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | ((constants as Record<string, number | undefined>).O_CLOEXEC ?? 0);
const MARKER_WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0) | ((constants as Record<string, number | undefined>).O_CLOEXEC ?? 0);
const LOCK_SH = 1;
const LOCK_UN = 8;

function assertSafeEntry(value: string, label: string): void {
  if (!SAFE_ENTRY.test(value)) throw new Error(`${label} contains unsafe characters`);
}

function hasErrno(error: unknown, value: number): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes(`errno ${value}`)) return true;
  const code = (error as Error & { code?: string }).code;
  return (value === 2 && code === "ENOENT") || (value === 17 && code === "EEXIST") || (value === 39 && code === "ENOTEMPTY") || (value === 66 && code === "EISDIR");
}

function isExistingTarget(error: unknown): boolean {
  return hasErrno(error, 17) || hasErrno(error, 39) || hasErrno(error, 66);
}


function shouldShowProjectSupport(rootFd: number): boolean {
  let presentationFd: number | undefined;
  try {
    presentationFd = secureOpenAt(rootFd, PROJECT_SUPPORT_DIRECTORY, MARKER_DIRECTORY_FLAGS);
  } catch (error) {
    return hasErrno(error, 2);
  }
  try {
    return !secureEntryExistsAt(presentationFd, PROJECT_SUPPORT_MARKER);
  } catch {
    return false;
  } finally {
    closeSecureDescriptor(presentationFd);
  }
}
export async function markProjectSupportSeen(stateDir: string): Promise<void> {
  const root = await openSecureRoot(resolve(stateDir));
  let presentationFd: number | undefined;
  let markerFd: number | undefined;
  try {
    assertPrivateRootPath(root, "Board state");
    presentationFd = openOrCreateSecureDirectory(root.fd, PROJECT_SUPPORT_DIRECTORY);
    try {
      markerFd = secureOpenAt(presentationFd, PROJECT_SUPPORT_MARKER, MARKER_WRITE_FLAGS, 0o600);
    } catch (error) {
      if (isExistingTarget(error)) return;
      throw error;
    }
    secureFsync(markerFd);
    closeSecureDescriptor(markerFd);
    markerFd = undefined;
    secureFsync(presentationFd);
  } finally {
    if (markerFd !== undefined) closeSecureDescriptor(markerFd);
    if (presentationFd !== undefined) closeSecureDescriptor(presentationFd);
    await closeSecureRoot(root);
  }
}

function writeBytes(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset, null);
    if (written <= 0) throw new Error("Board file write made no progress");
    offset += written;
  }
}

async function writeAtomic(directoryFd: number, name: string, bytes: Uint8Array): Promise<void> {
  const temporary = `.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let failure: unknown;
  try {
    fd = secureOpenAt(directoryFd, temporary, WRITE_FLAGS, 0o600);
    writeBytes(fd, bytes);
    secureFsync(fd);
    closeSecureDescriptor(fd);
    fd = undefined;
    secureRenameAt(directoryFd, temporary, directoryFd, name);
    secureFsync(directoryFd);
  } catch (error) {
    failure = error;
  } finally {
    if (fd !== undefined) closeSecureDescriptor(fd);
  }
  let cleanupError: unknown;
  try {
    secureUnlinkAt(directoryFd, temporary);
  } catch (error) {
    if (!hasErrno(error, 2)) cleanupError = error;
  }
  if (failure !== undefined && cleanupError !== undefined) {
    throw new AggregateError([failure, cleanupError], "Board atomic write failed");
  }
  if (failure !== undefined) throw failure;
  if (cleanupError !== undefined) throw cleanupError;
}

function availableScreenshots(view: QaBoardView, copied: ReadonlySet<string>): QaBoardView {
  return {
    ...view,
    findings: view.findings.map(finding => ({
      ...finding,
      screenshots: finding.screenshots.filter(item => copied.has(item.digest)),
    })),
  };
}

type BoardDirectoryHandles = {
  runsFd?: number;
  runFd?: number;
  boardsFd?: number;
  boardFd?: number;
  evidenceFd?: number;
  pendingName: string;
};

type BoardDirectories = {
  runsFd: number;
  runFd: number;
  boardsFd: number;
  boardFd: number;
  evidenceFd: number;
  pendingName: string;
};

/**
 * Cleanup is descriptor-relative and bounded to names this writer can create.
 * Unknown entries make rmdir fail rather than being walked; symlinks are
 * unlinked as entries and never traversed.
 */
function cleanupBoardBundle(
  handles: BoardDirectoryHandles,
  targetName: string,
  boardFiles: ReadonlySet<string>,
  evidenceFiles: ReadonlySet<string>,
): void {
  const failures: unknown[] = [];
  const attempt = (operation: () => void): void => {
    try {
      operation();
    } catch (error) {
      if (!hasErrno(error, 2)) failures.push(error);
    }
  };
  if (handles.evidenceFd !== undefined) {
    for (const name of evidenceFiles) attempt(() => secureUnlinkAt(handles.evidenceFd!, name));
    closeSecureDescriptor(handles.evidenceFd);
    handles.evidenceFd = undefined;
  }
  if (handles.boardFd !== undefined) {
    for (const name of boardFiles) attempt(() => secureUnlinkAt(handles.boardFd!, name));
    attempt(() => secureRmdirAt(handles.boardFd!, "evidence"));
    closeSecureDescriptor(handles.boardFd);
    handles.boardFd = undefined;
  }
  if (handles.boardsFd !== undefined) attempt(() => secureRmdirAt(handles.boardsFd!, targetName));
  if (failures.length > 0) throw new AggregateError(failures, "Board bundle cleanup failed");
}

function closeBoardDirectories(directories: BoardDirectoryHandles): void {
  if (directories.evidenceFd !== undefined) {
    closeSecureDescriptor(directories.evidenceFd);
    directories.evidenceFd = undefined;
  }
  if (directories.boardFd !== undefined) {
    closeSecureDescriptor(directories.boardFd);
    directories.boardFd = undefined;
  }
  if (directories.boardsFd !== undefined) {
    closeSecureDescriptor(directories.boardsFd);
    directories.boardsFd = undefined;
  }
  if (directories.runFd !== undefined) {
    closeSecureDescriptor(directories.runFd);
    directories.runFd = undefined;
  }
  if (directories.runsFd !== undefined) {
    closeSecureDescriptor(directories.runsFd);
    directories.runsFd = undefined;
  }
}

async function openBoardDirectories(root: SecureRootDescriptor, view: QaBoardView, pendingName: string): Promise<BoardDirectories> {
  const handles: BoardDirectoryHandles = { runsFd: openOrCreateSecureDirectory(root.fd, "runs"), pendingName };
  let pendingCreated = false;
  try {
    handles.runFd = openSecureDirectory(handles.runsFd!, view.runId);
    handles.boardsFd = openOrCreateSecureDirectory(handles.runFd!, "boards");
    secureMkdirAt(handles.boardsFd!, pendingName, 0o700);
    pendingCreated = true;
    handles.boardFd = openSecureDirectory(handles.boardsFd!, pendingName);
    secureMkdirAt(handles.boardFd!, "evidence", 0o700);
    handles.evidenceFd = openSecureDirectory(handles.boardFd!, "evidence");
    return {
      runsFd: handles.runsFd!,
      runFd: handles.runFd!,
      boardsFd: handles.boardsFd!,
      boardFd: handles.boardFd!,
      evidenceFd: handles.evidenceFd!,
      pendingName,
    };
  } catch (error) {
    let cleanupError: unknown;
    if (pendingCreated) {
      try {
        cleanupBoardBundle(handles, pendingName, new Set(["index.html", "manifest.json"]), new Set());
      } catch (caught) {
        cleanupError = caught;
      }
    }
    closeBoardDirectories(handles);
    if (cleanupError !== undefined) throw new AggregateError([error, cleanupError], "Board pending bundle cleanup failed");
    throw error;
  }
}

export async function writeQaBoardBundle(input: BoardBundleInput): Promise<BoardBundleResult> {
  const invocationId = input.invocationId ?? randomUUID();
  const sessionHost = input.sessionHost ?? "unavailable";
  assertSafeEntry(input.view.runId, "run ID");
  assertSafeEntry(invocationId, "invocation ID");
  if (!Number.isInteger(input.view.revision) || input.view.revision < 0) throw new Error("Board source revision must be a non-negative integer");
  const boardName = `${input.view.revision}-${invocationId}`;
  if (!SAFE_BOARD_NAME.test(boardName)) throw new Error("Board directory contains unsafe characters");
  const pendingName = `.pending-${randomUUID()}`;
  const root = await openSecureRoot(resolve(input.stateDir));
  let maintenanceFd: number | undefined;
  try {
    assertPrivateRootPath(root, "Board state");
    maintenanceFd = secureOpenAt(root.fd, STORAGE_MAINTENANCE_LOCK_FILE, LOCK_FLAGS, 0o600);
    await acquireSecureFlock(maintenanceFd, LOCK_SH, "Board publication maintenance lock");
  } catch (error) {
    if (maintenanceFd !== undefined) closeSecureDescriptor(maintenanceFd);
    await closeSecureRoot(root);
    throw error;
  }
  const boardRoot = root.canonical;
  const directory = join(boardRoot, "runs", input.view.runId, "boards", boardName);
  const entrypoint = join(directory, "index.html");
  const boardFiles = new Set(["index.html", ...QA_BOARD_LOCALES.map(locale => `index.${locale}.html`), "manifest.json"]);
  const evidenceFiles = new Set<string>();
  let directories: BoardDirectories | undefined;
  let published = false;
  let result: BoardBundleResult | undefined;
  let failure: unknown;
  let failed = false;
  try {
    directories = await openBoardDirectories(root, input.view, pendingName);
    const copied = new Set<string>();
    const files: QaBoardManifestFile[] = [];
    let screenshotCount = 0;
    let totalBytes = 0;
    for (const finding of input.view.findings) {
      for (const screenshot of finding.screenshots) {
        if (copied.has(screenshot.digest)) continue;
        if (!DIGEST.test(screenshot.digest)) continue;
        if (screenshotCount >= QA_BOARD_LIMITS.maxScreenshotCount) continue;
        const bytes = await input.artifactReader.readArtifact(screenshot.digest);
        if (bytes.byteLength > QA_BOARD_LIMITS.maxScreenshotBytes || totalBytes + bytes.byteLength > QA_BOARD_LIMITS.maxTotalPreviewBytes) continue;
        if (sha256(bytes) !== screenshot.digest) throw new Error(`screenshot artifact digest mismatch: ${screenshot.digest}`);
        const evidenceName = `${screenshot.digest}.png`;
        evidenceFiles.add(evidenceName);
        await writeAtomic(directories.evidenceFd, evidenceName, bytes);
        copied.add(screenshot.digest);
        screenshotCount += 1;
        totalBytes += bytes.byteLength;
        files.push({ path: `evidence/${evidenceName}`, role: "screenshot-preview", sha256: screenshot.digest, bytes: bytes.byteLength, artifactDigest: screenshot.digest, observationId: screenshot.observationId });
      }
    }
    const view = availableScreenshots(input.view, copied);
    const locale = input.locale ?? "en";
    const showProjectSupport = shouldShowProjectSupport(root.fd);
    const renderOptions: QaBoardRenderOptions = { showProjectSupport };
    const html = new TextEncoder().encode(renderQaBoardHtml(view, locale, renderOptions));
    await writeAtomic(directories.boardFd, "index.html", html);
    const pageFiles: QaBoardManifestFile[] = [{ path: "index.html", role: "entrypoint", sha256: sha256(html), bytes: html.byteLength }];
    for (const pageLocale of QA_BOARD_LOCALES) {
      const path = `index.${pageLocale}.html`;
      const localizedHtml = new TextEncoder().encode(renderQaBoardHtml(view, pageLocale, renderOptions));
      await writeAtomic(directories.boardFd, path, localizedHtml);
      pageFiles.push({ path, role: "localized-view", sha256: sha256(localizedHtml), bytes: localizedHtml.byteLength });
    }
    files.unshift(...pageFiles);
    const manifest = buildQaBoardManifest({ view, generatedAt: input.generatedAt, invocationId, sessionHost, sessionRef: sessionReference(sessionHost, input.sessionId), files });
    await writeAtomic(directories.boardFd, "manifest.json", new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
    try {
      secureRenameAt(directories.boardsFd, pendingName, directories.boardsFd, boardName);
      published = true;
      secureFsync(directories.boardsFd);
    } catch (error) {
      if (isExistingTarget(error)) throw new Error(`Board invocation already exists (${boardName}); choose a new --invocation-id`);
      throw error;
    }
    result = { directory, entrypoint, manifest, projectSupportIncluded: showProjectSupport };
  } catch (error) {
    failure = error;
    failed = true;
  }
  if (failed && directories) {
    try {
      cleanupBoardBundle(directories, published ? boardName : pendingName, boardFiles, evidenceFiles);
    } catch (cleanupError) {
      failure = new AggregateError([failure, cleanupError], "Board bundle cleanup failed");
    }
  }
  if (directories) closeBoardDirectories(directories);
  try {
    if (maintenanceFd !== undefined) secureFlock(maintenanceFd, LOCK_UN);
  } finally {
    if (maintenanceFd !== undefined) closeSecureDescriptor(maintenanceFd);
    await closeSecureRoot(root);
  }
  if (failed) throw failure;
  return result!;
}
export const SESSION_BOARD_UPDATE_SCHEMA = "traceknot-session-board-update/v1" as const;
export type SessionBoardUpdate = Readonly<{
  schemaVersion: typeof SESSION_BOARD_UPDATE_SCHEMA;
  sessionId: string;
  sessionHost: string;
  generatedAt: string;
  invocationId?: string;
  view: QaBoardView;
}>;

export type SessionBoardCurrent = Readonly<{
  schemaVersion: "traceknot-session-board-current/v1";
  sessionKey: string;
  sourceRevision: number;
  invocationId: string;
  revisionPath: string;
  entrypoint: "index.html";
  entrypointSha256: string;
  manifestSha256: string;
  sessionRef: string;
  generatedAt: string;
  authoritative: false;
}>;

export type SessionBoardPublicationResult = Readonly<{
  sessionKey: string;
  directory: string;
  entrypoint: string;
  entrypointUri: string;
  currentPath: string;
  current: SessionBoardCurrent;
  manifest: QaBoardManifest;
  projectSupportIncluded: boolean;
}>;

const SESSION_ID_MAX = 1024;
const SESSION_HOST_MAX = 128;
const SESSION_SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const ISO_TIMESTAMP = /^\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|02-(?:0[1-9]|1\d|2\d))T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/;
const SESSION_STATES = new Set(["CREATED", "BASIS_ESTABLISHED", "DISCOVERY_COMPLETED", "PLANNED", "EXECUTING", "EVIDENCE_EVALUATED", "VERDICT_RESOLVED", "TERMINAL"]);
const SESSION_VERDICTS: Readonly<Record<string, true>> = { PASS: true, PASS_WITH_ACCEPTED_RISK: true, FAIL: true, BLOCKED: true, INCOMPLETE: true };
const EVALUATION_STATUSES: Readonly<Record<string, true>> = { ACCEPTED: true, REJECTED: true, INDETERMINATE: true };
const PRODUCER_KINDS: Readonly<Record<string, true>> = { self: true, "harness-managed": true, "deterministic-verifier": true, ci: true, human: true, "external-system": true };
const INDEPENDENCE_LEVELS: Readonly<Record<string, true>> = { "self-check": true, "separate-verification-context": true, "independent-producer": true, "external-approval": true };
const SESSION_BOARD_MAX_DEFAULT = 10;
const SESSION_BOARD_QUOTA_DEFAULT = 1024 * 1024 * 1024;
const SESSION_FILE_LIMIT = 128 * 1024 * 1024;
const LOCK_EX = 2;

type UnknownRecord = Record<string, unknown>;

function sessionObject(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as UnknownRecord;
}

function sessionKeys(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): void {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(value, key)) || actual.some(key => !allowed.has(key))) {
    throw new Error("Board update contains unknown or missing fields");
  }
}

function sessionText(value: unknown, label: string, maxLength = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !SESSION_SAFE_TEXT.test(value)) {
    throw new Error(`${label} contains unsafe text`);
  }
  return value;
}

function sessionId(value: unknown, label: string, maxLength: number): string {
  return sessionText(value, label, maxLength);
}

function validSessionTimestamp(value: unknown, label: string): string {
  const timestamp = sessionText(value, label, 64);
  if (!ISO_TIMESTAMP.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  const [year, month, day] = timestamp.slice(0, 10).split("-").map(Number) as [number, number, number];
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day > daysInMonth) throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  return timestamp;
}

function sessionInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function sessionDigest(value: unknown, label: string): string {
  const digest = sessionText(value, label, 64);
  if (!DIGEST.test(digest)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return digest;
}
function validateSessionStringList(value: unknown, label: string, maxLength = 1024, unique = false): string[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error(`${label} is invalid`);
  const result = value.map((item, index) => sessionText(item, `${label}[${index}]`, maxLength));
  if (unique && new Set(result).size !== result.length) throw new Error(`${label} contains duplicate values`);
  return result;
}

function validateSessionProducer(value: unknown, path: string): void {
  const producer = sessionObject(value, path);
  sessionKeys(producer, ["kind", "identity", "independence"]);
  if (!Object.hasOwn(PRODUCER_KINDS, String(producer.kind))) throw new Error(`${path}.kind is invalid`);
  sessionText(producer.identity, `${path}.identity`);
  if (!Object.hasOwn(INDEPENDENCE_LEVELS, String(producer.independence))) throw new Error(`${path}.independence is invalid`);
}

function validateSessionArtifact(value: unknown, path: string): void {
  const artifact = sessionObject(value, path);
  sessionKeys(artifact, ["type", "digest"], ["path"]);
  sessionText(artifact.type, `${path}.type`);
  sessionDigest(artifact.digest, `${path}.digest`);
  if (artifact.path !== undefined) {
    const artifactPath = sessionText(artifact.path, `${path}.path`);
    if (artifactPath.startsWith("/") || artifactPath.includes("..") || artifactPath.includes("\\")) throw new Error(`${path}.path contains an unsafe path`);
  }
}

function validateSessionEvaluation(value: unknown, path: string): void {
  const evaluation = sessionObject(value, path);
  sessionKeys(evaluation, ["status", "rejectionReasons"]);
  if (!Object.hasOwn(EVALUATION_STATUSES, String(evaluation.status))) throw new Error(`${path}.status is invalid`);
  validateSessionStringList(evaluation.rejectionReasons, `${path}.rejectionReasons`, 4096);
}

function validateSessionPresentation(value: unknown, path = "$", seen = new Set<unknown>()): void {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") sessionText(value, path);
    return;
  }
  if (seen.has(value)) throw new Error(`${path} contains a cyclic value`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 10000) throw new Error(`${path} contains too many items`);
    value.forEach((item, index) => validateSessionPresentation(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value as UnknownRecord)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error(`${path} contains a forbidden key`);
      if (!SESSION_SAFE_TEXT.test(key)) throw new Error(`${path} contains an unsafe key`);
      if (typeof item === "string") {
        const text = sessionText(item, `${path}.${key}`);
        if (key.toLowerCase().includes("digest")) sessionDigest(text, `${path}.${key}`);
        if (key.toLowerCase().endsWith("path") && (text.startsWith("/") || text.includes("..") || text.includes("\\"))) {
          throw new Error(`${path}.${key} contains an unsafe path`);
        }
      } else validateSessionPresentation(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function sessionPresentationContains(value: unknown, sessionIdValue: string, seen = new Set<unknown>()): boolean {
  if (typeof value === "string") return value.includes(sessionIdValue);
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const found = Array.isArray(value)
    ? value.some(item => sessionPresentationContains(item, sessionIdValue, seen))
    : Object.values(value as UnknownRecord).some(item => sessionPresentationContains(item, sessionIdValue, seen));
  seen.delete(value);
  return found;
}


function validateSessionCounts(value: unknown, findings: readonly UnknownRecord[]): Record<string, number> {
  const counts = sessionObject(value, "view.counts");
  sessionKeys(counts, ["mandatory", "passed", "failed", "blocked", "incomplete"]);
  const values = Object.fromEntries(Object.entries(counts).map(([key, item]) => [key, sessionInteger(item, `view.counts.${key}`)])) as Record<string, number>;
  if (values.mandatory !== values.passed + values.failed + values.blocked + values.incomplete) throw new Error("view.counts totals are inconsistent");
  const mandatory = findings.filter(item => item.mandatory === true);
  if (mandatory.length !== values.mandatory) throw new Error("view.counts.mandatory does not match findings");
  const countByStatus: Readonly<Record<string, string>> = { PASS: "passed", FAIL: "failed", BLOCKED: "blocked", INCOMPLETE: "incomplete" };
  for (const status of ["PASS", "FAIL", "BLOCKED", "INCOMPLETE"] as const) {
    const count = mandatory.filter(item => item.status === status).length;
    const key = countByStatus[status]!;
    if (count !== values[key]) throw new Error(`view.counts.${key} does not match findings`);
  }
  return values;
}

function validateSessionCoverage(value: unknown, mandatory: number, passed: number): UnknownRecord {
  const coverage = sessionObject(value, "view.coverage");
  sessionKeys(coverage, ["basis", "risks", "conditions", "mandatoryObligations"]);
  for (const key of ["basis", "risks", "conditions", "mandatoryObligations"]) {
    const item = sessionObject(coverage[key], `view.coverage.${key}`);
    sessionKeys(item, ["total", "covered", "uncoveredIds"]);
    const total = sessionInteger(item.total, `view.coverage.${key}.total`);
    const covered = sessionInteger(item.covered, `view.coverage.${key}.covered`);
    const uncoveredIds = validateSessionStringList(item.uncoveredIds, `view.coverage.${key}.uncoveredIds`, 1024, true);
    if (covered > total || uncoveredIds.length !== total - covered) throw new Error(`view.coverage.${key} totals are inconsistent`);
  }
  const mandatoryCoverage = sessionObject(coverage.mandatoryObligations, "view.coverage.mandatoryObligations");
  if (mandatoryCoverage.total !== mandatory || mandatoryCoverage.covered !== passed) throw new Error("view.coverage.mandatoryObligations does not match counts");
  return coverage;
}

function validateSessionVerdict(
  verdict: string,
  counts: Readonly<Record<string, number>>,
  coverage: UnknownRecord,
  openDefectIds: readonly string[],
  acceptedRiskIds: readonly string[],
  residualRisks: readonly string[],
): void {
  const covered = new Set([...openDefectIds, ...acceptedRiskIds]);
  if (covered.size !== openDefectIds.length + acceptedRiskIds.length) throw new Error("view.openDefectIds and acceptedRiskIds overlap");
  const residual = new Set(residualRisks);
  if (residual.size !== covered.size || [...covered].some(id => !residual.has(id))) throw new Error("view.residualRisks does not match defects and accepted risks");
  const coverageIncomplete = ["basis", "risks", "conditions"].some(key => {
    const group = sessionObject(coverage[key], `view.coverage.${key}`);
    return (group.uncoveredIds as unknown[]).length > 0;
  });
  const expected = counts.failed > 0 || openDefectIds.length > 0
    ? "FAIL"
    : counts.blocked > 0
      ? "BLOCKED"
      : counts.incomplete > 0 || coverageIncomplete
        ? "INCOMPLETE"
        : acceptedRiskIds.length > 0
          ? "PASS_WITH_ACCEPTED_RISK"
          : "PASS";
  if (verdict !== expected) throw new Error(`view.verdict violates precedence; expected ${expected}`);
}

function validateSessionView(value: unknown): QaBoardView {
  const view = sessionObject(value, "view");
  sessionKeys(view, ["runId", "requestId", "rootIdentity", "snapshotId", "revision", "sourceState", "sourceUpdatedAt", "changeSummary", "assurance", "verdict", "authoritative", "rationale", "counts", "findings", "coverage", "openDefectIds", "acceptedRiskIds", "residualRisks"]);
  sessionId(view.runId, "view.runId", 256);
  sessionText(view.requestId, "view.requestId");
  sessionText(view.rootIdentity, "view.rootIdentity");
  sessionText(view.snapshotId, "view.snapshotId");
  sessionInteger(view.revision, "view.revision");
  if (!SESSION_STATES.has(String(view.sourceState))) throw new Error("view.sourceState is invalid");
  validSessionTimestamp(view.sourceUpdatedAt, "view.sourceUpdatedAt");
  sessionText(view.changeSummary, "view.changeSummary");
  const assurance = sessionObject(view.assurance, "view.assurance");
  sessionKeys(assurance, ["context", "requiredIndependence", "releaseStatus"]);
  if (assurance.context !== "local" && assurance.context !== "release") throw new Error("view.assurance.context is invalid");
  if (assurance.requiredIndependence !== "separate-verification-context" && assurance.requiredIndependence !== "independent-producer") throw new Error("view.assurance.requiredIndependence is invalid");
  if (assurance.releaseStatus !== "not-evaluated" && assurance.releaseStatus !== "satisfied" && assurance.releaseStatus !== "insufficient") throw new Error("view.assurance.releaseStatus is invalid");
  const verdict = String(view.verdict);
  if (!Object.hasOwn(SESSION_VERDICTS, verdict)) throw new Error("view.verdict is invalid");
  if (view.authoritative !== false) throw new Error("view.authoritative must be false");
  sessionText(view.rationale, "view.rationale");
  if (!Array.isArray(view.findings) || view.findings.length > 10000) throw new Error("view.findings must be an array");
  const findings: UnknownRecord[] = [];
  for (const [index, raw] of view.findings.entries()) {
    const finding = sessionObject(raw, `view.findings[${index}]`);
    sessionKeys(finding, ["obligationId", "mandatory", "status", "expectedResults", "summary", "screenshots", "artifacts"], ["producer", "evaluation"]);
    sessionText(finding.obligationId, `view.findings[${index}].obligationId`);
    if (typeof finding.mandatory !== "boolean" || !["PASS", "FAIL", "BLOCKED", "INCOMPLETE"].includes(String(finding.status))) throw new Error(`view.findings[${index}] has invalid mandatory/status`);
    validateSessionStringList(finding.expectedResults, `view.findings[${index}].expectedResults`, 4096);
    sessionText(finding.summary, `view.findings[${index}].summary`);
    if (!Array.isArray(finding.screenshots) || finding.screenshots.length > 10000) throw new Error(`view.findings[${index}].screenshots is invalid`);
    for (const [screenshotIndex, rawScreenshot] of finding.screenshots.entries()) {
      const screenshot = sessionObject(rawScreenshot, `view.findings[${index}].screenshots[${screenshotIndex}]`);
      sessionKeys(screenshot, ["digest", "observationId"]);
      sessionDigest(screenshot.digest, `view.findings[${index}].screenshots[${screenshotIndex}].digest`);
      sessionText(screenshot.observationId, `view.findings[${index}].screenshots[${screenshotIndex}].observationId`);
    }
    if (!Array.isArray(finding.artifacts) || finding.artifacts.length > 10000) throw new Error(`view.findings[${index}].artifacts is invalid`);
    finding.artifacts.forEach((artifact, artifactIndex) => validateSessionArtifact(artifact, `view.findings[${index}].artifacts[${artifactIndex}]`));
    if (finding.evaluation !== undefined) validateSessionEvaluation(finding.evaluation, `view.findings[${index}].evaluation`);
    if (finding.producer !== undefined) validateSessionProducer(finding.producer, `view.findings[${index}].producer`);
    findings.push(finding);
  }
  const counts = validateSessionCounts(view.counts, findings);
  const coverage = validateSessionCoverage(view.coverage, counts.mandatory, counts.passed);
  const openDefectIds = validateSessionStringList(view.openDefectIds, "view.openDefectIds", 1024, true);
  const acceptedRiskIds = validateSessionStringList(view.acceptedRiskIds, "view.acceptedRiskIds", 1024, true);
  const residualRisks = validateSessionStringList(view.residualRisks, "view.residualRisks", 1024, true);
  validateSessionVerdict(verdict, counts, coverage, openDefectIds, acceptedRiskIds, residualRisks);
  validateSessionPresentation(view);
  return view as unknown as QaBoardView;
}

export function parseSessionBoardUpdate(value: unknown): SessionBoardUpdate {
  const input = sessionObject(value, "Board update");
  sessionKeys(input, ["schemaVersion", "sessionId", "sessionHost", "generatedAt", "view"], ["invocationId"]);
  if (input.schemaVersion !== SESSION_BOARD_UPDATE_SCHEMA) throw new Error("unsupported Board update schemaVersion");
  const parsedSessionId = sessionId(input.sessionId, "sessionId", SESSION_ID_MAX);
  const parsedSessionHost = sessionId(input.sessionHost, "sessionHost", SESSION_HOST_MAX);
  const generatedAt = validSessionTimestamp(input.generatedAt, "generatedAt");
  const parsedView = validateSessionView(input.view);
  const invocationId = input.invocationId === undefined ? undefined : sessionId(input.invocationId, "invocationId", 128);
  if (invocationId !== undefined && !SAFE_ENTRY.test(invocationId)) throw new Error("invocationId contains unsafe characters");
  return Object.freeze({ schemaVersion: SESSION_BOARD_UPDATE_SCHEMA, sessionId: parsedSessionId, sessionHost: parsedSessionHost, generatedAt, ...(invocationId === undefined ? {} : { invocationId }), view: parsedView });
}

export function sessionBoardKey(sessionHostValue: string, sessionIdValue: string): string {
  sessionId(sessionIdValue, "sessionId", SESSION_ID_MAX);
  sessionId(sessionHostValue, "sessionHost", SESSION_HOST_MAX);
  return `s-${sha256(`${sessionHostValue}\0${sessionIdValue}`)}`;
}

function sessionAtomicBytes(bytes: Uint8Array | string): Uint8Array {
  return typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
}

function secureRelativePath(root: SecureRootDescriptor, path: string): string {
  const result = relative(root.canonical, resolve(path));
  if (result === "" || result.startsWith("..") || result.includes("\0") || result.split("/").some(component => component === "" || component === "." || component === "..")) {
    throw new Error("Board path escapes state root");
  }
  return result;
}

async function readOptionalSecure(root: SecureRootDescriptor, path: string, limit: number): Promise<Uint8Array | undefined> {
  try {
    return await readSecureRegularFile(root.fd, secureRelativePath(root, path), limit);
  } catch (error) {
    if (hasErrno(error, 2)) return undefined;
    throw error;
  }
}

async function sessionReadback(root: SecureRootDescriptor, path: string, expected: Uint8Array, followStableLinks = false): Promise<void> {
  const actual = followStableLinks
    ? new Uint8Array(await readFile(path))
    : await readSecureRegularFile(root.fd, secureRelativePath(root, path), SESSION_FILE_LIMIT);
  if (actual.byteLength !== expected.byteLength || sha256(actual) !== sha256(expected)) throw new Error(`Board read-back validation failed: ${path}`);
}

async function readStableFile(path: string, limit: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(await readFile(path));
  if (bytes.byteLength > limit) throw new Error(`Board stable file exceeds the configured byte bound: ${path}`);
  return bytes;
}

async function readOptionalStableFile(path: string, limit: number): Promise<Uint8Array | undefined> {
  try {
    return await readStableFile(path, limit);
  } catch (error) {
    if (hasErrno(error, 2)) return undefined;
    throw error;
  }
}

async function assertCurrentSelector(sessionPath: string, expectedName: string | undefined): Promise<void> {
  const selectorPath = join(sessionPath, "current");
  const target = await readlink(selectorPath).catch(error => {
    const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
    if (hasErrno(error, 2) || code === "EINVAL") return undefined;
    throw error;
  });
  if (expectedName === undefined) {
    if (target !== undefined) throw new Error("Board current selector exists without a current pointer");
    return;
  }
  if (target !== undefined && target !== `boards/${expectedName}`) throw new Error("Board current selector target is invalid");
}

async function ensureStableLinks(sessionFd: number, sessionPath: string): Promise<readonly string[]> {
  const links: Readonly<Record<string, string>> = {
    "index.html": "current/index.html",
    "manifest.json": "current/manifest.json",
    "current.json": "current/current.json",
  };
  const created: string[] = [];
  try {
    for (const [name, target] of Object.entries(links)) {
      const path = join(sessionPath, name);
      if (!secureEntryExistsAt(sessionFd, name)) {
        secureSymlinkAt(sessionFd, target, name);
        created.push(name);
        secureFsync(sessionFd);
        continue;
      }
      const actual = await readlink(path).catch(() => { throw new Error(`Board stable path is not an indirection link: ${path}`); });
      if (actual !== target) throw new Error(`Board stable link target is invalid: ${path}`);
    }
    return created;
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    for (const name of created) {
      try { secureUnlinkAt(sessionFd, name); } catch (cleanupError) { if (!hasErrno(cleanupError, 2)) cleanupFailures.push(cleanupError); }
    }
    try { secureFsync(sessionFd); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
    if (cleanupFailures.length > 0) throw new AggregateError([error, ...cleanupFailures], "Board stable link setup failed");
    throw error;
  }
}

async function commitCurrentSelector(sessionFd: number, boardName: string): Promise<void> {
  const temporary = `.current-${randomUUID()}`;
  let failure: unknown;
  try {
    secureSymlinkAt(sessionFd, `boards/${boardName}`, temporary);
    secureFsync(sessionFd);
    secureRenameAt(sessionFd, temporary, sessionFd, "current");
    secureFsync(sessionFd);
  } catch (error) {
    failure = error;
  }
  let cleanupError: unknown;
  try { secureUnlinkAt(sessionFd, temporary); } catch (error) { if (!hasErrno(error, 2)) cleanupError = error; }
  if (failure !== undefined && cleanupError !== undefined) throw new AggregateError([failure, cleanupError], "Board current selector commit failed");
  if (failure !== undefined) throw failure;
  if (cleanupError !== undefined) throw cleanupError;
}


type SessionBoardDirectoryHandles = {
  sessionsFd?: number;
  sessionFd?: number;
  boardsFd?: number;
  revisionFd?: number;
  evidenceFd?: number;
  pendingName: string;
  revisionName?: string;
};

type SessionBoardDirectories = {
  sessionsFd: number;
  sessionFd: number;
  boardsFd: number;
  revisionFd: number;
  evidenceFd: number;
  pendingName: string;
  revisionName?: string;
};

function closeSessionRevisionDirectories(handles: SessionBoardDirectoryHandles): void {
  if (handles.evidenceFd !== undefined) {
    closeSecureDescriptor(handles.evidenceFd);
    handles.evidenceFd = undefined;
  }
  if (handles.revisionFd !== undefined) {
    closeSecureDescriptor(handles.revisionFd);
    handles.revisionFd = undefined;
  }
}

function closeSessionDirectories(handles: SessionBoardDirectoryHandles): void {
  closeSessionRevisionDirectories(handles);
  if (handles.boardsFd !== undefined) {
    closeSecureDescriptor(handles.boardsFd);
    handles.boardsFd = undefined;
  }
  if (handles.sessionFd !== undefined) {
    closeSecureDescriptor(handles.sessionFd);
    handles.sessionFd = undefined;
  }
  if (handles.sessionsFd !== undefined) {
    closeSecureDescriptor(handles.sessionsFd);
    handles.sessionsFd = undefined;
  }
}

async function removeTreeAt(parentFd: number, parentPath: string, name: string): Promise<void> {
  if (!SAFE_BOARD_NAME.test(name) && !name.startsWith(".pending-")) throw new Error("Board cleanup target contains unsafe characters");
  let directoryFd: number;
  try {
    directoryFd = openSecureDirectory(parentFd, name);
  } catch (error) {
    if (hasErrno(error, 2)) return;
    throw error;
  }
  const failures: unknown[] = [];
  try {
    const entries = await readdir(join(parentPath, name), { withFileTypes: true });
    for (const entry of entries) {
      try {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          await removeTreeAt(directoryFd, join(parentPath, name), entry.name);
        } else {
          secureUnlinkAt(directoryFd, entry.name);
        }
      } catch (error) {
        if (!hasErrno(error, 2)) failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `Board revision cleanup failed (${name})`);
    secureFsync(directoryFd);
  } finally {
    closeSecureDescriptor(directoryFd);
  }
  secureRmdirAt(parentFd, name);
  secureFsync(parentFd);
}

async function openSessionDirectories(root: SecureRootDescriptor, sessionKey: string, pendingName: string): Promise<SessionBoardDirectories> {
  const handles: SessionBoardDirectoryHandles = { pendingName };
  let pendingCreated = false;
  const sessionsPath = join(root.canonical, "sessions");
  const sessionPath = join(sessionsPath, sessionKey);
  const boardsPath = join(sessionPath, "boards");
  try {
    handles.sessionsFd = openOrCreateSecureDirectory(root.fd, "sessions");
    secureFsync(root.fd);
    handles.sessionFd = openOrCreateSecureDirectory(handles.sessionsFd, sessionKey);
    secureFsync(handles.sessionsFd);
    handles.boardsFd = openOrCreateSecureDirectory(handles.sessionFd, "boards");
    secureFsync(handles.sessionFd);
    secureMkdirAt(handles.boardsFd, pendingName, 0o700);
    pendingCreated = true;
    secureFsync(handles.boardsFd);
    handles.revisionFd = openSecureDirectory(handles.boardsFd, pendingName);
    secureMkdirAt(handles.revisionFd, "evidence", 0o700);
    secureFsync(handles.revisionFd);
    handles.evidenceFd = openSecureDirectory(handles.revisionFd, "evidence");
    secureFsync(handles.boardsFd);
    return handles as SessionBoardDirectories;
  } catch (error) {
    let cleanupError: unknown;
    if (pendingCreated && handles.boardsFd !== undefined) {
      try {
        if (handles.evidenceFd !== undefined) { closeSecureDescriptor(handles.evidenceFd); handles.evidenceFd = undefined; }
        if (handles.revisionFd !== undefined) { closeSecureDescriptor(handles.revisionFd); handles.revisionFd = undefined; }
        await removeTreeAt(handles.boardsFd, boardsPath, pendingName);
      } catch (caught) {
        cleanupError = caught;
      }
    }
    closeSessionDirectories(handles);
    if (cleanupError !== undefined) throw new AggregateError([error, cleanupError], "Board pending revision cleanup failed");
    throw error;
  }
}

function parseSessionCurrentBytes(bytes: Uint8Array, sessionKey: string): SessionBoardCurrent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Board current pointer is malformed");
  }
  const value = sessionObject(parsed, "Board current pointer");
  sessionKeys(value, ["schemaVersion", "sessionKey", "sourceRevision", "invocationId", "revisionPath", "entrypoint", "entrypointSha256", "manifestSha256", "sessionRef", "generatedAt", "authoritative"]);
  if (value.schemaVersion !== "traceknot-session-board-current/v1") throw new Error("unsupported Board current pointer schemaVersion");
  if (value.sessionKey !== sessionKey) throw new Error("Board current pointer session key is invalid");
  sessionInteger(value.sourceRevision, "current.sourceRevision");
  sessionId(value.invocationId, "current.invocationId", 128);
  if (!SAFE_ENTRY.test(value.invocationId as string)) throw new Error("current.invocationId contains unsafe characters");
  const revisionPath = sessionText(value.revisionPath, "current.revisionPath", 512);
  if (!/^boards\/(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(revisionPath)) throw new Error("current.revisionPath is unsafe");
  if (value.entrypoint !== "index.html") throw new Error("current.entrypoint is invalid");
  sessionDigest(value.entrypointSha256, "current.entrypointSha256");
  sessionDigest(value.manifestSha256, "current.manifestSha256");
  sessionText(value.sessionRef, "current.sessionRef");
  validSessionTimestamp(value.generatedAt, "current.generatedAt");
  if (value.authoritative !== false) throw new Error("current.authoritative must be false");
  return Object.freeze(value as SessionBoardCurrent);
}

function revisionNameFromCurrent(current: SessionBoardCurrent | undefined): string | undefined {
  if (current === undefined) return undefined;
  const name = current.revisionPath.slice("boards/".length);
  if (!SAFE_BOARD_NAME.test(name)) throw new Error("current.revisionPath is unsafe");
  return name;
}

function compareStableSelection(sourceRevision: number, generatedAt: string, invocationId: string, current: SessionBoardCurrent): number {
  if (sourceRevision !== current.sourceRevision) return sourceRevision - current.sourceRevision;
  const generatedOrder = Date.parse(generatedAt) - Date.parse(current.generatedAt);
  if (generatedOrder !== 0) return generatedOrder;
  return invocationId.localeCompare(current.invocationId);
}

async function sessionDirectoryBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Board revision contains a symlink: ${join(path, entry.name)}`);
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await sessionDirectoryBytes(child);
    else if (entry.isFile()) total += (await statPath(child)).size;
    else throw new Error(`Board revision contains an unsupported entry: ${child}`);
  }
  return total;
}

type SessionRevision = {
  name: string;
  path: string;
  bytes: number;
  generatedAt: number;
  sourceRevision: number;
  runId?: string;
  sourceState?: string;
  malformed: boolean;
};

async function sessionReclaim(
  root: SecureRootDescriptor,
  boardsFd: number,
  boardsPath: string,
  sessionKey: string,
  currentName: string | undefined,
  newName: string | undefined,
  policy: Readonly<{ boardMaxPerSession?: number; boardQuotaBytes?: number }>,
  apply: boolean,
): Promise<void> {
  const entries = await readdir(boardsPath, { withFileTypes: true }).catch(() => []);
  const revisions: SessionRevision[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_BOARD_NAME.test(entry.name)) continue;
    const path = join(boardsPath, entry.name);
    const manifestBytes = await readOptionalSecure(root, join(path, "manifest.json"), 4 * 1024 * 1024);
    let manifestValue: UnknownRecord | undefined;
    if (manifestBytes !== undefined) {
      try {
        manifestValue = sessionObject(JSON.parse(new TextDecoder().decode(manifestBytes)), "Board manifest");
      } catch {
        manifestValue = undefined;
      }
    }
    const generatedAt = manifestValue && typeof manifestValue.generatedAt === "string" && ISO_TIMESTAMP.test(manifestValue.generatedAt) ? Date.parse(manifestValue.generatedAt) : NaN;
    const sourceRevision = manifestValue && typeof manifestValue.sourceRevision === "number" && Number.isSafeInteger(manifestValue.sourceRevision) && manifestValue.sourceRevision >= 0 ? manifestValue.sourceRevision : -1;
    revisions.push({ name: entry.name, path, bytes: await sessionDirectoryBytes(path), generatedAt, sourceRevision, runId: manifestValue && typeof manifestValue.runId === "string" ? manifestValue.runId : undefined, sourceState: manifestValue && typeof manifestValue.sourceState === "string" ? manifestValue.sourceState : undefined, malformed: manifestValue === undefined || !Number.isFinite(generatedAt) || sourceRevision < 0 });
  }
  const pinsBytes = await readOptionalSecure(root, join(root.canonical, ".traceknot-pins.json"), 1024 * 1024);
  let pinned: Set<string>;
  if (pinsBytes === undefined) {
    pinned = new Set();
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(pinsBytes));
    } catch {
      throw new Error("Board pin file is malformed");
    }
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string" || !SAFE_ENTRY.test(item))) {
      throw new Error("Board pin file is malformed");
    }
    pinned = new Set(parsed);
  }
  const terminal = revisions
    .filter(item => !item.malformed && item.sourceState === "TERMINAL")
    .sort((a, b) => b.sourceRevision - a.sourceRevision || b.generatedAt - a.generatedAt || a.name.localeCompare(b.name))[0]?.name;
  const protectedNames = new Set([currentName, newName, terminal, ...revisions.filter(item => item.runId !== undefined && pinned.has(item.runId)).map(item => item.name)].filter((item): item is string => item !== undefined));
  let bytes = revisions.reduce((sum, item) => sum + item.bytes, 0);
  let count = revisions.length;
  const max = policy.boardMaxPerSession ?? SESSION_BOARD_MAX_DEFAULT;
  const quota = policy.boardQuotaBytes ?? SESSION_BOARD_QUOTA_DEFAULT;
  if (!Number.isSafeInteger(max) || max < 0) throw new Error("boardMaxPerSession must be a non-negative integer");
  if (!Number.isSafeInteger(quota) || quota < 0) throw new Error("boardQuotaBytes must be a non-negative integer");
  const removable = revisions.filter(item => !protectedNames.has(item.name) && !item.malformed).sort((a, b) => a.sourceRevision - b.sourceRevision || a.generatedAt - b.generatedAt || a.name.localeCompare(b.name));
  const selected: SessionRevision[] = [];
  let predictedCount = count;
  let predictedBytes = bytes;
  for (const candidate of removable) {
    if (predictedCount <= max && predictedBytes <= quota) break;
    selected.push(candidate);
    predictedCount -= 1;
    predictedBytes -= candidate.bytes;
  }
  if (predictedCount > max || predictedBytes > quota) throw new Error(`Board publication quota exceeded for session ${sessionKey}`);
  if (!apply) return;
  for (const candidate of selected) {
    await removeTreeAt(boardsFd, boardsPath, candidate.name);
    bytes -= candidate.bytes;
    count -= 1;
  }
}

export async function verifySessionBoardPublication(stateDir: string, publication: SessionBoardPublicationResult): Promise<void> {
  const root = await openSecureRoot(resolve(stateDir));
  try {
    assertPrivateRootPath(root, "Board state");
    const stableRoot = join(root.canonical, "sessions", publication.sessionKey);
    const expectedLinks: Readonly<Record<string, string>> = { "index.html": "current/index.html", "manifest.json": "current/manifest.json", "current.json": "current/current.json" };
    for (const [name, target] of Object.entries(expectedLinks)) {
      const actual = await readlink(join(stableRoot, name)).catch(() => undefined);
      if (actual !== target) throw new Error(`Board stable link target is invalid: ${name}`);
    }
    const selectorTarget = await readlink(join(stableRoot, "current")).catch(() => undefined);
    const expectedName = revisionNameFromCurrent(publication.current);
    if (selectorTarget !== `boards/${expectedName}`) throw new Error("Board current selector target is invalid");
    const stableBytes = await readStableFile(publication.entrypoint, SESSION_FILE_LIMIT);
    const stableManifestBytes = await readStableFile(join(resolve(publication.entrypoint, ".."), "manifest.json"), 4 * 1024 * 1024);
    const currentBytes = await readStableFile(publication.currentPath, 1024 * 1024);
    const current = parseSessionCurrentBytes(currentBytes, publication.sessionKey);
    const expectedRevisionPath = relative(join(root.canonical, "sessions", publication.sessionKey), publication.directory);
    if (current.revisionPath !== expectedRevisionPath || current.entrypoint !== "index.html" || current.authoritative !== false) throw new Error("Board current pointer identity is invalid");
    if (current.entrypointSha256 !== sha256(stableBytes) || current.manifestSha256 !== sha256(stableManifestBytes)) throw new Error("Board stable file hashes do not match current pointer");
    if (JSON.stringify(current) !== JSON.stringify(publication.current)) throw new Error("Board current pointer changed before open");
    const revisionManifestBytes = await readSecureRegularFile(root.fd, secureRelativePath(root, join(publication.directory, "manifest.json")), 4 * 1024 * 1024);
    const revisionManifest = JSON.parse(new TextDecoder().decode(revisionManifestBytes)) as QaBoardManifest;
    if (JSON.stringify(revisionManifest) !== JSON.stringify(publication.manifest)) throw new Error("Board immutable manifest changed before open");
    if (revisionManifest.authoritative !== false || revisionManifest.generatedBy.sessionRef !== current.sessionRef) throw new Error("Board immutable manifest identity is invalid");
    for (const file of revisionManifest.files) {
      const bytes = await readSecureRegularFile(root.fd, secureRelativePath(root, join(publication.directory, file.path)), SESSION_FILE_LIMIT);
      if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Board immutable file changed before open: ${file.path}`);
    }
    if (sha256(stableManifestBytes) !== current.manifestSha256) throw new Error("Board stable manifest does not match immutable manifest");
    assertSecureRoot(root);
  } finally {
    await closeSecureRoot(root);
  }
}

export async function publishSessionBoardUpdate(input: Readonly<{
  update: SessionBoardUpdate;
  stateDir: string;
  artifactReader: BoardArtifactReader;
  locale?: QaBoardLocale;
  retentionPolicy?: Readonly<{ boardMaxPerSession?: number; boardQuotaBytes?: number }>;
  showProjectSupport?: boolean;
}>): Promise<SessionBoardPublicationResult> {
  const update = parseSessionBoardUpdate(input.update);
  if (sessionPresentationContains(update.view, update.sessionId)) throw new Error("Board view contains the raw session ID");
  const invocationId = update.invocationId ?? randomUUID();
  const sessionKey = sessionBoardKey(update.sessionHost, update.sessionId);
  const boardName = `${update.view.revision}-${invocationId}`;
  if (!SAFE_BOARD_NAME.test(boardName)) throw new Error("Board revision contains unsafe characters");
  const pendingName = `.pending-${randomUUID()}`;
  const root = await openSecureRoot(resolve(input.stateDir));
  let maintenanceFd: number | undefined;
  let directories: SessionBoardDirectories | undefined;
  let revisionPublished = false;
  let selectorCommitted = false;
  let publicationCommitted = false;
  let failure: unknown;
  let releaseFailure: unknown;
  let result: SessionBoardPublicationResult | undefined;
  let createdStableLinks: readonly string[] = [];
  let previousName: string | undefined;
  let previousCurrent: SessionBoardCurrent | undefined;
  let sessionRoot = "";
  let boardsPath = "";
  let stablePath = "";
  let stableManifestPath = "";
  let currentPath = "";
  try {
    assertPrivateRootPath(root, "Board state");
    maintenanceFd = secureOpenAt(root.fd, STORAGE_MAINTENANCE_LOCK_FILE, LOCK_FLAGS, 0o600);
    await acquireSecureFlock(maintenanceFd, LOCK_EX, "Board publication maintenance lock");
    directories = await openSessionDirectories(root, sessionKey, pendingName);
    sessionRoot = join(root.canonical, "sessions", sessionKey);
    boardsPath = join(sessionRoot, "boards");
    stablePath = join(sessionRoot, "index.html");
    stableManifestPath = join(sessionRoot, "manifest.json");
    currentPath = join(sessionRoot, "current.json");
    const priorCurrentBytes = await readOptionalStableFile(currentPath, 1024 * 1024);
    previousCurrent = priorCurrentBytes === undefined ? undefined : parseSessionCurrentBytes(priorCurrentBytes, sessionKey);
    previousName = revisionNameFromCurrent(previousCurrent);
    await assertCurrentSelector(sessionRoot, previousName);
    if (previousName !== undefined && !secureEntryExistsAt(directories.boardsFd, previousName)) throw new Error("Board current pointer references a missing revision");
    const copied = new Set<string>();
    const files: QaBoardManifestFile[] = [];
    let screenshotCount = 0;
    let totalBytes = 0;
    for (const finding of update.view.findings) {
      for (const screenshot of finding.screenshots) {
        if (copied.has(screenshot.digest) || screenshotCount >= QA_BOARD_LIMITS.maxScreenshotCount) continue;
        const bytes = await input.artifactReader.readArtifact(screenshot.digest);
        if (bytes.byteLength > QA_BOARD_LIMITS.maxScreenshotBytes || totalBytes + bytes.byteLength > QA_BOARD_LIMITS.maxTotalPreviewBytes) continue;
        if (sha256(bytes) !== screenshot.digest) throw new Error(`screenshot artifact digest mismatch: ${screenshot.digest}`);
        const evidenceName = `${screenshot.digest}.png`;
        await writeAtomic(directories.evidenceFd, evidenceName, bytes);
        copied.add(screenshot.digest);
        screenshotCount += 1;
        totalBytes += bytes.byteLength;
        files.push({ path: `evidence/${evidenceName}`, role: "screenshot-preview", sha256: screenshot.digest, bytes: bytes.byteLength, artifactDigest: screenshot.digest, observationId: screenshot.observationId });
      }
    }
    const view = availableScreenshots(update.view, copied);
    const showProjectSupport = input.showProjectSupport ?? shouldShowProjectSupport(root.fd);
    const renderOptions: QaBoardRenderOptions = { showProjectSupport };
    const pageFiles: QaBoardManifestFile[] = [];
    const html = sessionAtomicBytes(renderQaBoardHtml(view, input.locale ?? "en", renderOptions));
    await writeAtomic(directories.revisionFd, "index.html", html);
    pageFiles.push({ path: "index.html", role: "entrypoint", sha256: sha256(html), bytes: html.byteLength });
    for (const pageLocale of QA_BOARD_LOCALES) {
      const path = `index.${pageLocale}.html`;
      const localized = sessionAtomicBytes(renderQaBoardHtml(view, pageLocale, renderOptions));
      await writeAtomic(directories.revisionFd, path, localized);
      pageFiles.push({ path, role: "localized-view", sha256: sha256(localized), bytes: localized.byteLength });
    }
    files.unshift(...pageFiles);
    const manifest = { ...buildQaBoardManifest({ view, generatedAt: update.generatedAt, invocationId, sessionHost: update.sessionHost, sessionRef: sessionReference(update.sessionHost, update.sessionId), files }), sessionKey };
    const manifestBytes = sessionAtomicBytes(`${JSON.stringify(manifest, null, 2)}\n`);
    const incomingCurrent: SessionBoardCurrent = {
      schemaVersion: "traceknot-session-board-current/v1",
      sessionKey,
      sourceRevision: update.view.revision,
      invocationId,
      revisionPath: `boards/${boardName}`,
      entrypoint: "index.html",
      entrypointSha256: sha256(html),
      manifestSha256: sha256(manifestBytes),
      sessionRef: sessionReference(update.sessionHost, update.sessionId),
      generatedAt: update.generatedAt,
      authoritative: false,
    };
    await writeAtomic(directories.revisionFd, "manifest.json", manifestBytes);
    const currentBytes = sessionAtomicBytes(`${JSON.stringify(incomingCurrent, null, 2)}\n`);
    await writeAtomic(directories.revisionFd, "current.json", currentBytes);
    secureFsync(directories.evidenceFd);
    secureFsync(directories.revisionFd);
    try {
      secureRenameAt(directories.boardsFd, pendingName, directories.boardsFd, boardName);
    } catch (error) {
      if (isExistingTarget(error)) throw new Error(`Board invocation already exists (${boardName}); choose a new invocationId`);
      throw error;
    }
    directories.revisionName = boardName;
    revisionPublished = true;
    secureFsync(directories.boardsFd);
    await sessionReadback(root, join(boardsPath, boardName, "index.html"), html);
    await sessionReadback(root, join(boardsPath, boardName, "manifest.json"), manifestBytes);
    const incomingWins = previousCurrent === undefined || compareStableSelection(update.view.revision, update.generatedAt, invocationId, previousCurrent) > 0;
    await sessionReclaim(root, directories.boardsFd, boardsPath, sessionKey, previousName, incomingWins ? boardName : undefined, input.retentionPolicy ?? {}, false);
    if (incomingWins) {
      createdStableLinks = await ensureStableLinks(directories.sessionFd, sessionRoot);
      selectorCommitted = true;
      await commitCurrentSelector(directories.sessionFd, boardName);
    }
    const selectedCurrent = incomingWins ? incomingCurrent : previousCurrent!;
    const selectedName = revisionNameFromCurrent(selectedCurrent)!;
    const selectedManifestBytes = await readSecureRegularFile(root.fd, secureRelativePath(root, join(boardsPath, selectedName, "manifest.json")), 4 * 1024 * 1024);
    const selectedManifest = incomingWins ? manifest : JSON.parse(new TextDecoder().decode(selectedManifestBytes)) as QaBoardManifest;
    const publication: SessionBoardPublicationResult = {
      sessionKey,
      directory: join(boardsPath, selectedName),
      entrypoint: stablePath,
      entrypointUri: pathToFileURL(stablePath).href,
      currentPath,
      current: selectedCurrent,
      manifest: selectedManifest,
      projectSupportIncluded: showProjectSupport,
    };
    await sessionReadback(root, stablePath, await readStableFile(stablePath, SESSION_FILE_LIMIT), true);
    await sessionReadback(root, stableManifestPath, await readStableFile(stableManifestPath, 4 * 1024 * 1024), true);
    await sessionReadback(root, currentPath, await readStableFile(currentPath, 1024 * 1024), true);
    await verifySessionBoardPublication(input.stateDir, publication);
    publicationCommitted = true;
    await sessionReclaim(root, directories.boardsFd, boardsPath, sessionKey, selectedName, undefined, input.retentionPolicy ?? {}, true);
    result = publication;
  } catch (error) {
    failure = error;
    const cleanupFailures: unknown[] = [];
    if (!publicationCommitted && selectorCommitted && directories !== undefined) {
      try {
        if (previousName !== undefined) await commitCurrentSelector(directories.sessionFd, previousName);
        else { secureUnlinkAt(directories.sessionFd, "current"); secureFsync(directories.sessionFd); }
      } catch (rollbackError) { cleanupFailures.push(rollbackError); }
    }
    if (!publicationCommitted && createdStableLinks.length > 0 && directories !== undefined) {
      for (const name of createdStableLinks) {
        try { secureUnlinkAt(directories.sessionFd, name); } catch (cleanupError) { if (!hasErrno(cleanupError, 2)) cleanupFailures.push(cleanupError); }
      }
      try { secureFsync(directories.sessionFd); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
    }
    if (!publicationCommitted && directories !== undefined) {
      closeSessionRevisionDirectories(directories);
      try { await removeTreeAt(directories.boardsFd, boardsPath, revisionPublished ? boardName : pendingName); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
    }
    if (cleanupFailures.length > 0) failure = new AggregateError([failure, ...cleanupFailures], "Board publication failed and cleanup was incomplete");
  } finally {
    if (maintenanceFd !== undefined) {
      try { secureFlock(maintenanceFd, LOCK_UN); } catch (error) { releaseFailure = error; }
      closeSecureDescriptor(maintenanceFd);
    }
    if (directories !== undefined) closeSessionDirectories(directories);
    await closeSecureRoot(root);
  }
  if (failure !== undefined && releaseFailure !== undefined) throw new AggregateError([failure, releaseFailure], "Board publication and lock release failed");
  if (failure !== undefined) throw failure;
  if (releaseFailure !== undefined) throw releaseFailure;
  if (result === undefined) throw new Error("Board publication did not produce a result");
  return result;
}
