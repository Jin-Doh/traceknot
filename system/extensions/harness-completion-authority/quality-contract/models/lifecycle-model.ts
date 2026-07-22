/* Pure Phase 0 lifecycle contract model. No runtime or I/O dependencies. */

export const TERMINAL_STATUSES = ["verified_success", "failed", "cancelled", "blocked"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export const TERMINAL_REASONS = ["clear_watch_receipt", "pre_agent", "provider", "scheduler", "watchdog", "global_deadline", "user_abort", "dispose", "policy", "snapshot", "trust", "capability", "quality_timeout"] as const;
export type TerminalReason = (typeof TERMINAL_REASONS)[number];
const STATUS_REASONS: Readonly<Record<TerminalStatus, readonly TerminalReason[]>> = {
	verified_success: ["clear_watch_receipt"], failed: ["pre_agent", "provider", "scheduler", "watchdog", "global_deadline"], cancelled: ["user_abort", "dispose"], blocked: ["policy", "snapshot", "trust", "capability", "quality_timeout"],
};
export const TERMINAL_REASON_BY_STATUS = STATUS_REASONS;

export type TerminalOwner = { sessionId: string; promptGeneration: number; terminalId: string };
export type OwnerKey = string;
export const ownerKey = (owner: TerminalOwner): OwnerKey => `${owner.sessionId}\u0000${owner.promptGeneration}\u0000${owner.terminalId}`;
export type Prompt = { owner: TerminalOwner; admissionEpoch: number };
export type DrainClaim = { claimId: string; claimantPrincipal: string; headAdmissionEpoch: number; nonceHash: string; expiresAt: number };
export type StartPending = { owner: TerminalOwner; invocationId: string; createdAt: number };
export type PairFlush = { owner: TerminalOwner; status: TerminalStatus; reason: TerminalReason; receiptId?: string; qualityAck: boolean; agentEndAck: boolean };

export type OutboxKind = "start_publish" | "terminal_pair";
export type OutboxStatus = "pending" | "published" | "acked";
export type DurableOutboxEntry = {
	outboxId: string;
	kind: OutboxKind;
	owner: TerminalOwner;
	invocationId: string;
	receiptId?: string;
	status: OutboxStatus;
	qualityAck: boolean;
	agentEndAck: boolean;
	createdAt: number;
	publishedAt?: number;
};

export type TimerKind = "provider_deadline" | "quality_deadline" | "continuation_lease" | "drain_claim";
export type StableTimer = { timerId: string; kind: TimerKind; generation: number; terminalId: string; leaseId?: string; cancellationEpoch: number; duration: number; wallAtPersist: number; bootId: string; monoAtPersist: number; wallUncertaintyAtPersist: number; fired: boolean };
export type ContinuationLease = { leaseId: string; owner: TerminalOwner; kind: "retry" | "tts" | "compaction" | "goal" | "todo" | "rewind" | "steer" | "follow_up"; expiresAt: number; consumed: boolean };
export type InvocationArchiveEntry = { invocationId: string; owner: TerminalOwner; status: TerminalStatus; reason: TerminalReason; receiptId?: string; archivedAt: number };
export type LifecycleAudit = { kind: "stale_terminal" | "duplicate_terminal" | "stale_ack" | "duplicate_ack" | "stale_publish" | "duplicate_publish" | "stale_claim" | "stale_callback" | "recovery"; owner?: TerminalOwner; invocationId?: string; at: number };

export type LifecycleState = {
	generation: number; admissionEpoch: number; phase: "idle" | "queued" | "draining" | "start_pending" | "running" | "terminal_pending";
	fifo: readonly Prompt[]; pairFlush: PairFlush | null; drainClaim: DrainClaim | null; startPending: StartPending | null;
	activeOwner: TerminalOwner | null; activeInvocationId: string | null; terminalStatus: TerminalStatus | null; terminalReason: TerminalReason | null;
	durableOutbox: readonly DurableOutboxEntry[]; timers: readonly StableTimer[]; continuationLeases: readonly ContinuationLease[];
	invocationArchive: readonly InvocationArchiveEntry[]; audit: readonly LifecycleAudit[]; cancellationEpoch: number;
};

export const initialLifecycleState = (): LifecycleState => ({ generation: 0, admissionEpoch: 0, phase: "idle", fifo: [], pairFlush: null, drainClaim: null, startPending: null, activeOwner: null, activeInvocationId: null, terminalStatus: null, terminalReason: null, durableOutbox: [], timers: [], continuationLeases: [], invocationArchive: [], audit: [], cancellationEpoch: 0 });
const validTerminal = (status: TerminalStatus, reason: TerminalReason): boolean => STATUS_REASONS[status].includes(reason);
const sameOwner = (a: TerminalOwner | null, b: TerminalOwner): boolean => a !== null && ownerKey(a) === ownerKey(b);
const nonemptyReceipt = (receiptId: string | undefined): boolean => typeof receiptId === "string" && receiptId.length > 0;
const receiptMatches = (pair: PairFlush, receiptId: string | undefined): boolean =>
	pair.receiptId === receiptId && (pair.status !== "verified_success" || nonemptyReceipt(receiptId));
const appendOutbox = (state: LifecycleState, entry: DurableOutboxEntry): LifecycleState => ({ ...state, durableOutbox: [...state.durableOutbox, entry] });
const outboxFor = (state: LifecycleState, kind: OutboxKind, invocationId: string): DurableOutboxEntry | undefined => state.durableOutbox.find((entry) => entry.kind === kind && entry.invocationId === invocationId);
const audit = (state: LifecycleState, item: LifecycleAudit): LifecycleState => ({ ...state, audit: [...state.audit, item] });

export type LifecycleAction =
	| { type: "enqueue"; owner: TerminalOwner }
	| { type: "claimDrain"; claim: DrainClaim; now: number }
	| { type: "start"; now: number; invocationId: string }
	| { type: "publishStart"; invocationId: string; now: number }
	| { type: "providerStarted"; invocationId?: string }
	| { type: "terminalize"; owner: TerminalOwner; invocationId?: string; status: TerminalStatus; reason: TerminalReason; receiptId?: string; now: number }
	| { type: "ackPair"; owner: TerminalOwner; invocationId?: string; part: "quality" | "agent_end"; status: TerminalStatus; reason: TerminalReason; receiptId?: string; now: number }
	| { type: "clear"; owner: TerminalOwner; invocationId?: string; receiptId: string; now: number }
	| { type: "abort"; owner: TerminalOwner; invocationId?: string; now: number }
	| { type: "addTimer"; timer: StableTimer }
	| { type: "timerCallback"; timerId: string; nowWall: number; nowMono: number; bootId: string; wallUncertainty: number }
	| { type: "lease"; lease: ContinuationLease }
	| { type: "consumeLease"; leaseId: string }
	| { type: "recoverInvocation"; invocationId: string; now?: number }
	| { type: "crashRestart" };

export const reduceLifecycle = (state: LifecycleState, action: LifecycleAction): LifecycleState => {
	switch (action.type) {
		case "enqueue": return { ...state, phase: state.phase === "idle" ? "queued" : state.phase, fifo: [...state.fifo, { owner: action.owner, admissionEpoch: state.admissionEpoch + state.fifo.length + 1 }] };
		case "claimDrain":
			if (state.drainClaim !== null || state.fifo.length === 0 || action.claim.claimId.length === 0 || action.claim.claimantPrincipal.length === 0 || action.claim.nonceHash.length === 0 || action.claim.expiresAt <= action.now || action.claim.headAdmissionEpoch !== state.fifo[0].admissionEpoch) return audit(state, { kind: "stale_claim", at: action.now });
			return { ...state, phase: "draining", drainClaim: action.claim };
		case "start": {
			if (state.phase !== "draining" || state.drainClaim === null || state.fifo.length === 0 || state.startPending !== null || state.pairFlush !== null || state.activeOwner !== null || state.drainClaim.expiresAt <= action.now || action.invocationId.length === 0) return state;
			const head = state.fifo[0];
			if (head === undefined) return state;
			const next = { owner: head.owner, invocationId: action.invocationId, createdAt: action.now };
			const outbox: DurableOutboxEntry = { outboxId: `start:${action.invocationId}`, kind: "start_publish", owner: head.owner, invocationId: action.invocationId, status: "pending", qualityAck: false, agentEndAck: false, createdAt: action.now };
			return { ...state, phase: "start_pending", fifo: state.fifo.slice(1), startPending: next, activeOwner: head.owner, activeInvocationId: action.invocationId, generation: head.owner.promptGeneration, admissionEpoch: head.admissionEpoch, durableOutbox: [...state.durableOutbox, outbox] };
		}
		case "publishStart": {
			const entry = outboxFor(state, "start_publish", action.invocationId);
			if (entry === undefined || entry.status !== "pending" || state.startPending?.invocationId !== action.invocationId) return audit(state, { kind: entry?.status === "published" ? "duplicate_publish" : "stale_publish", invocationId: action.invocationId, at: action.now });
			return { ...state, durableOutbox: state.durableOutbox.map((item) => item.outboxId === entry.outboxId ? { ...item, status: "published", publishedAt: action.now } : item) };
		}
		case "providerStarted": {
			const invocationId = action.invocationId ?? state.startPending?.invocationId;
			const entry = invocationId === undefined ? undefined : outboxFor(state, "start_publish", invocationId);
			if (state.phase !== "start_pending" || state.startPending === null || invocationId !== state.startPending.invocationId || entry?.status !== "published") return audit(state, { kind: "stale_callback", invocationId, at: 0 });
			return { ...state, phase: "running", startPending: null, drainClaim: null };
		}
		case "terminalize": {
			if (!validTerminal(action.status, action.reason)) return state;
			const invocationId = action.invocationId ?? state.activeInvocationId;
			if (invocationId === null || !sameOwner(state.activeOwner, action.owner) || invocationId !== state.activeInvocationId) return audit(state, { kind: state.terminalStatus === null ? "stale_terminal" : "duplicate_terminal", owner: action.owner, invocationId: invocationId ?? undefined, at: action.now });
			if (state.terminalStatus !== null) return audit(state, { kind: "duplicate_terminal", owner: action.owner, invocationId, at: action.now });
			if (action.status === "verified_success" && !nonemptyReceipt(action.receiptId)) return audit(state, { kind: "stale_terminal", owner: action.owner, invocationId, at: action.now });
			const pair: PairFlush = { owner: action.owner, status: action.status, reason: action.reason, receiptId: action.receiptId, qualityAck: false, agentEndAck: false };
			const entry: DurableOutboxEntry = { outboxId: `pair:${invocationId}`, kind: "terminal_pair", owner: action.owner, invocationId, receiptId: action.receiptId, status: "pending", qualityAck: false, agentEndAck: false, createdAt: action.now };
			return appendOutbox({ ...state, phase: "terminal_pending", terminalStatus: action.status, terminalReason: action.reason, pairFlush: pair }, entry);
		}
		case "clear": return reduceLifecycle(state, { type: "terminalize", owner: action.owner, invocationId: action.invocationId, status: "verified_success", reason: "clear_watch_receipt", receiptId: action.receiptId, now: action.now });
		case "abort": return reduceLifecycle(state, { type: "terminalize", owner: action.owner, invocationId: action.invocationId, status: "cancelled", reason: "user_abort", now: action.now });
		case "ackPair": {
			const pair = state.pairFlush;
			const invocationId = action.invocationId ?? state.activeInvocationId;
			if (pair === null || invocationId === null) return audit(state, { kind: "stale_ack", owner: action.owner, invocationId: invocationId ?? undefined, at: action.now });
			const entry = outboxFor(state, "terminal_pair", invocationId);
			if (entry === undefined || !sameOwner(pair.owner, action.owner) || invocationId !== state.activeInvocationId || pair.status !== action.status || pair.reason !== action.reason || !receiptMatches(pair, action.receiptId)) return audit(state, { kind: "stale_ack", owner: action.owner, invocationId, at: action.now });
			const alreadyAcked = action.part === "quality" ? pair.qualityAck : pair.agentEndAck;
			if (alreadyAcked) return audit(state, { kind: "duplicate_ack", owner: action.owner, invocationId, at: action.now });
			const nextPair: PairFlush = { ...pair, receiptId: pair.receiptId, qualityAck: pair.qualityAck || action.part === "quality", agentEndAck: pair.agentEndAck || action.part === "agent_end" };
			const nextEntry = { ...entry, status: "published" as const, qualityAck: nextPair.qualityAck, agentEndAck: nextPair.agentEndAck };
			if (!nextPair.qualityAck || !nextPair.agentEndAck) return { ...state, pairFlush: nextPair, durableOutbox: state.durableOutbox.map((item) => item.outboxId === entry.outboxId ? nextEntry : item) };
			const archive = [...state.invocationArchive, { invocationId, owner: pair.owner, status: pair.status, reason: pair.reason, receiptId: pair.receiptId, archivedAt: action.now }];
			const terminalPhase = state.fifo.length > 0 ? "queued" : "idle";
			return { ...state, phase: terminalPhase, pairFlush: null, drainClaim: null, startPending: null, activeOwner: null, activeInvocationId: null, terminalStatus: null, terminalReason: null, invocationArchive: archive, cancellationEpoch: state.cancellationEpoch + 1, durableOutbox: state.durableOutbox.map((item) => item.outboxId === entry.outboxId ? { ...nextEntry, receiptId: pair.receiptId, status: "acked" } : item) };
		}
		case "addTimer": return { ...state, timers: [...state.timers.filter((timer) => timer.timerId !== action.timer.timerId), action.timer] };
		case "timerCallback": {
			const timer = state.timers.find((item) => item.timerId === action.timerId);
			if (timer === undefined || timer.fired || timer.cancellationEpoch !== state.cancellationEpoch) return state;
			if (stableTimerRemaining(timer, action.nowWall, action.nowMono, action.bootId, action.wallUncertainty) > 0) return state;
			return { ...state, timers: state.timers.map((item) => item.timerId === action.timerId ? { ...item, fired: true } : item) };
		}
		case "lease": return { ...state, continuationLeases: [...state.continuationLeases.filter((lease) => lease.leaseId !== action.lease.leaseId), action.lease] };
		case "consumeLease": return { ...state, continuationLeases: state.continuationLeases.map((lease) => lease.leaseId === action.leaseId ? { ...lease, consumed: true } : lease) };
		case "recoverInvocation": {
			const entry = outboxFor(state, "start_publish", action.invocationId);
			if (state.phase !== "start_pending" || state.startPending?.invocationId !== action.invocationId || entry === undefined) return audit(state, { kind: "stale_callback", invocationId: action.invocationId, at: action.now ?? 0 });
			return { ...state, phase: "running", startPending: null, drainClaim: null, durableOutbox: state.durableOutbox.map((item) => item.outboxId === entry.outboxId ? { ...item, status: "published", publishedAt: action.now ?? item.createdAt } : item) };
		}
		case "crashRestart": return state.startPending === null ? state : { ...state, phase: "start_pending" };
	}
};

export const stableTimerRemaining = (timer: StableTimer, wallNow: number, monoNow: number, bootId: string, currentUncertainty: number): number => {
	const duration = Number.isFinite(timer.duration) && timer.duration >= 0 ? timer.duration : 0;
	if (bootId === timer.bootId) {
		if (!Number.isFinite(monoNow) || !Number.isFinite(timer.monoAtPersist)) return duration;
		return Math.min(duration, Math.max(0, duration - Math.max(0, monoNow - timer.monoAtPersist)));
	}
	if (!Number.isFinite(wallNow) || !Number.isFinite(timer.wallAtPersist) || !Number.isFinite(currentUncertainty) || currentUncertainty < 0 ||
		!Number.isFinite(timer.wallUncertaintyAtPersist) || timer.wallUncertaintyAtPersist < 0) return duration;
	const earliestDeadline = timer.wallAtPersist - timer.wallUncertaintyAtPersist + duration;
	const latestNow = wallNow + currentUncertainty;
	if (!Number.isFinite(earliestDeadline) || !Number.isFinite(latestNow)) return duration;
	return Math.min(duration, Math.max(0, earliestDeadline - latestNow));
};
export const pairFullyAcknowledged = (state: LifecycleState): boolean => state.pairFlush !== null && state.pairFlush.qualityAck && state.pairFlush.agentEndAck;
export const pairReceiptIdentity = (state: LifecycleState): string | undefined => state.pairFlush?.receiptId ?? state.invocationArchive.at(-1)?.receiptId;
export type StreamingEditDisposition = "supported" | "unsupported";
export type StreamingEditKind = "single_local_regular_patch" | "single_local_regular_replace" | "normal_local_regular_write" | "multi_file_apply_patch" | "hashline" | "vim" | "archive" | "sqlite" | "internal_url" | "conflict" | "acp_client_bridge" | "notebook" | "special_handler" | "unclassified";
export type StreamingEditGuard = { kind: StreamingEditKind; disposition: StreamingEditDisposition; reason: "declared_supported" | "unsupported_mutator" | "unsupported_platform" | "unknown" };
const SUPPORTED_STREAMING_EDIT_KINDS: readonly StreamingEditKind[] = ["single_local_regular_patch", "single_local_regular_replace", "normal_local_regular_write"];
export const streamingEditGuard = (kind: StreamingEditKind): StreamingEditGuard => {
	if (SUPPORTED_STREAMING_EDIT_KINDS.includes(kind)) return { kind, disposition: "supported", reason: "declared_supported" };
	if (kind === "unclassified") return { kind, disposition: "unsupported", reason: "unknown" };
	if (kind === "acp_client_bridge") return { kind, disposition: "unsupported", reason: "unsupported_platform" };
	return { kind, disposition: "unsupported", reason: "unsupported_mutator" };
};
