import { constants, readSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  CanonicalRunState,
  DispatchClaim,
  DispatchClaimResult,
  ExecutionCheckpointTransition,
  RepositoryPort,
  RepositoryTransition,
  StageDocument,
  StageName,
  TerminalEvidenceVerdictTransition,
  VerificationExecutionCompletionEnvelope,
} from "./verification-run";
import { DispatchClaimAcquisitionError as ClaimError } from "./verification-run";
import { canonicalizeJson } from "./verification-run";
import {
  acquireSecureFlock,
  assertSecureRoot,
  closeSecureDescriptor,
  closeSecureRoot,
  openSecureDirectory,
  openSecureRegularFile,
  openSecureRoot,
  readSecureRegularFile,
  secureFlock,
  secureFsync,
  secureMkdirAt,
  secureOpenAt,
  secureRenameAt,
  secureUnlinkAt,
  STORAGE_MAINTENANCE_LOCK_FILE,
  type SecureRootDescriptor,
} from "./local-artifact-store";

export type VerificationStateMetadata = Readonly<{
  schemaVersion: "traceknot-cli-state/v1";
  rootIdentity: string;
  snapshotId: string;
  manifestDigest: string;
  capabilities: readonly string[];
}>;

type DispatchRecord = Readonly<{
  claim: DispatchClaim;
  status: "CLAIMED" | "COMPLETED";
  outputStored: boolean;
  completion?: VerificationExecutionCompletionEnvelope;
}>;
type PersistedState = {
  schemaVersion: "traceknot-state/v1";
  run?: CanonicalRunState;
  documents: Partial<Record<StageName, StageDocument>>;
  dispatch: Record<string, DispatchRecord>;
};

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_CLOEXEC = (constants as Record<string, number | undefined>).O_CLOEXEC ?? 0;
const DIRECTORY_FLAGS = constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC;
const READ_FLAGS = constants.O_RDONLY | O_NOFOLLOW | O_CLOEXEC;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW | O_CLOEXEC;
const LOCK_FLAGS = constants.O_RDWR | constants.O_CREAT | O_NOFOLLOW | O_CLOEXEC;
const ENOENT = 2;
const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_UN = 8;

function assertSafeValue(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error("cyclic state is not supported");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) assertSafeValue(child, seen);
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) throw new Error(`unsafe state key: ${key}`);
      assertSafeValue(child, seen);
    }
  }
  seen.delete(value);
}

function isErrno(error: unknown, code: number): boolean {
  return error instanceof Error && new RegExp(`errno ${code}\\b`).test(error.message);
}
function emptyState(): PersistedState {
  return { schemaVersion: "traceknot-state/v1", documents: {}, dispatch: {} };
}
function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId) || runId.includes("..")) throw new Error("runId contains unsafe characters");
}
function relativeRunPath(runId: string, file: string): string {
  assertRunId(runId);
  return `runs/${runId}/${file}`;
}
function asState(value: unknown): PersistedState {
  if (!value) return emptyState();
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid persisted state");
  const state = value as Partial<PersistedState>;
  if (state.schemaVersion !== "traceknot-state/v1" || !state.documents || typeof state.documents !== "object" || !state.dispatch || typeof state.dispatch !== "object") throw new Error("invalid persisted state");
  assertSafeValue(state);
  return { schemaVersion: "traceknot-state/v1", run: state.run, documents: state.documents as PersistedState["documents"], dispatch: state.dispatch as PersistedState["dispatch"] };
}

async function readJson(root: SecureRootDescriptor, relativePath: string): Promise<unknown | undefined> {
  try {
    const bytes = await readSecureRegularFile(root.fd, relativePath, MAX_STATE_BYTES);
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    assertSafeValue(value);
    return value;
  } catch (error) {
    if (isErrno(error, ENOENT)) return undefined;
    throw error;
  }
}
function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset, null);
    if (written <= 0) throw new Error("state write made no progress");
    offset += written;
  }
}
function closeQuietly(fd: number | undefined): void {
  if (fd !== undefined) closeSecureDescriptor(fd);
}
function ensureDirectoryAt(parentFd: number, name: string): void {
  try { secureMkdirAt(parentFd, name, 0o700); } catch (error) { if (!isErrno(error, 17)) throw error; }
  const fd = secureOpenAt(parentFd, name, DIRECTORY_FLAGS, 0);
  closeQuietly(fd);
  secureFsync(parentFd);
}
async function openRunDirectory(root: SecureRootDescriptor, runId: string, create: boolean): Promise<{ runsFd: number; runFd: number } | undefined> {
  assertRunId(runId);
  assertSecureRoot(root);
  let runsFd: number;
  try { runsFd = openSecureDirectory(root.fd, "runs"); }
  catch (error) {
    if (!create || !isErrno(error, ENOENT)) throw error;
    ensureDirectoryAt(root.fd, "runs");
    runsFd = openSecureDirectory(root.fd, "runs");
  }
  try {
    let runFd: number;
    try { runFd = secureOpenAt(runsFd, runId, DIRECTORY_FLAGS, 0); }
    catch (error) {
      if (!create || !isErrno(error, ENOENT)) throw error;
      ensureDirectoryAt(runsFd, runId);
      runFd = secureOpenAt(runsFd, runId, DIRECTORY_FLAGS, 0);
    }
    return { runsFd, runFd };
  } catch (error) {
    closeQuietly(runsFd);
    throw error;
  }
}
async function atomicWriteAt(runFd: number, name: string, value: unknown): Promise<void> {
  assertSafeValue(value);
  const encoded = Buffer.from(canonicalizeJson(value), "utf8");
  const temporary = `.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = secureOpenAt(runFd, temporary, WRITE_FLAGS, 0o600);
    writeAll(fd, encoded);
    secureFsync(fd);
    closeQuietly(fd);
    fd = undefined;
    secureRenameAt(runFd, temporary, runFd, name);
    secureFsync(runFd);
  } finally {
    closeQuietly(fd);
    try { secureUnlinkAt(runFd, temporary); } catch { /* already renamed */ }
  }
}
async function acquireStateLock(runFd: number): Promise<() => Promise<void>> {
  const fd = secureOpenAt(runFd, ".state.lock", LOCK_FLAGS, 0o600);
  try {
    await acquireSecureFlock(fd, LOCK_EX, "durable run state lock");
    return async () => {
      try { secureFlock(fd, LOCK_UN); }
      finally { closeQuietly(fd); }
    };
  } catch (error) {
    closeQuietly(fd);
    throw error;
  }
}

/** Atomic, append-oriented JSON repository used by the verify CLI. */
export class FileVerificationRepository implements RepositoryPort {
  readonly generationFencedDispatchCompletion = true;
  readonly generationFencedDispatchCheckpoint = true;
  readonly rootDir: string;
  private readonly operations = new Map<string, Promise<void>>();
  private rootPromise: Promise<SecureRootDescriptor> | undefined;
  constructor(rootDir: string) {
    if (typeof rootDir !== "string" || !rootDir) throw new Error("state root is required");
    this.rootDir = rootDir;
  }
  private root(): Promise<SecureRootDescriptor> {
    this.rootPromise ??= openSecureRoot(this.rootDir);
    return this.rootPromise;
  }
  private async withPinnedRoot<T>(operation: (root: SecureRootDescriptor) => Promise<T>): Promise<T> {
    const root = await this.root();
    assertSecureRoot(root);
    const maintenanceFd = secureOpenAt(root.fd, STORAGE_MAINTENANCE_LOCK_FILE, LOCK_FLAGS, 0o600);
    let locked = false;
    try {
      await acquireSecureFlock(maintenanceFd, LOCK_SH, "storage maintenance lock");
      locked = true;
      return await operation(root);
    } finally {
      try { if (locked) secureFlock(maintenanceFd, LOCK_UN); }
      finally { closeQuietly(maintenanceFd); assertSecureRoot(root); }
    }
  }
  private async serialize<T>(runId: string, operation: (runFd: number) => Promise<T>): Promise<T> {
    const prior = this.operations.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolvePromise => { release = resolvePromise; });
    const chain = prior.then(() => current);
    this.operations.set(runId, chain);
    await prior;
    let root: SecureRootDescriptor | undefined;
    let directories: { runsFd: number; runFd: number } | undefined;
    let unlock: (() => Promise<void>) | undefined;
    let maintenanceFd: number | undefined;
    let maintenanceLocked = false;
    try {
      root = await this.root();
      maintenanceFd = secureOpenAt(root.fd, STORAGE_MAINTENANCE_LOCK_FILE, LOCK_FLAGS, 0o600);
      await acquireSecureFlock(maintenanceFd, LOCK_SH, "storage maintenance lock");
      maintenanceLocked = true;
      directories = await openRunDirectory(root, runId, true);
      if (!directories) throw new Error("run directory could not be opened");
      unlock = await acquireStateLock(directories.runFd);
      return await operation(directories.runFd);
    } finally {
      try {
        if (unlock) await unlock();
      } finally {
        try {
          if (maintenanceFd !== undefined) {
            try { if (maintenanceLocked) secureFlock(maintenanceFd, LOCK_UN); }
            finally { closeQuietly(maintenanceFd); }
          }
        } finally {
          if (directories) { closeQuietly(directories.runFd); closeQuietly(directories.runsFd); }
          try { if (root) assertSecureRoot(root); }
          finally { release(); if (this.operations.get(runId) === chain) this.operations.delete(runId); }
        }
      }
    }
  }
  private async loadState(runId: string): Promise<PersistedState | undefined> {
    return this.withPinnedRoot(async root => {
      const value = await readJson(root, relativeRunPath(runId, "state.json"));
      return value === undefined ? undefined : asState(value);
    });
  }
  private async loadStateAt(runFd: number): Promise<PersistedState | undefined> {
    try {
      const bytes = await readSecureRegularFile(runFd, "state.json", MAX_STATE_BYTES);
      return asState(JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown);
    } catch (error) {
      if (isErrno(error, ENOENT)) return undefined;
      throw error;
    }
  }
  private async saveStateAt(runFd: number, state: PersistedState): Promise<void> { await atomicWriteAt(runFd, "state.json", state); }
  async readMetadata(runId: string): Promise<VerificationStateMetadata | undefined> {
    return this.withPinnedRoot(async root => {
      const value = await readJson(root, relativeRunPath(runId, "metadata.json"));
      if (value === undefined) return undefined;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid CLI state metadata");
      const metadata = value as Partial<VerificationStateMetadata>;
      if (metadata.schemaVersion !== "traceknot-cli-state/v1" || typeof metadata.rootIdentity !== "string" || typeof metadata.snapshotId !== "string" || typeof metadata.manifestDigest !== "string" || !Array.isArray(metadata.capabilities) || metadata.capabilities.some(item => typeof item !== "string")) throw new Error("invalid CLI state metadata");
      return metadata as VerificationStateMetadata;
    });
  }
  async writeMetadata(runId: string, metadata: VerificationStateMetadata): Promise<void> {
    if (metadata.schemaVersion !== "traceknot-cli-state/v1") throw new Error("invalid CLI state metadata");
    await this.serialize(runId, async runFd => { await atomicWriteAt(runFd, "metadata.json", metadata); });
  }
  async loadRun(runId: string): Promise<CanonicalRunState | undefined> { return (await this.loadState(runId))?.run; }
  async loadStageDocument(runId: string, stage: StageName): Promise<unknown | undefined> { return (await this.loadState(runId))?.documents[stage]; }
  async commitTransition(transition: RepositoryTransition): Promise<boolean> {
    return this.serialize(transition.runId, async runFd => {
      const state = (await this.loadStateAt(runFd)) ?? emptyState();
      if (state.run && transition.expectedRevision !== undefined && state.run.revision !== transition.expectedRevision) return false;
      if (!state.run && transition.expectedRevision !== undefined) return false;
      if (transition.run.runId !== transition.runId) throw new Error("run identity mismatch");
      const documents = { ...state.documents };
      if (transition.stage !== undefined) {
        if (transition.document === undefined) throw new Error("stage document is required");
        documents[transition.stage] = transition.document;
      }
      await this.saveStateAt(runFd, { ...state, run: transition.run, documents });
      return true;
    });
  }
  async commitEvidenceAndVerdict(transition: TerminalEvidenceVerdictTransition): Promise<boolean> {
    return this.serialize(transition.runId, async runFd => {
      const state = await this.loadStateAt(runFd);
      if (!state || !state.run || transition.expectedRevision !== undefined && state.run.revision !== transition.expectedRevision) return false;
      await this.saveStateAt(runFd, { ...state, run: transition.run, documents: { ...state.documents, evidence: transition.evidence, verdict: transition.verdict } });
      return true;
    });
  }
  async commitExecutionCheckpoint(transition: ExecutionCheckpointTransition, claim: DispatchClaim): Promise<boolean> {
    return this.serialize(transition.runId, async runFd => {
      const state = await this.loadStateAt(runFd);
      const previous = state?.dispatch[claim.claimKey];
      if (!state || !state.run || state.run.revision !== transition.expectedRevision || !previous || previous.status !== "CLAIMED" || previous.claim.ownerId !== claim.ownerId || previous.claim.leaseGeneration !== claim.leaseGeneration || previous.claim.acquisitionId !== claim.acquisitionId) return false;
      if (transition.run.runId !== transition.runId) throw new Error("run identity mismatch");
      await this.saveStateAt(runFd, { ...state, run: transition.run, documents: { ...state.documents, execution: transition.document } });
      return true;
    });
  }
  async claimExecutionDispatch(claim: DispatchClaim, now = new Date().toISOString(), attemptToken?: symbol): Promise<DispatchClaimResult> {
    return this.serialize(claim.runId, async runFd => {
      const state = (await this.loadStateAt(runFd)) ?? emptyState();
      const previous = state.dispatch[claim.claimKey];
      if (previous?.status === "COMPLETED") return { claimed: false, status: "COMPLETED", claim: previous.claim, outputStored: previous.outputStored, ...(previous.completion ? { completion: previous.completion } : {}) };
      if (previous?.status === "CLAIMED" && Date.parse(previous.claim.leaseExpiresAt) > Date.parse(now)) {
        if (attemptToken) throw new ClaimError("dispatch claim is held by another owner", previous.claim, attemptToken);
        throw new Error("dispatch claim is held by another owner");
      }
      const acquired = previous?.status === "CLAIMED" ? { ...claim, leaseGeneration: previous.claim.leaseGeneration + 1 } : claim;
      await this.saveStateAt(runFd, { ...state, dispatch: { ...state.dispatch, [claim.claimKey]: { claim: acquired, status: "CLAIMED", outputStored: false } } });
      return { claimed: true, status: "CLAIMED", claim: acquired, outputStored: false };
    });
  }
  async completeExecutionDispatch(claim: DispatchClaim, completion: VerificationExecutionCompletionEnvelope | undefined, _now = new Date().toISOString()): Promise<boolean> {
    return this.serialize(claim.runId, async runFd => {
      const state = await this.loadStateAt(runFd); const previous = state?.dispatch[claim.claimKey];
      if (!state || !previous || previous.status !== "CLAIMED" || previous.claim.ownerId !== claim.ownerId || previous.claim.leaseGeneration !== claim.leaseGeneration || previous.claim.acquisitionId !== claim.acquisitionId) return false;
      await this.saveStateAt(runFd, { ...state, dispatch: { ...state.dispatch, [claim.claimKey]: { claim: previous.claim, status: "COMPLETED", outputStored: completion !== undefined, ...(completion ? { completion } : {}) } } });
      return true;
    });
  }
  async releaseExecutionDispatch(claim: DispatchClaim, _now = new Date().toISOString()): Promise<boolean> {
    return this.serialize(claim.runId, async runFd => {
      const state = await this.loadStateAt(runFd); const previous = state?.dispatch[claim.claimKey];
      if (!state || !previous) return true;
      if (previous.claim.ownerId !== claim.ownerId || previous.claim.leaseGeneration !== claim.leaseGeneration || previous.claim.acquisitionId !== claim.acquisitionId) return false;
      const dispatch = { ...state.dispatch }; delete dispatch[claim.claimKey];
      await this.saveStateAt(runFd, { ...state, dispatch });
      return true;
    });
  }
  async close(): Promise<void> {
    const root = this.rootPromise ? await this.rootPromise : undefined;
    this.rootPromise = undefined;
    if (root) await closeSecureRoot(root);
  }
}
export type VerificationStateStore = FileVerificationRepository;
