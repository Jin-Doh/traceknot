#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type PhaseBObject = { [key: string]: Json };
export type GateId =
  | "b1-unit" | "b2-gjc-integration" | "b3-hook-integration" | "b4-enforcement-e2e"
  | "coding-agent-types" | "coding-agent-check" | "coding-agent-regression" | "root-check-ts" | "root-test-ts";
export type QualityGateId = Extract<GateId, "b1-unit" | "b2-gjc-integration" | "b3-hook-integration" | "b4-enforcement-e2e">;
export type ClockAnchor = { bootId: string; wallUtcMs: number; monoMs: number; uncertaintyMs: number; persistedActionSequence: number; candidateGeneration: number; mutationEpoch: number; cancellationEpoch: number };
export type TimingSegment = { start: ClockAnchor; end: ClockAnchor; derivation: "same-boot-monotonic" | "cross-boot-conservative-upper-bound"; durationMs: number };
export type PhaseTimings = { unit: "ms"; clockSource: "coordinator-monotonic-v1"; queueMs: number; bootstrapMs: number; collectionMs: number; executionMs: number; evidenceFlushMs: number; shutdownMs: number; segments: Record<string, TimingSegment> };

export const PHASE_B_DOMAINS = {
  command: "gajae:quality-contract:qtb:phase-b-command:v1",
  trace: "gajae:quality-contract:qtb:phase-b-trace:v1",
  contentInventory: "gajae:quality-contract:qtb:phase-b-content-inventory:v1",
  result: "gajae:quality-contract:qtb:phase-b-result:v1",
  finalInventory: "gajae:quality-contract:qtb:phase-b-final-inventory:v1",
} as const;
export const QUALITY_GATES: ReadonlySet<string> = new Set(["b1-unit", "b2-gjc-integration", "b3-hook-integration", "b4-enforcement-e2e"]);
const repoRoot = resolve(import.meta.dir, "../..");
const phases = ["queue", "bootstrap", "collection", "execution", "evidenceFlush", "shutdown"] as const;
const text = (value: string): Buffer => Buffer.from(value, "utf8");
export const compareUtf8 = (left: string, right: string): number => Buffer.compare(text(left), text(right));
export const canonical = (value: Json): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite JSON number");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort(compareUtf8).map(key => `${JSON.stringify(key)}:${canonical(value[key] as Json)}`).join(",")}}`;
};
const u64 = (value: number): Buffer => { if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid U64"); const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(value)); return out; };
export const domainSeparated = (domain: string, payload: Uint8Array): Buffer => Buffer.concat([u64(text(domain).byteLength), text(domain), u64(payload.byteLength), Buffer.from(payload)]);
export const hashDomain = (domain: string, value: Json): string => createHash("sha256").update(domainSeparated(domain, text(canonical(value)))).digest("hex");
const object = (value: unknown, label: string): PhaseBObject => { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as PhaseBObject; };
const hash = (value: unknown, label: string): string => { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 hash`); return value; };
const identifier = (value: unknown, label: string): string => { if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${label} is not a bounded identifier`); return value; };
const mediaType = (value: unknown, label: string): string => { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(value)) throw new Error(`${label} is not a media type`); return value; };
const keys = (value: PhaseBObject, expected: readonly string[], label: string): void => { const actual = Object.keys(value).sort(compareUtf8); const wanted = [...expected].sort(compareUtf8); if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} is not closed`); };
const sortedUnique = (values: string[], label: string): string[] => { const output = [...values].sort(compareUtf8); if (output.some((value, index) => index > 0 && value === output[index - 1])) throw new Error(`${label} contains duplicates`); return output; };
const relativePath = (value: unknown, label: string): string => { if (typeof value !== "string" || value.startsWith("/") || value.split("/").some(part => part === ".." || part.length === 0)) throw new Error(`${label} must be repo-relative`); return value; };
const positiveInteger = (value: unknown, label: string): number => { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`); return value as number; };
export function constructCommand(input: Omit<PhaseBObject, "commandHash">): PhaseBObject {
  const command = { ...input, commandHash: "" };
  keys(command, ["schemaVersion", "objectType", "runId", "gateId", "matrixHash", "wrapperHash", "schemaHash", "argv", "cwd", "executable", "envPolicyHash", "envNames", "admittedAtUtc", "commandHash"], "command");
  if (!Array.isArray(command.argv) || command.argv.some(value => typeof value !== "string" || value.length === 0)) throw new Error("command argv is invalid");
  if (!Array.isArray(command.envNames)) throw new Error("command envNames is invalid");
  command.envNames = sortedUnique(command.envNames.map(value => identifier(value, "command env name")), "command envNames");
  const unsigned = { ...command }; delete unsigned.commandHash;
  command.commandHash = hashDomain(PHASE_B_DOMAINS.command, unsigned);
  return command;
}

export function deriveTiming(segment: TimingSegment, label = "timing segment"): number {
  const segmentObject = object(segment, label);
  keys(segmentObject, ["start", "end", "derivation", "durationMs"], label);
  const start = validateClockAnchor(segmentObject.start, `${label}.start`);
  const end = validateClockAnchor(segmentObject.end, `${label}.end`);
  if (end.persistedActionSequence < start.persistedActionSequence || end.candidateGeneration !== start.candidateGeneration || end.mutationEpoch !== start.mutationEpoch || end.cancellationEpoch !== start.cancellationEpoch) throw new Error(`${label} anchors are not causally compatible`);
  let duration: number;
  if (start.bootId === end.bootId) {
    if (segmentObject.derivation !== "same-boot-monotonic" || end.monoMs < start.monoMs) throw new Error(`${label} is not same-boot monotonic`);
    duration = end.monoMs - start.monoMs;
  } else {
    if (segmentObject.derivation !== "cross-boot-conservative-upper-bound") throw new Error(`${label} lacks changed-boot conservative derivation`);
    duration = Math.max(0, end.wallUtcMs + end.uncertaintyMs - start.wallUtcMs + start.uncertaintyMs);
  }
  if (segmentObject.durationMs !== duration) throw new Error(`${label}.durationMs does not equal its derived duration`);
  return duration;
}

const anchorKeys = ["bootId", "wallUtcMs", "monoMs", "uncertaintyMs", "persistedActionSequence", "candidateGeneration", "mutationEpoch", "cancellationEpoch"] as const;
function validateClockAnchor(value: unknown, label: string): ClockAnchor {
  const anchor = object(value, label);
  keys(anchor, anchorKeys, label);
  identifier(anchor.bootId, `${label}.bootId`);
  for (const name of ["wallUtcMs", "monoMs", "persistedActionSequence", "candidateGeneration", "mutationEpoch", "cancellationEpoch"] as const) positiveInteger(anchor[name], `${label}.${name}`);
  positiveInteger(anchor.uncertaintyMs, `${label}.uncertaintyMs`);
  if ((anchor.uncertaintyMs as number) > 1000) throw new Error(`${label}.uncertaintyMs exceeds 1000`);
  return anchor as unknown as ClockAnchor;
}

function causalBefore(left: ClockAnchor, right: ClockAnchor, label: string): void {
  if (left.bootId === right.bootId ? left.monoMs > right.monoMs : left.wallUtcMs + left.uncertaintyMs > right.wallUtcMs - right.uncertaintyMs) throw new Error(`${label} segments are causally inverted`);
}

function validateBaseLeaseTuple(value: unknown, label: string): void {
  const tuple = object(value, label);
  keys(tuple, ["projectId", "rootObjectiveId", "candidateGeneration", "mutationEpoch", "profileId"], label);
  identifier(tuple.projectId, `${label}.projectId`);
  identifier(tuple.rootObjectiveId, `${label}.rootObjectiveId`);
  positiveInteger(tuple.candidateGeneration, `${label}.candidateGeneration`);
  positiveInteger(tuple.mutationEpoch, `${label}.mutationEpoch`);
  identifier(tuple.profileId, `${label}.profileId`);
}

function validateGateBindings(trace: PhaseBObject, gateId: QualityGateId): void {
  const demanding = gateId === "b2-gjc-integration" || gateId === "b4-enforcement-e2e";
  const enforcement = gateId === "b4-enforcement-e2e";
  if (demanding) {
    hash(trace.candidateKey, "trace.candidateKey");
    validateBaseLeaseTuple(trace.baseLeaseTuple, "trace.baseLeaseTuple");
    if (!Array.isArray(trace.fenceTokens) || trace.fenceTokens.length === 0) throw new Error("trace fence tokens are required");
  } else {
    if (trace.candidateKey !== null || trace.baseLeaseTuple !== null) throw new Error("trace candidate/base lease must be null for this gate");
    if (!Array.isArray(trace.fenceTokens) || trace.fenceTokens.length !== 0) throw new Error("trace fence tokens must be empty for this gate");
  }
  for (const field of ["receiptHash", "bindingHash", "pairHash"] as const) {
    if (enforcement) hash(trace[field], `trace.${field}`);
    else if (trace[field] !== null) throw new Error(`trace.${field} must be null for this gate`);
  }
}

export function validateTrace(trace: PhaseBObject, runId: string, gateId: QualityGateId): Record<string, number> {
  keys(trace, ["schemaVersion", "objectType", "runId", "gateId", "timingSource", "candidateKey", "baseLeaseTuple", "fenceTokens", "receiptHash", "bindingHash", "pairHash", "timings", "assertions", "traceHash"], "trace");
  if (!QUALITY_GATES.has(gateId) || trace.schemaVersion !== "phase-b-trace/v1" || trace.objectType !== "PhaseBTrace" || trace.runId !== runId || trace.gateId !== gateId || trace.timingSource !== "quality-trace") throw new Error("trace identity/source mismatch");
  validateGateBindings(trace, gateId);
  const timing = object(trace.timings, "trace.timings");
  keys(timing, ["unit", "clockSource", "queueMs", "bootstrapMs", "collectionMs", "executionMs", "evidenceFlushMs", "shutdownMs", "segments"], "trace.timings");
  if (timing.unit !== "ms" || timing.clockSource !== "coordinator-monotonic-v1") throw new Error("trace timing source mismatch");
  const segments = object(timing.segments, "trace.timings.segments");
  keys(segments, phases, "trace.timings.segments");
  const durations: Record<string, number> = {};
  const anchors: Array<{ start: ClockAnchor; end: ClockAnchor }> = [];
  for (const phase of phases) {
    const segment = object(segments[phase], `${phase} segment`);
    const start = validateClockAnchor(segment.start, `${phase}.start`);
    const end = validateClockAnchor(segment.end, `${phase}.end`);
    const duration = deriveTiming(segment as unknown as TimingSegment, phase);
    const scalar = timing[`${phase}Ms`];
    if (scalar !== duration) throw new Error(`${phase} scalar does not equal derived duration`);
    durations[`${phase}Ms`] = duration;
    anchors.push({ start, end });
  }
  for (let index = 0; index < anchors.length - 1; index++) causalBefore(anchors[index].end, anchors[index + 1].start, phases[index]);
  if (!Array.isArray(trace.fenceTokens) || trace.fenceTokens.some(value => !Number.isSafeInteger(value) || (value as number) < 1) || trace.fenceTokens.some((value, index) => index > 0 && (value as number) <= (trace.fenceTokens[index - 1] as number))) throw new Error("trace fence tokens are not sorted unique");
  if (!Array.isArray(trace.assertions)) throw new Error("trace assertions are not an array");
  let previous = "";
  for (const value of trace.assertions) {
    const assertion = object(value, "trace assertion");
    if (assertion.passed === true) keys(assertion, ["id", "passed", "evidenceHash"], "trace assertion");
    else if (assertion.passed === false) keys(assertion, ["id", "passed"], "trace assertion");
    else throw new Error("trace assertion passed must be boolean");
    identifier(assertion.id, "trace assertion id");
    if (previous !== "" && compareUtf8(previous, assertion.id as string) >= 0) throw new Error("trace assertions are not UTF-8 sorted unique");
    previous = assertion.id as string;
    if (assertion.passed) hash(assertion.evidenceHash, "trace assertion evidenceHash");
  }
  hash(trace.traceHash, "traceHash");
  const unsigned = { ...trace }; delete unsigned.traceHash;
  if (trace.traceHash !== hashDomain(PHASE_B_DOMAINS.trace, unsigned)) throw new Error("traceHash does not match canonical domain hash");
  return durations;
}

export function constructTrace(input: Omit<PhaseBObject, "traceHash">): PhaseBObject {
  const trace = { ...input, traceHash: "" };
  const unsigned = { ...trace }; delete unsigned.traceHash;
  trace.traceHash = hashDomain(PHASE_B_DOMAINS.trace, unsigned);
  validateTrace(trace, String(trace.runId), String(trace.gateId) as QualityGateId);
  return trace;
}

export function constructContentInventory(runId: string, gateId: GateId, entries: Array<{ relativePath: string; bytes: number; sha256: string; mediaType: string }>): PhaseBObject {
  const normalized = entries.map(entry => ({ relativePath: relativePath(entry.relativePath, "inventory.relativePath"), bytes: positiveInteger(entry.bytes, "inventory.bytes"), sha256: hash(entry.sha256, "inventory.sha256"), mediaType: mediaType(entry.mediaType, "inventory.mediaType") })).sort((a, b) => compareUtf8(a.relativePath, b.relativePath));
  if (normalized.some((entry, index) => index > 0 && entry.relativePath === normalized[index - 1]?.relativePath)) throw new Error("inventory contains duplicate paths");
  if (normalized.some(entry => entry.relativePath === "inventory.json" || entry.relativePath === "result.json")) throw new Error("inventory contains an acyclic self/parent reference");
  const inventory = { schemaVersion: "phase-b-content-inventory/v1", objectType: "PhaseBContentInventory", runId: identifier(runId, "inventory.runId"), gateId, entries: normalized, inventoryHash: "" };
  const unsigned = { ...inventory }; delete unsigned.inventoryHash; inventory.inventoryHash = hashDomain(PHASE_B_DOMAINS.contentInventory, unsigned); return inventory;
}

function validateResult(result: PhaseBObject, trace?: PhaseBObject): void {
  const expected = ["schemaVersion", "objectType", "runId", "gateId", "commandHash", "startedAtUtc", "endedAtUtc", "wallElapsedMs", "exitCode", "signal", "passed", "timingSource", "queueMs", "bootstrapMs", "collectionMs", "executionMs", "evidenceFlushMs", "shutdownMs", "contentInventoryPath", "contentInventoryFileSha256", "contentInventoryHash", "declaredArtifactIds", "resultHash"];
  keys(result, expected, "result");
  const gateId = identifier(result.gateId, "result.gateId") as GateId;
  if (result.schemaVersion !== "phase-b-result/v1" || result.objectType !== "PhaseBResult" || !QUALITY_GATES.has(gateId) && !["coding-agent-types", "coding-agent-check", "coding-agent-regression", "root-check-ts", "root-test-ts"].includes(gateId)) throw new Error("result identity mismatch");
  identifier(result.runId, "result.runId");
  for (const field of ["commandHash", "contentInventoryFileSha256", "contentInventoryHash"] as const) hash(result[field], `result.${field}`);
  if (typeof result.startedAtUtc !== "string" || Number.isNaN(Date.parse(result.startedAtUtc)) || typeof result.endedAtUtc !== "string" || Number.isNaN(Date.parse(result.endedAtUtc))) throw new Error("result timestamps are invalid");
  positiveInteger(result.wallElapsedMs, "result.wallElapsedMs");
  if (result.exitCode !== null) positiveInteger(result.exitCode, "result.exitCode");
  if (result.signal !== null && typeof result.signal !== "string") throw new Error("result.signal is invalid");
  if (typeof result.passed !== "boolean") throw new Error("result.passed must be boolean");
  const quality = QUALITY_GATES.has(gateId);
  if (result.timingSource !== (quality ? "quality-trace" : "not-applicable")) throw new Error("result timing source does not match gate");
  if (quality) {
    if (trace === undefined) throw new Error("quality result requires trace");
    const durations = validateTrace(trace, result.runId as string, gateId as QualityGateId);
    for (const phase of phases) if (result[`${phase}Ms`] !== durations[`${phase}Ms`]) throw new Error(`result ${phase} scalar does not equal trace`);
  } else {
    if (trace !== undefined) throw new Error("non-quality result cannot carry trace");
    if (phases.some(phase => result[`${phase}Ms`] !== null)) throw new Error("non-quality result timing must be null");
  }
  if (!Array.isArray(result.declaredArtifactIds)) throw new Error("result declaredArtifactIds is invalid");
  const artifacts = result.declaredArtifactIds.map(value => relativePath(value, "result artifact"));
  const expectedArtifacts = quality ? ["artifacts/trace.json"] : [];
  if (artifacts.length !== expectedArtifacts.length || artifacts.some((value, index) => value !== expectedArtifacts[index])) throw new Error("result artifact declaration mismatch");
  const unsigned = { ...result }; delete unsigned.resultHash;
  hash(result.resultHash, "resultHash");
  if (result.resultHash !== hashDomain(PHASE_B_DOMAINS.result, unsigned)) throw new Error("resultHash does not match canonical domain hash");
}

export function constructResult(input: Omit<PhaseBObject, "resultHash">, trace?: PhaseBObject): PhaseBObject {
  const result = { ...input, resultHash: "" };
  const unsigned = { ...result }; delete unsigned.resultHash;
  result.resultHash = hashDomain(PHASE_B_DOMAINS.result, unsigned);
  validateResult(result, trace);
  return result;
}

function validateContentInventory(inventory: PhaseBObject): void {
  const expected = ["schemaVersion", "objectType", "runId", "gateId", "entries", "inventoryHash"];
  keys(inventory, expected, "content inventory");
  if (inventory.schemaVersion !== "phase-b-content-inventory/v1" || inventory.objectType !== "PhaseBContentInventory") throw new Error("content inventory identity mismatch");
  identifier(inventory.runId, "inventory.runId");
  identifier(inventory.gateId, "inventory.gateId");
  if (!Array.isArray(inventory.entries)) throw new Error("inventory.entries is invalid");
  let previous = "";
  for (const value of inventory.entries) {
    const entry = object(value, "inventory entry");
    keys(entry, ["relativePath", "bytes", "sha256", "mediaType"], "inventory entry");
    const path = relativePath(entry.relativePath, "inventory.relativePath");
    if (path === "inventory.json" || path === "result.json") throw new Error("inventory has a self/parent path");
    if (previous !== "" && compareUtf8(previous, path) >= 0) throw new Error("inventory paths are not sorted unique");
    previous = path;
    positiveInteger(entry.bytes, "inventory.bytes");
    hash(entry.sha256, "inventory.sha256");
    mediaType(entry.mediaType, "inventory.mediaType");
  }
  hash(inventory.inventoryHash, "inventoryHash");
  const unsigned = { ...inventory }; delete unsigned.inventoryHash;
  if (inventory.inventoryHash !== hashDomain(PHASE_B_DOMAINS.contentInventory, unsigned)) throw new Error("inventoryHash does not match canonical domain hash");
}

function validateFinalInventory(final: PhaseBObject): void {
  const expected = ["schemaVersion", "objectType", "runId", "matrixHash", "wrapperHash", "schemaHash", "gates", "overallPass", "finalInventoryHash"];
  keys(final, expected, "final inventory");
  if (final.schemaVersion !== "phase-b-final-inventory/v1" || final.objectType !== "PhaseBFinalInventory") throw new Error("final inventory identity mismatch");
  identifier(final.runId, "final.runId");
  for (const field of ["matrixHash", "wrapperHash", "schemaHash", "finalInventoryHash"] as const) hash(final[field], `final.${field}`);
  if (!Array.isArray(final.gates)) throw new Error("final.gates is invalid");
  let previous = "";
  const seen = new Set<string>();
  for (const value of final.gates) {
    const gate = object(value, "final gate");
    keys(gate, ["gateId", "inventoryPath", "inventoryFileSha256", "inventoryHash", "resultPath", "resultFileSha256", "resultHash"], "final gate");
    const gateId = identifier(gate.gateId, "final gateId");
    if (!["b1-unit", "b2-gjc-integration", "b3-hook-integration", "b4-enforcement-e2e", "coding-agent-types", "coding-agent-check", "coding-agent-regression", "root-check-ts", "root-test-ts"].includes(gateId)) throw new Error("final gateId is unknown");
    if (seen.has(gateId) || (previous !== "" && compareUtf8(previous, gateId) >= 0)) throw new Error("final gates are not sorted unique");
    seen.add(gateId); previous = gateId;
    relativePath(gate.inventoryPath, "final inventoryPath"); relativePath(gate.resultPath, "final resultPath");
    if (gate.inventoryPath === gate.resultPath) throw new Error("final inventory aliases result");
    for (const field of ["inventoryFileSha256", "inventoryHash", "resultFileSha256", "resultHash"] as const) hash(gate[field], `final.${field}`);
  }
  if (seen.size !== 9) throw new Error("final inventory must contain exactly nine gates");
  const unsigned = { ...final }; delete unsigned.finalInventoryHash;
  if (final.finalInventoryHash !== hashDomain(PHASE_B_DOMAINS.finalInventory, unsigned)) throw new Error("finalInventoryHash does not match canonical domain hash");
}

export function constructFinalInventory(runId: string, matrixHash: string, wrapperHash: string, schemaHash: string, gates: Array<{ gateId: GateId; inventoryPath: string; inventoryFileSha256: string; inventoryHash: string; resultPath: string; resultFileSha256: string; resultHash: string }>, overallPass: boolean): PhaseBObject {
  const normalized = gates.map(gate => ({ gateId: gate.gateId, inventoryPath: relativePath(gate.inventoryPath, "final inventoryPath"), inventoryFileSha256: hash(gate.inventoryFileSha256, "inventoryFileSha256"), inventoryHash: hash(gate.inventoryHash, "inventoryHash"), resultPath: relativePath(gate.resultPath, "final resultPath"), resultFileSha256: hash(gate.resultFileSha256, "resultFileSha256"), resultHash: hash(gate.resultHash, "resultHash") })).sort((a, b) => compareUtf8(a.gateId, b.gateId));
  const allGates = ["b1-unit", "b2-gjc-integration", "b3-hook-integration", "b4-enforcement-e2e", "coding-agent-types", "coding-agent-check", "coding-agent-regression", "root-check-ts", "root-test-ts"].sort(compareUtf8);
  if (normalized.length !== allGates.length || normalized.some((gate, index) => gate.gateId !== allGates[index] || index > 0 && gate.gateId === normalized[index - 1]?.gateId)) throw new Error("final inventory must contain exactly nine sorted gates");
  if (normalized.some(gate => gate.inventoryPath === gate.resultPath)) throw new Error("final inventory aliases inventory and result");
  const final = { schemaVersion: "phase-b-final-inventory/v1", objectType: "PhaseBFinalInventory", runId: identifier(runId, "final.runId"), matrixHash: hash(matrixHash, "matrixHash"), wrapperHash: hash(wrapperHash, "wrapperHash"), schemaHash: hash(schemaHash, "schemaHash"), gates: normalized, overallPass, finalInventoryHash: "" };
  const unsigned = { ...final }; delete unsigned.finalInventoryHash; final.finalInventoryHash = hashDomain(PHASE_B_DOMAINS.finalInventory, unsigned); return final;
}

export function validateReadOnlyProtocol(value: PhaseBObject): void { if (value.phase1Authorized !== false) throw new Error("Phase B remains unauthorized"); }
const readJson = (file: string): PhaseBObject => object(JSON.parse(readFileSync(file, "utf8")), file);
function intent(matrix: PhaseBObject): void {
  if (matrix.schemaVersion !== "phase-b-verification-matrix/v1" || matrix.objectType !== "PhaseBVerificationMatrix" || matrix.phase1Authorized !== false) throw new Error("matrix is not an unauthorized v1 intent");
  const gates = matrix.gates; if (!Array.isArray(gates) || gates.length !== 9) throw new Error("matrix must contain exactly nine gates");
  const seen = new Set<string>(); for (const value of gates) { const gate = object(value, "matrix gate"); const id = identifier(gate.gateId, "gateId"); if (seen.has(id)) throw new Error(`duplicate gate ${id}`); seen.add(id); if (!Array.isArray(gate.argv) || gate.argv.length < 2 || gate.argv.some(item => typeof item !== "string" || item.length === 0 || /[;&|`$()<>]/.test(item))) throw new Error(`${id}: invalid argv`); if (Boolean(gate.qualityTrace) !== QUALITY_GATES.has(id)) throw new Error(`${id}: trace applicability mismatch`); if (!Array.isArray(gate.declaredArtifacts) || (QUALITY_GATES.has(id) ? gate.declaredArtifacts.join("\0") !== "artifacts/trace.json" : gate.declaredArtifacts.length !== 0)) throw new Error(`${id}: artifact declaration mismatch`); }
  const required = ["b1-unit", "b2-gjc-integration", "b3-hook-integration", "b4-enforcement-e2e", "coding-agent-types", "coding-agent-check", "coding-agent-regression", "root-check-ts", "root-test-ts"]; if (required.some(id => !seen.has(id))) throw new Error("matrix is missing a required gate");
  process.stdout.write(`${canonical({ format: "quality-contract.phase-b-intent.v1", matrixVersion: matrix.schemaVersion, gateCount: gates.length, futureFilesChecked: false, phase1Authorized: false, valid: true })}\n`);
}
export function proveConstructorRoundTrips(): void {
  const withoutHash = (value: PhaseBObject, field: string): PhaseBObject => {
    const copy = { ...value };
    delete copy[field];
    return copy;
  };
  const same = (label: string, actual: PhaseBObject, expected: PhaseBObject): void => {
    if (canonical(actual) !== canonical(expected)) throw new Error(`${label} constructor round-trip changed the value`);
  };
  const anchor = (sequence: number): ClockAnchor => ({
    bootId: "boot-a", wallUtcMs: 1000 + sequence, monoMs: sequence, uncertaintyMs: 0,
    persistedActionSequence: sequence, candidateGeneration: 0, mutationEpoch: 0, cancellationEpoch: 0,
  });
  const command = constructCommand({
    schemaVersion: "phase-b-command/v1", objectType: "PhaseBCommand", runId: "run-a", gateId: "b1-unit",
    matrixHash: "a".repeat(64), wrapperHash: "b".repeat(64), schemaHash: "c".repeat(64),
    argv: ["bun", "test"], cwd: ".", executable: "bun", envPolicyHash: "d".repeat(64), envNames: [],
    admittedAtUtc: "2026-01-01T00:00:00.000Z",
  });
  same("command", constructCommand(withoutHash(command, "commandHash")), command);
  const phasesForProof = ["queue", "bootstrap", "collection", "execution", "evidenceFlush", "shutdown"] as const;
  const segments = Object.fromEntries(phasesForProof.map((phase, index) => [phase, {
    start: anchor(index), end: anchor(index + 1), derivation: "same-boot-monotonic", durationMs: 1,
  }])) as Record<string, TimingSegment>;
  const trace = constructTrace({
    schemaVersion: "phase-b-trace/v1", objectType: "PhaseBTrace", runId: "run-a", gateId: "b1-unit",
    timingSource: "quality-trace", candidateKey: null, baseLeaseTuple: null, fenceTokens: [],
    receiptHash: null, bindingHash: null, pairHash: null,
    timings: { unit: "ms", clockSource: "coordinator-monotonic-v1", queueMs: 1, bootstrapMs: 1, collectionMs: 1,
      executionMs: 1, evidenceFlushMs: 1, shutdownMs: 1, segments },
    assertions: [],
  });
  same("trace", constructTrace(withoutHash(trace, "traceHash")), trace);
  const inventory = constructContentInventory("run-a", "b1-unit", [
    { relativePath: "command.json", bytes: 1, sha256: "e".repeat(64), mediaType: "application/json" },
  ]);
  same("content inventory", constructContentInventory("run-a", "b1-unit", inventory.entries as Array<{ relativePath: string; bytes: number; sha256: string; mediaType: string }>), inventory);
  const result = constructResult({
    schemaVersion: "phase-b-result/v1", objectType: "PhaseBResult", runId: "run-a", gateId: "b1-unit",
    commandHash: command.commandHash, startedAtUtc: "2026-01-01T00:00:00.000Z", endedAtUtc: "2026-01-01T00:00:01.000Z",
    wallElapsedMs: 1, exitCode: 0, signal: null, passed: true, timingSource: "quality-trace",
    queueMs: 1, bootstrapMs: 1, collectionMs: 1, executionMs: 1, evidenceFlushMs: 1, shutdownMs: 1,
    contentInventoryPath: "inventory.json", contentInventoryFileSha256: "f".repeat(64), contentInventoryHash: inventory.inventoryHash,
    declaredArtifactIds: ["artifacts/trace.json"],
  }, trace);
  same("result", constructResult(withoutHash(result, "resultHash"), trace), result);
  const allGates: GateId[] = ["b1-unit", "b2-gjc-integration", "b3-hook-integration", "b4-enforcement-e2e",
    "coding-agent-types", "coding-agent-check", "coding-agent-regression", "root-check-ts", "root-test-ts"];
  const finalInventory = constructFinalInventory("run-a", "a".repeat(64), "b".repeat(64), "c".repeat(64),
    allGates.map((gateId, index) => ({
      gateId, inventoryPath: `inventory-${index}.json`, inventoryFileSha256: "d".repeat(64),
      inventoryHash: inventory.inventoryHash, resultPath: `result-${index}.json`, resultFileSha256: "e".repeat(64),
      resultHash: result.resultHash,
    })), true);
  same("final inventory", constructFinalInventory(finalInventory.runId as string, finalInventory.matrixHash as string,
    finalInventory.wrapperHash as string, finalInventory.schemaHash as string, finalInventory.gates as Array<{
      gateId: GateId; inventoryPath: string; inventoryFileSha256: string; inventoryHash: string;
      resultPath: string; resultFileSha256: string; resultHash: string;
    }>, finalInventory.overallPass as boolean), finalInventory);
}

function main(): void { const args = process.argv.slice(2); let matrix = resolve(repoRoot, "quality-contract/manifests/phase-b-verification-matrix.json"); let intentFlag = false; for (let index = 0; index < args.length; index++) { const arg = args[index]; if (arg === "--intent") { intentFlag = true; continue; } if (arg === "--matrix") { const next = args[++index]; if (next === undefined || next.startsWith("--")) throw new Error("--matrix requires a path"); matrix = resolve(next); continue; } throw new Error("Phase B execution requires separate approval; only --intent is safe"); } if (!intentFlag) throw new Error("Phase B execution requires separate approval"); intent(readJson(matrix)); }
if (import.meta.main) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
