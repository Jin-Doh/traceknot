/* Pure Phase 0 SessionStorage durability model. It models observed order and evidence, not I/O. */

export type StorageSlotKind = "mutation" | "rewrite" | "close";
export type StorageSlotStatus = "queued" | "in_progress" | "committed" | "provisionally_failed" | "superseded" | "blocked";
export type RecoveryDisposition = "verified_no_mutation" | "recovered_commit" | "unrecoverable";
export type RecoveryStatus = "claimed" | "completed" | "stale";
export type MoveKind = "same_fs" | "exdev";
export type MovePhase = "created" | "renamed" | "copied_temp" | "file_fsynced" | "verified_temp" | "dest_renamed" | "dest_dir_fsynced" | "source_unlinked" | "source_dir_fsynced" | "verified" | "committed" | "failed_unknown";
export type StorageSlot = { physicalWriteSeq: number; kind: StorageSlotKind; inputFileVersion: number; outputFileVersion: number | null; status: StorageSlotStatus; intentHash: string; invocationId: string; deferred: boolean; recovery?: RecoveryJournal };
export type RecoveryJournal = { originalPhysicalWriteSeq: number; recoveryOfSeq: number; recoveryAttempt: number; inputFileVersion: number; claimId: string; claimantPrincipal: string; invocationId: string; claimedAt: number; expiresAt: number; status: RecoveryStatus; disposition?: RecoveryDisposition };
export type SyncStep = "write_all" | "fsync_temp" | "close_temp" | "rename" | "directory_fsync" | "source_unlink" | "verify" | "commit_version";
export type ObservedOperationEvent = { invocationId: string; operation: SyncStep; outcome: "success" | "failure"; at: number };
export type MoveTransaction = { invocationId: string; sourceIdentity: string; destinationIdentity: string; overwrite: boolean; kind: MoveKind; phase: MovePhase; steps: readonly SyncStep[]; evidence: readonly string[] };
export type StorageAudit = { kind: "duplicate_cas" | "stale_cas" | "blocked_successor" | "crash_restart" | "invalid_step" | "claim_expired" | "recovery_limit" | "move_failure"; physicalWriteSeq?: number; at: number };
export type StorageState = { physicalWriteSeq: number; fileVersion: number; nextExpectedSeq: number; slots: readonly StorageSlot[]; move: MoveTransaction | null; observedEvents: readonly ObservedOperationEvent[]; audit: readonly StorageAudit[] };
export const initialStorageState = (fileVersion = 0): StorageState => ({ physicalWriteSeq: 0, fileVersion, nextExpectedSeq: 1, slots: [], move: null, observedEvents: [], audit: [] });

export type StorageAction =
	| { type: "enqueue"; kind: StorageSlotKind; intentHash: string; invocationId: string }
	| { type: "deferRewrite"; intentHash: string; invocationId: string }
	| { type: "begin"; physicalWriteSeq: number }
	| { type: "commit"; physicalWriteSeq: number; now: number }
	| { type: "fail"; physicalWriteSeq: number; now: number }
	| { type: "recoverClaim"; physicalWriteSeq: number; claimId: string; claimantPrincipal: string; invocationId: string; now: number; expiresAt: number }
	| { type: "recoverComplete"; physicalWriteSeq: number; claimId: string; disposition: RecoveryDisposition; now: number }
	| { type: "restart"; now: number }
	| { type: "startMove"; move: Omit<MoveTransaction, "phase" | "steps" | "evidence"> }
	| { type: "moveStep"; invocationId: string; phase: MovePhase; success?: boolean; now?: number; evidence?: string }
	| { type: "supersede"; physicalWriteSeq: number; now: number };

const appendAudit = (state: StorageState, entry: StorageAudit): StorageState => ({ ...state, audit: [...state.audit, entry] });
const slotAt = (state: StorageState, sequence: number): StorageSlot | undefined => state.slots.find((slot) => slot.physicalWriteSeq === sequence);
const replaceSlot = (state: StorageState, replacement: StorageSlot): StorageState => ({ ...state, slots: state.slots.map((slot) => slot.physicalWriteSeq === replacement.physicalWriteSeq ? replacement : slot) });

export const reduceStorage = (state: StorageState, action: StorageAction): StorageState => {
	switch (action.type) {
		case "enqueue": { const seq = state.physicalWriteSeq + 1; const slot: StorageSlot = { physicalWriteSeq: seq, kind: action.kind, inputFileVersion: state.fileVersion, outputFileVersion: null, status: "queued", intentHash: action.intentHash, invocationId: action.invocationId, deferred: false }; return { ...state, physicalWriteSeq: seq, slots: [...state.slots, slot] }; }
		case "deferRewrite": { const seq = state.physicalWriteSeq + 1; const slot: StorageSlot = { physicalWriteSeq: seq, kind: "rewrite", inputFileVersion: state.fileVersion, outputFileVersion: null, status: "queued", intentHash: action.intentHash, invocationId: action.invocationId, deferred: true }; return { ...state, physicalWriteSeq: seq, slots: [...state.slots, slot] }; }
		case "begin": { const slot = slotAt(state, action.physicalWriteSeq); if (slot === undefined || slot.status !== "queued" || action.physicalWriteSeq !== state.nextExpectedSeq) return appendAudit(state, { kind: "blocked_successor", physicalWriteSeq: action.physicalWriteSeq, at: 0 }); return replaceSlot(state, { ...slot, status: "in_progress", inputFileVersion: state.fileVersion }); }
		case "commit": { const slot = slotAt(state, action.physicalWriteSeq); if (slot === undefined || slot.status === "committed") return appendAudit(state, { kind: "duplicate_cas", physicalWriteSeq: action.physicalWriteSeq, at: action.now }); if (slot.status !== "in_progress" || slot.inputFileVersion !== state.fileVersion) return appendAudit(state, { kind: "stale_cas", physicalWriteSeq: action.physicalWriteSeq, at: action.now }); const output = slot.kind === "mutation" || slot.kind === "rewrite" ? slot.inputFileVersion + 1 : slot.inputFileVersion; const committed = { ...slot, status: "committed" as const, outputFileVersion: output }; return { ...replaceSlot(state, committed), fileVersion: output, nextExpectedSeq: action.physicalWriteSeq + 1 }; }
		case "fail": { const slot = slotAt(state, action.physicalWriteSeq); if (slot === undefined || slot.status === "provisionally_failed") return appendAudit(state, { kind: "duplicate_cas", physicalWriteSeq: action.physicalWriteSeq, at: action.now }); if (slot.status !== "in_progress" || action.physicalWriteSeq !== state.nextExpectedSeq) return appendAudit(state, { kind: "stale_cas", physicalWriteSeq: action.physicalWriteSeq, at: action.now }); return replaceSlot(state, { ...slot, status: "provisionally_failed" }); }
		case "recoverClaim": {
			const slot = slotAt(state, action.physicalWriteSeq);
			if (slot === undefined || slot.status !== "provisionally_failed" || action.physicalWriteSeq !== state.nextExpectedSeq) return appendAudit(state, { kind: "stale_cas", physicalWriteSeq: action.physicalWriteSeq, at: action.now });
			if (action.claimId.length === 0 || action.claimantPrincipal.length === 0 || action.invocationId.length === 0 || action.expiresAt <= action.now) return appendAudit(state, { kind: "claim_expired", physicalWriteSeq: action.physicalWriteSeq, at: action.now });
			if (slot.recovery?.status === "claimed" && slot.recovery.expiresAt > action.now) return appendAudit(state, { kind: "duplicate_cas", physicalWriteSeq: action.physicalWriteSeq, at: action.now });
			const attempt = (slot.recovery?.recoveryAttempt ?? 0) + 1;
			if (attempt > 3) return appendAudit(state, { kind: "recovery_limit", physicalWriteSeq: action.physicalWriteSeq, at: action.now });
			return replaceSlot(state, { ...slot, recovery: { originalPhysicalWriteSeq: action.physicalWriteSeq, recoveryOfSeq: action.physicalWriteSeq, recoveryAttempt: attempt, inputFileVersion: state.fileVersion, claimId: action.claimId, claimantPrincipal: action.claimantPrincipal, invocationId: action.invocationId, claimedAt: action.now, expiresAt: action.expiresAt, status: "claimed" } });
		}
		case "recoverComplete": {
			const slot = slotAt(state, action.physicalWriteSeq);
			if (slot === undefined || slot.recovery === undefined || slot.recovery.status !== "claimed" || slot.recovery.claimId !== action.claimId) return appendAudit(state, { kind: "stale_cas", physicalWriteSeq: action.physicalWriteSeq, at: action.now });
			if (action.now >= slot.recovery.expiresAt) return appendAudit(state, { kind: "claim_expired", physicalWriteSeq: action.physicalWriteSeq, at: action.now });
			if (action.disposition === "unrecoverable") return replaceSlot(state, { ...slot, status: "blocked", recovery: { ...slot.recovery, status: "completed", disposition: action.disposition } });
			const output = action.disposition === "recovered_commit" ? slot.recovery.inputFileVersion + 1 : slot.recovery.inputFileVersion;
			const completed = { ...slot, status: "committed" as const, outputFileVersion: output, recovery: { ...slot.recovery, status: "completed" as const, disposition: action.disposition } };
			return { ...replaceSlot(state, completed), fileVersion: output, nextExpectedSeq: action.physicalWriteSeq + 1 };
		}
		case "restart": { const inFlight = state.slots.find((slot) => slot.status === "in_progress"); if (inFlight === undefined) return state; return { ...replaceSlot(state, { ...inFlight, status: "provisionally_failed" }), audit: [...state.audit, { kind: "crash_restart", physicalWriteSeq: inFlight.physicalWriteSeq, at: action.now }] }; }
		case "supersede": { const slot = slotAt(state, action.physicalWriteSeq); if (slot === undefined || slot.status !== "queued" || action.physicalWriteSeq !== state.nextExpectedSeq) return appendAudit(state, { kind: "stale_cas", physicalWriteSeq: action.physicalWriteSeq, at: action.now }); const superseded = { ...slot, status: "superseded" as const, outputFileVersion: slot.inputFileVersion }; return { ...replaceSlot(state, superseded), nextExpectedSeq: action.physicalWriteSeq + 1 }; }
		case "startMove": return state.move === null ? { ...state, move: { ...action.move, phase: "created", steps: [], evidence: [] } } : state;
		case "moveStep": {
			const move = state.move;
			if (move === null || move.invocationId !== action.invocationId || !validMoveTransition(move.kind, move.phase, action.phase)) return appendAudit(state, { kind: "invalid_step", at: action.now ?? 0 });
			const operations = expectedSteps(move.kind, move.phase, action.phase);
			if (action.phase === "source_unlinked" && (operations.length !== 1 || operations[0] !== "source_unlink")) return appendAudit(state, { kind: "invalid_step", at: action.now ?? 0 });
			const at = action.now ?? state.observedEvents.length;
			if (action.success === false) {
				const failedOperation = operations[0];
				return failedOperation === undefined ? appendAudit(state, { kind: "invalid_step", at }) : { ...state, move: { ...move, phase: "failed_unknown" }, observedEvents: [...state.observedEvents, { invocationId: move.invocationId, operation: failedOperation, outcome: "failure", at }], audit: [...state.audit, { kind: "move_failure", at }] };
			}
			const evidence = operations.filter((operation) => operation === "directory_fsync" || operation === "source_unlink").map((operation) => `${operation}:success`);
			return { ...state, move: { ...move, phase: action.phase, steps: [...move.steps, ...operations], evidence: [...move.evidence, ...evidence] }, observedEvents: [...state.observedEvents, ...operations.map((operation) => ({ invocationId: move.invocationId, operation, outcome: "success" as const, at }))] };
		}
	}
};

const SAME_FS_STEPS: readonly SyncStep[] = ["write_all", "fsync_temp", "close_temp", "rename", "directory_fsync", "verify", "commit_version"];
const EXDEV_STEPS: readonly SyncStep[] = ["write_all", "fsync_temp", "verify", "rename", "directory_fsync", "source_unlink", "directory_fsync", "verify", "commit_version"];
/* These are protocol orders, while observedEvents is the evidence used by verification. */
export const syncDurabilityOrder = SAME_FS_STEPS;
export const exdevDurabilityOrder = EXDEV_STEPS;
const expectedSteps = (kind: MoveKind, from: MovePhase, to: MovePhase): readonly SyncStep[] => {
	if (kind === "same_fs") {
		const map: Partial<Record<string, readonly SyncStep[]>> = { "created:renamed": SAME_FS_STEPS.slice(0, 4), "renamed:verified": SAME_FS_STEPS.slice(4, 6), "verified:committed": SAME_FS_STEPS.slice(6) };
		return map[`${from}:${to}`] ?? [];
	}
	const map: Partial<Record<string, readonly SyncStep[]>> = {
		"created:copied_temp": ["write_all"], "copied_temp:file_fsynced": ["fsync_temp"], "file_fsynced:verified_temp": ["verify"], "verified_temp:dest_renamed": ["rename"], "dest_renamed:dest_dir_fsynced": ["directory_fsync"], "dest_dir_fsynced:source_unlinked": ["source_unlink"], "source_unlinked:source_dir_fsynced": ["directory_fsync"], "source_dir_fsynced:verified": ["verify"], "verified:committed": ["commit_version"],
	};
	return map[`${from}:${to}`] ?? [];
};
const validMoveTransition = (kind: MoveKind, from: MovePhase, to: MovePhase): boolean => kind === "same_fs" ? (from === "created" && to === "renamed") || (from === "renamed" && to === "verified") || (from === "verified" && to === "committed") : (from === "created" && to === "copied_temp") || (from === "copied_temp" && to === "file_fsynced") || (from === "file_fsynced" && to === "verified_temp") || (from === "verified_temp" && to === "dest_renamed") || (from === "dest_renamed" && to === "dest_dir_fsynced") || (from === "dest_dir_fsynced" && to === "source_unlinked") || (from === "source_unlinked" && to === "source_dir_fsynced") || (from === "source_dir_fsynced" && to === "verified") || (from === "verified" && to === "committed");
export const successorsBlocked = (state: StorageState, sequence: number): boolean => state.slots.some((slot) => slot.physicalWriteSeq > sequence && slot.status === "queued") && state.slots.some((slot) => slot.physicalWriteSeq === sequence && ["provisionally_failed", "blocked"].includes(slot.status));
export const noFutureVersionReservation = (state: StorageState): boolean => state.slots.every((slot) => slot.outputFileVersion === null || slot.outputFileVersion <= state.fileVersion) && state.fileVersion >= 0;
