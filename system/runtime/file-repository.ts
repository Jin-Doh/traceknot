import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  CanonicalRunState,
  DispatchClaim,
  DispatchClaimResult,
  RepositoryPort,
  RepositoryTransition,
  StageDocument,
  StageName,
  TerminalEvidenceVerdictTransition,
  VerificationExecutionCompletionEnvelope,
} from "./verification-run";
import { DispatchClaimAcquisitionError as ClaimError } from "./verification-run";
import { canonicalizeJson } from "./verification-run";
export type VerificationStateMetadata = Readonly<{ schemaVersion: "traceknot-cli-state/v1"; rootIdentity: string; snapshotId: string; manifestDigest: string; capabilities: readonly string[] }>;

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

async function ensureDirectory(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true, mode });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`state path is not a real directory: ${path}`);
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  assertSafeValue(value);
  const parent = dirname(path);
  await ensureDirectory(parent, 0o700);
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(canonicalizeJson(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("state file is not a regular file");
    const text = await readFile(path, "utf8");
    if (text.length > 16 * 1024 * 1024) throw new Error("state file exceeds size bound");
    const value = JSON.parse(text) as unknown;
    assertSafeValue(value);
    return value;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

function emptyState(): PersistedState {
  return { schemaVersion: "traceknot-state/v1", documents: {}, dispatch: {} };
}

function runPath(root: string, runId: string): string {
  if (!RUN_ID.test(runId) || runId.includes("..")) throw new Error("runId contains unsafe characters");
  return join(root, "runs", runId);
}

const sleep = (milliseconds: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
async function acquireStateLock(directory: string): Promise<() => Promise<void>> {
  await ensureDirectory(directory, 0o700);
  const lockPath = join(directory, ".state.lock");
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}:${Date.now()}`, "utf8");
      await handle.sync();
      await handle.close();
      return async () => { await rm(lockPath, { force: true }).catch(() => undefined); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await lstat(lockPath);
        if (Date.now() - info.mtimeMs > 60_000) await rm(lockPath, { force: true });
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
      }
      await sleep(50);
    }
  }
  throw new Error("timed out waiting for durable run state lock");
}
function asState(value: unknown): PersistedState {
  if (!value) return emptyState();
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid persisted state");
  const state = value as Partial<PersistedState>;
  if (state.schemaVersion !== "traceknot-state/v1" || !state.documents || typeof state.documents !== "object" || !state.dispatch || typeof state.dispatch !== "object") throw new Error("invalid persisted state");
  return { schemaVersion: "traceknot-state/v1", run: state.run, documents: state.documents as PersistedState["documents"], dispatch: state.dispatch as PersistedState["dispatch"] };
}

/** Atomic, append-oriented JSON repository used by the verify CLI. */
export class FileVerificationRepository implements RepositoryPort {
  readonly rootDir: string;
  private readonly operations = new Map<string, Promise<void>>();
  constructor(rootDir: string) {
    if (typeof rootDir !== "string" || !rootDir) throw new Error("state root is required");
    this.rootDir = resolve(rootDir);
  }
  private async serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.operations.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolvePromise => { release = resolvePromise; });
    const chain = prior.then(() => current);
    this.operations.set(runId, chain);
    await prior;
    const unlock = await acquireStateLock(runPath(this.rootDir, runId));
    try { return await operation(); } finally { await unlock(); release(); if (this.operations.get(runId) === chain) this.operations.delete(runId); }
  }
  private async loadState(runId: string): Promise<PersistedState | undefined> {
    const dir = runPath(this.rootDir, runId);
    const value = await readJson(join(dir, "state.json"));
    return value === undefined ? undefined : asState(value);
  }
  private async saveState(runId: string, state: PersistedState): Promise<void> {
    const dir = runPath(this.rootDir, runId);
    await ensureDirectory(dir, 0o700);
    await atomicWrite(join(dir, "state.json"), state);
  }
  async readMetadata(runId: string): Promise<VerificationStateMetadata | undefined> {
    const value = await readJson(join(runPath(this.rootDir, runId), "metadata.json"));
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid CLI state metadata");
    const metadata = value as Partial<VerificationStateMetadata>;
    if (metadata.schemaVersion !== "traceknot-cli-state/v1" || typeof metadata.rootIdentity !== "string" || typeof metadata.snapshotId !== "string" || typeof metadata.manifestDigest !== "string" || !Array.isArray(metadata.capabilities) || metadata.capabilities.some(item => typeof item !== "string")) throw new Error("invalid CLI state metadata");
    return metadata as VerificationStateMetadata;
  }
  async writeMetadata(runId: string, metadata: VerificationStateMetadata): Promise<void> {
    if (metadata.schemaVersion !== "traceknot-cli-state/v1") throw new Error("invalid CLI state metadata");
    await this.serialize(runId, async () => {
      const dir = runPath(this.rootDir, runId);
      await ensureDirectory(dir, 0o700);
      await atomicWrite(join(dir, "metadata.json"), metadata);
    });
  }
  async loadRun(runId: string): Promise<CanonicalRunState | undefined> {
    return (await this.loadState(runId))?.run;
  }
  async loadStageDocument(runId: string, stage: StageName): Promise<unknown | undefined> {
    return (await this.loadState(runId))?.documents[stage];
  }
  async commitTransition(transition: RepositoryTransition): Promise<boolean> {
    return this.serialize(transition.runId, async () => {
      const state = (await this.loadState(transition.runId)) ?? emptyState();
      if (state.run && transition.expectedRevision !== undefined && state.run.revision !== transition.expectedRevision) return false;
      if (!state.run && transition.expectedRevision !== undefined) return false;
      if (transition.run.runId !== transition.runId) throw new Error("run identity mismatch");
      const documents = { ...state.documents };
      if (transition.stage !== undefined) {
        if (transition.document === undefined) throw new Error("stage document is required");
        documents[transition.stage] = transition.document;
      }
      await this.saveState(transition.runId, { ...state, run: transition.run, documents });
      return true;
    });
  }
  async commitEvidenceAndVerdict(transition: TerminalEvidenceVerdictTransition): Promise<boolean> {
    return this.serialize(transition.runId, async () => {
      const state = (await this.loadState(transition.runId)) ?? emptyState();
      if (!state.run || transition.expectedRevision !== undefined && state.run.revision !== transition.expectedRevision) return false;
      const documents = { ...state.documents, evidence: transition.evidence, verdict: transition.verdict };
      await this.saveState(transition.runId, { ...state, run: transition.run, documents });
      return true;
    });
  }
  async claimExecutionDispatch(claim: DispatchClaim, now = new Date().toISOString(), attemptToken?: symbol): Promise<DispatchClaimResult> {
    return this.serialize(claim.runId, async () => {
      const state = (await this.loadState(claim.runId)) ?? emptyState();
      const previous = state.dispatch[claim.claimKey];
      if (previous?.status === "COMPLETED") return { claimed: false, status: "COMPLETED", claim: previous.claim, outputStored: previous.outputStored, ...(previous.completion ? { completion: previous.completion } : {}) };
      if (previous?.status === "CLAIMED" && Date.parse(previous.claim.leaseExpiresAt) > Date.parse(now)) {
        if (attemptToken) throw new ClaimError("dispatch claim is held by another owner", previous.claim, attemptToken);
        throw new Error("dispatch claim is held by another owner");
      }
      const next: DispatchRecord = { claim, status: "CLAIMED", outputStored: false };
      await this.saveState(claim.runId, { ...state, dispatch: { ...state.dispatch, [claim.claimKey]: next } });
      return { claimed: true, status: "CLAIMED", claim, outputStored: false };
    });
  }
  async completeExecutionDispatch(claim: DispatchClaim, completion: VerificationExecutionCompletionEnvelope | undefined, _now = new Date().toISOString()): Promise<boolean> {
    return this.serialize(claim.runId, async () => {
      const state = await this.loadState(claim.runId);
      const previous = state?.dispatch[claim.claimKey];
      if (!state || !previous || previous.status !== "CLAIMED" || previous.claim.acquisitionId !== claim.acquisitionId) return false;
      await this.saveState(claim.runId, { ...state, dispatch: { ...state.dispatch, [claim.claimKey]: { claim: previous.claim, status: "COMPLETED", outputStored: completion !== undefined, ...(completion ? { completion } : {}) } } });
      return true;
    });
  }
  async releaseExecutionDispatch(claim: DispatchClaim, _now = new Date().toISOString()): Promise<boolean> {
    return this.serialize(claim.runId, async () => {
      const state = await this.loadState(claim.runId);
      const previous = state?.dispatch[claim.claimKey];
      if (!state || !previous) return true;
      if (previous.claim.acquisitionId !== claim.acquisitionId) return false;
      const dispatch = { ...state.dispatch };
      delete dispatch[claim.claimKey];
      await this.saveState(claim.runId, { ...state, dispatch });
      return true;
    });
  }
}

export type VerificationStateStore = FileVerificationRepository;
