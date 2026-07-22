import * as fs from "node:fs/promises";
import * as path from "node:path";
import { initialLifecycleState, ownerKey, pairFullyAcknowledged, reduceLifecycle, stableTimerRemaining, streamingEditGuard, type LifecycleAction, type LifecycleState, type StableTimer, type TerminalOwner } from "../models/lifecycle-model";
import { ACCEPTANCE_RESOLVER_ROWS, crossed, initialQuiescenceState, isQuiescent, mandatoryObligations, phaseDeadlines, reconstructDeadline, reduceQuiescence, resolveAcceptance, resolveAcceptanceFromRows, riskBudgetFor, RUNNER_PROFILES, RISK_BUDGETS, type AcceptanceResolverRow, type Candidate, type PhaseName, type Risk, type SurfaceClass } from "../models/quiescence-budget-model";
import { exdevDurabilityOrder, initialStorageState, noFutureVersionReservation, reduceStorage, successorsBlocked, type MovePhase, type StorageAction, type StorageState } from "../models/storage-model";

/* Deterministic bounded state exploration. This is the only model I/O. */
type CaseResult = { name: string; passed: boolean; details?: string };
const cases: CaseResult[] = [];
const check = (name: string, predicate: boolean, details?: string): void => { cases.push({ name, passed: predicate, ...(details === undefined ? {} : { details }) }); };
const owner = (generation: number, terminalId = `terminal-${generation}`): TerminalOwner => ({ sessionId: "session-0", promptGeneration: generation, terminalId });
const invocation = (state: LifecycleState): string => state.activeInvocationId ?? "inv-1";


const lifecycleActions = (state: LifecycleState): readonly LifecycleAction[] => {
	const active = state.activeOwner ?? owner(1);
	const id = invocation(state);
	const timer: StableTimer = { timerId: "timer-1", kind: "provider_deadline", generation: active.promptGeneration, terminalId: active.terminalId, cancellationEpoch: state.cancellationEpoch, duration: 10, wallAtPersist: 100, bootId: "boot-a", monoAtPersist: 0, wallUncertaintyAtPersist: 2, fired: false };
	if (state.phase === "idle") return [{ type: "enqueue", owner: owner(state.invocationArchive.length + 1) }];
	if (state.phase === "queued") return [
		{ type: "claimDrain", claim: { claimId: "claim-1", claimantPrincipal: "svc", headAdmissionEpoch: state.fifo[0]?.admissionEpoch ?? 1, nonceHash: "n", expiresAt: 20 }, now: 1 },
		{ type: "claimDrain", claim: { claimId: "stale", claimantPrincipal: "svc", headAdmissionEpoch: 99, nonceHash: "n", expiresAt: 20 }, now: 1 },
	];
	if (state.phase === "draining") return [{ type: "start", invocationId: `inv-${active.promptGeneration}`, now: 2 }, { type: "crashRestart" }];
	if (state.phase === "start_pending") return [
		{ type: "publishStart", invocationId: id, now: 3 },
		{ type: "providerStarted", invocationId: id },
		{ type: "providerStarted", invocationId: "stale-inv" },
		{ type: "crashRestart" },
	];
	if (state.phase === "running") return [
		{ type: "clear", owner: active, invocationId: id, receiptId: `receipt:${id}`, now: 4 },
		{ type: "abort", owner: active, invocationId: id, now: 4 },
		{ type: "terminalize", owner: active, invocationId: id, status: "failed", reason: "provider", now: 4 },
		{ type: "addTimer", timer },
		{ type: "timerCallback", timerId: "timer-1", nowWall: 105, nowMono: 5, bootId: "boot-a", wallUncertainty: 2 },
		{ type: "crashRestart" },
	];
	if (state.phase === "terminal_pending") return [
		{ type: "ackPair", owner: active, invocationId: id, part: "quality", status: state.terminalStatus ?? "failed", reason: state.terminalReason ?? "provider", receiptId: state.pairFlush?.receiptId, now: 5 },
		{ type: "ackPair", owner: active, invocationId: id, part: "agent_end", status: state.terminalStatus ?? "failed", reason: state.terminalReason ?? "provider", receiptId: state.pairFlush?.receiptId, now: 5 },
		{ type: "recoverInvocation", invocationId: id, now: 6 },
		{ type: "crashRestart" },
	];
	return [];
};

type LifecycleTransition = { before: LifecycleState; action: LifecycleAction; after: LifecycleState; depth: number };
type LifecycleExploration = { states: number; transitions: number; terminalReachable: boolean; reachableStates: readonly LifecycleState[]; reachableTransitions: readonly LifecycleTransition[] };

const exploreLifecycle = (): LifecycleExploration => {
	const maxDepth = 9;
	const seen = new Set<string>();
	const maxStates = 5000;
	const queue: Array<{ state: LifecycleState; depth: number }> = [{ state: initialLifecycleState(), depth: 0 }];
	const reachableStates: LifecycleState[] = [];
	const reachableTransitions: LifecycleTransition[] = [];
	let terminalReachable = false;
	while (queue.length > 0 && seen.size < maxStates) {
		const item = queue.shift();
		if (item === undefined) break;
		const key = JSON.stringify(item.state);
		if (seen.has(key)) continue;
		seen.add(key);
		reachableStates.push(item.state);
		if (item.state.invocationArchive.length > 0) terminalReachable = true;
		if (item.depth >= maxDepth) continue;
		for (const action of lifecycleActions(item.state)) {
			const next = reduceLifecycle(item.state, action);
			reachableTransitions.push({ before: item.state, action, after: next, depth: item.depth + 1 });
			if (!seen.has(JSON.stringify(next))) queue.push({ state: next, depth: item.depth + 1 });
		}
	}
	return { states: reachableStates.length, transitions: reachableTransitions.length, terminalReachable, reachableStates, reachableTransitions };
};

const startRunning = (generation: number): LifecycleState => {
	let state = initialLifecycleState();
	state = reduceLifecycle(state, { type: "enqueue", owner: owner(generation) });
	state = reduceLifecycle(state, { type: "claimDrain", claim: { claimId: `claim-${generation}`, claimantPrincipal: "svc", headAdmissionEpoch: 1, nonceHash: "nonce", expiresAt: 100 }, now: 1 });
	state = reduceLifecycle(state, { type: "start", invocationId: `inv-${generation}`, now: 2 });
	state = reduceLifecycle(state, { type: "publishStart", invocationId: `inv-${generation}`, now: 2.5 });
	return reduceLifecycle(state, { type: "providerStarted", invocationId: `inv-${generation}` });
};

const lifecycleCases = (): void => {
	let state = startRunning(1);
	state = reduceLifecycle(state, { type: "terminalize", owner: owner(1), invocationId: "inv-1", status: "verified_success", reason: "clear_watch_receipt", receiptId: "receipt-1", now: 3 });
	const reordered = reduceLifecycle(state, { type: "ackPair", owner: owner(1), invocationId: "inv-1", part: "agent_end", status: "verified_success", reason: "clear_watch_receipt", receiptId: "receipt-1", now: 4 });
	check("lifecycle/pair-flush-requires-both-acks", !pairFullyAcknowledged(reordered) && reordered.activeOwner !== null);
	const fullAck = reduceLifecycle(reordered, { type: "ackPair", owner: owner(1), invocationId: "inv-1", part: "quality", status: "verified_success", reason: "clear_watch_receipt", receiptId: "receipt-1", now: 5 });
	check("lifecycle/pair-flush-archives-and-releases", fullAck.phase === "idle" && fullAck.activeOwner === null && fullAck.invocationArchive.length === 1 && fullAck.durableOutbox[1]?.status === "acked");
	check("lifecycle/reordered-pair-acks", reordered.pairFlush?.agentEndAck === true && fullAck.durableOutbox.some((entry) => entry.kind === "terminal_pair" && entry.status === "acked"));
	check("lifecycle/duplicate-ack-event", reduceLifecycle(reordered, { type: "ackPair", owner: owner(1), invocationId: "inv-1", part: "agent_end", status: "verified_success", reason: "clear_watch_receipt", receiptId: "receipt-1", now: 4 }).audit.at(-1)?.kind === "duplicate_ack");
	let twoPrompt = initialLifecycleState();
	for (const generation of [20, 21]) twoPrompt = reduceLifecycle(twoPrompt, { type: "enqueue", owner: owner(generation) });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "claimDrain", claim: { claimId: "two-a", claimantPrincipal: "svc", headAdmissionEpoch: 1, nonceHash: "n", expiresAt: 100 }, now: 1 });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "start", invocationId: "two-a", now: 2 });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "publishStart", invocationId: "two-a", now: 2 });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "providerStarted", invocationId: "two-a" });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "terminalize", owner: owner(20), invocationId: "two-a", status: "failed", reason: "provider", receiptId: "receipt-a", now: 3 });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "ackPair", owner: owner(20), invocationId: "two-a", part: "agent_end", status: "failed", reason: "provider", receiptId: "receipt-a", now: 4 });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "crashRestart" });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "ackPair", owner: owner(20), invocationId: "two-a", part: "quality", status: "failed", reason: "provider", receiptId: "receipt-a", now: 5 });
	const firstReceiptOutbox = twoPrompt.durableOutbox.find((entry) => entry.invocationId === "two-a" && entry.kind === "terminal_pair");
	check("lifecycle/full-pair-queues-successor", twoPrompt.phase === "queued" && twoPrompt.fifo[0]?.owner.promptGeneration === 21 && firstReceiptOutbox?.receiptId === "receipt-a" && twoPrompt.invocationArchive[0]?.receiptId === "receipt-a");
	twoPrompt = reduceLifecycle(twoPrompt, { type: "claimDrain", claim: { claimId: "two-b", claimantPrincipal: "svc", headAdmissionEpoch: 2, nonceHash: "n", expiresAt: 100 }, now: 6 });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "start", invocationId: "two-b", now: 7 });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "publishStart", invocationId: "two-b", now: 7 });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "providerStarted", invocationId: "two-b" });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "terminalize", owner: owner(21), invocationId: "two-b", status: "failed", reason: "provider", receiptId: "receipt-b", now: 8 });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "ackPair", owner: owner(21), invocationId: "two-b", part: "quality", status: "failed", reason: "provider", receiptId: "receipt-b", now: 9 });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "crashRestart" });
	twoPrompt = reduceLifecycle(twoPrompt, { type: "ackPair", owner: owner(21), invocationId: "two-b", part: "agent_end", status: "failed", reason: "provider", receiptId: "receipt-b", now: 10 });
	check("lifecycle/two-prompt-reordered-ack-crash-trace", twoPrompt.phase === "idle" && twoPrompt.fifo.length === 0 && twoPrompt.invocationArchive.length === 2);
	let missingReceipt = startRunning(22);
	missingReceipt = reduceLifecycle(missingReceipt, { type: "terminalize", owner: owner(22), invocationId: "inv-22", status: "verified_success", reason: "clear_watch_receipt", now: 3 });
	check("lifecycle/verified-success-requires-receipt", missingReceipt.phase === "running" && missingReceipt.audit.at(-1)?.kind === "stale_terminal");
	let missingClearReceipt = startRunning(24);
	missingClearReceipt = reduceLifecycle(missingClearReceipt, { type: "clear", owner: owner(24), invocationId: "inv-24", now: 3 } as unknown as LifecycleAction);
	check("lifecycle/clear-requires-real-receipt", missingClearReceipt.phase === "running" && missingClearReceipt.audit.at(-1)?.kind === "stale_terminal");
	let receiptMismatch = startRunning(23);
	receiptMismatch = reduceLifecycle(receiptMismatch, { type: "terminalize", owner: owner(23), invocationId: "inv-23", status: "verified_success", reason: "clear_watch_receipt", receiptId: "receipt-a", now: 3 });
	receiptMismatch = reduceLifecycle(receiptMismatch, { type: "ackPair", owner: owner(23), invocationId: "inv-23", part: "quality", status: "verified_success", reason: "clear_watch_receipt", receiptId: "receipt-b", now: 4 });
	check("lifecycle/receipt-mismatch-is-stale", receiptMismatch.pairFlush?.receiptId === "receipt-a" && receiptMismatch.pairFlush?.qualityAck === false && receiptMismatch.audit.at(-1)?.kind === "stale_ack");
	let fifo = initialLifecycleState();
	fifo = reduceLifecycle(fifo, { type: "enqueue", owner: owner(10) }); fifo = reduceLifecycle(fifo, { type: "enqueue", owner: owner(11) });
	fifo = reduceLifecycle(fifo, { type: "claimDrain", claim: { claimId: "fifo-claim", claimantPrincipal: "svc", headAdmissionEpoch: 1, nonceHash: "fifo", expiresAt: 100 }, now: 1 });
	fifo = reduceLifecycle(fifo, { type: "start", invocationId: "fifo-inv", now: 2 });
	check("lifecycle/fifo-head-before-successor", fifo.activeOwner?.promptGeneration === 10 && fifo.fifo[0]?.owner.promptGeneration === 11);
	const retryLeaseState = reduceLifecycle(initialLifecycleState(), { type: "lease", lease: { leaseId: "lease-1", owner: owner(10), kind: "retry", expiresAt: 100, consumed: false } });
	check("lifecycle/manual-retry-continuation-lease", reduceLifecycle(retryLeaseState, { type: "consumeLease", leaseId: "lease-1" }).continuationLeases[0]?.consumed === true);
	const clearWins = reduceLifecycle(startRunning(2), { type: "clear", owner: owner(2), invocationId: "inv-2", receiptId: "receipt:inv-2", now: 3 });
	const abortAfterClear = reduceLifecycle(clearWins, { type: "abort", owner: owner(2), invocationId: "inv-2", now: 4 });
	check("lifecycle/abort-vs-clear-first-cas", abortAfterClear.terminalStatus === "verified_success" && abortAfterClear.audit.some((entry) => entry.kind === "duplicate_terminal"));
	const abortWins = reduceLifecycle(startRunning(3), { type: "abort", owner: owner(3), invocationId: "inv-3", now: 3 });
	check("lifecycle/clear-loses-after-abort-cas", reduceLifecycle(abortWins, { type: "clear", owner: owner(3), invocationId: "inv-3", receiptId: "receipt:inv-3", now: 4 }).terminalStatus === "cancelled");
	const stale = reduceLifecycle(startRunning(4), { type: "terminalize", owner: owner(999), invocationId: "inv-4", status: "failed", reason: "provider", now: 3 });
	check("lifecycle/stale-terminal-is-audit-noop", stale.activeOwner !== null && stale.terminalStatus === null && stale.audit.at(-1)?.kind === "stale_terminal");
	let pendingCrash = initialLifecycleState();
	pendingCrash = reduceLifecycle(pendingCrash, { type: "enqueue", owner: owner(5) }); pendingCrash = reduceLifecycle(pendingCrash, { type: "claimDrain", claim: { claimId: "c5", claimantPrincipal: "svc", headAdmissionEpoch: 1, nonceHash: "n", expiresAt: 100 }, now: 1 }); pendingCrash = reduceLifecycle(pendingCrash, { type: "start", invocationId: "i5", now: 2 });
	check("lifecycle/crash-restart-preserves-start-outbox", reduceLifecycle(pendingCrash, { type: "crashRestart" }).durableOutbox[0]?.status === "pending");
	check("lifecycle/provider-start-requires-published-outbox", reduceLifecycle(pendingCrash, { type: "providerStarted", invocationId: "i5" }).phase === "start_pending");
	check("lifecycle/lost-effect-recovery-reuses-invocation", reduceLifecycle(pendingCrash, { type: "recoverInvocation", invocationId: "i5", now: 3 }).phase === "running");
	check("lifecycle/publish-ack-restart-stale-callback", reduceLifecycle(reduceLifecycle(pendingCrash, { type: "publishStart", invocationId: "i5", now: 3 }), { type: "providerStarted", invocationId: "old-i5" }).audit.at(-1)?.kind === "stale_callback");
	const staleRecoveryState: LifecycleState = {
		...pendingCrash,
		durableOutbox: [...pendingCrash.durableOutbox, { outboxId: "start:stale-i5", kind: "start_publish", owner: owner(5), invocationId: "stale-i5", status: "pending", qualityAck: false, agentEndAck: false, createdAt: 3 }],
	};
	const staleRecoveryResult = reduceLifecycle(staleRecoveryState, { type: "recoverInvocation", invocationId: "stale-i5", now: 4 });
	check("lifecycle/stale-recovery-callback-is-audit-noop", staleRecoveryResult.phase === "start_pending" && staleRecoveryResult.audit.at(-1)?.kind === "stale_callback");
	check("lifecycle/duplicate-publish-and-ack-events", reduceLifecycle(reduceLifecycle(reduceLifecycle(pendingCrash, { type: "publishStart", invocationId: "i5", now: 3 }), { type: "publishStart", invocationId: "i5", now: 4 }), { type: "providerStarted", invocationId: "old-i5" }).audit.some((entry) => entry.kind === "duplicate_publish"));
	const timer: StableTimer = { timerId: "timer-1", kind: "provider_deadline", generation: 1, terminalId: "terminal-1", cancellationEpoch: 0, duration: 100, wallAtPersist: 1_000, monoAtPersist: 10, bootId: "boot-a", wallUncertaintyAtPersist: 5, fired: false };
	check("lifecycle/stable-timer-same-boot", stableTimerRemaining(timer, 1_001, 60, "boot-a", 5) === 50);
	check("lifecycle/stable-timer-changed-boot-uncertainty", stableTimerRemaining(timer, 1_050, 0, "boot-b", 10) === 35);
	check("lifecycle/stable-timer-wall-clock-rollback-bounded", stableTimerRemaining(timer, 900, 0, "boot-b", 0) <= timer.duration && stableTimerRemaining(timer, Number.NEGATIVE_INFINITY, 0, "boot-b", 0) === timer.duration && stableTimerRemaining(timer, 1_050, 0, "boot-b", Number.POSITIVE_INFINITY) === timer.duration);
	let timerState = reduceLifecycle(initialLifecycleState(), { type: "addTimer", timer });
	timerState = reduceLifecycle(timerState, { type: "timerCallback", timerId: "timer-1", nowWall: 1_010, nowMono: 1, bootId: "boot-a", wallUncertainty: 5 });
	check("lifecycle/early-timer-callback-does-not-fire", timerState.timers[0].fired === false);
	const exact = reduceLifecycle(timerState, { type: "timerCallback", timerId: "timer-1", nowWall: 1_010, nowMono: 110, bootId: "boot-a", wallUncertainty: 5 });
	check("lifecycle/exact-timer-callback-fires-once", exact.timers[0].fired && reduceLifecycle(exact, { type: "timerCallback", timerId: "timer-1", nowWall: 1_100, nowMono: 110, bootId: "boot-a", wallUncertainty: 5 }).timers[0].fired);
	check("lifecycle/repeated-timer-callback-is-idempotent", reduceLifecycle(exact, { type: "timerCallback", timerId: "timer-1", nowWall: 1_100, nowMono: 110, bootId: "boot-a", wallUncertainty: 5 }).timers[0].fired);
	let cancelBase = reduceLifecycle(startRunning(9), { type: "clear", owner: owner(9), invocationId: "inv-9", receiptId: "receipt:inv-9", now: 2 });
	cancelBase = reduceLifecycle(cancelBase, { type: "addTimer", timer });
	cancelBase = reduceLifecycle(cancelBase, { type: "ackPair", owner: owner(9), invocationId: "inv-9", part: "quality", status: "verified_success", reason: "clear_watch_receipt", receiptId: "receipt:inv-9", now: 3 });
	cancelBase = reduceLifecycle(cancelBase, { type: "ackPair", owner: owner(9), invocationId: "inv-9", part: "agent_end", status: "verified_success", reason: "clear_watch_receipt", receiptId: "receipt:inv-9", now: 4 });
	check("lifecycle/cancelled-timer-callback-is-noop", reduceLifecycle(cancelBase, { type: "timerCallback", timerId: "timer-1", nowWall: 2_000, nowMono: 1, bootId: "boot-b", wallUncertainty: 0 }).timers[0].fired === false);
	check("lifecycle/guard-supported", streamingEditGuard("single_local_regular_patch").disposition === "supported"); check("lifecycle/guard-unsupported", streamingEditGuard("multi_file_apply_patch").disposition === "unsupported"); check("lifecycle/guard-unknown-fails-closed", streamingEditGuard("unclassified").reason === "unknown"); check("lifecycle/owner-key-generation-scoped", ownerKey(owner(1)) !== ownerKey(owner(2)));
	const explored = exploreLifecycle();
	check("lifecycle/bounded-reachable-exploration", explored.states > 1 && explored.transitions > explored.states && explored.terminalReachable, JSON.stringify({ states: explored.states, transitions: explored.transitions }));
};

const storageActions = (state: StorageState): readonly StorageAction[] => {
	const common: readonly StorageAction[] = [
		{ type: "enqueue", kind: "mutation", intentHash: "m1", invocationId: "inv-1" }, { type: "enqueue", kind: "mutation", intentHash: "m2", invocationId: "inv-2" },
		{ type: "begin", physicalWriteSeq: 1 }, { type: "begin", physicalWriteSeq: 2 }, { type: "commit", physicalWriteSeq: 1, now: 1 }, { type: "fail", physicalWriteSeq: 1, now: 1 }, { type: "restart", now: 2 },
		{ type: "recoverClaim", physicalWriteSeq: 1, claimId: "r1", claimantPrincipal: "svc", invocationId: "rec-1", now: 2, expiresAt: 5 }, { type: "recoverClaim", physicalWriteSeq: 1, claimId: "r2", claimantPrincipal: "svc", invocationId: "rec-2", now: 6, expiresAt: 8 }, { type: "recoverComplete", physicalWriteSeq: 1, claimId: "r1", disposition: "recovered_commit", now: 3 }, { type: "recoverComplete", physicalWriteSeq: 1, claimId: "r2", disposition: "unrecoverable", now: 7 },
	];
	if (state.move === null) return [{ type: "startMove", move: { invocationId: "move-exdev", sourceIdentity: "src", destinationIdentity: "dst", overwrite: false, kind: "exdev" } }, { type: "startMove", move: { invocationId: "move", sourceIdentity: "src", destinationIdentity: "dst", overwrite: false, kind: "same_fs" } }, ...common];
	if (state.move.kind === "same_fs") {
		if (state.move.phase === "created") return [{ type: "moveStep", invocationId: state.move.invocationId, phase: "renamed", now: state.observedEvents.length }];
		if (state.move.phase === "renamed") return [{ type: "moveStep", invocationId: state.move.invocationId, phase: "verified", now: state.observedEvents.length }, { type: "moveStep", invocationId: state.move.invocationId, phase: "verified", success: false, now: state.observedEvents.length }];
		if (state.move.phase === "verified") return [{ type: "moveStep", invocationId: state.move.invocationId, phase: "committed", now: state.observedEvents.length }];
		return [];
	}
	const nextPhase: Partial<Record<MovePhase, MovePhase>> = { created: "copied_temp", copied_temp: "file_fsynced", file_fsynced: "verified_temp", verified_temp: "dest_renamed", dest_renamed: "dest_dir_fsynced", dest_dir_fsynced: "source_unlinked", source_unlinked: "source_dir_fsynced", source_dir_fsynced: "verified", verified: "committed" };
	const next = nextPhase[state.move.phase];
	if (next === undefined) return [];
	const success: StorageAction = { type: "moveStep", invocationId: state.move.invocationId, phase: next, now: state.observedEvents.length };
	return state.move.phase === "dest_dir_fsynced" ? [success, { ...success, success: false }] : [success];
};
type StorageTransition = { before: StorageState; action: StorageAction; after: StorageState; depth: number };
type StorageExploration = { states: number; transitions: number; reachableStates: readonly StorageState[]; reachableTransitions: readonly StorageTransition[] };

const exploreStorage = (): StorageExploration => {
	const seen = new Set<string>();
	const maxStates = 5000;
	const initial = initialStorageState();
	const exdevSeed = reduceStorage(initial, { type: "startMove", move: { invocationId: "move-exdev", sourceIdentity: "src", destinationIdentity: "dst", overwrite: false, kind: "exdev" } });
	const queue: Array<{ state: StorageState; depth: number }> = [{ state: exdevSeed, depth: 0 }, { state: initial, depth: 0 }];
	const reachableStates: StorageState[] = [];
	const reachableTransitions: StorageTransition[] = [];
	while (queue.length > 0 && seen.size < maxStates) {
		const item = queue.shift();
		if (item === undefined) break;
		const key = JSON.stringify(item.state);
		if (seen.has(key)) continue;
		seen.add(key);
		reachableStates.push(item.state);
		if (item.depth >= 10) continue;
		for (const action of storageActions(item.state)) {
			const next = reduceStorage(item.state, action);
			reachableTransitions.push({ before: item.state, action, after: next, depth: item.depth + 1 });
			if (!seen.has(JSON.stringify(next))) {
				const queued = { state: next, depth: item.depth + 1 };
				if (item.state.move === null) queue.push(queued);
				else queue.unshift(queued);
			}
		}
	}
	return { states: reachableStates.length, transitions: reachableTransitions.length, reachableStates, reachableTransitions };
};

const storageCases = (): void => {
	let state = initialStorageState(7); state = reduceStorage(state, { type: "enqueue", kind: "mutation", intentHash: "m10", invocationId: "inv-10" }); state = reduceStorage(state, { type: "begin", physicalWriteSeq: 1 }); state = reduceStorage(state, { type: "fail", physicalWriteSeq: 1, now: 1 }); state = reduceStorage(state, { type: "recoverClaim", physicalWriteSeq: 1, claimId: "r10", claimantPrincipal: "svc", invocationId: "rec-10", now: 2, expiresAt: 100 }); state = reduceStorage(state, { type: "recoverComplete", physicalWriteSeq: 1, claimId: "r10", disposition: "verified_no_mutation", now: 3 }); state = reduceStorage(state, { type: "enqueue", kind: "mutation", intentHash: "m11", invocationId: "inv-11" }); state = reduceStorage(state, { type: "begin", physicalWriteSeq: 2 }); state = reduceStorage(state, { type: "commit", physicalWriteSeq: 2, now: 4 });
	check("storage/R10-noop-then-B11-commit", state.fileVersion === 8 && state.slots[0].outputFileVersion === 7 && state.slots[1].inputFileVersion === 7);
	let prequeued = initialStorageState(0);
	prequeued = reduceStorage(prequeued, { type: "enqueue", kind: "mutation", intentHash: "a", invocationId: "a" });
	prequeued = reduceStorage(prequeued, { type: "enqueue", kind: "mutation", intentHash: "b", invocationId: "b" });
	prequeued = reduceStorage(prequeued, { type: "begin", physicalWriteSeq: 1 });
	prequeued = reduceStorage(prequeued, { type: "commit", physicalWriteSeq: 1, now: 1 });
	prequeued = reduceStorage(prequeued, { type: "begin", physicalWriteSeq: 2 });
	prequeued = reduceStorage(prequeued, { type: "commit", physicalWriteSeq: 2, now: 2 });
	check("storage/prequeued-A-B-progress-v0-v1-v2", prequeued.fileVersion === 2 && prequeued.slots[0]?.outputFileVersion === 1 && prequeued.slots[1]?.inputFileVersion === 1 && prequeued.slots[1]?.outputFileVersion === 2);
	let partial = initialStorageState(10); partial = reduceStorage(partial, { type: "enqueue", kind: "mutation", intentHash: "m10", invocationId: "inv-10" }); partial = reduceStorage(partial, { type: "begin", physicalWriteSeq: 1 }); partial = reduceStorage(partial, { type: "fail", physicalWriteSeq: 1, now: 1 }); partial = reduceStorage(partial, { type: "recoverClaim", physicalWriteSeq: 1, claimId: "r10", claimantPrincipal: "svc", invocationId: "rec-10", now: 2, expiresAt: 100 }); partial = reduceStorage(partial, { type: "recoverComplete", physicalWriteSeq: 1, claimId: "r10", disposition: "recovered_commit", now: 3 });
	check("storage/partial-move-recovered-commit", partial.fileVersion === 11 && partial.slots[0].outputFileVersion === 11);
	check("storage/duplicate-recovery-cas-audit", reduceStorage(partial, { type: "recoverComplete", physicalWriteSeq: 1, claimId: "r10", disposition: "recovered_commit", now: 4 }).audit.at(-1)?.kind === "stale_cas");
	let blocked = initialStorageState(0); blocked = reduceStorage(blocked, { type: "enqueue", kind: "mutation", intentHash: "a", invocationId: "a" }); blocked = reduceStorage(blocked, { type: "enqueue", kind: "mutation", intentHash: "b", invocationId: "b" }); blocked = reduceStorage(blocked, { type: "begin", physicalWriteSeq: 1 }); blocked = reduceStorage(blocked, { type: "fail", physicalWriteSeq: 1, now: 1 });
	check("storage/blocked-successor", successorsBlocked(blocked, 1) && reduceStorage(blocked, { type: "begin", physicalWriteSeq: 2 }).audit.at(-1)?.kind === "blocked_successor");
	let deferred = initialStorageState(3); deferred = reduceStorage(deferred, { type: "deferRewrite", intentHash: "rewrite", invocationId: "rw" }); check("storage/deferred-rewrite-does-not-reserve-version", deferred.fileVersion === 3 && deferred.slots[0].deferred && noFutureVersionReservation(deferred));
	let restarted = initialStorageState(4); restarted = reduceStorage(restarted, { type: "enqueue", kind: "mutation", intentHash: "m", invocationId: "i" }); restarted = reduceStorage(restarted, { type: "begin", physicalWriteSeq: 1 }); restarted = reduceStorage(restarted, { type: "restart", now: 9 }); check("storage/crash-restart-enters-same-slot-recovery", restarted.slots[0].status === "provisionally_failed");
	let sameFs = initialStorageState(); sameFs = reduceStorage(sameFs, { type: "startMove", move: { invocationId: "move-same", sourceIdentity: "src", destinationIdentity: "dst", overwrite: false, kind: "same_fs" } }); sameFs = reduceStorage(sameFs, { type: "moveStep", invocationId: "move-same", phase: "renamed", now: 1 }); sameFs = reduceStorage(sameFs, { type: "moveStep", invocationId: "move-same", phase: "verified", now: 2, evidence: "forged" }); sameFs = reduceStorage(sameFs, { type: "moveStep", invocationId: "move-same", phase: "committed", now: 3 });
	check("storage/same-fs-move-directory-fsync-evidence", sameFs.move?.phase === "committed" && sameFs.move.evidence.join(",") === "directory_fsync:success" && sameFs.observedEvents.every((event) => event.outcome === "success"));
	check("storage/sync-fsync-order", sameFs.observedEvents.map((event) => event.operation).join(",") === ["write_all", "fsync_temp", "close_temp", "rename", "directory_fsync", "verify", "commit_version"].join(","));
	let exdev = initialStorageState(); exdev = reduceStorage(exdev, { type: "startMove", move: { invocationId: "move-exdev", sourceIdentity: "src", destinationIdentity: "dst", overwrite: false, kind: "exdev" } }); for (const phase of ["copied_temp", "file_fsynced", "verified_temp", "dest_renamed"] as const) exdev = reduceStorage(exdev, { type: "moveStep", invocationId: "move-exdev", phase, now: exdev.observedEvents.length }); exdev = reduceStorage(exdev, { type: "moveStep", invocationId: "move-exdev", phase: "dest_dir_fsynced", now: 5 }); exdev = reduceStorage(exdev, { type: "moveStep", invocationId: "move-exdev", phase: "source_unlinked", now: 6 }); exdev = reduceStorage(exdev, { type: "moveStep", invocationId: "move-exdev", phase: "source_dir_fsynced", now: 7 }); exdev = reduceStorage(exdev, { type: "moveStep", invocationId: "move-exdev", phase: "verified", now: 8 }); exdev = reduceStorage(exdev, { type: "moveStep", invocationId: "move-exdev", phase: "committed", now: 9 });
	check("storage/exdev-copy-unlink-directory-fsync", exdev.move?.phase === "committed" && exdev.move.evidence.length === 3 && exdev.move.evidence.join(",") === "directory_fsync:success,source_unlink:success,directory_fsync:success" && exdev.observedEvents.filter((event) => event.operation === "directory_fsync").length === 2);
	check("storage/exdev-phase-order", exdev.observedEvents.findIndex((event) => event.operation === "fsync_temp") < exdev.observedEvents.findIndex((event) => event.operation === "directory_fsync"));
	check("storage/exdev-source-unlink-order", exdev.move?.phase === "committed" && exdev.observedEvents.map((event) => `${event.operation}:${event.outcome}`).join(",") === "write_all:success,fsync_temp:success,verify:success,rename:success,directory_fsync:success,source_unlink:success,directory_fsync:success,verify:success,commit_version:success");
	let failedMove = initialStorageState(); failedMove = reduceStorage(failedMove, { type: "startMove", move: { invocationId: "fsync-fail", sourceIdentity: "src", destinationIdentity: "dst", overwrite: false, kind: "same_fs" } }); failedMove = reduceStorage(failedMove, { type: "moveStep", invocationId: "fsync-fail", phase: "renamed", now: 1 }); failedMove = reduceStorage(failedMove, { type: "moveStep", invocationId: "fsync-fail", phase: "verified", now: 2, success: false });
	check("storage/fsync-failure-no-fabricated-evidence", failedMove.move?.phase === "failed_unknown" && failedMove.move.evidence.length === 0 && failedMove.observedEvents.at(-1)?.outcome === "failure");
	let exdevFailure = initialStorageState();
	exdevFailure = reduceStorage(exdevFailure, { type: "startMove", move: { invocationId: "exdev-fail", sourceIdentity: "src", destinationIdentity: "dst", overwrite: false, kind: "exdev" } });
	exdevFailure = reduceStorage(exdevFailure, { type: "moveStep", invocationId: "exdev-fail", phase: "copied_temp", now: 1 });
	exdevFailure = reduceStorage(exdevFailure, { type: "moveStep", invocationId: "exdev-fail", phase: "file_fsynced", now: 2, success: false });
	check("storage/exdev-failure-no-fabricated-evidence", exdevFailure.move?.phase === "failed_unknown" && exdevFailure.move.evidence.length === 0 && exdevFailure.observedEvents.at(-1)?.outcome === "failure");
	let unlinkFailure = initialStorageState();
	unlinkFailure = reduceStorage(unlinkFailure, { type: "startMove", move: { invocationId: "exdev-unlink-fail", sourceIdentity: "src", destinationIdentity: "dst", overwrite: false, kind: "exdev" } });
	for (const phase of ["copied_temp", "file_fsynced", "verified_temp", "dest_renamed", "dest_dir_fsynced"] as const) unlinkFailure = reduceStorage(unlinkFailure, { type: "moveStep", invocationId: "exdev-unlink-fail", phase, now: unlinkFailure.observedEvents.length });
	unlinkFailure = reduceStorage(unlinkFailure, { type: "moveStep", invocationId: "exdev-unlink-fail", phase: "source_unlinked", success: false, now: unlinkFailure.observedEvents.length });
	check("storage/exdev-unlink-failure-no-fabricated-evidence", unlinkFailure.move?.phase === "failed_unknown" && !unlinkFailure.move.evidence.some((evidence) => evidence === "source_unlink:success") && unlinkFailure.observedEvents.at(-1)?.operation === "source_unlink" && unlinkFailure.observedEvents.at(-1)?.outcome === "failure");
	let unrecoverable = initialStorageState(); unrecoverable = reduceStorage(unrecoverable, { type: "enqueue", kind: "mutation", intentHash: "u", invocationId: "u" }); unrecoverable = reduceStorage(unrecoverable, { type: "begin", physicalWriteSeq: 1 }); unrecoverable = reduceStorage(unrecoverable, { type: "fail", physicalWriteSeq: 1, now: 1 }); unrecoverable = reduceStorage(unrecoverable, { type: "recoverClaim", physicalWriteSeq: 1, claimId: "u1", claimantPrincipal: "svc", invocationId: "r", now: 2, expiresAt: 3 }); unrecoverable = reduceStorage(unrecoverable, { type: "recoverComplete", physicalWriteSeq: 1, claimId: "u1", disposition: "unrecoverable", now: 2 });
	check("storage/unrecoverable-disposition-blocks-slot", unrecoverable.slots[0].status === "blocked" && successorsBlocked({ ...unrecoverable, slots: [...unrecoverable.slots, { ...unrecoverable.slots[0], physicalWriteSeq: 2, status: "queued" }] }, 1));
	let limited = initialStorageState(); limited = reduceStorage(limited, { type: "enqueue", kind: "mutation", intentHash: "limit", invocationId: "limit" }); limited = reduceStorage(limited, { type: "begin", physicalWriteSeq: 1 }); limited = reduceStorage(limited, { type: "fail", physicalWriteSeq: 1, now: 1 });
	for (let attempt = 0; attempt < 4; attempt++) limited = reduceStorage(limited, { type: "recoverClaim", physicalWriteSeq: 1, claimId: `limit-${attempt}`, claimantPrincipal: "svc", invocationId: `r-${attempt}`, now: 10 + attempt * 2, expiresAt: 11 + attempt * 2 });
	check("storage/same-slot-recovery-attempt-limit", limited.audit.some((entry) => entry.kind === "recovery_limit"));
	const expiry = reduceStorage(reduceStorage(reduceStorage(initialStorageState(), { type: "enqueue", kind: "mutation", intentHash: "e", invocationId: "e" }), { type: "begin", physicalWriteSeq: 1 }), { type: "fail", physicalWriteSeq: 1, now: 1 });
	const claimedExpiry = reduceStorage(expiry, { type: "recoverClaim", physicalWriteSeq: 1, claimId: "expiry", claimantPrincipal: "svc", invocationId: "expiry", now: 2, expiresAt: 3 });
	check("storage/claim-expiry-boundary", reduceStorage(claimedExpiry, { type: "recoverComplete", physicalWriteSeq: 1, claimId: "expiry", disposition: "verified_no_mutation", now: 3 }).audit.at(-1)?.kind === "claim_expired");
	check("storage/no-future-version-reservation", noFutureVersionReservation(state));
	const explored = exploreStorage(); check("storage/bounded-reachable-exploration", explored.states > 1 && explored.transitions > explored.states, JSON.stringify({ states: explored.states, transitions: explored.transitions }));
	check("storage/reachable-exdev-commit-with-unlink", explored.reachableStates.some((candidate) => candidate.move?.kind === "exdev" && candidate.move.phase === "committed"));
};

type LifecycleInvariant = { name: string; predicate: (model: LifecycleExploration) => boolean };
type StorageInvariant = { name: string; predicate: (model: StorageExploration) => boolean };
type MutationProbe = { name: string; rejected: boolean; details: string };

const lifecycleInvariantDefinitions: readonly LifecycleInvariant[] = [
	{
		name: "bounded_liveness",
		predicate: (model) => model.states > 1 && model.transitions > model.states && model.terminalReachable &&
			model.reachableStates.length === model.states && model.reachableTransitions.length === model.transitions,
	},
	{
		name: "terminal_pair_exactly_once",
		predicate: (model) => model.reachableStates.every((state) => state.phase !== "terminal_pending" ||
			(state.pairFlush !== null && state.activeInvocationId !== null && state.terminalStatus !== null && state.terminalReason !== null)) &&
			model.reachableStates.every((state) => new Set(state.durableOutbox.map((entry) => `${entry.kind}:${entry.invocationId}`)).size === state.durableOutbox.length &&
				new Set(state.invocationArchive.map((entry) => entry.invocationId)).size === state.invocationArchive.length) &&
			model.reachableTransitions.every((transition) => transition.action.type !== "terminalize" ||
				transition.after.phase !== "terminal_pending" ||
				transition.after.pairFlush !== null),
	},
	{
		name: "terminal_receipt_identity",
		predicate: (model) => model.reachableStates.every((state) => {
			const terminalEntries = state.durableOutbox.filter((entry) => entry.kind === "terminal_pair");
			return terminalEntries.every((entry) => {
				const archive = state.invocationArchive.find((item) => item.invocationId === entry.invocationId);
				const pending = state.pairFlush !== null && state.activeInvocationId === entry.invocationId ? state.pairFlush : undefined;
				return (archive === undefined || archive.receiptId === entry.receiptId) &&
					(pending === undefined || (pending.receiptId === entry.receiptId && (pending.status !== "verified_success" || typeof pending.receiptId === "string" && pending.receiptId.length > 0)));
			});
		}),
	},
	{
		name: "fifo_pair_drain",
		predicate: (model) => model.reachableTransitions.every((transition) => {
			if (transition.action.type !== "ackPair" || transition.before.pairFlush === null || transition.before.fifo.length === 0) return true;
			const pair = transition.before.pairFlush;
			const alreadyAcked = transition.action.part === "quality" ? pair.qualityAck : pair.agentEndAck;
			if (alreadyAcked || transition.action.receiptId !== pair.receiptId) return true;
			const complete = (pair.qualityAck || transition.action.part === "quality") && (pair.agentEndAck || transition.action.part === "agent_end");
			return !complete || transition.after.phase === "queued";
		}),
	},
	{
		name: "fifo",
		predicate: (model) => model.reachableStates.every((state) => state.fifo.every((prompt, index, fifo) =>
			index === 0 || prompt.admissionEpoch > (fifo[index - 1]?.admissionEpoch ?? 0))) &&
			model.reachableTransitions.every((transition) => transition.action.type !== "start" ||
				transition.before.fifo[0] === undefined ||
				transition.after.activeOwner === null ||
				ownerKey(transition.before.fifo[0].owner) === ownerKey(transition.after.activeOwner)),
	},
	{
		name: "cas_first_winner",
		predicate: (model) => model.reachableStates.every((state) =>
			state.terminalStatus === null || (state.phase === "terminal_pending" && state.pairFlush !== null)) &&
			model.reachableTransitions.every((transition) => transition.action.type !== "terminalize" ||
				(transition.before.terminalStatus === null
					? transition.after.terminalStatus !== null && transition.after.phase === "terminal_pending" && transition.after.pairFlush !== null
					: transition.after.audit.some((entry) => entry.kind === "duplicate_terminal"))),
	},
	{
		name: "outbox_invocation_identity",
		predicate: (model) => model.reachableStates.every((state) => state.durableOutbox.every((entry) =>
			entry.invocationId.length > 0 &&
			(entry.kind !== "start_publish" || state.startPending === null || state.startPending.invocationId === entry.invocationId) &&
			(entry.kind !== "terminal_pair" || state.pairFlush === null || state.activeInvocationId === entry.invocationId))),
	},
];

const storageInvariantDefinitions: readonly StorageInvariant[] = [
	{
		name: "no_future_version_reservation",
		predicate: (model) => model.reachableStates.every((state) => state.fileVersion >= 0 &&
			state.slots.every((slot) => slot.outputFileVersion === null || slot.outputFileVersion <= state.fileVersion)),
	},
	{
		name: "queued_head_rebases_version",
		predicate: (model) => model.reachableTransitions.every((transition) => {
			if (transition.action.type !== "begin") return true;
			const before = transition.before.slots.find((slot) => slot.physicalWriteSeq === transition.action.physicalWriteSeq);
			const after = transition.after.slots.find((slot) => slot.physicalWriteSeq === transition.action.physicalWriteSeq);
			if (before === undefined || before.status !== "queued" || transition.action.physicalWriteSeq !== transition.before.nextExpectedSeq) return true;
			return after !== undefined && after.status === "in_progress" && after.inputFileVersion === transition.before.fileVersion;
		}),
	},
	{
		name: "same_slot_recovery",
		predicate: (model) => model.reachableStates.every((state) => state.slots.every((slot) =>
			slot.recovery === undefined || slot.recovery.recoveryOfSeq === slot.physicalWriteSeq)) &&
			model.reachableTransitions.every((transition) => transition.action.type !== "recoverComplete" ||
				transition.after.slots.every((slot) => slot.recovery === undefined ||
					slot.recovery.recoveryOfSeq === slot.physicalWriteSeq)),
	},
	{
		name: "observed_operation_evidence",
		predicate: (model) => model.reachableStates.every((state) => state.move === null ||
			state.move.evidence.every((evidence) => state.observedEvents.some((event) =>
				`${event.operation}:success` === evidence && event.invocationId === state.move?.invocationId && event.outcome === "success"))),
	},
	{
		name: "exdev_source_unlink_order",
		predicate: (model) => model.reachableStates.every((state) => {
			const move = state.move;
			if (move === null || move.kind !== "exdev") return true;
			const events = state.observedEvents.filter((event) => event.invocationId === move.invocationId);
			const unlinkRequired = ["source_unlinked", "source_dir_fsynced", "verified", "committed"].includes(move.phase);
			const unlinkIndex = events.findIndex((event) => event.operation === "source_unlink" && event.outcome === "success");
			if (unlinkRequired && unlinkIndex < 0) return false;
			if (move.phase !== "committed") return true;
			return events.length === exdevDurabilityOrder.length && events.every((event, index) => event.outcome === "success" && event.operation === exdevDurabilityOrder[index]);
		}),
	},
];

const evaluateInvariants = (lifecycle: LifecycleExploration, storage: StorageExploration): readonly string[] => {
	const results: string[] = [];
	for (const invariant of lifecycleInvariantDefinitions) {
		const passed = invariant.predicate(lifecycle);
		check(`invariant/${invariant.name}`, passed, `reachable states=${lifecycle.states}, transitions=${lifecycle.transitions}`);
		if (passed) results.push(invariant.name);
	}
	for (const invariant of storageInvariantDefinitions) {
		const passed = invariant.predicate(storage);
		check(`invariant/${invariant.name}`, passed, `reachable states=${storage.states}, transitions=${storage.transitions}`);
		if (passed) results.push(invariant.name);
	}
	return results;
};

const mutateLifecycleState = (model: LifecycleExploration, select: (state: LifecycleState) => boolean, mutate: (state: LifecycleState) => LifecycleState): LifecycleExploration | null => {
	const index = model.reachableStates.findIndex(select);
	if (index < 0) return null;
	return { ...model, reachableStates: model.reachableStates.map((state, current) => current === index ? mutate(state) : state) };
};
const mutateLifecycleTransition = (model: LifecycleExploration, select: (transition: LifecycleTransition) => boolean, mutate: (transition: LifecycleTransition) => LifecycleTransition): LifecycleExploration | null => {
	const index = model.reachableTransitions.findIndex(select);
	if (index < 0) return null;
	return { ...model, reachableTransitions: model.reachableTransitions.map((transition, current) => current === index ? mutate(transition) : transition) };
};
const mutateStorageState = (model: StorageExploration, select: (state: StorageState) => boolean, mutate: (state: StorageState) => StorageState): StorageExploration | null => {
	const index = model.reachableStates.findIndex(select);
	if (index < 0) return null;
	return { ...model, reachableStates: model.reachableStates.map((state, current) => current === index ? mutate(state) : state) };
};

const runMutationProbe = (name: string, baseline: boolean, mutated: boolean, details: string): MutationProbe => {
	const rejected = baseline && !mutated;
	check(`mutation/${name}-oracle-rejects`, rejected, details);
	return { name, rejected, details };
};
const lifecycleInvariant = (name: string): LifecycleInvariant => {
	const invariant = lifecycleInvariantDefinitions.find((candidate) => candidate.name === name);
	if (invariant === undefined) throw new Error(`missing lifecycle invariant ${name}`);
	return invariant;
};
const storageInvariant = (name: string): StorageInvariant => {
	const invariant = storageInvariantDefinitions.find((candidate) => candidate.name === name);
	if (invariant === undefined) throw new Error(`missing storage invariant ${name}`);
	return invariant;
};

const runMutationProbes = (lifecycle: LifecycleExploration, storage: StorageExploration): readonly MutationProbe[] => {
	const terminalTransition = mutateLifecycleTransition(lifecycle, (transition) => transition.action.type === "terminalize", (transition) => ({
		...transition,
		after: { ...transition.after, pairFlush: null },
	}));
	const casTransition = mutateLifecycleTransition(lifecycle, (transition) => transition.action.type === "terminalize", (transition) => ({
		...transition,
		after: { ...transition.after, phase: "running" },
	}));
	const fifoState = mutateLifecycleState(lifecycle, (state) => state.fifo.length > 1, (state) => ({
		...state,
		fifo: state.fifo.map((prompt, index) => index === 1 ? { ...prompt, admissionEpoch: state.fifo[0]?.admissionEpoch ?? prompt.admissionEpoch } : prompt),
	}));
	const outboxState = mutateLifecycleState(lifecycle, (state) => state.durableOutbox.length > 0, (state) => ({
		...state,
		durableOutbox: state.durableOutbox.map((entry, index) => index === 0 ? { ...entry, invocationId: "" } : entry),
	}));
	const versionState = mutateStorageState(storage, (state) => state.slots.some((slot) => slot.outputFileVersion !== null), (state) => ({
		...state,
		fileVersion: Math.max(0, state.fileVersion - 1),
	}));
	const recoveryState = mutateStorageState(storage, (state) => state.slots.some((slot) => slot.recovery !== undefined), (state) => ({
		...state,
		slots: state.slots.map((slot) => slot.recovery === undefined ? slot : { ...slot, recovery: { ...slot.recovery, recoveryOfSeq: slot.physicalWriteSeq + 1 } }),
	}));
	const evidenceState = mutateStorageState(storage, (state) => state.move?.evidence.length ? true : false, (state) => ({
		...state,
		move: state.move === null ? null : { ...state.move, evidence: ["forged:success"] },
	}));
	const boundedMutation: LifecycleExploration = { ...lifecycle, states: 0, transitions: 0, terminalReachable: false, reachableStates: [], reachableTransitions: [] };
	return [
		runMutationProbe("bounded-liveness", lifecycleInvariant("bounded_liveness").predicate(lifecycle), lifecycleInvariant("bounded_liveness").predicate(boundedMutation), "removed reachable states and transitions"),
		runMutationProbe("terminal-pair", lifecycleInvariant("terminal_pair_exactly_once").predicate(lifecycle), terminalTransition === null ? false : lifecycleInvariant("terminal_pair_exactly_once").predicate(terminalTransition), "removed pair flush from a terminalizing transition"),
		runMutationProbe("cas-first-winner", lifecycleInvariant("cas_first_winner").predicate(lifecycle), casTransition === null ? false : lifecycleInvariant("cas_first_winner").predicate(casTransition), "perturbed terminal transition result"),
		runMutationProbe("fifo-order", lifecycleInvariant("fifo").predicate(lifecycle), fifoState === null ? false : lifecycleInvariant("fifo").predicate(fifoState), "duplicated a reachable admission epoch"),
		runMutationProbe("outbox-identity", lifecycleInvariant("outbox_invocation_identity").predicate(lifecycle), outboxState === null ? false : lifecycleInvariant("outbox_invocation_identity").predicate(outboxState), "removed invocation identity from an outbox result"),
		runMutationProbe("future-version", storageInvariant("no_future_version_reservation").predicate(storage), versionState === null ? false : storageInvariant("no_future_version_reservation").predicate(versionState), "lowered file version below a committed output"),
		runMutationProbe("same-slot-recovery", storageInvariant("same_slot_recovery").predicate(storage), recoveryState === null ? false : storageInvariant("same_slot_recovery").predicate(recoveryState), "changed recovery ownership to another physical sequence"),
		runMutationProbe("observed-operation-evidence", storageInvariant("observed_operation_evidence").predicate(storage), evidenceState === null ? false : storageInvariant("observed_operation_evidence").predicate(evidenceState), "replaced observed directory-fsync evidence"),
	];
};
type ContractBudgetRow = { risk: string; surfaceClass?: string; queueSlaMs: number; riskSoftMs: number; riskHardMs: number; globalCompletionMs: number };
type ContractPhaseBudget = { softMs: number; hardMs: number };
type ContractRunnerRow = { totalSoftMs?: number; totalHardMs?: number; total?: { softMs: number; hardMs: number }; phases?: Record<string, readonly [number, number]>; bootstrap?: ContractPhaseBudget; collection?: ContractPhaseBudget; execution?: ContractPhaseBudget; evidenceFlush?: ContractPhaseBudget; shutdown?: ContractPhaseBudget };
type ContractFixture = { phase1Authorized: boolean; riskBudgets: readonly ContractBudgetRow[]; runnerBudgets: Record<string, ContractRunnerRow>; fixtures: readonly (Record<string, unknown> & { cases?: readonly unknown[] })[] };
type ContractRiskPolicy = { phase1Authorized: boolean; queueBudgetsMs: readonly ContractBudgetRow[]; runnerBudgetsMs: readonly (ContractRunnerRow & { runnerProfileId: string })[]; phaseDeadlinePolicy: Record<string, unknown>; retentionPolicy: Record<string, unknown> };
type ContractObligation = { obligationId: string; runnerProfileId: string; mandatory: boolean };
type ContractResolverRow = { acceptanceRequirementId: string; runnerProfileId: string; capability: string; riskIn: readonly string[]; obligationId: string | null; disposition: "supported" | "unsupported" };
type ContractManifest = { obligations: readonly ContractObligation[]; acceptanceResolver: { rows: readonly ContractResolverRow[]; unknownDisposition: string; zeroMatchDisposition: string; multipleMatchDisposition: string; incompatibleCapabilityDisposition: string; hashConflictDisposition: string; conflictingCommandEvidenceDisposition: string; g0MinimumMandatoryObligations: number } };
const FIXED_ACCEPTANCE_RESOLVER_CASE_IDS: ReadonlySet<string> = new Set([
	"acceptance.tests-pass|js-ts-focused|G1|R1",
	"acceptance.static-checks-pass|python-focused|G1|R1",
	"acceptance.adversarial-pass|rust-incremental|G1|R1",
	"acceptance.cold-build-pass|rust-cold|G1|R2",
	"acceptance.browser-flow-pass|playwright-focused|G1|R2",
	"acceptance.no-mutation|g0-evidence-only|G0|R0",
	"acceptance.ledger-consistent|g0-evidence-only|G0|R0",
	"acceptance.tests-pass|g0-evidence-only|G0|R0",
	"acceptance.browser-flow-pass|js-ts-focused|G1|R1",
	"unknown.acceptance|js-ts-focused|G1|R1",
	"acceptance.tests-pass|js-ts-focused|G0|R1",
	"acceptance.tests-pass|playwright-focused|G1|R1",
]);
const FIXED_MAPPING_MUTANT_CASE_IDS: ReadonlySet<string> = new Set([
	"dropped-risk",
	"added-risk",
	"changed-disposition",
	"changed-obligation",
	"zero-mapping",
	"multiple-mapping",
	"conflicting-mapping",
	"incompatible-capability",
]);
const FIXED_MAPPING_MUTANT_KINDS: Readonly<Record<string, string>> = {
	"dropped-risk": "drop-risk",
	"added-risk": "add-risk",
	"changed-disposition": "change-disposition",
	"changed-obligation": "change-obligation",
	"zero-mapping": "zero-mapping",
	"multiple-mapping": "multiple-mapping",
	"conflicting-mapping": "conflicting-mapping",
	"incompatible-capability": "incompatible-capability",
};
const KNOWN_MAPPING_MUTATION_KINDS: ReadonlySet<string> = new Set([
	"drop-risk",
	"add-risk",
	"change-disposition",
	"change-obligation",
	"zero-mapping",
	"multiple-mapping",
	"conflicting-mapping",
	"incompatible-capability",
]);
const fixtureCaseId = (item: unknown): string | undefined => {
	if (typeof item !== "object" || item === null) return undefined;
	const id = (item as { id?: unknown }).id;
	return typeof id === "string" ? id : undefined;
};
const checkFixedCaseIds = (name: string, cases: readonly unknown[], expectedIds: ReadonlySet<string>): void => {
	const actualIds = cases.map(fixtureCaseId);
	const actualIdSet = new Set(actualIds.filter((id): id is string => id !== undefined));
	check(`${name}-case-count`, cases.length === expectedIds.size);
	check(`${name}-case-ids-exact`, actualIds.every((id): id is string => id !== undefined) &&
		actualIdSet.size === cases.length &&
		[...expectedIds].every((id) => actualIdSet.has(id)) &&
		[...actualIdSet].every((id) => expectedIds.has(id)));
};
const fixtureContainers = (fixture: ContractFixture, id: string): readonly (Record<string, unknown> & { cases?: readonly unknown[] })[] =>
	fixture.fixtures.filter((item) => item.id === id);
const consumeFixedFixtureId = (name: string, id: string, expectedIds: ReadonlySet<string>, consumedIds: Set<string>): void => {
	const duplicate = consumedIds.has(id);
	const known = expectedIds.has(id);
	if (known) consumedIds.add(id);
	check(`quiescence/${name}-consumed-once-${id}`, known && !duplicate);
};
const checkAllFixedFixtureIdsConsumed = (name: string, expectedIds: ReadonlySet<string>, consumedIds: ReadonlySet<string>): void => {
	check(`quiescence/${name}-fixtures-consumed-exactly-once`, consumedIds.size === expectedIds.size &&
		[...expectedIds].every((id) => consumedIds.has(id)));
};

const contractValidationCases = (fixture: ContractFixture, riskPolicy: ContractRiskPolicy, manifest: ContractManifest): void => {
	const riskSurface: Readonly<Record<string, readonly [Risk, SurfaceClass]>> = {
		R0: ["R0", "non-gui"], R1: ["R1", "non-gui"], "R2-non-gui": ["R2", "non-gui"], "R2-gui": ["R2", "gui"], "R3-local": ["R3", "local"],
	};
	const budgetKey = (risk: string, surfaceClass: string | undefined): string => surfaceClass === undefined ? risk === "R3" ? "R3-local" : risk : `${risk}-${surfaceClass}`;
	check("quiescence/phase-a-remains-unauthorized", fixture.phase1Authorized === false && riskPolicy.phase1Authorized === false);
	check("quiescence/risk-budget-row-count", fixture.riskBudgets.length === 5 && riskPolicy.queueBudgetsMs.length === 5);
	const fixtureRiskKeys = new Set<string>();
	for (const row of fixture.riskBudgets) {
		const key = budgetKey(row.risk, row.surfaceClass);
		const selected = riskSurface[key];
		const budget = selected === undefined ? null : riskBudgetFor(selected[0], selected[1]);
		fixtureRiskKeys.add(key);
		check(`quiescence/risk-row-${key}`, budget !== null && budget.queueSlaMs === row.queueSlaMs && budget.softMs === row.riskSoftMs && budget.hardMs === row.riskHardMs && budget.globalCompletionMs === row.globalCompletionMs && row.globalCompletionMs === row.queueSlaMs + row.riskHardMs);
	}
	check("quiescence/risk-budget-rows-exact", fixtureRiskKeys.size === 5 && [...fixtureRiskKeys].every((key) => riskSurface[key] !== undefined) && riskBudgetFor("R2", "non-gui")?.hardMs !== riskBudgetFor("R2", "gui")?.hardMs);
	for (const row of riskPolicy.queueBudgetsMs) {
		const key = budgetKey(row.risk, row.surfaceClass);
		const selected = riskSurface[key];
		const budget = selected === undefined ? null : riskBudgetFor(selected[0], selected[1]);
		check(`quiescence/policy-risk-row-${key}`, budget !== null && budget.queueSlaMs === row.queueSlaMs && budget.softMs === row.riskSoftMs && budget.hardMs === row.riskHardMs && budget.globalCompletionMs === row.globalCompletionMs);
	}
	const profiles = Object.entries(RUNNER_PROFILES);
	check("quiescence/runner-profile-count", profiles.length === fixture.riskBudgets.length + 1);
	for (const [profileId, profile] of profiles) {
		const fixtureRow = fixture.runnerBudgets[profileId];
		const policyRow = riskPolicy.runnerBudgetsMs.find((row) => row.runnerProfileId === profileId);
		const fixturePhases = fixtureRow?.phases;
		const phaseNames: readonly PhaseName[] = ["bootstrap", "collection", "execution", "evidenceFlush", "shutdown"];
		const phaseShape = fixtureRow !== undefined && policyRow !== undefined && fixturePhases !== undefined && phaseNames.every((phase) => {
			const modelBudget = profile[phase];
			const fixtureBudget = fixturePhases[phase];
			const policyBudget = policyRow[phase];
			return fixtureBudget !== undefined && policyBudget !== undefined && fixtureBudget[0] === modelBudget.softMs && fixtureBudget[1] === modelBudget.hardMs && policyBudget.softMs === modelBudget.softMs && policyBudget.hardMs === modelBudget.hardMs;
		});
		const softTotal = phaseNames.reduce((sum, phase) => sum + profile[phase].softMs, 0);
		const hardTotal = phaseNames.reduce((sum, phase) => sum + profile[phase].hardMs, 0);
		const fixtureSoft = fixtureRow?.totalSoftMs ?? fixtureRow?.total?.softMs;
		const fixtureHard = fixtureRow?.totalHardMs ?? fixtureRow?.total?.hardMs;
		const policySoft = policyRow?.totalSoftMs ?? policyRow?.total?.softMs;
		const policyHard = policyRow?.totalHardMs ?? policyRow?.total?.hardMs;
		check(`quiescence/runner-row-${profileId}`, phaseShape && fixtureSoft === softTotal && fixtureHard === hardTotal && policySoft === softTotal && policyHard === hardTotal);
	}
	const boundaryFixture = fixture.fixtures.find((item) => item.id === "queue-global-boundaries");
	const boundaryCases = boundaryFixture?.cases;
	if (Array.isArray(boundaryCases)) {
		for (const item of boundaryCases) {
			const c = item as unknown as { id: string; kind: string; configuredMs: number; elapsedMs: number; nowOffsetMs: number; runnerProfileId?: string; phase?: PhaseName };
			if (c.runnerProfileId !== undefined) {
				const phase = c.phase ?? c.kind.split(".")[0] as PhaseName;
				const profile = RUNNER_PROFILES[c.runnerProfileId];
				const phaseBudget = profile?.[phase];
				const kind = c.kind.endsWith(".soft") ? "soft" : c.kind.endsWith(".hard") ? "hard" : null;
				const deadlines = profile === undefined ? null : phaseDeadlines(phase, 0, profile, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
				const configured = phaseBudget === undefined || kind === null ? null : phaseBudget[`${kind}Ms` as "softMs" | "hardMs"];
				const deadlineAt = deadlines === null || kind === null ? null : deadlines[`${kind}Deadline` as "softDeadline" | "hardDeadline"];
				check(`quiescence/boundary-${c.id}`, configured === c.configuredMs && deadlineAt === c.configuredMs && crossed(c.elapsedMs, c.configuredMs) === (c.nowOffsetMs >= 0));
			} else {
				const key = c.id.split(/-(?=queueSlaMs|riskSoftMs|riskHardMs|globalCompletionMs)/, 1)[0] ?? "";
				const selected = riskSurface[key];
				const budget = selected === undefined ? null : riskBudgetFor(selected[0], selected[1]);
				const field = c.kind as "queueSlaMs" | "riskSoftMs" | "riskHardMs" | "globalCompletionMs";
				const configured = budget === null ? null : field === "riskSoftMs" ? budget.softMs : field === "riskHardMs" ? budget.hardMs : budget[field];
				check(`quiescence/budget-boundary-${c.id}`, configured === c.configuredMs && crossed(c.elapsedMs, c.configuredMs) === (c.nowOffsetMs >= 0));
			}
		}
	}
	const policy = riskPolicy.phaseDeadlinePolicy;
	check("quiescence/phase-formulas-governed", policy.softFormula === "min(phaseStart + phaseSoftMs, optionalStopDeadline, workDeadline)" && policy.hardFormula === "min(phaseStart + phaseHardMs, workDeadline)" && policy.flushSoftFormula === "min(flushStart + flushSoftMs, flushHardDeadline)" && policy.flushHardFormula === "min(flushStart + flushHardMs, finalDeadline - shutdownHardMs)" && policy.shutdownSoftFormula === "min(shutdownStart + shutdownSoftMs, shutdownHardDeadline)" && policy.shutdownHardFormula === "min(shutdownStart + shutdownHardMs, finalDeadline)" && policy.boundary === "inclusive" && policy.admission === "now < deadline" && policy.crossing === "now >= deadline");
	const reserveProfile = RUNNER_PROFILES["js-ts-focused"];
	const capped = phaseDeadlines("execution", 0, reserveProfile, Number.POSITIVE_INFINITY, 60_000, Number.POSITIVE_INFINITY);
	check("quiescence/phase-hard-clamped-to-work", capped.hardDeadline === 60_000);
	const flush = phaseDeadlines("evidenceFlush", 80_000, reserveProfile, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 100_000);
	check("quiescence/flush-reserve-formula", flush.hardDeadline === 85_000);
	check("quiescence/retention-governed", riskPolicy.retentionPolicy.mandatoryEvidence === "retain-durable-and-referenced" && (riskPolicy.retentionPolicy.failedPartialRuns as { retainDays: number }).retainDays === 7 && (riskPolicy.retentionPolicy.importedEphemeral as { removeAfterAck: boolean }).removeAfterAck === true && riskPolicy.retentionPolicy.crossRunCache === "forbidden");
	const manifestRows = manifest.acceptanceResolver.rows;
	const modelRows = (ACCEPTANCE_RESOLVER_ROWS as readonly AcceptanceResolverRow[]);
	type ComparableResolverRow = { acceptanceRequirementId: string; runnerProfileId: string; capability: string; riskIn: readonly string[]; obligationId: string | null; disposition: string };
	const rowKey = (row: Pick<ComparableResolverRow, "acceptanceRequirementId" | "runnerProfileId" | "capability">): string => `${row.acceptanceRequirementId}|${row.runnerProfileId}|${row.capability}`;
	const rowFingerprint = (row: ComparableResolverRow): string => JSON.stringify({
		acceptanceRequirementId: row.acceptanceRequirementId,
		runnerProfileId: row.runnerProfileId,
		capability: row.capability,
		riskIn: [...row.riskIn].sort(),
		disposition: row.disposition,
		obligationId: row.obligationId,
	});
	const duplicateKeys = (rows: readonly ComparableResolverRow[]): readonly string[] => {
		const counts = new Map<string, number>();
		for (const row of rows) counts.set(rowKey(row), (counts.get(rowKey(row)) ?? 0) + 1);
		return [...counts.entries()].filter(([, count]) => count !== 1).map(([key]) => key);
	};
	const modelByKey = new Map(modelRows.map((row) => [rowKey(row), row]));
	const manifestByKey = new Map(manifestRows.map((row) => [rowKey(row), row]));
	const completeRowSet = (rows: readonly AcceptanceResolverRow[]): boolean =>
		rows.length === modelRows.length &&
		duplicateKeys(rows).length === 0 &&
		duplicateKeys(modelRows).length === 0 &&
		duplicateKeys(manifestRows).length === 0 &&
		rows.every((row) => {
			const expected = manifestByKey.get(rowKey(row));
			return expected !== undefined && rowFingerprint(row) === rowFingerprint(expected);
		}) &&
		modelRows.every((row) => {
			const expected = manifestByKey.get(rowKey(row));
			return expected !== undefined && rowFingerprint(row) === rowFingerprint(expected);
		});
	check("quiescence/acceptance-row-shape", completeRowSet(modelRows));
	check("quiescence/acceptance-row-count-exact", modelRows.length === manifestRows.length && modelByKey.size === manifestByKey.size);
	for (const row of manifestRows) {
		const expected = row.disposition === "supported" ? row.obligationId : null;
		for (const risk of row.riskIn) {
			check(`quiescence/acceptance-${row.acceptanceRequirementId}-${row.runnerProfileId}-${risk}`, resolveAcceptance(row.acceptanceRequirementId, row.runnerProfileId, row.capability, risk) === expected);
		}
	}
	const resolverContainers = fixtureContainers(fixture, "acceptance-resolver");
	check("quiescence/acceptance-resolver-container-exactly-once", resolverContainers.length === 1);
	const resolverFixture = resolverContainers.length === 1 ? resolverContainers[0] : undefined;
	const resolverCases = resolverFixture !== undefined && Array.isArray(resolverFixture.cases) ? resolverFixture.cases : [];
	checkFixedCaseIds("acceptance-resolver", resolverCases, FIXED_ACCEPTANCE_RESOLVER_CASE_IDS);
	const consumedResolverIds = new Set<string>();
	for (const item of resolverCases) {
		const row = item as unknown as { acceptanceRequirementId: string; runnerProfileId: string; capability: string; risk: string; resolvedObligationId: string | null; expected: string };
		const fixtureId = fixtureCaseId(item) ?? "<missing-id>";
		consumeFixedFixtureId("acceptance-resolver", fixtureId, FIXED_ACCEPTANCE_RESOLVER_CASE_IDS, consumedResolverIds);
		const tupleId = `${row.acceptanceRequirementId}|${row.runnerProfileId}|${row.capability}|${row.risk}`;
		check(`quiescence/acceptance-fixture-id-${fixtureId}`, fixtureId === tupleId);
		const actual = resolveAcceptance(row.acceptanceRequirementId, row.runnerProfileId, row.capability, row.risk);
		check(`quiescence/acceptance-fixture-${fixtureId}`, actual === row.resolvedObligationId && (row.expected === "resolved" ? actual !== null : actual === null));
	}
	checkAllFixedFixtureIdsConsumed("acceptance-resolver", FIXED_ACCEPTANCE_RESOLVER_CASE_IDS, consumedResolverIds);

	const mutationContainers = fixtureContainers(fixture, "mapping-mutants");
	check("quiescence/mapping-mutants-container-exactly-once", mutationContainers.length === 1);
	const mutationFixture = mutationContainers.length === 1 ? mutationContainers[0] : undefined;
	const mutationCases = mutationFixture !== undefined && Array.isArray(mutationFixture.cases) ? mutationFixture.cases : [];
	checkFixedCaseIds("mapping-mutants", mutationCases, FIXED_MAPPING_MUTANT_CASE_IDS);
	const consumedMutationIds = new Set<string>();
	const mutationTarget = modelRows.find((row) => row.acceptanceRequirementId === "acceptance.tests-pass" && row.runnerProfileId === "js-ts-focused");
	if (mutationTarget !== undefined) {
		for (const item of mutationCases) {
			const mutation = item as unknown as { mutation: string; expected: string; probeRisk: string; probeCapability: string; probeExpectedObligationId: string | null };
			const mutationId = fixtureCaseId(item) ?? "<missing-id>";
			consumeFixedFixtureId("mapping-mutants", mutationId, FIXED_MAPPING_MUTANT_CASE_IDS, consumedMutationIds);
			check(`quiescence/acceptance-mutation-known-kind-${mutationId}`, KNOWN_MAPPING_MUTATION_KINDS.has(mutation.mutation) && FIXED_MAPPING_MUTANT_KINDS[mutationId] === mutation.mutation);
			const mutatedRows = modelRows.filter((row) => rowKey(row) !== rowKey(mutationTarget));
			const replacement = (changes: Partial<AcceptanceResolverRow>): AcceptanceResolverRow => ({ ...mutationTarget, ...changes });
			const rows = mutation.mutation === "drop-risk" ? [...modelRows.map((row) => row === mutationTarget ? { ...row, riskIn: ["R0"] as readonly Risk[] } : row)] :
				mutation.mutation === "add-risk" ? [...modelRows.map((row) => row === mutationTarget ? { ...row, riskIn: ["R0", "R1", "R2"] as readonly Risk[] } : row)] :
				mutation.mutation === "change-disposition" ? [...mutatedRows, replacement({ disposition: "unsupported", obligationId: null })] :
				mutation.mutation === "change-obligation" ? [...mutatedRows, replacement({ obligationId: "qtb.mutant.obligation" })] :
				mutation.mutation === "zero-mapping" ? mutatedRows :
				mutation.mutation === "multiple-mapping" ? [...modelRows, mutationTarget] :
				mutation.mutation === "conflicting-mapping" ? [...modelRows, replacement({ obligationId: "qtb.mutant.obligation" })] :
				mutation.mutation === "incompatible-capability" ? [...mutatedRows, replacement({ capability: "G0" })] :
				[];
			const actual = resolveAcceptanceFromRows(rows, mutationTarget.acceptanceRequirementId, mutationTarget.runnerProfileId, mutation.probeCapability, mutation.probeRisk);
			check(`quiescence/acceptance-mutation-${mutationId}`, mutation.expected === "blocked" && !completeRowSet(rows) && actual === mutation.probeExpectedObligationId);
		}
	}
	checkAllFixedFixtureIdsConsumed("mapping-mutants", FIXED_MAPPING_MUTANT_CASE_IDS, consumedMutationIds);
	check("quiescence/acceptance-multiple-match-fails-closed", modelRows.length > 0 && resolveAcceptanceFromRows([...modelRows, modelRows[0]!], modelRows[0]!.acceptanceRequirementId, modelRows[0]!.runnerProfileId, modelRows[0]!.capability, modelRows[0]!.riskIn[0]!) === null);
	check("quiescence/acceptance-conflicting-match-fails-closed", modelRows.length > 0 && resolveAcceptanceFromRows([...modelRows, { ...modelRows[0]!, obligationId: "qtb.conflict" }], modelRows[0]!.acceptanceRequirementId, modelRows[0]!.runnerProfileId, modelRows[0]!.capability, modelRows[0]!.riskIn[0]!) === null);
	check("quiescence/acceptance-unknown-zero-capability-fails-closed", resolveAcceptance("unknown.acceptance", "js-ts-focused", "G1", "R1") === null && resolveAcceptance("acceptance.tests-pass", "unknown-profile", "G1", "R1") === null && resolveAcceptance("acceptance.tests-pass", "js-ts-focused", "G0", "R1") === null);
	for (const [profileId, profile] of Object.entries(RUNNER_PROFILES)) {
		const expectedIds = manifest.obligations.filter((row) => row.mandatory && (row.runnerProfileId === profileId || (profileId !== "g0-evidence-only" && row.runnerProfileId === "all-non-g0"))).map((row) => row.obligationId).sort();
		const actualIds = mandatoryObligations(profileId).map((row) => row.id).sort();
		check(`quiescence/mandatory-manifest-${profileId}`, expectedIds.join("|") === actualIds.join("|") && actualIds.length >= manifest.acceptanceResolver.g0MinimumMandatoryObligations);
	}
	check("quiescence/manifest-dispositions", manifest.acceptanceResolver.unknownDisposition === "blocked:acceptance-requirement-unmapped" && manifest.acceptanceResolver.zeroMatchDisposition === manifest.acceptanceResolver.unknownDisposition && manifest.acceptanceResolver.multipleMatchDisposition === manifest.acceptanceResolver.unknownDisposition && manifest.acceptanceResolver.incompatibleCapabilityDisposition === manifest.acceptanceResolver.unknownDisposition && manifest.acceptanceResolver.hashConflictDisposition === manifest.acceptanceResolver.unknownDisposition && manifest.acceptanceResolver.conflictingCommandEvidenceDisposition === manifest.acceptanceResolver.unknownDisposition);
};
const quiescenceCases = (): void => {
	const emptyLedger = { activeActors: 0, activeTasks: 0, queuedTasks: 0, pendingDeliveries: 0, incompleteRequiredTasks: 0, pausedRequiredActors: 0, openRequiredTasks: 0 };
	let state = initialQuiescenceState("project-a", "root-a");
	state = reduceQuiescence(state, { type: "rootCompletionCandidate", at: 10 });
	state = reduceQuiescence(state, { type: "mainSettled", at: 10 });
	state = reduceQuiescence(state, { type: "ledger", at: 10, ledger: emptyLedger });
	state = reduceQuiescence(state, { type: "reconcile", at: 10, census: emptyLedger, cursor: "cursor-0", complete: true });
	check("quiescence/single-agent-quiet-window", !isQuiescent(state, 2009) && isQuiescent(state, 2010));
	state = reduceQuiescence(state, { type: "tick", at: 2010 });
	const candidate: Candidate = { candidateKey: "candidate-a", physicalRoot: "/repo", snapshotHash: "snapshot-a", inventoryHash: "inventory-a", acceptanceHash: "acceptance-a", candidateGeneration: 0, mutationEpoch: 0 };
	state = reduceQuiescence(state, { type: "materialize", at: 2010, candidate });
	state = reduceQuiescence(state, { type: "tick", at: 2010 });
	state = reduceQuiescence(state, { type: "claimLease", at: 2010, lease: { leaseId: "lease-a", candidateKey: "candidate-a", projectId: "project-a", rootObjectiveId: "root-a", candidateGeneration: 0, mutationEpoch: 0, profileId: "g0-evidence-only", fence: 1, expiresAt: 3010, committed: false } });
	check("quiescence/candidate-and-one-fenced-lease", state.phase === "sealed" && state.lease?.fence === 1);
	const expectedObligations = mandatoryObligations("g0-evidence-only");
	const optional = [...expectedObligations, { id: "optional", mandatory: false, status: "pending" as const }];
	const duplicate = [expectedObligations[0]!, expectedObligations[0]!];
	const omitted = expectedObligations.slice(0, -1);
	check("quiescence/optional-obligation-rejected", reduceQuiescence(state, { type: "startVerification", at: 2010, obligations: optional }).phase === "sealed");
	check("quiescence/duplicate-obligation-rejected", reduceQuiescence(state, { type: "startVerification", at: 2010, obligations: duplicate }).phase === "sealed");
	check("quiescence/omitted-obligation-rejected", reduceQuiescence(state, { type: "startVerification", at: 2010, obligations: omitted }).phase === "sealed");
	state = reduceQuiescence(state, { type: "startVerification", at: 2010, obligations: expectedObligations });
	for (const obligation of state.obligations) state = reduceQuiescence(state, { type: "completeObligation", at: 2011, obligationId: obligation.id, passed: true, evidenceId: `evidence:${obligation.id}` });
	const verified = state;
	check("quiescence/one-evidence-rejected", reduceQuiescence(verified, { type: "flushEvidence", at: 2012, evidenceIds: ["evidence:one"] }).phase === "verifying");
	check("quiescence/unrelated-evidence-rejected", reduceQuiescence(verified, { type: "flushEvidence", at: 2012, evidenceIds: ["unrelated-1", "unrelated-2", "unrelated-3", "unrelated-4", "unrelated-5"] }).phase === "verifying");
	check("quiescence/duplicate-evidence-rejected", reduceQuiescence(verified, { type: "flushEvidence", at: 2012, evidenceIds: ["evidence:qtb.g0.no-mutation-attestation", "evidence:qtb.g0.identity-ledger-smoke", "evidence:qtb.g0.no-mutation-attestation", "duplicate-4", "duplicate-5"] }).phase === "verifying");
	check("quiescence/mismatched-evidence-rejected", reduceQuiescence(verified, { type: "flushEvidence", at: 2012, evidenceIds: ["evidence:qtb.g0.no-mutation-attestation", "mismatch-2", "mismatch-3", "mismatch-4", "mismatch-5"] }).phase === "verifying");
	state = reduceQuiescence(verified, { type: "flushEvidence", at: 2012, evidenceIds: ["evidence:qtb.g0.no-mutation-attestation", "evidence:qtb.g0.identity-ledger-smoke", "evidence:qtb.snapshot.sealed", "evidence:qtb.ledger.integrity", "evidence:bridge"] });
	state = reduceQuiescence(state, { type: "bridgeCommit", at: 2013, candidateKey: "candidate-a", receiptId: "receipt-a", terminalPairId: "pair-a" });
	check("quiescence/mandatory-evidence-bridge-clear", state.phase === "clear" && state.receiptId === "receipt-a" && state.terminalPairId === "pair-a");
	const stale = reduceQuiescence(state, { type: "bridgeCommit", at: 2014, candidateKey: "candidate-other", receiptId: "receipt-other", terminalPairId: "pair-other" });
	check("quiescence/stale-commit-fenced", stale.receiptId === "receipt-a" && stale.audit.at(-1)?.kind === "bridge-rejected");
	let multi = initialQuiescenceState();
	multi = reduceQuiescence(multi, { type: "ledger", at: 1, multiAgent: true, ledger: emptyLedger });
	multi = reduceQuiescence(multi, { type: "rootCompletionCandidate", at: 1 });
	multi = reduceQuiescence(multi, { type: "mainSettled", at: 1 });
	multi = reduceQuiescence(multi, { type: "reconcile", at: 1, census: emptyLedger, cursor: "cursor-1", complete: true });
	check("quiescence/multi-agent-five-second-window", !isQuiescent(multi, 5000) && isQuiescent(multi, 5001));
	const forged = reduceQuiescence(initialQuiescenceState("project-a", "root-a"), { type: "rootCompletionCandidate", at: 1, projectId: "forged" });
	check("quiescence/source-forged-identity-rejected", forged.rootCompletionCandidate === false && forged.audit.at(-1)?.kind === "source-authority-rejected");
	const invalidated = reduceQuiescence(state, { type: "invalidate", at: 2015, reason: "mutation" });
	check("quiescence/mutation-invalidates-generation", invalidated.phase === "collecting" && invalidated.identity.candidateGeneration === 1 && invalidated.lease === null);
	check("quiescence/inclusive-deadline", !crossed(99, 100) && crossed(100, 100) && crossed(101, 100));
	check("quiescence/restart-never-extends", reconstructDeadline(1_000, 900, 10, 100, 950, 20) <= 1_000);
	check("quiescence/risk-global-total", RISK_BUDGETS.R1.globalCompletionMs === RISK_BUDGETS.R1.queueSlaMs + RISK_BUDGETS.R1.hardMs);
	check("quiescence/runner-phase-table", Object.keys(RUNNER_PROFILES).length === 6 && RUNNER_PROFILES["js-ts-focused"].execution.hardMs === 120_000);
	check("quiescence/acceptance-exact-resolution", resolveAcceptance("acceptance.tests-pass", "js-ts-focused", "G1", "R1") === "qtb.js-ts.existing-tests" && resolveAcceptance("acceptance.browser-flow-pass", "js-ts-focused", "G1", "R1") === null);
	const unfinished = reduceQuiescence({ ...state, phase: "verifying", obligations: [{ id: "mandatory", mandatory: true, status: "pending" }], lease: { ...state.lease!, expiresAt: 10000 } }, { type: "flushEvidence", at: 2016, evidenceIds: ["e1", "e2", "e3", "e4", "e5"] });
	check("quiescence/mandatory-omission-blocks", unfinished.phase === "blocked" && unfinished.unfinishedMandatoryIds.includes("mandatory"));
};
const lifecycleExploration = exploreLifecycle();
const storageExploration = exploreStorage();
lifecycleCases();
storageCases();
const invariantNames = evaluateInvariants(lifecycleExploration, storageExploration);
const mutationProbes = runMutationProbes(lifecycleExploration, storageExploration);
const fixture = JSON.parse(await fs.readFile(path.resolve(import.meta.dir, "../fixtures/quiescence-model-fixtures.json"), "utf8")) as unknown as ContractFixture;
const riskPolicy = JSON.parse(await fs.readFile(path.resolve(import.meta.dir, "../manifests/risk-policy.json"), "utf8")) as unknown as ContractRiskPolicy;
const obligationManifest = JSON.parse(await fs.readFile(path.resolve(import.meta.dir, "../manifests/verification-obligations.json"), "utf8")) as unknown as ContractManifest;
contractValidationCases(fixture, riskPolicy, obligationManifest);
quiescenceCases();
const failed = cases.filter((result) => !result.passed);
const report = {
	modelVersion: "phase-0-revision-14",
	deterministic: true,
	bounded: true,
	evidence: {
		sameScriptRegeneration: "reproducibility-only; not independent producer evidence",
	},
	exploration: {
		lifecycle: {
			states: lifecycleExploration.states,
			transitions: lifecycleExploration.transitions,
			terminalReachable: lifecycleExploration.terminalReachable,
		},
		storage: {
			states: storageExploration.states,
			transitions: storageExploration.transitions,
		},
	},
	exploredStates: lifecycleExploration.states + storageExploration.states,
	exploredTransitions: lifecycleExploration.transitions + storageExploration.transitions,
	adversarialBoundaryCases: cases.filter((result) => result.name.includes("timer") || result.name.includes("stale") || result.name.includes("failure") || result.name.includes("expiry") || result.name.includes("limit") || result.name.includes("unrecoverable") || result.name.includes("duplicate") || result.name.startsWith("mutation/")).map((result) => result.name),
	caseCount: cases.length,
	passed: cases.length - failed.length,
	failed: failed.length,
	cases,
	invariants: invariantNames,
	invariantCount: invariantNames.length,
	mutationProbes,
};
const outputPath = path.resolve(import.meta.dir, "../generated/model-report.json"); await fs.mkdir(path.dirname(outputPath), { recursive: true }); await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (failed.length > 0) { console.error(`model verification failed: ${failed.map((result) => result.name).join(", ")}`); process.exitCode = 1; }
