import { constants, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  acquireSecureFlock,
  closeSecureDescriptor,
  closeSecureRoot,
  openOrCreateSecureDirectory,
  openSecureDirectory,
  openSecureRoot,
  secureFsync,
  secureMkdirAt,
  secureOpenAt,
  secureRenameAt,
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
}>;

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
const LOCK_SH = 1;
const LOCK_UN = 8;

function assertSafeEntry(value: string, label: string): void {
  if (!SAFE_ENTRY.test(value)) throw new Error(`${label} contains unsafe characters`);
}

function hasErrno(error: unknown, value: number): boolean {
  return error instanceof Error && error.message.includes(`errno ${value}`);
}

function isExistingTarget(error: unknown): boolean {
  return hasErrno(error, 17) || hasErrno(error, 39) || hasErrno(error, 66);
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
  try {
    fd = secureOpenAt(directoryFd, temporary, WRITE_FLAGS, 0o600);
    writeBytes(fd, bytes);
    secureFsync(fd);
    closeSecureDescriptor(fd);
    fd = undefined;
    secureRenameAt(directoryFd, temporary, directoryFd, name);
    secureFsync(directoryFd);
  } finally {
    if (fd !== undefined) closeSecureDescriptor(fd);
    try { secureUnlinkAt(directoryFd, temporary); } catch { /* renamed or absent */ }
  }
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
    const html = new TextEncoder().encode(renderQaBoardHtml(view, locale));
    await writeAtomic(directories.boardFd, "index.html", html);
    const pageFiles: QaBoardManifestFile[] = [{ path: "index.html", role: "entrypoint", sha256: sha256(html), bytes: html.byteLength }];
    for (const pageLocale of QA_BOARD_LOCALES) {
      const path = `index.${pageLocale}.html`;
      const localizedHtml = new TextEncoder().encode(renderQaBoardHtml(view, pageLocale));
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
    result = { directory, entrypoint, manifest };
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
