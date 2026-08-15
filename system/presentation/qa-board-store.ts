import { constants, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  closeSecureDescriptor,
  closeSecureRoot,
  openOrCreateSecureDirectory,
  openSecureDirectory,
  openSecureRoot,
  secureFsync,
  secureMkdirAt,
  secureOpenAt,
  secureRenameAt,
  secureUnlinkAt,
  type SecureRootDescriptor,
} from "../runtime/local-artifact-store";
import {
  buildQaBoardManifest,
  renderQaBoardHtml,
  sessionReference,
  sha256,
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
const SAFE_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0) | ((constants as Record<string, number | undefined>).O_CLOEXEC ?? 0);

function assertSafeEntry(value: string, label: string): void {
  if (!SAFE_ENTRY.test(value)) throw new Error(`${label} contains unsafe characters`);
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

async function openBoardDirectories(root: SecureRootDescriptor, view: QaBoardView, boardName: string): Promise<{ runsFd: number; runFd: number; boardsFd: number; boardFd: number; evidenceFd: number }> {
  const runsFd = openOrCreateSecureDirectory(root.fd, "runs");
  let runFd: number | undefined;
  let boardsFd: number | undefined;
  let boardFd: number | undefined;
  let evidenceFd: number | undefined;
  try {
    runFd = openSecureDirectory(runsFd, view.runId);
    boardsFd = openOrCreateSecureDirectory(runFd, "boards");
    try {
      secureMkdirAt(boardsFd, boardName, 0o700);
    } catch (error) {
      if (error instanceof Error && /\(errno 17\)$/.test(error.message)) {
        throw new Error(`Board invocation already exists (${boardName}); choose a new --invocation-id`);
      }
      throw error;
    }
    boardFd = openSecureDirectory(boardsFd, boardName);
    secureMkdirAt(boardFd, "evidence", 0o700);
    evidenceFd = openSecureDirectory(boardFd, "evidence");
    return { runsFd, runFd, boardsFd, boardFd, evidenceFd };
  } catch (error) {
    if (evidenceFd !== undefined) closeSecureDescriptor(evidenceFd);
    if (boardFd !== undefined) closeSecureDescriptor(boardFd);
    if (boardsFd !== undefined) closeSecureDescriptor(boardsFd);
    if (runFd !== undefined) closeSecureDescriptor(runFd);
    closeSecureDescriptor(runsFd);
    throw error;
  }
}

function closeBoardDirectories(directories: { runsFd: number; runFd: number; boardsFd: number; boardFd: number; evidenceFd: number }): void {
  closeSecureDescriptor(directories.evidenceFd);
  closeSecureDescriptor(directories.boardFd);
  closeSecureDescriptor(directories.boardsFd);
  closeSecureDescriptor(directories.runFd);
  closeSecureDescriptor(directories.runsFd);
}

export async function writeQaBoardBundle(input: BoardBundleInput): Promise<BoardBundleResult> {
  const invocationId = input.invocationId ?? randomUUID();
  const sessionHost = input.sessionHost ?? "unavailable";
  assertSafeEntry(input.view.runId, "run ID");
  assertSafeEntry(invocationId, "invocation ID");
  if (!Number.isInteger(input.view.revision) || input.view.revision < 0) throw new Error("Board source revision must be a non-negative integer");
  const boardName = `${input.view.revision}-${invocationId}`;
  assertSafeEntry(boardName, "Board directory");
  const root = await openSecureRoot(resolve(input.stateDir));
  let directories: { runsFd: number; runFd: number; boardsFd: number; boardFd: number; evidenceFd: number } | undefined;
  try {
    directories = await openBoardDirectories(root, input.view, boardName);
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
        await writeAtomic(directories.evidenceFd, `${screenshot.digest}.png`, bytes);
        copied.add(screenshot.digest);
        screenshotCount += 1;
        totalBytes += bytes.byteLength;
        files.push({ path: `evidence/${screenshot.digest}.png`, role: "screenshot-preview", sha256: screenshot.digest, artifactDigest: screenshot.digest, observationId: screenshot.observationId });
      }
    }
    const view = availableScreenshots(input.view, copied);
    const html = new TextEncoder().encode(renderQaBoardHtml(view));
    await writeAtomic(directories.boardFd, "index.html", html);
    files.unshift({ path: "index.html", role: "entrypoint", sha256: sha256(html) });
    const manifest = buildQaBoardManifest({ view, generatedAt: input.generatedAt, invocationId, sessionHost, sessionRef: sessionReference(sessionHost, input.sessionId), files });
    await writeAtomic(directories.boardFd, "manifest.json", new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
    const directory = join(resolve(input.stateDir), "runs", input.view.runId, "boards", boardName);
    return { directory, entrypoint: join(directory, "index.html"), manifest };
  } finally {
    if (directories) closeBoardDirectories(directories);
    await closeSecureRoot(root);
  }
}
