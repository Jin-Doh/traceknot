/* Pure Phase A quiescence, budget, lease, obligation, and bridge model. */

export const QUIESCENCE_STATES = ["collecting", "candidate", "settling", "quiet_wait", "sealing", "sealed", "verifying", "clear", "blocked", "verification_pending"] as const;
export type QuiescencePhase = (typeof QUIESCENCE_STATES)[number];
export const QUIET_WINDOWS_MS = { single: 2_000, multi: 5_000 } as const;
export const HOOK_SOFT_MS = 500;
export const HOOK_HARD_MS = 2_000;

export type Ledger = {
  activeActors: number;
  activeTasks: number;
  queuedTasks: number;
  pendingDeliveries: number;
  incompleteRequiredTasks: number;
  pausedRequiredActors: number;
  openRequiredTasks: number;
};
export type CoordinatorIdentity = {
  projectId: string;
  rootObjectiveId: string;
  candidateGeneration: number;
  mutationEpoch: number;
  cancellationEpoch: number;
  actionSequence: number;
};
export type Candidate = {
  candidateKey: string;
  physicalRoot: string;
  snapshotHash: string;
  inventoryHash: string;
  acceptanceHash: string;
  candidateGeneration: number;
  mutationEpoch: number;
};
export type VerificationLease = {
  leaseId: string;
  candidateKey: string;
  projectId: string;
  rootObjectiveId: string;
  candidateGeneration: number;
  mutationEpoch: number;
  profileId: string;
  fence: number;
  expiresAt: number;
  committed: boolean;
};
export type Obligation = { id: string; mandatory: boolean; status: "pending" | "running" | "passed" | "failed"; evidenceId?: string };
export type ModelAudit = { kind: string; at: number; detail?: string };
export type QuiescenceState = {
  phase: QuiescencePhase;
  identity: CoordinatorIdentity;
  ledger: Ledger;
  rootCompletionCandidate: boolean;
  mainSettled: boolean;
  sourceCursor: string | null;
  authoritativeCensus: boolean;
  gap: boolean;
  lastActivityAt: number;
  quietWindowMs: number;
  candidate: Candidate | null;
  lease: VerificationLease | null;
  obligations: readonly Obligation[];
  evidenceIds: readonly string[];
  receiptId: string | null;
  terminalPairId: string | null;
  unfinishedMandatoryIds: readonly string[];
  audit: readonly ModelAudit[];
};

export const emptyLedger = (): Ledger => ({ activeActors: 0, activeTasks: 0, queuedTasks: 0, pendingDeliveries: 0, incompleteRequiredTasks: 0, pausedRequiredActors: 0, openRequiredTasks: 0 });
export const initialQuiescenceState = (projectId = "project", rootObjectiveId = "root"): QuiescenceState => ({
  phase: "collecting",
  identity: { projectId, rootObjectiveId, candidateGeneration: 0, mutationEpoch: 0, cancellationEpoch: 0, actionSequence: 0 },
  ledger: emptyLedger(), rootCompletionCandidate: false, mainSettled: false, sourceCursor: null, authoritativeCensus: false, gap: false,
  lastActivityAt: 0, quietWindowMs: QUIET_WINDOWS_MS.single, candidate: null, lease: null, obligations: [], evidenceIds: [], receiptId: null, terminalPairId: null,
  unfinishedMandatoryIds: [], audit: [],
});

export type QuiescenceAction =
  | { type: "rootCompletionCandidate"; at: number; projectId?: string; rootObjectiveId?: string; generation?: number; mutationEpoch?: number }
  | { type: "mainSettled"; at: number; projectId?: string; rootObjectiveId?: string }
  | { type: "ledger"; at: number; ledger: Ledger; multiAgent?: boolean; projectId?: string; rootObjectiveId?: string }
  | { type: "observation"; at: number; kind: "task" | "delivery" | "mutation"; delta?: Partial<Ledger>; projectId?: string; rootObjectiveId?: string; generation?: number; mutationEpoch?: number }
  | { type: "reconcile"; at: number; census: Ledger; cursor: string; complete: boolean; projectId?: string; rootObjectiveId?: string }
  | { type: "materialize"; at: number; candidate: Candidate }
  | { type: "tick"; at: number }
  | { type: "claimLease"; at: number; lease: VerificationLease }
  | { type: "startVerification"; at: number; obligations: readonly Obligation[] }
  | { type: "completeObligation"; at: number; obligationId: string; passed: boolean; evidenceId?: string }
  | { type: "flushEvidence"; at: number; evidenceIds: readonly string[] }
  | { type: "bridgeCommit"; at: number; candidateKey: string; receiptId: string; terminalPairId: string }
  | { type: "invalidate"; at: number; reason: string }
  | { type: "restart"; at: number };

const audit = (state: QuiescenceState, kind: string, at: number, detail?: string): QuiescenceState => ({ ...state, audit: [...state.audit, { kind, at, ...(detail === undefined ? {} : { detail }) }] });
const validText = (value: string): boolean => value.length > 0;
const sourceMatches = (state: QuiescenceState, action: { projectId?: string; rootObjectiveId?: string; generation?: number; mutationEpoch?: number }): boolean =>
  (action.projectId === undefined || action.projectId === state.identity.projectId) &&
  (action.rootObjectiveId === undefined || action.rootObjectiveId === state.identity.rootObjectiveId) &&
  (action.generation === undefined || action.generation === state.identity.candidateGeneration) &&
  (action.mutationEpoch === undefined || action.mutationEpoch === state.identity.mutationEpoch);
const zeroLedger = (ledger: Ledger): boolean => Object.values(ledger).every((value) => Number.isInteger(value) && value === 0);
const validLedger = (ledger: Ledger): boolean => Object.values(ledger).every((value) => Number.isInteger(value) && value >= 0);
const quiet = (state: QuiescenceState, at: number): boolean => at >= state.lastActivityAt + state.quietWindowMs;
const sealable = (state: QuiescenceState, at: number): boolean => state.rootCompletionCandidate && state.mainSettled && state.authoritativeCensus && !state.gap && zeroLedger(state.ledger) && quiet(state, at);
const invalidate = (state: QuiescenceState, at: number, reason: string): QuiescenceState => ({ ...audit(state, "invalidated", at, reason), phase: "collecting", identity: { ...state.identity, candidateGeneration: state.identity.candidateGeneration + 1, mutationEpoch: state.identity.mutationEpoch + 1, actionSequence: state.identity.actionSequence + 1 }, rootCompletionCandidate: false, mainSettled: false, authoritativeCensus: false, gap: false, candidate: null, lease: null, obligations: [], evidenceIds: [], receiptId: null, terminalPairId: null, unfinishedMandatoryIds: [] });
const canonicalObligation = (item: Obligation): string => [item.id, item.mandatory, item.status, item.evidenceId ?? ""].join("\u0000");
const exactObligations = (actual: readonly Obligation[], expected: readonly Obligation[]): boolean =>
  actual.length === expected.length &&
  new Set(actual.map((item) => item.id)).size === expected.length &&
  actual.map(canonicalObligation).sort().join("\u0001") === expected.map(canonicalObligation).sort().join("\u0001");
const exactMandatoryShape = (actual: readonly Obligation[], expected: readonly Obligation[]): boolean =>
  actual.length === expected.length && new Set(actual.map((item) => item.id)).size === expected.length &&
  actual.every((item) => item.mandatory && expected.some((candidate) => candidate.id === item.id && candidate.mandatory));
const mandatoryEvidenceIds = (obligations: readonly Obligation[]): readonly string[] =>
  obligations.filter((item) => item.mandatory && item.status === "passed" && item.evidenceId !== undefined).map((item) => item.evidenceId!);
const exactEvidenceSet = (obligations: readonly Obligation[], evidenceIds: readonly string[]): boolean => {
  const expected = mandatoryEvidenceIds(obligations);
  return expected.length > 0 && evidenceIds.length === 5 && new Set(evidenceIds).size === 5 && expected.every((id) => evidenceIds.includes(id));
};

export const reduceQuiescence = (state: QuiescenceState, action: QuiescenceAction): QuiescenceState => {
  if (!Number.isFinite(action.at) || action.at < 0) return audit(state, "invalid-time", 0);
  const sequenced = { ...state, identity: { ...state.identity, actionSequence: state.identity.actionSequence + 1 } };
  switch (action.type) {
    case "rootCompletionCandidate":
      if (!sourceMatches(sequenced, action) || sequenced.phase !== "collecting") return audit(sequenced, "source-authority-rejected", action.at);
      return { ...sequenced, rootCompletionCandidate: true, lastActivityAt: action.at, phase: sequenced.mainSettled ? "settling" : "collecting" };
    case "mainSettled":
      if (!sourceMatches(sequenced, action)) return audit(sequenced, "source-authority-rejected", action.at);
      return { ...sequenced, mainSettled: true, lastActivityAt: action.at, phase: sequenced.rootCompletionCandidate ? "settling" : sequenced.phase };
    case "ledger":
      if (!sourceMatches(sequenced, action) || !validLedger(action.ledger)) return audit(sequenced, "ledger-rejected", action.at);
      return { ...sequenced, ledger: { ...action.ledger }, authoritativeCensus: false, gap: true, quietWindowMs: action.multiAgent ? QUIET_WINDOWS_MS.multi : QUIET_WINDOWS_MS.single, lastActivityAt: action.at, phase: "collecting" };
    case "observation": {
      if (!sourceMatches(sequenced, action)) return audit(sequenced, "source-authority-rejected", action.at);
      const delta = action.delta ?? {};
      const nextLedger = { ...sequenced.ledger };
      for (const key of Object.keys(nextLedger) as Array<keyof Ledger>) nextLedger[key] = Math.max(0, nextLedger[key] + (delta[key] ?? 0));
      const changed = action.kind === "mutation";
      const next = { ...sequenced, ledger: nextLedger, authoritativeCensus: false, gap: true, lastActivityAt: action.at, phase: "collecting" as const };
      return changed ? invalidate(next, action.at, "mutation") : next;
    }
    case "reconcile":
      if (!sourceMatches(sequenced, action) || !action.complete || !validText(action.cursor) || !validLedger(action.census)) return audit(sequenced, "reconciliation-rejected", action.at);
      return { ...sequenced, ledger: { ...action.census }, sourceCursor: action.cursor, authoritativeCensus: true, gap: false, lastActivityAt: action.at, phase: sequenced.rootCompletionCandidate && sequenced.mainSettled ? "settling" : "collecting" };
    case "materialize":
      if (!sealable(sequenced, action.at) || sequenced.phase === "sealed" || sequenced.phase === "verifying" || sequenced.candidate !== null) return audit(sequenced, "candidate-rejected", action.at);
      if (action.candidate.candidateGeneration !== sequenced.identity.candidateGeneration || action.candidate.mutationEpoch !== sequenced.identity.mutationEpoch || !validText(action.candidate.candidateKey) || !validText(action.candidate.physicalRoot) || !validText(action.candidate.snapshotHash) || !validText(action.candidate.inventoryHash) || !validText(action.candidate.acceptanceHash)) return audit(sequenced, "candidate-binding-rejected", action.at);
      return { ...sequenced, candidate: { ...action.candidate }, phase: "candidate" };
    case "tick":
      if (sealable(sequenced, action.at) && sequenced.candidate === null) return { ...sequenced, phase: "quiet_wait" };
      if (sealable(sequenced, action.at) && sequenced.candidate !== null && sequenced.phase === "candidate") return { ...sequenced, phase: "sealing" };
      return sequenced;
    case "claimLease": {
      const candidate = sequenced.candidate;
      const lease = action.lease;
      if (candidate === null || sequenced.phase !== "sealing" || !sealable(sequenced, action.at) || !validText(lease.leaseId) || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= action.at || lease.candidateKey !== candidate.candidateKey || lease.projectId !== sequenced.identity.projectId || lease.rootObjectiveId !== sequenced.identity.rootObjectiveId || lease.candidateGeneration !== candidate.candidateGeneration || lease.mutationEpoch !== candidate.mutationEpoch || lease.fence < 1 || sequenced.lease !== null) return audit(sequenced, "lease-cas-rejected", action.at);
      return { ...sequenced, lease: { ...lease }, phase: "sealed" };
    }
    case "startVerification":
      if (sequenced.phase !== "sealed" || sequenced.lease === null || action.at >= sequenced.lease.expiresAt || !exactObligations(action.obligations, mandatoryObligations(sequenced.lease.profileId))) return audit(sequenced, "verification-start-rejected", action.at);
      return { ...sequenced, obligations: action.obligations.map((item) => ({ ...item })), phase: "verifying" };
    case "completeObligation": {
      if (sequenced.phase !== "verifying" || sequenced.lease === null || action.at >= sequenced.lease.expiresAt) return audit(sequenced, "obligation-rejected", action.at);
      const index = sequenced.obligations.findIndex((item) => item.id === action.obligationId);
      if (index < 0 || !validText(action.evidenceId ?? "") || sequenced.obligations[index]?.status === "passed" || (action.passed && sequenced.obligations.some((item, itemIndex) => itemIndex !== index && item.evidenceId === action.evidenceId))) return audit(sequenced, "obligation-rejected", action.at);
      const obligations = sequenced.obligations.map((item, itemIndex) => itemIndex === index ? { ...item, status: action.passed ? "passed" as const : "failed" as const, evidenceId: action.evidenceId } : item);
      return { ...sequenced, obligations, evidenceIds: action.passed && action.evidenceId !== undefined && !sequenced.evidenceIds.includes(action.evidenceId) ? [...sequenced.evidenceIds, action.evidenceId] : sequenced.evidenceIds };
    }
    case "flushEvidence":
      if (sequenced.phase !== "verifying" || sequenced.lease === null || action.at >= sequenced.lease.expiresAt || action.evidenceIds.length === 0 || action.evidenceIds.some((id) => !validText(id))) return audit(sequenced, "evidence-flush-rejected", action.at);
      if (sequenced.obligations.some((item) => item.mandatory && item.status !== "passed")) return { ...audit(sequenced, "mandatory-evidence-missing", action.at), phase: "blocked", unfinishedMandatoryIds: sequenced.obligations.filter((item) => item.mandatory && item.status !== "passed").map((item) => item.id) };
      if (!exactMandatoryShape(sequenced.obligations, mandatoryObligations(sequenced.lease.profileId))) return audit(sequenced, "obligation-set-rejected", action.at);
      if (!exactEvidenceSet(sequenced.obligations, action.evidenceIds)) return audit(sequenced, "evidence-binding-rejected", action.at);
      return { ...sequenced, evidenceIds: [...action.evidenceIds], phase: "verifying" };
    case "bridgeCommit":
      if (sequenced.phase !== "verifying" || sequenced.lease === null || sequenced.receiptId !== null || sequenced.terminalPairId !== null || sequenced.candidate?.candidateKey !== action.candidateKey || action.at >= sequenced.lease.expiresAt || !exactMandatoryShape(sequenced.obligations, mandatoryObligations(sequenced.lease.profileId)) || sequenced.obligations.some((item) => item.mandatory && item.status !== "passed") || !exactEvidenceSet(sequenced.obligations, sequenced.evidenceIds) || !bridgeRelationsValid(action.candidateKey, sequenced.evidenceIds, action.receiptId, action.terminalPairId)) return audit(sequenced, "bridge-rejected", action.at);
      return { ...sequenced, receiptId: action.receiptId, terminalPairId: action.terminalPairId, lease: { ...sequenced.lease, committed: true }, phase: "clear" };
    case "invalidate": return invalidate(sequenced, action.at, action.reason);
    case "restart":
      if (sequenced.lease !== null && sequenced.phase === "verifying") return { ...audit(sequenced, "restart-recovery", action.at), phase: "verification_pending", unfinishedMandatoryIds: sequenced.obligations.filter((item) => item.mandatory && item.status !== "passed").map((item) => item.id) };
      return sequenced;
  }
};

export const isQuiescent = (state: QuiescenceState, now: number): boolean => sealable(state, now);
export const quietWindowFor = (activeActors: number): number => activeActors > 1 ? QUIET_WINDOWS_MS.multi : QUIET_WINDOWS_MS.single;

export type Risk = "R0" | "R1" | "R2" | "R3";
export type SurfaceClass = "non-gui" | "gui" | "local";
export type RiskBudget = { queueSlaMs: number; softMs: number; hardMs: number; globalCompletionMs: number };
export type RiskBudgetKey = "R0" | "R1" | "R2-non-gui" | "R2-gui" | "R3-local";
export const RISK_BUDGETS: Readonly<Record<RiskBudgetKey, RiskBudget>> = {
  R0: { queueSlaMs: 15_000, softMs: 30_000, hardMs: 60_000, globalCompletionMs: 75_000 },
  R1: { queueSlaMs: 30_000, softMs: 120_000, hardMs: 240_000, globalCompletionMs: 270_000 },
  "R2-non-gui": { queueSlaMs: 60_000, softMs: 360_000, hardMs: 720_000, globalCompletionMs: 780_000 },
  "R2-gui": { queueSlaMs: 60_000, softMs: 600_000, hardMs: 1_080_000, globalCompletionMs: 1_140_000 },
  "R3-local": { queueSlaMs: 120_000, softMs: 600_000, hardMs: 1_200_000, globalCompletionMs: 1_320_000 },
};
const RISK_SURFACE_KEYS: Readonly<Record<Risk, Readonly<Record<SurfaceClass, RiskBudgetKey | null>>>> = {
  R0: { "non-gui": "R0", gui: "R0", local: "R0" },
  R1: { "non-gui": "R1", gui: "R1", local: "R1" },
  R2: { "non-gui": "R2-non-gui", gui: "R2-gui", local: null },
  R3: { "non-gui": null, gui: null, local: "R3-local" },
};
export const riskBudgetFor = (risk: string, surfaceClass: string): RiskBudget | null => {
  const key = RISK_SURFACE_KEYS[risk as Risk]?.[surfaceClass as SurfaceClass];
  return key === null || key === undefined ? null : RISK_BUDGETS[key];
};
export type PhaseName = "bootstrap" | "collection" | "execution" | "evidenceFlush" | "shutdown";
export type PhaseBudget = { softMs: number; hardMs: number };
export type RunnerProfile = Record<PhaseName, PhaseBudget>;
export const RUNNER_PROFILES: Readonly<Record<string, RunnerProfile>> = {
  "js-ts-focused": { bootstrap: { softMs: 10_000, hardMs: 30_000 }, collection: { softMs: 10_000, hardMs: 30_000 }, execution: { softMs: 60_000, hardMs: 120_000 }, evidenceFlush: { softMs: 5_000, hardMs: 15_000 }, shutdown: { softMs: 5_000, hardMs: 15_000 } },
  "python-focused": { bootstrap: { softMs: 15_000, hardMs: 45_000 }, collection: { softMs: 15_000, hardMs: 45_000 }, execution: { softMs: 90_000, hardMs: 240_000 }, evidenceFlush: { softMs: 10_000, hardMs: 20_000 }, shutdown: { softMs: 5_000, hardMs: 10_000 } },
  "rust-incremental": { bootstrap: { softMs: 90_000, hardMs: 240_000 }, collection: { softMs: 15_000, hardMs: 30_000 }, execution: { softMs: 120_000, hardMs: 300_000 }, evidenceFlush: { softMs: 10_000, hardMs: 20_000 }, shutdown: { softMs: 5_000, hardMs: 10_000 } },
  "rust-cold": { bootstrap: { softMs: 360_000, hardMs: 720_000 }, collection: { softMs: 15_000, hardMs: 30_000 }, execution: { softMs: 195_000, hardMs: 390_000 }, evidenceFlush: { softMs: 20_000, hardMs: 40_000 }, shutdown: { softMs: 10_000, hardMs: 20_000 } },
  "playwright-focused": { bootstrap: { softMs: 65_000, hardMs: 180_000 }, collection: { softMs: 20_000, hardMs: 60_000 }, execution: { softMs: 240_000, hardMs: 480_000 }, evidenceFlush: { softMs: 20_000, hardMs: 60_000 }, shutdown: { softMs: 10_000, hardMs: 30_000 } },
  "g0-evidence-only": { bootstrap: { softMs: 0, hardMs: 1_000 }, collection: { softMs: 1_000, hardMs: 2_000 }, execution: { softMs: 1_000, hardMs: 2_000 }, evidenceFlush: { softMs: 1_000, hardMs: 2_000 }, shutdown: { softMs: 1_000, hardMs: 2_000 } },
};
export const deadline = (start: number, duration: number, ...caps: number[]): number => Math.min(start + Math.max(0, duration), ...caps);
export const crossed = (now: number, at: number): boolean => now >= at;
export const remaining = (now: number, at: number): number => Math.max(0, at - now);
export const reconstructDeadline = (persistedAbsolute: number, startWall: number, persistedUncertainty: number, configuredDuration: number, currentWall: number, currentUncertainty: number, ...caps: number[]): number => Math.min(persistedAbsolute, currentWall + Math.max(0, startWall - persistedUncertainty + configuredDuration - (currentWall + currentUncertainty)), ...caps);

export type PhaseDeadlines = { softDeadline: number; hardDeadline: number };
export const phaseDeadlines = (phase: PhaseName, start: number, profile: RunnerProfile, optionalStopDeadline: number, workDeadline: number, finalDeadline: number): PhaseDeadlines => {
  const budget = profile[phase];
  if (phase === "evidenceFlush") {
    const hardDeadline = Math.min(start + budget.hardMs, finalDeadline - profile.shutdown.hardMs);
    return { softDeadline: Math.min(start + budget.softMs, hardDeadline), hardDeadline };
  }
  if (phase === "shutdown") {
    const hardDeadline = Math.min(start + budget.hardMs, finalDeadline);
    return { softDeadline: Math.min(start + budget.softMs, hardDeadline), hardDeadline };
  }
  return { softDeadline: Math.min(start + budget.softMs, optionalStopDeadline, workDeadline), hardDeadline: Math.min(start + budget.hardMs, workDeadline) };
};
export type AcceptanceId = "acceptance.tests-pass" | "acceptance.static-checks-pass" | "acceptance.adversarial-pass" | "acceptance.sealed-snapshot" | "acceptance.browser-flow-pass" | "acceptance.cold-build-pass" | "acceptance.no-mutation" | "acceptance.ledger-consistent" | "acceptance.unspecified-smoke";
export type Capability = "G0" | "G1" | "G2" | "G3";
export type AcceptanceResolverRow = {
  acceptanceRequirementId: AcceptanceId;
  runnerProfileId: string;
  capability: Capability;
  riskIn: readonly Risk[];
  obligationId: string | null;
  disposition: "supported" | "unsupported";
};
const ACCEPTANCE_IDS: readonly AcceptanceId[] = ["acceptance.tests-pass", "acceptance.static-checks-pass", "acceptance.adversarial-pass", "acceptance.sealed-snapshot", "acceptance.browser-flow-pass", "acceptance.cold-build-pass", "acceptance.no-mutation", "acceptance.ledger-consistent", "acceptance.unspecified-smoke"];
const ALL_RISKS: readonly Risk[] = ["R0", "R1", "R2", "R3"];
const PROFILE_CAPABILITIES: Readonly<Record<string, Capability>> = {
  "g0-evidence-only": "G0",
  "js-ts-focused": "G1",
  "python-focused": "G1",
  "rust-incremental": "G1",
  "rust-cold": "G1",
  "playwright-focused": "G1",
};
const PROFILE_RISKS: Readonly<Record<string, readonly Risk[]>> = {
  "g0-evidence-only": ["R0"],
  "js-ts-focused": ["R0", "R1"],
  "python-focused": ["R0", "R1"],
  "rust-incremental": ["R0", "R1"],
  "rust-cold": ["R1", "R2"],
  "playwright-focused": ["R2"],
};
type ProfileAcceptance = Readonly<Partial<Record<AcceptanceId, string>> & { mandatory: readonly string[] }>;
const PROFILE_OBLIGATIONS: Readonly<Record<string, ProfileAcceptance>> = {
  "g0-evidence-only": { "acceptance.no-mutation": "qtb.g0.no-mutation-attestation", "acceptance.static-checks-pass": "qtb.g0.identity-ledger-smoke", "acceptance.ledger-consistent": "qtb.g0.identity-ledger-smoke", "acceptance.unspecified-smoke": "qtb.g0.identity-ledger-smoke", mandatory: ["qtb.g0.no-mutation-attestation", "qtb.g0.identity-ledger-smoke"] },
  "js-ts-focused": { "acceptance.tests-pass": "qtb.js-ts.existing-tests", "acceptance.static-checks-pass": "qtb.js-ts.independent-smoke", "acceptance.adversarial-pass": "qtb.js-ts.adversarial", "acceptance.sealed-snapshot": "qtb.snapshot.sealed", "acceptance.ledger-consistent": "qtb.ledger.integrity", "acceptance.unspecified-smoke": "qtb.js-ts.independent-smoke", mandatory: ["qtb.js-ts.existing-tests", "qtb.js-ts.independent-smoke", "qtb.js-ts.adversarial", "qtb.snapshot.sealed", "qtb.ledger.integrity"] },
  "python-focused": { "acceptance.tests-pass": "qtb.python.existing-tests", "acceptance.static-checks-pass": "qtb.python.independent-smoke", "acceptance.adversarial-pass": "qtb.python.adversarial", "acceptance.sealed-snapshot": "qtb.snapshot.sealed", "acceptance.ledger-consistent": "qtb.ledger.integrity", "acceptance.unspecified-smoke": "qtb.python.independent-smoke", mandatory: ["qtb.python.existing-tests", "qtb.python.independent-smoke", "qtb.python.adversarial", "qtb.snapshot.sealed", "qtb.ledger.integrity"] },
  "rust-incremental": { "acceptance.tests-pass": "qtb.rust-incremental.existing-tests", "acceptance.static-checks-pass": "qtb.rust-incremental.independent-smoke", "acceptance.adversarial-pass": "qtb.rust-incremental.adversarial", "acceptance.sealed-snapshot": "qtb.snapshot.sealed", "acceptance.ledger-consistent": "qtb.ledger.integrity", "acceptance.unspecified-smoke": "qtb.rust-incremental.independent-smoke", mandatory: ["qtb.rust-incremental.existing-tests", "qtb.rust-incremental.independent-smoke", "qtb.rust-incremental.adversarial", "qtb.snapshot.sealed", "qtb.ledger.integrity"] },
  "rust-cold": { "acceptance.tests-pass": "qtb.rust-cold.existing-tests", "acceptance.static-checks-pass": "qtb.rust-cold.independent-smoke", "acceptance.adversarial-pass": "qtb.rust-cold.adversarial", "acceptance.sealed-snapshot": "qtb.snapshot.sealed", "acceptance.cold-build-pass": "qtb.rust-cold.existing-tests", "acceptance.ledger-consistent": "qtb.ledger.integrity", "acceptance.unspecified-smoke": "qtb.rust-cold.independent-smoke", mandatory: ["qtb.rust-cold.existing-tests", "qtb.rust-cold.independent-smoke", "qtb.rust-cold.adversarial", "qtb.snapshot.sealed", "qtb.ledger.integrity"] },
  "playwright-focused": { "acceptance.tests-pass": "qtb.playwright.existing-tests", "acceptance.static-checks-pass": "qtb.playwright.independent-smoke", "acceptance.adversarial-pass": "qtb.playwright.adversarial", "acceptance.sealed-snapshot": "qtb.snapshot.sealed", "acceptance.browser-flow-pass": "qtb.playwright.existing-tests", "acceptance.ledger-consistent": "qtb.ledger.integrity", "acceptance.unspecified-smoke": "qtb.playwright.independent-smoke", mandatory: ["qtb.playwright.existing-tests", "qtb.playwright.independent-smoke", "qtb.playwright.adversarial", "qtb.snapshot.sealed", "qtb.ledger.integrity"] },
};
export const ACCEPTANCE_RESOLVER_ROWS: readonly AcceptanceResolverRow[] = Object.entries(PROFILE_CAPABILITIES).flatMap(([runnerProfileId, capability]) => ACCEPTANCE_IDS.map((acceptanceRequirementId) => {
  const obligationId = PROFILE_OBLIGATIONS[runnerProfileId]?.[acceptanceRequirementId] ?? null;
  const supported = obligationId !== null;
  return { acceptanceRequirementId, runnerProfileId, capability, riskIn: supported ? PROFILE_RISKS[runnerProfileId]! : ALL_RISKS, obligationId, disposition: supported ? "supported" as const : "unsupported" as const };
}));
export const resolveAcceptanceFromRows = (rows: readonly AcceptanceResolverRow[], acceptanceRequirementId: string, runnerProfileId: string, capability: string, risk: string): string | null => {
  const matches = rows.filter((row) => row.acceptanceRequirementId === acceptanceRequirementId && row.runnerProfileId === runnerProfileId && row.capability === capability && row.riskIn.includes(risk as Risk));
  const match = matches[0];
  if (matches.length !== 1 || match === undefined || match.disposition !== "supported" || match.obligationId === null) return null;
  return match.obligationId;
};
export const resolveAcceptance = (id: string, profileId: string, capability: string, risk: string): string | null => resolveAcceptanceFromRows(ACCEPTANCE_RESOLVER_ROWS, id, profileId, capability, risk);
export const mandatoryObligations = (profileId: string): readonly Obligation[] => {
  const ids = PROFILE_OBLIGATIONS[profileId]?.mandatory;
  return ids === undefined ? [] : ids.map((id) => ({ id, mandatory: true, status: "pending" as const }));
};
export const candidateBindingEqual = (left: Candidate, right: Candidate): boolean =>
  left.candidateKey === right.candidateKey &&
  left.physicalRoot === right.physicalRoot &&
  left.snapshotHash === right.snapshotHash &&
  left.inventoryHash === right.inventoryHash &&
  left.acceptanceHash === right.acceptanceHash &&
  left.candidateGeneration === right.candidateGeneration &&
  left.mutationEpoch === right.mutationEpoch;
export const leaseTuple = (lease: VerificationLease): string => [lease.projectId, lease.rootObjectiveId, lease.candidateGeneration, lease.mutationEpoch, lease.profileId].join("\u0000");
export const bridgeRelationsValid = (candidateKey: string, evidenceIds: readonly string[], receiptId: string, terminalPairId: string): boolean =>
  validText(candidateKey) && evidenceIds.length === 5 && evidenceIds.every(validText) && new Set(evidenceIds).size === 5 && validText(receiptId) && validText(terminalPairId);
