import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync as Database } from "node:sqlite";

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

const root = new URL("..", import.meta.url);
const authoritySql = readFileSync(new URL("sql/authority.sql", root), "utf8");
const promotionSql = readFileSync(new URL("sql/promotion.sql", root), "utf8");
const quiescenceSql = readFileSync(new URL("sql/quiescence-authority.sql", root), "utf8");
const fixtures = JSON.parse(readFileSync(new URL("fixtures/sql-fixtures.json", root), "utf8")) as {
  version: number;
  windowSeconds: number;
  identityFields: string[];
  scenarios: Array<{ id: string; kind: string; expect: string }>;
};
const quiescenceFixtures = JSON.parse(readFileSync(new URL("fixtures/quiescence-sql-fixtures.json", root), "utf8")) as {
  version: number;
  identityFields: string[];
  scenarios: Array<{ id: string; kind: string; expect: string }>;
};
const fixtureBytes = readFileSync(new URL("fixtures/sql-fixtures.json", root));
const quiescenceFixtureBytes = readFileSync(new URL("fixtures/quiescence-sql-fixtures.json", root));

const ids = {
  groundTruthKey: "gt-demo",
  projectRootIdentity: "project-demo",
  rootBundleSequence: 7,
  trustBundleSequence: 3,
  checkpointKey: "checkpoint-a",
  profileKey: "profile-a",
  stageKey: "stage-a",
  gateVerdict: "CLEAR",
  risk: "R1",
};
const now = 1_000_000;
const bytes = (text: string) => new TextEncoder().encode(text);
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("receipt JSON value is not serializable");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("receipt JSON value is not serializable");
};

type JsonRecord = Record<string, unknown>;

const cloneRecord = (record: JsonRecord): JsonRecord => JSON.parse(JSON.stringify(record)) as JsonRecord;

const signatureGroups = (receipt: JsonRecord): JsonRecord[] => {
  const rootTransition = receipt.rootTransition as JsonRecord;
  return [receipt.signatureGroup as JsonRecord, rootTransition.signatureGroup as JsonRecord];
};

const clearSignatureHashes = (receipt: JsonRecord) => {
  for (const group of signatureGroups(receipt)) {
    const signatures = group.signatures as JsonRecord[];
    for (const signature of signatures) signature.signatureHash = "";
  }
};

const receiptEnvelopeHash = (receipt: JsonRecord) => {
  const payload = cloneRecord(receipt);
  payload.canonicalEnvelopeHash = "";
  clearSignatureHashes(payload);
  return sha256(bytes(`GJC-QUALITY-RECEIPT-ENVELOPE\0v1\0${canonicalJson(payload)}`));
};

const receiptSignatureHash = (receipt: JsonRecord) => {
  const payload = cloneRecord(receipt);
  clearSignatureHashes(payload);
  return createHmac("sha256", "quality-contract-receipt-test-key").update(bytes(`GJC-QUALITY-RECEIPT-SIGNATURE\0v1\0${canonicalJson(payload)}`)).digest("hex");
};

const assertRecordKeys = (value: unknown, expected: string[], message: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  const record = value as JsonRecord;
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== [...expected].sort()[index])) throw new Error(message);
  return record;
};

const assertHash = (value: unknown, message: string) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(message);
};

const assertSignedCanonicalReceipt = (receiptBytes: Uint8Array): JsonRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(receiptBytes));
  } catch {
    throw new Error("receipt envelope must be valid JSON");
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && !("signatureGroup" in parsed)) {
    throw new Error("receipt signature required");
  }
  const receipt = assertRecordKeys(parsed, [
    "$schema", "accepted", "canonicalEnvelopeHash", "canonicalization", "evidenceCount", "evidenceHash",
    "evidenceMerkleRoot", "hashDomain", "issuedAt", "objectId", "objectType", "processedAt", "receiptFor",
    "rootTransition", "schemaVersion", "signatureGroup",
  ], "receipt envelope schema invalid");
  if (canonicalJson(receipt) !== new TextDecoder().decode(receiptBytes)) throw new Error("receipt must use JCS canonical encoding");
  if (receipt.$schema !== "https://json-schema.org/draft/2020-12/schema" || receipt.schemaVersion !== "0.1.0" ||
      receipt.objectType !== "Receipt" || receipt.hashDomain !== "gajae.quality.receipt.v1" ||
      receipt.canonicalization !== "JCS-RFC8785" || receipt.accepted !== true ||
      typeof receipt.objectId !== "string" || typeof receipt.receiptFor !== "string" ||
      typeof receipt.issuedAt !== "string" || Number.isNaN(Date.parse(receipt.issuedAt)) ||
      typeof receipt.processedAt !== "string" || Number.isNaN(Date.parse(receipt.processedAt)) ||
      !Number.isInteger(receipt.evidenceCount) || (receipt.evidenceCount as number) < 0) {
    throw new Error("receipt envelope schema invalid");
  }
  assertHash(receipt.evidenceHash, "receipt envelope schema invalid");
  assertHash(receipt.evidenceMerkleRoot, "receipt envelope schema invalid");
  assertHash(receipt.canonicalEnvelopeHash, "receipt envelope schema invalid");
  const rootTransition = assertRecordKeys(receipt.rootTransition, [
    "nextRootHash", "previousRootHash", "signatureGroup", "transitionId", "transitionKind",
  ], "receipt envelope schema invalid");
  assertHash(rootTransition.nextRootHash, "receipt envelope schema invalid");
  if (rootTransition.previousRootHash !== null) assertHash(rootTransition.previousRootHash, "receipt envelope schema invalid");
  if (rootTransition.transitionKind !== "GENESIS" && rootTransition.transitionKind !== "ROTATE" && rootTransition.transitionKind !== "REVOKE") {
    throw new Error("receipt envelope schema invalid");
  }
  const validateGroup = (value: unknown) => {
    const group = assertRecordKeys(value, ["signatures", "threshold"], "receipt signature required");
    if (!Number.isInteger(group.threshold) || (group.threshold as number) < 1 || !Array.isArray(group.signatures) || group.signatures.length < 1) {
      throw new Error("receipt signature required");
    }
    for (const signatureValue of group.signatures) {
      const signature = assertRecordKeys(signatureValue, ["algorithm", "keyId", "signatureHash", "signerId"], "receipt signature invalid");
      if ((signature.algorithm !== "ed25519" && signature.algorithm !== "hmac-sha256") ||
          typeof signature.keyId !== "string" || typeof signature.signerId !== "string") {
        throw new Error("receipt signature invalid");
      }
      assertHash(signature.signatureHash, "receipt signature invalid");
    }
  };
  validateGroup(receipt.signatureGroup);
  validateGroup(rootTransition.signatureGroup);
  if (receipt.canonicalEnvelopeHash !== receiptEnvelopeHash(receipt)) throw new Error("receipt canonical envelope hash mismatch");
  const expectedSignatureHash = receiptSignatureHash(receipt);
  for (const group of signatureGroups(receipt)) {
    for (const signature of group.signatures as JsonRecord[]) {
      if (signature.signatureHash !== expectedSignatureHash) throw new Error("receipt signature invalid");
    }
  }
  return receipt;
};

const signedReceipt = (slot: string, verdict: "CLEAR" | "WATCH") => {
  const signature = () => ({
    algorithm: "hmac-sha256",
    keyId: "receipt-key",
    signatureHash: "",
    signerId: "receipt-signer",
  });
  const receipt: JsonRecord = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    accepted: true,
    canonicalEnvelopeHash: "",
    canonicalization: "JCS-RFC8785",
    evidenceCount: 0,
    evidenceHash: sha256(bytes(`evidence:${verdict}:${slot}`)),
    evidenceMerkleRoot: sha256(new Uint8Array()),
    hashDomain: "gajae.quality.receipt.v1",
    issuedAt: "1970-01-12T13:46:40.000Z",
    objectId: `receipt-${slot}`,
    objectType: "Receipt",
    processedAt: "1970-01-12T13:46:40.000Z",
    receiptFor: "attempt-1",
    rootTransition: {
      nextRootHash: sha256(bytes("root-next")),
      previousRootHash: null,
      signatureGroup: { signatures: [signature()], threshold: 1 },
      transitionId: "transition-1",
      transitionKind: "GENESIS",
    },
    schemaVersion: "0.1.0",
    signatureGroup: { signatures: [signature()], threshold: 1 },
  };
  receipt.canonicalEnvelopeHash = receiptEnvelopeHash(receipt);
  const signatureHash = receiptSignatureHash(receipt);
  for (const group of signatureGroups(receipt)) {
    for (const entry of group.signatures as JsonRecord[]) entry.signatureHash = signatureHash;
  }
  const encoded = bytes(canonicalJson(receipt));
  assertSignedCanonicalReceipt(encoded);
  return encoded;
};
type Identity = {
  groundTruthKey: string;
  projectRootIdentity: string;
  rootBundleSequence: number;
  trustBundleSequence: number;
  checkpointKey: string;
  profileKey: string;
  stageKey: string;
  gateVerdict: string;
  risk: string;
};
type Assertion = { id: string; passed: boolean; detail: string };
let activeIds: Identity = ids;
const assertions: Assertion[] = [];
const scenario = (id: string) => fixtures.scenarios.find((entry) => entry.id === id);
const qtbScenario = (id: string) => quiescenceFixtures.scenarios.find((entry) => entry.id === id);
const check = (id: string, passed: boolean, detail: string) => {
  if (!scenario(id) && !qtbScenario(id)) throw new Error(`fixture missing scenario ${id}`);
  assertions.push({ id, passed, detail });
  if (!passed) throw new Error(`${id}: ${detail}`);
};

// The assertion is deliberately outside the catch: check() itself throws on false.
// Only an exception raised by the SQL action counts as a negative result.
const expectFailure = (id: string, action: () => void, expectedError?: string) => {
  let threw = false;
  let errorMessage = "";
  try {
    action();
  } catch (error) {
    threw = true;
    errorMessage = String(error);
  }
  const matchedExpectedError = expectedError === undefined || errorMessage.includes(expectedError);
  const detail = threw
    ? matchedExpectedError
      ? `SQL action rejected by intended guard: ${errorMessage}`
      : `SQL action rejected by unexpected guard: ${errorMessage}`
    : "operation unexpectedly succeeded";
  check(id, threw && matchedExpectedError, detail);
};

const identitySqlColumns = [
  "ground_truth_key", "project_root_identity", "root_bundle_sequence", "trust_bundle_sequence",
  "gate_verdict", "risk", "checkpoint_key", "profile_key", "stage_key",
] as const;
const identityFixtureNames: Record<string, string> = {
  groundTruthKey: "ground-truth-key",
  projectRootIdentity: "project-root-identity",
  rootBundleSequence: "root-bundle-sequence",
  trustBundleSequence: "trust-bundle-sequence",
  gateVerdict: "gate-verdict",
  risk: "risk",
  checkpointKey: "checkpoint-key",
  profileKey: "profile-key",
  stageKey: "stage-key",
};

const makeDb = (filenameOrOverrides: string | Partial<Identity> = ":memory:", overrides: Partial<Identity> = {}) => {
  const filename = typeof filenameOrOverrides === "string" ? filenameOrOverrides : ":memory:";
  const selectedOverrides = typeof filenameOrOverrides === "string" ? overrides : filenameOrOverrides;
  const db = new Database(filename);
  registerDeterministicHashFunctions(db);
  db.exec(authoritySql);
  db.exec(promotionSql);
  db.exec(quiescenceSql);
  const value = { ...ids, ...selectedOverrides };
  activeIds = value;
  db.prepare(`INSERT INTO commit_sequences
    (ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, checkpoint_key, profile_key, stage_key, committed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(value.groundTruthKey, value.projectRootIdentity, value.rootBundleSequence, value.trustBundleSequence, value.checkpointKey, value.profileKey, value.stageKey, now);
  db.prepare(`INSERT INTO attempts
    (attempt_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key, slot_key, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("attempt-1", value.groundTruthKey, value.projectRootIdentity, value.rootBundleSequence, value.trustBundleSequence, value.gateVerdict, value.risk, value.checkpointKey, value.profileKey, value.stageKey, "slot-1", now);
  db.prepare(`INSERT INTO gate_decisions
    (decision_id, attempt_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key, decided_at, decision_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("decision-1", "attempt-1", value.groundTruthKey, value.projectRootIdentity, value.rootBundleSequence, value.trustBundleSequence, value.gateVerdict, value.risk, value.checkpointKey, value.profileKey, value.stageKey, now, bytes("decision-1"));
  return db;
};

const insertAuthorization = (db: Database, options: {
  id: string;
  principal: string;
  kind: string;
  role: string;
  scope?: string;
  risk?: string;
  authorizedFrom?: number;
  expiresAt?: number;
  revokedAt?: number | null;
}) => {
  const risk = options.risk ?? activeIds.risk;
  const authorizedFrom = options.authorizedFrom ?? now;
  const expiresAt = options.expiresAt ?? now + 10_000;
  db.prepare(`INSERT INTO authorizations
    (authorization_id, principal_id, authorization_kind, authorization_role, decision_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key, scope_key, authorized_from, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, 'decision-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    options.id, options.principal.toLowerCase().trim(), options.kind, options.role,
    activeIds.groundTruthKey, activeIds.projectRootIdentity, activeIds.rootBundleSequence, activeIds.trustBundleSequence,
    activeIds.gateVerdict, risk, activeIds.checkpointKey, activeIds.profileKey, activeIds.stageKey,
    options.scope ?? "scope-a", authorizedFrom, expiresAt, options.revokedAt ?? null,
  );
};

const insertMetricAndEvaluation = (db: Database, options: { denominator?: number; blocked?: number; evaluationBlocked?: number; measuredAt?: number; evaluatedAt?: number; risk?: string } = {}) => {
  const denominator = options.denominator ?? 10;
  const blocked = options.blocked ?? (denominator === 0 ? 0 : 1);
  const evaluationBlocked = options.evaluationBlocked ?? blocked;
  const evaluatedAt = options.evaluatedAt ?? now;
  const measuredAt = options.measuredAt ?? evaluatedAt;
  const risk = options.risk ?? activeIds.risk;
  const expires = measuredAt + fixtures.windowSeconds;
  const blockedPpm = denominator === 0 ? 0 : Math.floor((blocked * 1_000_000 + Math.floor(denominator / 2)) / denominator);
  const evaluationBlockedPpm = denominator === 0 ? 0 : Math.floor((evaluationBlocked * 1_000_000 + Math.floor(denominator / 2)) / denominator);
  db.prepare(`INSERT INTO evaluation_runtime_metrics
    (metric_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key, measured_at, window_seconds, expires_at, total_count, blocked_count, false_accept_count, missing_count, late_count, conflict_count, unresolved_count, denominator, error_ppm, blocked_ppm, product_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "metric-1", activeIds.groundTruthKey, activeIds.projectRootIdentity, activeIds.rootBundleSequence, activeIds.trustBundleSequence, activeIds.gateVerdict, risk, activeIds.checkpointKey, activeIds.profileKey, activeIds.stageKey,
    measuredAt, fixtures.windowSeconds, expires, 10, blocked, 0, 0, 0, 0, 0, denominator, 0, blockedPpm, 10,
  );
  db.prepare(`INSERT INTO evaluations
    (evaluation_id, decision_id, metric_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key, evaluated_at, metric_expires_at, blocked_count, false_accept_count, missing_count, late_count, conflict_count, unresolved_count, denominator, error_ppm, blocked_ppm, product_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "evaluation-1", "decision-1", "metric-1", activeIds.groundTruthKey, activeIds.projectRootIdentity, activeIds.rootBundleSequence, activeIds.trustBundleSequence, activeIds.gateVerdict, risk, activeIds.checkpointKey, activeIds.profileKey, activeIds.stageKey,
    evaluatedAt, expires, evaluationBlocked, 0, 0, 0, 0, 0, denominator, 0, evaluationBlockedPpm, 10,
  );
};

const promotion = (db: Database, overrides: Record<string, unknown> = {}) => db.prepare(`INSERT INTO promotions
  (promotion_id, evaluation_id, decision_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key, promoted_at, status, reason)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  overrides.promotionId ?? "promotion-1", overrides.evaluationId ?? "evaluation-1", overrides.decisionId ?? "decision-1",
  overrides.groundTruthKey ?? ids.groundTruthKey, overrides.projectRootIdentity ?? ids.projectRootIdentity, overrides.rootBundleSequence ?? ids.rootBundleSequence, overrides.trustBundleSequence ?? ids.trustBundleSequence,
  overrides.gateVerdict ?? ids.gateVerdict, overrides.risk ?? ids.risk, overrides.checkpointKey ?? ids.checkpointKey, overrides.profileKey ?? ids.profileKey, overrides.stageKey ?? ids.stageKey,
  overrides.promotedAt ?? now + 1, overrides.status ?? "PROMOTED", overrides.reason ?? "verified-allow",
);

const canonicalReceiptHash = (receipt: Uint8Array) => {
  const domain = bytes("GJC-QUALITY-RECEIPT-HASH\0v1\0");
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(receipt.byteLength), false);
  const canonical = new Uint8Array(domain.length + length.length + receipt.length);
  canonical.set(domain, 0);
  canonical.set(length, domain.length);
  canonical.set(receipt, domain.length + length.length);
  return sha256(canonical);
};
const canonicalEvidenceHash = (content: Uint8Array) => sha256(content);
const canonicalAuditHash = (event: Uint8Array) => {
  const domain = bytes("quality-contract.audit.v1\0");
  const canonical = new Uint8Array(domain.length + event.length);
  canonical.set(domain, 0);
  canonical.set(event, domain.length);
  return sha256(canonical);
};
type HashOverrides = Partial<{
  receiptHash: string;
  evidenceHash: string;
  auditHash: string;
}>;
const approvedHashes = (receipt: Uint8Array) => ({
  receiptHash: canonicalReceiptHash(receipt),
  evidenceHash: canonicalEvidenceHash(receipt),
  auditHash: canonicalAuditHash(receipt),
});
const assertApprovedHashes = (receipt: Uint8Array, overrides: HashOverrides) => {
  const expected = approvedHashes(receipt);
  if (overrides.receiptHash !== undefined && overrides.receiptHash !== expected.receiptHash) {
    throw new Error("receipt hash mismatch");
  }
  if (overrides.evidenceHash !== undefined && overrides.evidenceHash !== expected.evidenceHash) {
    throw new Error("evidence hash mismatch");
  }
  if (overrides.auditHash !== undefined && overrides.auditHash !== expected.auditHash) {
    throw new Error("audit hash mismatch");
  }
  return expected;
};
type DatabaseWithFunctions = Database & {
  function?: (
    name: string,
    options: { deterministic: boolean },
    fn: (value: Uint8Array) => string,
  ) => void;
};
const registerDeterministicHashFunctions = (db: Database) => {
  const register = (db as DatabaseWithFunctions).function;
  if (typeof register !== "function") {
    throw new Error("SQLite deterministic hash UDF registration unavailable");
  }
  try {
    register.call(db, "gjc_receipt_hash", { deterministic: true }, canonicalReceiptHash);
    register.call(db, "gjc_evidence_hash", { deterministic: true }, canonicalEvidenceHash);
    register.call(db, "gjc_audit_hash", { deterministic: true }, canonicalAuditHash);
  } catch (error) {
    throw new Error(`SQLite deterministic hash UDF registration failed: ${String(error)}`);
  }
};

const finalizeWatchBody = (db: Database, slot: string, hashOverrides: HashOverrides = {}) => {
  const existing = db.prepare("SELECT receipt_bytes FROM receipts WHERE attempt_id = ? AND slot_key = ?").get("attempt-1", slot) as { receipt_bytes?: Uint8Array } | null;
  if (existing) return existing.receipt_bytes;
  const grant = db.prepare(`SELECT grant_id, expires_at, revoked_at, used_count, max_uses FROM exception_grants
    WHERE ground_truth_key = ? AND project_root_identity = ? AND root_bundle_sequence = ? AND trust_bundle_sequence = ? AND gate_verdict = 'WATCH'`).get(activeIds.groundTruthKey, activeIds.projectRootIdentity, activeIds.rootBundleSequence, activeIds.trustBundleSequence) as { grant_id: string; expires_at: number; revoked_at: number | null; used_count: number; max_uses: number } | null;
  if (!grant || grant.revoked_at !== null || grant.expires_at <= now || grant.used_count >= grant.max_uses) throw new Error("WATCH grant unavailable");
  const useId = `use-${slot}`;
  const receiptId = `receipt-${slot}`;
  const evidenceId = `evidence-${slot}`;
  const eventId = `event-${slot}`;
  const outboxId = `outbox-${slot}`;
  const receipt = signedReceipt(slot, "WATCH");
  const hashes = assertApprovedHashes(receipt, hashOverrides);
  db.prepare("INSERT INTO exception_uses (use_id, grant_id, attempt_id, slot_key, used_at) VALUES (?, ?, ?, ?, ?)").run(useId, grant.grant_id, "attempt-1", slot, now);
  db.prepare("INSERT INTO evidence_objects (evidence_id, content_hash, content_bytes, media_type, captured_at) VALUES (?, ?, ?, ?, ?)").run(evidenceId, hashes.evidenceHash, receipt, "application/receipt", now);
  db.prepare("INSERT INTO evidence_refs (decision_id, evidence_id, ref_kind, ordinal) VALUES (?, ?, 'RECEIPT', 0)").run("decision-1", evidenceId);
  db.prepare("INSERT INTO audit_events (event_id, event_type, aggregate_id, event_bytes, event_hash, occurred_at) VALUES (?, ?, ?, ?, ?, ?)").run(eventId, "RECEIPT_COMMITTED", receiptId, receipt, hashes.auditHash, now);
  db.prepare("INSERT INTO outbox (outbox_id, event_id, topic, payload_bytes) VALUES (?, ?, 'quality-contract.receipt', ?)").run(outboxId, eventId, receipt);
  db.prepare("INSERT INTO receipts (receipt_id, attempt_id, slot_key, receipt_bytes, receipt_hash, exception_use_id, evidence_id, event_id, outbox_id, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(receiptId, "attempt-1", slot, receipt, hashes.receiptHash, useId, evidenceId, eventId, outboxId, now);
  return receipt;
};

const finalizeWatch = (db: Database, slot = "slot-1", hashOverrides: HashOverrides = {}) => {
  let started = false;
  db.exec("BEGIN IMMEDIATE");
  started = true;
  try {
    const receipt = finalizeWatchBody(db, slot, hashOverrides);
    db.exec("COMMIT");
    started = false;
    return receipt;
  } catch (error) {
    if (started) db.exec("ROLLBACK");
    throw error;
  }
};
const finalizeClearBody = (db: Database, slot: string, hashOverrides: HashOverrides = {}) => {
  const existing = db.prepare("SELECT receipt_bytes FROM receipts WHERE attempt_id = ? AND slot_key = ?").get("attempt-1", slot) as { receipt_bytes?: Uint8Array } | null;
  if (existing) return existing.receipt_bytes;
  const receiptId = `receipt-${slot}`;
  const evidenceId = `evidence-${slot}`;
  const eventId = `event-${slot}`;
  const outboxId = `outbox-${slot}`;
  const receipt = signedReceipt(slot, "CLEAR");
  const hashes = assertApprovedHashes(receipt, hashOverrides);
  db.prepare("INSERT INTO evidence_objects (evidence_id, content_hash, content_bytes, media_type, captured_at) VALUES (?, ?, ?, ?, ?)").run(evidenceId, hashes.evidenceHash, receipt, "application/receipt", now);
  db.prepare("INSERT INTO evidence_refs (decision_id, evidence_id, ref_kind, ordinal) VALUES (?, ?, 'RECEIPT', 0)").run("decision-1", evidenceId);
  db.prepare("INSERT INTO audit_events (event_id, event_type, aggregate_id, event_bytes, event_hash, occurred_at) VALUES (?, ?, ?, ?, ?, ?)").run(eventId, "RECEIPT_COMMITTED", receiptId, receipt, hashes.auditHash, now);
  db.prepare("INSERT INTO outbox (outbox_id, event_id, topic, payload_bytes) VALUES (?, ?, 'quality-contract.receipt', ?)").run(outboxId, eventId, receipt);
  db.prepare("INSERT INTO receipts (receipt_id, attempt_id, slot_key, receipt_bytes, receipt_hash, exception_use_id, evidence_id, event_id, outbox_id, committed_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)").run(receiptId, "attempt-1", slot, receipt, hashes.receiptHash, evidenceId, eventId, outboxId, now);
  return receipt;
};

const finalizeClear = (db: Database, slot = "slot-1", hashOverrides: HashOverrides = {}) => {
  let started = false;
  db.exec("BEGIN IMMEDIATE");
  started = true;
  try {
    const receipt = finalizeClearBody(db, slot, hashOverrides);
    db.exec("COMMIT");
    started = false;
    return receipt;
  } catch (error) {
    if (started) db.exec("ROLLBACK");
    throw error;
  }
};
const baseWatch = (db: Database, expiresAt = now + 100, revokedAt: number | null = null) => {
  registerDeterministicHashFunctions(db);
  insertAuthorization(db, {
    id: "approver-1",
    principal: "operator",
    kind: "APPROVER",
    role: "OPERATOR",
    authorizedFrom: now - 2,
    expiresAt: now + 10_000,
  });
  db.prepare(`INSERT INTO exception_grants (grant_id, approver_authorization_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key, scope_key, max_uses, created_at, expires_at, revoked_at)
    VALUES ('grant-1', 'approver-1', ?, ?, ?, ?, 'WATCH', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(activeIds.groundTruthKey, activeIds.projectRootIdentity, activeIds.rootBundleSequence, activeIds.trustBundleSequence, activeIds.risk, activeIds.checkpointKey, activeIds.profileKey, activeIds.stageKey, "scope-a", 1, now - 2, expiresAt, revokedAt);
};
const runRaceWorker = (filename: string, barrier: string, workerId: string): Promise<{ workerId: string; created: boolean; receiptHex: string }> =>
  new Promise((resolve, reject) => {
    const workerPath = new URL("sqlite-race-worker.ts", import.meta.url).pathname;
    const child = spawn(process.execPath, [workerPath, filename, barrier, workerId], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`race worker ${workerId} failed (${code}): ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as { workerId: string; created: boolean; receiptHex: string });
      } catch (error) {
        reject(new Error(`race worker ${workerId} returned invalid JSON: ${stdout} (${String(error)})`));
      }
    });
  });


const qtbClaimWorkerSource = `
const { DatabaseSync: Database } = require("node:sqlite");
const { existsSync } = require("node:fs");
const [filename, barrier, workerId] = process.argv.slice(1);
const started = Date.now();
while (!existsSync(barrier)) {
  if (Date.now() - started > 5_000) throw new Error("quiescence race barrier timeout");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
const db = new Database(filename);
db.exec("PRAGMA busy_timeout = 5000");
let startedTransaction = false;
const result = { workerId, won: false, error: "" };
try {
  db.exec("BEGIN IMMEDIATE");
  startedTransaction = true;
  try {
    db.prepare(\`INSERT INTO qtb_leases
      (lease_id, candidate_key, project_id, root_objective_id, candidate_generation, mutation_epoch, profile_id, fence, claimed_at, expires_at)
      VALUES (?, 'candidate-race', 'project-race', 'objective-race', 0, 0, 'g0-evidence-only', 1, 1000000, 1000100)\`).run(workerId);
    db.exec("COMMIT");
    startedTransaction = false;
    result.won = true;
  } catch (error) {
    if (startedTransaction) db.exec("ROLLBACK");
    startedTransaction = false;
    result.error = String(error);
  }
} finally {
  if (startedTransaction) db.exec("ROLLBACK");
  db.close();
}
console.log(JSON.stringify(result));
`;

type QtbRaceResult = { workerId: string; won: boolean; error: string };
const runQtbClaimWorker = (filename: string, barrier: string, workerId: string): Promise<QtbRaceResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", qtbClaimWorkerSource, filename, barrier, workerId], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`quiescence race worker ${workerId} failed (${code}): ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as QtbRaceResult);
      } catch (error) {
        reject(new Error(`quiescence race worker ${workerId} returned invalid JSON: ${stdout} (${String(error)})`));
      }
    });
  });

const db = makeDb();
check("authority-constraints", Boolean(db.prepare("SELECT 1 FROM gate_decisions WHERE decision_id = 'decision-1'").get()), "base authority row committed");
db.close();

{
  const directory = await mkdtemp(join(tmpdir(), "quality-contract-bootstrap-"));
  const local = makeDb(join(directory, "bootstrap.sqlite"));
  const journal = String((local.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase();
  const synchronous = Number((local.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous);
  check("bootstrap-wal", journal === "wal", `journal_mode=${journal}`);
  check("bootstrap-synchronous-full", synchronous === 2, `synchronous=${synchronous}`);
  local.close();
  await rm(directory, { recursive: true, force: true });
}
{
  const local = makeDb();
  const first = finalizeClear(local);
  const second = finalizeClear(local);
  const row = local.prepare("SELECT exception_use_id FROM receipts WHERE receipt_id = 'receipt-slot-1'").get() as { exception_use_id: string | null };
  check("clear-receipt-positive", row.exception_use_id === null, "CLEAR receipt commits without exception use");
  check("clear-receipt-idempotent", first?.toString() === second?.toString(), "same CLEAR receipt bytes are idempotent");
  check("canonical-receipt-envelope", Boolean(first && assertSignedCanonicalReceipt(first)), "receipt is a schema-valid signed JCS envelope");
  local.close();
}
{
  const local = makeDb({ gateVerdict: "WATCH" });
  expectFailure("watch-receipt-exception-required", () => local.prepare(
    "INSERT INTO receipts (receipt_id, attempt_id, slot_key, receipt_bytes, receipt_hash, exception_use_id, evidence_id, event_id, outbox_id, committed_at) VALUES ('missing-watch', 'attempt-1', 'slot-watch', x'78', 'x', NULL, 'e', 'e', 'o', 0)",
  ).run(), "WATCH receipt requires exception use");
  local.close();
}
{
  const local = makeDb();
  expectFailure("clear-receipt-exception-forbidden", () => local.prepare(
    "INSERT INTO receipts (receipt_id, attempt_id, slot_key, receipt_bytes, receipt_hash, exception_use_id, evidence_id, event_id, outbox_id, committed_at) VALUES ('bad-clear', 'attempt-1', 'slot-clear', x'78', 'x', 'use-clear', 'e', 'e', 'o', 0)",
  ).run(), "exception use forbidden for CLEAR/BLOCK receipt");
  local.close();
}
{
  const local = makeDb({ gateVerdict: "BLOCK" });
  expectFailure("block-receipt-exception-forbidden", () => local.prepare(
    "INSERT INTO receipts (receipt_id, attempt_id, slot_key, receipt_bytes, receipt_hash, exception_use_id, evidence_id, event_id, outbox_id, committed_at) VALUES ('bad-block', 'attempt-1', 'slot-block', x'78', 'x', 'use-block', 'e', 'e', 'o', 0)",
  ).run(), "exception use forbidden for CLEAR/BLOCK receipt");
  local.close();
}
{
  const canonical = signedReceipt("fixture", "CLEAR");
  const noncanonical = bytes(` ${new TextDecoder().decode(canonical)}`);
  expectFailure("canonical-receipt-noncanonical", () => assertSignedCanonicalReceipt(noncanonical), "receipt must use JCS canonical encoding");
  const unsigned = cloneRecord(JSON.parse(new TextDecoder().decode(canonical)) as JsonRecord);
  delete unsigned.signatureGroup;
  expectFailure("canonical-receipt-missing-signature", () => assertSignedCanonicalReceipt(bytes(canonicalJson(unsigned))), "receipt signature required");
  const invalidSignature = cloneRecord(JSON.parse(new TextDecoder().decode(canonical)) as JsonRecord);
  for (const group of signatureGroups(invalidSignature)) {
    for (const signature of group.signatures as JsonRecord[]) signature.signatureHash = "0".repeat(64);
  }
  expectFailure("canonical-receipt-invalid-signature", () => assertSignedCanonicalReceipt(bytes(canonicalJson(invalidSignature))), "receipt signature invalid");
}
for (const field of fixtures.identityFields) {
  const fixtureName = identityFixtureNames[field];
  if (!fixtureName) throw new Error(`unknown identity field ${field}`);
  const local = makeDb();
  const mismatch = { ...ids } as Record<string, string | number>;
  mismatch[field] = typeof ids[field as keyof Identity] === "number" ? Number(ids[field as keyof Identity]) + 1 : `other-${field}`;
  if (field === "gateVerdict") mismatch[field] = "WATCH";
  if (field === "risk") mismatch[field] = "R2";
  const values = identitySqlColumns.map((column) => mismatch[({
    ground_truth_key: "groundTruthKey", project_root_identity: "projectRootIdentity", root_bundle_sequence: "rootBundleSequence", trust_bundle_sequence: "trustBundleSequence",
    gate_verdict: "gateVerdict", risk: "risk", checkpoint_key: "checkpointKey", profile_key: "profileKey", stage_key: "stageKey",
  } as Record<string, string>)[column]]);
  expectFailure(`identity-mismatch-${fixtureName}`, () => local.prepare(`INSERT INTO gate_decisions
    (decision_id, attempt_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key, decided_at, decision_bytes)
    VALUES ('bad-${fixtureName}', 'attempt-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(...values, bytes(`bad-${fixtureName}`)));
  local.close();
}

{
  const local = makeDb();
  insertMetricAndEvaluation(local, { denominator: 0 });
  expectFailure("zero-denominator", () => promotion(local));
  local.close();
}
{
  const local = makeDb();
  expectFailure("evaluation-counter-mismatch", () => insertMetricAndEvaluation(local, { blocked: 1, evaluationBlocked: 2 }), "evaluation metric identity mismatch");
  local.close();
}

{
  const local = makeDb();
  expectFailure("evaluation-before-measurement", () => insertMetricAndEvaluation(local, { measuredAt: now, evaluatedAt: now - 1 }), "evaluation metric identity mismatch");
  local.close();
}

{
  const local = makeDb();
  expectFailure("expiry-before-window", () => local.prepare(`INSERT INTO evaluation_runtime_metrics
    (metric_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key, measured_at, window_seconds, expires_at, total_count, blocked_count, false_accept_count, missing_count, late_count, conflict_count, unresolved_count, denominator, error_ppm, blocked_ppm, product_count)
    VALUES ('bad-metric', 'gt-demo', 'project-demo', 7, 3, 'CLEAR', 'R1', 'checkpoint-a', 'profile-a', 'stage-a', 100, 1209600, 1209699, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1000000, 1)`).run());
  local.close();
}

{
  const local = makeDb();
  insertMetricAndEvaluation(local, { evaluatedAt: now });
  expectFailure("expiry-at-boundary", () => promotion(local, { promotedAt: now + fixtures.windowSeconds }));
  local.close();
}

{
  const local = makeDb();
  expectFailure("bounded-promotion-arithmetic", () => local.prepare(`INSERT INTO evaluation_runtime_metrics
    (metric_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key, measured_at, window_seconds, expires_at, total_count, blocked_count, false_accept_count, missing_count, late_count, conflict_count, unresolved_count, denominator, error_ppm, blocked_ppm, product_count)
    VALUES ('bad-arithmetic', 'gt-demo', 'project-demo', 7, 3, 'CLEAR', 'R1', 'checkpoint-a', 'profile-a', 'stage-a', ?, 1209600, ?, 10, 1, 0, 0, 0, 0, 0, 10, 0, 1, 1000000000000001)`).run(now, now + fixtures.windowSeconds));
  local.close();
}

{
  const local = makeDb({ risk: "R3" });
  insertAuthorization(local, { id: "adjudicator-alice", principal: "alice", kind: "ADJUDICATOR", role: "REVIEWER", risk: "R3" });
  local.prepare("INSERT INTO adjudications (envelope_id, decision_id, adjudicator_authorization_id, adjudication_kind, payload_bytes, payload_hash, created_at) VALUES ('env-1', 'decision-1', 'adjudicator-alice', 'ALLOW', ?, 'payload-1', ?)").run(bytes("allow"), now);
  local.prepare("INSERT INTO adjudication_signers (envelope_id, signer_id, signer_id_normalized, authorization_id, signer_role, signer_rank, signature_bytes, signed_at) VALUES ('env-1', 'alice', 'alice', 'adjudicator-alice', 'REVIEWER', 1, ?, ?)").run(bytes("sig"), now);
  expectFailure("duplicate-signers", () => local.prepare("INSERT INTO adjudication_signers (envelope_id, signer_id, signer_id_normalized, authorization_id, signer_role, signer_rank, signature_bytes, signed_at) VALUES ('env-1', 'ALICE', 'alice', 'adjudicator-alice', 'REVIEWER', 2, ?, ?)").run(bytes("sig2"), now));
  local.close();
}

{
  const local = makeDb({ risk: "R3" });
  insertMetricAndEvaluation(local, { risk: "R3" });
  insertAuthorization(local, { id: "adjudicator-alice", principal: "alice", kind: "ADJUDICATOR", role: "REVIEWER", risk: "R3" });
  local.prepare("INSERT INTO adjudications (envelope_id, decision_id, adjudicator_authorization_id, adjudication_kind, payload_bytes, payload_hash, created_at) VALUES ('env-1', 'decision-1', 'adjudicator-alice', 'ALLOW', ?, 'payload-1', ?)").run(bytes("allow"), now);
  local.prepare("INSERT INTO adjudication_signers (envelope_id, signer_id, signer_id_normalized, authorization_id, signer_role, signer_rank, signature_bytes, signed_at) VALUES ('env-1', 'alice', 'alice', 'adjudicator-alice', 'REVIEWER', 1, ?, ?)").run(bytes("sig"), now);
  expectFailure("rank2-security-required", () => promotion(local, { risk: "R3" }), "rank two authorized security signer required");
  local.close();
}

{
  const local = makeDb({ risk: "R3" });
  insertMetricAndEvaluation(local, { risk: "R3" });
  insertAuthorization(local, { id: "adjudicator-alice", principal: "alice", kind: "ADJUDICATOR", role: "REVIEWER", risk: "R3" });
  insertAuthorization(local, { id: "adjudicator-bob", principal: "bob", kind: "ADJUDICATOR", role: "SECURITY", risk: "R3" });
  local.prepare("INSERT INTO adjudications (envelope_id, decision_id, adjudicator_authorization_id, adjudication_kind, payload_bytes, payload_hash, created_at) VALUES ('env-positive', 'decision-1', 'adjudicator-alice', 'ALLOW', ?, 'payload-positive', ?)").run(bytes("allow"), now);
  local.prepare("INSERT INTO adjudication_signers (envelope_id, signer_id, signer_id_normalized, authorization_id, signer_role, signer_rank, signature_bytes, signed_at) VALUES ('env-positive', 'alice', 'alice', 'adjudicator-alice', 'REVIEWER', 1, ?, ?)").run(bytes("sig-a"), now);
  local.prepare("INSERT INTO adjudication_signers (envelope_id, signer_id, signer_id_normalized, authorization_id, signer_role, signer_rank, signature_bytes, signed_at) VALUES ('env-positive', 'bob', 'bob', 'adjudicator-bob', 'SECURITY', 2, ?, ?)").run(bytes("sig-b"), now);
  promotion(local, { risk: "R3" });
  check("rank2-security-positive", (local.prepare("SELECT COUNT(*) AS count FROM promotions WHERE promotion_id = 'promotion-1'").get() as { count: number }).count === 1, "distinct authorized REVIEWER and SECURITY signers permit R3 promotion");
  local.close();
}
{
  const local = makeDb({ risk: "R3" });
  insertMetricAndEvaluation(local, { risk: "R3" });
  insertAuthorization(local, { id: "adjudicator-alice", principal: "alice", kind: "ADJUDICATOR", role: "REVIEWER", risk: "R3" });
  insertAuthorization(local, { id: "adjudicator-bob", principal: "bob", kind: "ADJUDICATOR", role: "SECURITY", risk: "R3" });
  local.prepare("INSERT INTO adjudications (envelope_id, decision_id, adjudicator_authorization_id, adjudication_kind, payload_bytes, payload_hash, created_at) VALUES ('env-deny', 'decision-1', 'adjudicator-alice', 'DENY', ?, 'payload-deny', ?)").run(bytes("deny"), now);
  local.prepare("INSERT INTO adjudication_signers (envelope_id, signer_id, signer_id_normalized, authorization_id, signer_role, signer_rank, signature_bytes, signed_at) VALUES ('env-deny', 'alice', 'alice', 'adjudicator-alice', 'REVIEWER', 1, ?, ?)").run(bytes("sig-a"), now);
  local.prepare("INSERT INTO adjudication_signers (envelope_id, signer_id, signer_id_normalized, authorization_id, signer_role, signer_rank, signature_bytes, signed_at) VALUES ('env-deny', 'bob', 'bob', 'adjudicator-bob', 'SECURITY', 2, ?, ?)").run(bytes("sig-b"), now);
  expectFailure("r3-deny-rejected", () => promotion(local, { risk: "R3" }), "ALLOW adjudication required for R3 promotion");
  local.close();
}
{
  const local = makeDb({ risk: "R3" });
  insertMetricAndEvaluation(local, { risk: "R3" });
  insertAuthorization(local, { id: "adjudicator-alice", principal: "alice", kind: "ADJUDICATOR", role: "REVIEWER", risk: "R3" });
  insertAuthorization(local, { id: "adjudicator-bob", principal: "bob", kind: "ADJUDICATOR", role: "SECURITY", risk: "R3" });
  local.prepare("INSERT INTO adjudications (envelope_id, decision_id, adjudicator_authorization_id, adjudication_kind, payload_bytes, payload_hash, created_at) VALUES ('env-resolve', 'decision-1', 'adjudicator-alice', 'RESOLVE', ?, 'payload-resolve', ?)").run(bytes("resolve"), now);
  local.prepare("INSERT INTO adjudication_signers (envelope_id, signer_id, signer_id_normalized, authorization_id, signer_role, signer_rank, signature_bytes, signed_at) VALUES ('env-resolve', 'alice', 'alice', 'adjudicator-alice', 'REVIEWER', 1, ?, ?)").run(bytes("sig-a"), now);
  local.prepare("INSERT INTO adjudication_signers (envelope_id, signer_id, signer_id_normalized, authorization_id, signer_role, signer_rank, signature_bytes, signed_at) VALUES ('env-resolve', 'bob', 'bob', 'adjudicator-bob', 'SECURITY', 2, ?, ?)").run(bytes("sig-b"), now);
  expectFailure("r3-resolve-rejected", () => promotion(local, { risk: "R3" }), "ALLOW adjudication required for R3 promotion");
  local.close();
}
{
  const local = makeDb();
  insertMetricAndEvaluation(local);
  expectFailure("promotion-conclusion-forgery", () => promotion(local, { reason: "forged-conclusion" }));
  local.close();
}
{
  const local = makeDb({ risk: "R3" });
  insertMetricAndEvaluation(local, { risk: "R3" });
  expectFailure("unauthorized-adjudicator", () => local.prepare("INSERT INTO adjudications (envelope_id, decision_id, adjudicator_authorization_id, adjudication_kind, payload_bytes, payload_hash, created_at) VALUES ('env-bad', 'decision-1', 'missing-auth', 'ALLOW', ?, 'payload-bad', ?)").run(bytes("allow"), now));
  local.close();
}

{
  const local = makeDb({ gateVerdict: "WATCH" });
  baseWatch(local, now);
  expectFailure("grant-expired-boundary", () => finalizeWatch(local));
  local.close();
}

{
  const local = makeDb({ gateVerdict: "WATCH" });
  baseWatch(local, now + 100, now - 1);
  expectFailure("grant-revoked", () => finalizeWatch(local));
  local.close();
}
{
  const local = makeDb({ gateVerdict: "WATCH" });
  insertAuthorization(local, {
    id: "revoked-before-grant",
    principal: "operator",
    kind: "APPROVER",
    role: "OPERATOR",
    authorizedFrom: now - 100,
    expiresAt: now + 100,
    revokedAt: now - 1,
  });
  expectFailure("authorization-revoked-before-grant", () => local.prepare(`INSERT INTO exception_grants
    (grant_id, approver_authorization_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key, scope_key, max_uses, created_at, expires_at)
    VALUES ('revoked-grant', 'revoked-before-grant', ?, ?, ?, ?, 'WATCH', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      activeIds.groundTruthKey, activeIds.projectRootIdentity, activeIds.rootBundleSequence, activeIds.trustBundleSequence,
      activeIds.risk, activeIds.checkpointKey, activeIds.profileKey, activeIds.stageKey, "scope-revoked", 1, now, now + 100,
    ), "scoped approver authorization required");
  local.close();
}

{
  const local = makeDb({ gateVerdict: "WATCH" });
  baseWatch(local);
  local.prepare("UPDATE authorizations SET revoked_at = ? WHERE authorization_id = 'approver-1'").run(now + 1);
  expectFailure("authorization-revoked-during-use", () => local.prepare(
    "INSERT INTO exception_uses (use_id, grant_id, attempt_id, slot_key, used_at) VALUES ('use-revoked-during', 'grant-1', 'attempt-1', 'slot-1', ?)",
  ).run(now + 2), "exception authorization unavailable");
  local.close();
}

{
  const local = makeDb({ gateVerdict: "WATCH" });
  baseWatch(local);
  local.prepare("INSERT INTO exception_uses (use_id, grant_id, attempt_id, slot_key, used_at) VALUES ('use-direct', 'grant-1', 'attempt-1', 'slot-1', ?)").run(now);
  const counts = local.prepare("SELECT used_count, (SELECT COUNT(*) FROM exception_uses WHERE grant_id = 'grant-1') AS uses FROM exception_grants WHERE grant_id = 'grant-1'").get() as { used_count: number; uses: number };
  check("direct-exception-use-bypass", counts.used_count === 1 && counts.uses === 1, "direct SQL exception use reconciles the grant count");
  expectFailure("direct-exception-use-overuse", () => local.prepare(
    "INSERT INTO exception_uses (use_id, grant_id, attempt_id, slot_key, used_at) VALUES ('use-over', 'grant-1', 'attempt-1', 'slot-1', ?)",
  ).run(now), "exception grant unavailable");
  local.close();
}

{
  const local = makeDb({ gateVerdict: "WATCH" });
  baseWatch(local);
  expectFailure("exception-use-rollback", () => {
    local.exec("BEGIN IMMEDIATE");
    try {
      local.prepare("INSERT INTO exception_uses (use_id, grant_id, attempt_id, slot_key, used_at) VALUES ('use-rollback', 'grant-1', 'attempt-1', 'slot-1', ?)").run(now);
      const receipt = bytes("rollback-receipt");
      local.prepare("INSERT INTO evidence_objects (evidence_id, content_hash, content_bytes, media_type, captured_at) VALUES ('rollback-evidence', 'rollback-hash', ?, 'application/receipt', ?)").run(receipt, now);
      local.prepare("INSERT INTO evidence_refs (decision_id, evidence_id, ref_kind, ordinal) VALUES ('decision-1', 'rollback-evidence', 'RECEIPT', 0)").run();
      local.prepare("INSERT INTO audit_events (event_id, event_type, aggregate_id, event_bytes, event_hash, occurred_at) VALUES ('rollback-event', 'RECEIPT_COMMITTED', 'rollback-receipt-id', ?, 'rollback-audit-hash', ?)").run(receipt, now);
      local.prepare("INSERT INTO outbox (outbox_id, event_id, topic, payload_bytes) VALUES ('rollback-outbox', 'rollback-event', 'quality-contract.receipt', 'tampered')").run();
      local.prepare("INSERT INTO receipts (receipt_id, attempt_id, slot_key, receipt_bytes, receipt_hash, exception_use_id, evidence_id, event_id, outbox_id, committed_at) VALUES ('rollback-receipt-id', 'attempt-1', 'slot-1', ?, 'rollback-receipt-hash', 'use-rollback', 'rollback-evidence', 'rollback-event', 'rollback-outbox', ?)").run(receipt, now);
      local.exec("COMMIT");
    } catch (error) {
      local.exec("ROLLBACK");
      throw error;
    }
  });
  const counts = local.prepare("SELECT used_count, (SELECT COUNT(*) FROM exception_uses WHERE grant_id = 'grant-1') AS uses FROM exception_grants WHERE grant_id = 'grant-1'").get() as { used_count: number; uses: number };
  check("exception-use-rollback-state", counts.used_count === 0 && counts.uses === 0, "failed receipt rolls back use and reconciled grant count");
  local.close();
}
{
  const local = makeDb();
  const original = bytes("prebinding-evidence");
  const hashes = approvedHashes(original);
  local.prepare("INSERT INTO evidence_objects (evidence_id, content_hash, content_bytes, media_type, captured_at) VALUES ('prebinding-evidence', ?, ?, 'application/octet-stream', ?)").run(hashes.evidenceHash, original, now);
  expectFailure("forged-prebinding-evidence-update", () => local.prepare("UPDATE evidence_objects SET content_hash = ? WHERE evidence_id = 'prebinding-evidence'").run("0".repeat(64)), "evidence hash mismatch");
  local.close();
}

{
  const local = makeDb();
  const original = bytes("prebinding-audit");
  const hashes = approvedHashes(original);
  local.prepare("INSERT INTO audit_events (event_id, event_type, aggregate_id, event_bytes, event_hash, occurred_at) VALUES ('prebinding-audit', 'TEST', 'aggregate-1', ?, ?, ?)").run(original, hashes.auditHash, now);
  expectFailure("forged-prebinding-audit-update", () => local.prepare("UPDATE audit_events SET event_hash = ? WHERE event_id = 'prebinding-audit'").run("0".repeat(64)), "audit hash mismatch");
  local.close();
}
{
  const local = makeDb({ gateVerdict: "WATCH", risk: "R3" });
  expectFailure("r3-watch-grant-rejected", () => baseWatch(local));
  local.close();
}

{
  const local = makeDb({ gateVerdict: "WATCH" });
  baseWatch(local);
  const first = finalizeWatch(local);
  const second = finalizeWatch(local);
  const row = local.prepare("SELECT used_count, receipt_hash FROM exception_grants JOIN receipts ON receipts.exception_use_id IS NOT NULL WHERE grant_id = 'grant-1'").get() as { used_count: number; receipt_hash: string };
  check("watch-exception-transaction", row.used_count === 1, "exactly one transactional grant use");
  check("same-slot-idempotent-receipt", first?.toString() === second?.toString(), "same committed receipt bytes");
  check("canonical-receipt-hash", row.receipt_hash === canonicalReceiptHash(first as Uint8Array), "approved domain-separated length-prefixed canonical signed-envelope receipt hash");
  const tamperedReceipt = bytes(`${new TextDecoder().decode(first as Uint8Array)} `);
  check("canonical-receipt-hash-negative", canonicalReceiptHash(tamperedReceipt) !== row.receipt_hash, "receipt byte or length change invalidates the approved hash");
  check("transactional-evidence-audit-outbox", (local.prepare("SELECT COUNT(*) AS count FROM receipts r JOIN evidence_objects e ON e.evidence_id = r.evidence_id JOIN audit_events a ON a.event_id = r.event_id JOIN outbox o ON o.outbox_id = r.outbox_id WHERE r.receipt_id = 'receipt-slot-1'").get() as { count: number }).count === 1, "receipt binds evidence, audit, and outbox");
  expectFailure("receipt-tamper-evidence-bytes", () => local.prepare("UPDATE evidence_objects SET content_bytes = ? WHERE evidence_id = 'evidence-slot-1'").run(bytes("tampered")), "receipt evidence binding is immutable");
  expectFailure("receipt-tamper-evidence-hash", () => local.prepare("UPDATE evidence_objects SET content_hash = 'tampered-evidence-hash' WHERE evidence_id = 'evidence-slot-1'").run(), "receipt evidence binding is immutable");
  expectFailure("receipt-tamper-audit-bytes", () => local.prepare("UPDATE audit_events SET event_bytes = ? WHERE event_id = 'event-slot-1'").run(bytes("tampered")), "receipt audit binding is immutable");
  expectFailure("receipt-tamper-audit-hash", () => local.prepare("UPDATE audit_events SET event_hash = 'tampered-audit-hash' WHERE event_id = 'event-slot-1'").run(), "receipt audit binding is immutable");
  expectFailure("receipt-tamper-outbox-payload", () => local.prepare("UPDATE outbox SET payload_bytes = ? WHERE outbox_id = 'outbox-slot-1'").run(bytes("tampered")), "receipt outbox binding is immutable");
  expectFailure("receipt-tamper-receipt-bytes", () => local.prepare("UPDATE receipts SET receipt_bytes = ? WHERE receipt_id = 'receipt-slot-1'").run(bytes("tampered")), "committed receipt is immutable");
  expectFailure("receipt-tamper-receipt-hash", () => local.prepare("UPDATE receipts SET receipt_hash = 'tampered-receipt-hash' WHERE receipt_id = 'receipt-slot-1'").run(), "committed receipt is immutable");
  local.close();
}
{
  const local = makeDb({ gateVerdict: "WATCH" });
  baseWatch(local);
  const canonical = signedReceipt("hash-binding", "WATCH");
  const tampered = bytes(`${new TextDecoder().decode(canonical)} `);
  const hashes = approvedHashes(canonical);
  const tamperedHashes = approvedHashes(tampered);
  local.prepare("INSERT INTO exception_uses (use_id, grant_id, attempt_id, slot_key, used_at) VALUES ('use-hash-binding', 'grant-1', 'attempt-1', 'slot-1', ?)").run(now);
  local.prepare("INSERT INTO evidence_objects (evidence_id, content_hash, content_bytes, media_type, captured_at) VALUES ('evidence-hash-binding', ?, ?, 'application/receipt', ?)").run(tamperedHashes.evidenceHash, tampered, now);
  local.prepare("INSERT INTO evidence_refs (decision_id, evidence_id, ref_kind, ordinal) VALUES ('decision-1', 'evidence-hash-binding', 'RECEIPT', 0)").run();
  local.prepare("INSERT INTO audit_events (event_id, event_type, aggregate_id, event_bytes, event_hash, occurred_at) VALUES ('event-hash-binding', 'RECEIPT_COMMITTED', 'receipt-hash-binding', ?, ?, ?)").run(tampered, tamperedHashes.auditHash, now);
  local.prepare("INSERT INTO outbox (outbox_id, event_id, topic, payload_bytes) VALUES ('outbox-hash-binding', 'event-hash-binding', 'quality-contract.receipt', ?)").run(tampered);
  expectFailure("canonical-receipt-byte-hash-binding", () => local.prepare(
    "INSERT INTO receipts (receipt_id, attempt_id, slot_key, receipt_bytes, receipt_hash, exception_use_id, evidence_id, event_id, outbox_id, committed_at) VALUES ('receipt-hash-binding', 'attempt-1', 'slot-1', ?, ?, 'use-hash-binding', 'evidence-hash-binding', 'event-hash-binding', 'outbox-hash-binding', ?)",
  ).run(tampered, hashes.receiptHash, now), "receipt hash mismatch");
  local.close();
}
{
  const local = makeDb({ gateVerdict: "WATCH" });
  baseWatch(local);
  expectFailure("forged-initial-receipt-hash", () => finalizeWatch(local, "forged-receipt", { receiptHash: "forged-receipt-hash" }), "receipt hash mismatch");
  local.close();
}

{
  const local = makeDb({ gateVerdict: "WATCH" });
  baseWatch(local);
  expectFailure("forged-initial-evidence-hash", () => finalizeWatch(local, "forged-evidence", { evidenceHash: "forged-evidence-hash" }), "evidence hash mismatch");
  local.close();
}

{
  const local = makeDb({ gateVerdict: "WATCH" });
  baseWatch(local);
  expectFailure("forged-initial-audit-hash", () => finalizeWatch(local, "forged-audit", { auditHash: "forged-audit-hash" }), "audit hash mismatch");
  local.close();
}

{
  const directory = await mkdtemp(join(tmpdir(), "quality-contract-race-"));
  const filename = join(directory, "race.sqlite");
  const barrier = join(directory, "start.barrier");
  const seed = makeDb(filename, { gateVerdict: "WATCH" });
  baseWatch(seed);
  seed.close();
  const firstPromise = runRaceWorker(filename, barrier, "first");
  const secondPromise = runRaceWorker(filename, barrier, "second");
  await new Promise(resolve => setTimeout(resolve, 50));
  writeFileSync(barrier, "go");
  const results = await Promise.all([firstPromise, secondPromise]);
  const verificationDb = new Database(filename);
  registerDeterministicHashFunctions(verificationDb);
  const count = (verificationDb.prepare("SELECT COUNT(*) AS count FROM receipts WHERE attempt_id = 'attempt-1' AND slot_key = 'slot-1'").get() as { count: number }).count;
  const used = (verificationDb.prepare("SELECT used_count FROM exception_grants WHERE grant_id = 'grant-1'").get() as { used_count: number }).used_count;
  const created = results.filter((result) => result.created).length;
  check("concurrent-duplicate-finalization", created === 1 && count === 1 && used === 1 && results[0]?.receiptHex === results[1]?.receiptHex, "two independently spawned SQLite finalizers race from one barrier and converge on one receipt");
  verificationDb.close();
  await rm(directory, { recursive: true, force: true });
}

{
  const local = makeDb();
  insertMetricAndEvaluation(local);
  promotion(local);
  check("promotion-positive", (local.prepare("SELECT status FROM promotions WHERE promotion_id = 'promotion-1'").get() as { status: string }).status === "PROMOTED", "fresh full-identity promotion committed");
  local.close();
}

{
  const local = makeDb();
  insertMetricAndEvaluation(local);
  local.prepare("INSERT INTO suspicions (suspicion_id, decision_id, suspicion_kind, status, opened_at) VALUES ('suspicion-1', 'decision-1', 'UNRESOLVED', 'OPEN', ?)").run(now);
  expectFailure("suspicion-blocks-promotion", () => promotion(local));
  local.close();
}

const runQuiescenceSqlProofs = async () => {
  const db = makeDb();
  const hash = "a".repeat(64);
  const otherHash = "b".repeat(64);
  const root = "project-demo";
  const objective = "root-demo";
  const seedRecoveryDb = (filename = ":memory:") => {
    const local = makeDb(filename);
    local.prepare(`INSERT INTO qtb_runs
      (project_id, root_objective_id, candidate_generation, mutation_epoch, cancellation_epoch, source_cursor, authoritative_census, gap, updated_at)
      VALUES (?, ?, 0, 0, 0, 'cursor-recovery', 1, 0, ?)`).run(root, objective, now);
    local.prepare(`INSERT INTO qtb_candidates
      (candidate_key, project_id, root_objective_id, candidate_generation, mutation_epoch, physical_root, snapshot_hash, inventory_hash, acceptance_hash, materialized_at)
      VALUES ('candidate-demo', ?, ?, 0, 0, '/recovery', ?, ?, ?, ?)`).run(root, objective, "a".repeat(64), "a".repeat(64), "a".repeat(64), now);
    return local;
  };
  const insertRecoveryLease = (
    local: Database,
    leaseId: string,
    fence: number,
    claimedAt: number,
    expiresAt: number,
    profileId = "g0-evidence-only",
    catalogVersion = "verification-obligations/v1",
  ) => local.prepare(`INSERT INTO qtb_leases
    (lease_id, candidate_key, project_id, root_objective_id, candidate_generation, mutation_epoch, profile_id, fence, claimed_at, expires_at, catalog_version)
    VALUES (?, 'candidate-demo', ?, ?, 0, 0, ?, ?, ?, ?, ?)`).run(leaseId, root, objective, profileId, fence, claimedAt, expiresAt, catalogVersion);
  const captureFailure = (action: () => void) => {
    try {
      action();
      return "";
    } catch (error) {
      return String(error);
    }
  };
  {
    const local = seedRecoveryDb();
    const wrongProfile = captureFailure(() => insertRecoveryLease(local, "wrong-profile", 1, now, now + 100, "missing-profile"));
    const wrongCatalog = captureFailure(() => insertRecoveryLease(local, "wrong-catalog", 1, now, now + 100, "g0-evidence-only", "verification-obligations/v0"));
    check("qtb-catalog-wrong-identity", wrongProfile.includes("lease profile catalog mismatch") && wrongCatalog.length > 0, "wrong profile and catalog version cannot bind a recovery lease");
    local.close();
  }
  {
    const directory = await mkdtemp(join(tmpdir(), "quality-contract-qtb-race-"));
    const filename = join(directory, "race.sqlite");
    const barrier = join(directory, "start.barrier");
    const local = makeDb(filename);
    local.prepare(`INSERT INTO qtb_runs
      (project_id, root_objective_id, candidate_generation, mutation_epoch, cancellation_epoch, source_cursor, authoritative_census, gap, updated_at)
      VALUES ('project-race', 'objective-race', 0, 0, 0, 'cursor-race', 1, 0, ?)`).run(now);
    local.prepare(`INSERT INTO qtb_candidates
      (candidate_key, project_id, root_objective_id, candidate_generation, mutation_epoch, physical_root, snapshot_hash, inventory_hash, acceptance_hash, materialized_at)
      VALUES ('candidate-race', 'project-race', 'objective-race', 0, 0, '/race', ?, ?, ?, ?)`).run("a".repeat(64), "a".repeat(64), "a".repeat(64), now);
    local.close();
    const firstPromise = runQtbClaimWorker(filename, barrier, "race-first");
    const secondPromise = runQtbClaimWorker(filename, barrier, "race-second");
    await new Promise(resolve => setTimeout(resolve, 50));
    writeFileSync(barrier, "go");
    const results = await Promise.all([firstPromise, secondPromise]);
    const verificationDb = new Database(filename);
    const winnerCount = results.filter(result => result.won).length;
    const leaseCount = (verificationDb.prepare("SELECT COUNT(*) AS count FROM qtb_leases WHERE candidate_key = 'candidate-race'").get() as { count: number }).count;
    const losers = results.filter(result => !result.won);
    check("qtb-concurrent-initial-claim", winnerCount === 1 && leaseCount === 1 && losers.length === 1 && losers[0]?.error.includes("lease fence regression"), "two process-like SQLite claimers produce one initial lease winner");
    verificationDb.close();
    await rm(directory, { recursive: true, force: true });
  }
  {
    const local = seedRecoveryDb();
    insertRecoveryLease(local, "lease-initial", 1, now, now + 100);
    const error = captureFailure(() => insertRecoveryLease(local, "lease-before-expiry", 2, now + 99, now + 200));
    check("qtb-takeover-before-expiry", error.includes("lease incumbent still live"), "takeover one tick before expiry is rejected");
    local.close();
  }
  {
    const local = seedRecoveryDb();
    insertRecoveryLease(local, "lease-initial", 1, now, now + 100);
    insertRecoveryLease(local, "lease-at-expiry", 2, now + 100, now + 200);
    const row = local.prepare("SELECT fence, claimed_at FROM qtb_leases WHERE lease_id = 'lease-at-expiry'").get() as { fence: number; claimed_at: number };
    check("qtb-takeover-at-expiry", row.fence === 2 && row.claimed_at === now + 100, "takeover at incumbent expiry is accepted");
    local.close();
  }
  {
    const local = seedRecoveryDb();
    insertRecoveryLease(local, "lease-initial", 1, now, now + 100);
    insertRecoveryLease(local, "lease-after-expiry", 2, now + 101, now + 200);
    const row = local.prepare("SELECT fence, claimed_at FROM qtb_leases WHERE lease_id = 'lease-after-expiry'").get() as { fence: number; claimed_at: number };
    check("qtb-takeover-after-expiry", row.fence === 2 && row.claimed_at === now + 101, "takeover after incumbent expiry is accepted");
    local.close();
  }
  {
    const local = seedRecoveryDb();
    insertRecoveryLease(local, "lease-initial", 1, now, now + 100);
    insertRecoveryLease(local, "lease-recovery-one", 2, now + 100, now + 200);
    insertRecoveryLease(local, "lease-recovery-two", 3, now + 200, now + 300);
    const rows = local.prepare("SELECT lease_id, fence FROM qtb_current_leases WHERE candidate_key = 'candidate-demo'").all() as Array<{ lease_id: string; fence: number }>;
    check("qtb-recovery-winner", rows.length === 1 && rows[0]?.lease_id === "lease-recovery-two" && rows[0]?.fence === 3, "only the highest-fence recovery lease is current");
    const supersededDelete = captureFailure(() => local.prepare("DELETE FROM qtb_leases WHERE lease_id = 'lease-recovery-one'").run());
    check("qtb-superseded-lease-delete-immutable", supersededDelete.includes("lease immutable") && (local.prepare("SELECT COUNT(*) AS count FROM qtb_leases WHERE lease_id = 'lease-recovery-one'").get() as { count: number }).count === 1, "superseded lease deletion is rejected and historical fence remains");
    local.close();
  }
  {
    const local = seedRecoveryDb();
    insertRecoveryLease(local, "lease-initial", 1, now, now + 100);
    const receiptBytes = bytes("receipt-before-takeover");
    local.prepare(`INSERT INTO qtb_receipts
      (receipt_id, candidate_key, lease_id, receipt_bytes, receipt_hash, committed_at)
      VALUES ('receipt-before-takeover', 'candidate-demo', 'lease-initial', ?, ?, ?)`).run(receiptBytes, "a".repeat(64), now + 1);
    local.prepare(`INSERT INTO qtb_terminal_pairs
      (terminal_pair_id, candidate_key, receipt_id, owner_session_id, owner_prompt_generation, owner_terminal_id, pair_bytes, pair_hash, committed_at)
      VALUES ('pair-before-takeover', 'candidate-demo', 'receipt-before-takeover', 'session-recovery', 1, 'terminal-recovery', ?, ?, ?)`).run(bytes("pair-before-takeover"), "a".repeat(64), now + 1);
    insertRecoveryLease(local, "lease-recovery", 2, now + 100, now + 200);
    const staleLeaseMutations: Array<[string, string]> = [
      ["fence", "99"],
      ["expires_at", String(now + 10_000)],
      ["profile_id", "'js-ts-focused'"],
    ];
    for (const [column, value] of staleLeaseMutations) {
      const mutation = captureFailure(() => local.exec(`UPDATE qtb_leases SET ${column} = ${value} WHERE lease_id = 'lease-initial'`));
      check("qtb-stale-lease-mutation", mutation.includes("lease immutable"), `superseded lease ${column} mutation is rejected`);
    }
    const staleReceipt = captureFailure(() => local.prepare(`INSERT INTO qtb_receipts
      (receipt_id, candidate_key, lease_id, receipt_bytes, receipt_hash, committed_at)
      VALUES ('receipt-stale-owner', 'candidate-demo', 'lease-initial', ?, ?, ?)`).run(bytes("stale-owner"), "b".repeat(64), now + 2));
    const staleBridge = captureFailure(() => local.prepare(`INSERT INTO qtb_bridge_transactions
      (transaction_id, candidate_key, lease_id, receipt_id, terminal_pair_id, bridge_committed_at)
      VALUES ('bridge-stale-owner', 'candidate-demo', 'lease-initial', 'receipt-before-takeover', 'pair-before-takeover', ?)`).run(now + 100));
    check("qtb-stale-owner-commit", staleReceipt.includes("receipt fence mismatch") && staleBridge.includes("bridge lease stale or expired"), "stale owner receipt and bridge are denied after recovery takeover");
    local.close();
  }
  {
    const local = seedRecoveryDb();
    insertRecoveryLease(local, "lease-initial", 1, now, now + 1);
    insertRecoveryLease(local, "lease-next", 2, now + 1, now + 101);
    const fenceRegression = captureFailure(() => insertRecoveryLease(local, "lease-fence-regression", 1, now + 2, now + 102));
    const claimRegression = captureFailure(() => insertRecoveryLease(local, "lease-claim-regression", 3, now, now + 100));
    check("qtb-monotonic-fence", fenceRegression.includes("lease fence regression") && claimRegression.includes("lease claimed_at regression"), "fence and claim time regressions are rejected");
    local.close();
  }
  db.prepare(`INSERT INTO qtb_runs
    (project_id, root_objective_id, candidate_generation, mutation_epoch, cancellation_epoch, source_cursor, authoritative_census, gap, updated_at)
    VALUES (?, ?, 0, 0, 0, 'cursor-0', 1, 0, ?)`).run(root, objective, now);
  db.prepare(`INSERT INTO qtb_identity_ledger
    (project_id, root_objective_id, action_sequence, actor_key, task_key, delivery_key, actor_state, task_state, delivery_state, required, source_cursor, observed_at)
    VALUES (?, ?, 1, 'actor-1', 'task-1', 'delivery-1', 'terminal', 'complete', 'acknowledged', 1, 'cursor-0', ?)`).run(root, objective, now);
  check("qtb-schema-positive", (db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'qtb_%'").get() as { count: number }).count >= 12, "quiescence authority tables installed");
  const expectedCatalogs: Record<string, string[]> = {
    "g0-evidence-only": ["qtb.g0.no-mutation-attestation", "qtb.g0.identity-ledger-smoke"],
    "js-ts-focused": ["qtb.js-ts.existing-tests", "qtb.js-ts.independent-smoke", "qtb.js-ts.adversarial", "qtb.snapshot.sealed", "qtb.ledger.integrity"],
    "python-focused": ["qtb.python.existing-tests", "qtb.python.independent-smoke", "qtb.python.adversarial", "qtb.snapshot.sealed", "qtb.ledger.integrity"],
    "rust-incremental": ["qtb.rust-incremental.existing-tests", "qtb.rust-incremental.independent-smoke", "qtb.rust-incremental.adversarial", "qtb.snapshot.sealed", "qtb.ledger.integrity"],
    "rust-cold": ["qtb.rust-cold.existing-tests", "qtb.rust-cold.independent-smoke", "qtb.rust-cold.adversarial", "qtb.snapshot.sealed", "qtb.ledger.integrity"],
    "playwright-focused": ["qtb.playwright.existing-tests", "qtb.playwright.independent-smoke", "qtb.playwright.adversarial", "qtb.snapshot.sealed", "qtb.ledger.integrity"],
  };
  const catalogRows = (database: Database, profileId: string) => (database.prepare(
    "SELECT obligation_id AS obligationId FROM qtb_profile_obligation_catalog WHERE profile_id = ? AND catalog_version = 'verification-obligations/v1' AND mandatory = 1 ORDER BY obligation_id",
  ).all(profileId) as Array<{ obligationId: string }>).map(row => row.obligationId);
  const exactCatalog = (actual: string[], expected: string[]) => actual.length === expected.length && actual.every((id, index) => id === [...expected].sort()[index]);
  check("qtb-profile-catalog", Object.entries(expectedCatalogs).every(([profileId, expected]) => exactCatalog(catalogRows(db, profileId), expected)), "all runner profiles have exact verification-obligations/v1 mandatory catalogs");
  check("qtb-catalog-exact-all-profiles", Object.entries(expectedCatalogs).every(([profileId, expected]) => exactCatalog(catalogRows(db, profileId), expected)), "all immutable profile catalogs match the exact governed sets");
  for (const [profileId, expected] of Object.entries(expectedCatalogs)) {
    const local = makeDb();
    const rows = (local.prepare(
      "SELECT obligation_id AS obligationId FROM qtb_profile_obligation_catalog WHERE profile_id = ? AND catalog_version = 'verification-obligations/v1' AND mandatory = 1 ORDER BY obligation_id",
    ).all(profileId) as Array<{ obligationId: string }>).map(row => row.obligationId);
    const exactBefore = exactCatalog(rows, expected);
    const omitted = captureFailure(() => local.prepare(
      "DELETE FROM qtb_profile_obligation_catalog WHERE profile_id = ? AND obligation_id = ?",
    ).run(profileId, expected[0]));
    check("qtb-catalog-delete-immutable", exactBefore && omitted.includes("profile obligation catalog immutable") && exactCatalog(catalogRows(local, profileId), expected), `${profileId} omission is rejected and catalog remains exact`);
    const replaced = captureFailure(() => local.prepare(
      "UPDATE qtb_profile_obligation_catalog SET obligation_id = 'qtb.replaced' WHERE profile_id = ? AND obligation_id = ?",
    ).run(profileId, expected[0]));
    check("qtb-catalog-update-immutable", replaced.includes("profile obligation catalog immutable") && exactCatalog(catalogRows(local, profileId), expected), `${profileId} replacement is rejected and catalog remains exact`);
    const extra = captureFailure(() => local.prepare(
      "INSERT INTO qtb_profile_obligation_catalog (profile_id, catalog_version, obligation_id, mandatory) VALUES (?, 'verification-obligations/v1', ?, 1)",
    ).run(profileId, "qtb.extra"));
    check("qtb-catalog-insert-immutable", extra.includes("profile obligation catalog immutable") && exactCatalog(catalogRows(local, profileId), expected), `${profileId} extra row is rejected and catalog remains exact`);
    local.close();
  }
  expectFailure("qtb-ledger-duplicate", () => db.prepare(`INSERT INTO qtb_identity_ledger
    (project_id, root_objective_id, action_sequence, actor_key, task_key, delivery_key, actor_state, task_state, delivery_state, required, source_cursor, observed_at)
    VALUES (?, ?, 1, 'actor-1', 'task-1', 'delivery-1', 'terminal', 'complete', 'acknowledged', 1, 'cursor-0', ?)`).run(root, objective, now));
  check("qtb-reordered-events", (db.prepare("SELECT COUNT(*) AS count FROM qtb_identity_ledger WHERE action_sequence = 1").get() as { count: number }).count === 1, "duplicate/reordered event did not overwrite ledger");
  db.prepare(`INSERT INTO qtb_candidates
    (candidate_key, project_id, root_objective_id, candidate_generation, mutation_epoch, physical_root, snapshot_hash, inventory_hash, acceptance_hash, materialized_at)
    VALUES ('candidate-demo', ?, ?, 0, 0, '/repo', ?, ?, ?, ?)`).run(root, objective, hash, hash, hash, now);
  expectFailure("qtb-candidate-immutable", () => db.prepare("UPDATE qtb_candidates SET physical_root = '/forged' WHERE candidate_key = 'candidate-demo'").run(), "candidate immutable");
  db.prepare(`INSERT INTO qtb_leases
    (lease_id, candidate_key, project_id, root_objective_id, candidate_generation, mutation_epoch, profile_id, fence, claimed_at, expires_at)
    VALUES ('lease-demo', 'candidate-demo', ?, ?, 0, 0, 'g0-evidence-only', 1, ?, ?)`).run(root, objective, now, now + 1_000);
  expectFailure("qtb-lease-committed-insert", () => db.prepare(`INSERT INTO qtb_leases
    (lease_id, candidate_key, project_id, root_objective_id, candidate_generation, mutation_epoch, profile_id, fence, claimed_at, expires_at, committed)
    VALUES ('lease-direct-committed', 'candidate-demo', ?, ?, 0, 0, 'g0-evidence-only', 2, ?, ?, 1)`).run(root, objective, now + 1, now + 2_000), "lease must begin uncommitted");
  const leaseIdentityMutations: Array<[string, string]> = [
    ["lease_id", "'lease-forged'"],
    ["candidate_key", "'candidate-forged'"],
    ["project_id", "'project-forged'"],
    ["root_objective_id", "'objective-forged'"],
    ["candidate_generation", "1"],
    ["mutation_epoch", "1"],
    ["profile_id", "'js-ts-focused'"],
    ["catalog_version", "'verification-obligations/v0'"],
    ["fence", "2"],
    ["claimed_at", String(now + 1)],
    ["expires_at", String(now + 2_000)],
  ];
  for (const [column, value] of leaseIdentityMutations) {
    const mutation = captureFailure(() => db.exec(`UPDATE qtb_leases SET ${column} = ${value} WHERE lease_id = 'lease-demo'`));
    check("qtb-lease-identity-mutation", mutation.includes("lease immutable"), `lease ${column} mutation is rejected`);
  }
  const committedRegression = captureFailure(() => db.prepare("UPDATE qtb_leases SET committed = 0 WHERE lease_id = 'lease-demo'").run());
  check("qtb-lease-committed-regression", committedRegression.includes("lease immutable"), "uncommitted lease cannot accept a non-commit update");
  const unauthorizedCommit = captureFailure(() => db.prepare("UPDATE qtb_leases SET committed = 1 WHERE lease_id = 'lease-demo'").run());
  check("qtb-lease-direct-commit", unauthorizedCommit.includes("lease immutable") && (db.prepare("SELECT committed FROM qtb_leases WHERE lease_id = 'lease-demo'").get() as { committed: number }).committed === 0, "direct lease commit without matching bridge is rejected");
  const leaseDelete = captureFailure(() => db.prepare("DELETE FROM qtb_leases WHERE lease_id = 'lease-demo'").run());
  check("qtb-lease-delete-immutable", leaseDelete.includes("lease immutable") && (db.prepare("SELECT COUNT(*) AS count FROM qtb_leases WHERE lease_id = 'lease-demo'").get() as { count: number }).count === 1, "lease deletion is rejected and fence history remains");
  expectFailure("qtb-lease-binding", () => db.prepare(`INSERT INTO qtb_leases
    (lease_id, candidate_key, project_id, root_objective_id, candidate_generation, mutation_epoch, profile_id, fence, claimed_at, expires_at)
    VALUES ('lease-forged', 'candidate-demo', ?, ?, 1, 0, 'g0-evidence-only', 2, ?, ?)`).run(root, objective, now, now + 1_000));
  expectFailure("qtb-one-current-fence", () => db.prepare(`INSERT INTO qtb_leases
    (lease_id, candidate_key, project_id, root_objective_id, candidate_generation, mutation_epoch, profile_id, fence, claimed_at, expires_at)
    VALUES ('lease-race', 'candidate-demo', ?, ?, 0, 0, 'g0-evidence-only', 2, ?, ?)`).run(root, objective, now, now + 1_000));
  expectFailure("qtb-receipt-fence", () => db.prepare(`INSERT INTO qtb_receipts
    (receipt_id, candidate_key, lease_id, receipt_bytes, receipt_hash, committed_at)
    VALUES ('receipt-stale', 'candidate-demo', 'lease-demo', ?, ?, ?)`).run(bytes("stale"), otherHash, now + 1_000));
  for (const [index, evidenceType] of ["acceptance", "obligations", "outcome", "snapshot", "timing"].entries()) {
    db.prepare(`INSERT INTO qtb_evidence
      (evidence_id, candidate_key, evidence_type, object_bytes, object_hash, created_at)
      VALUES (?, 'candidate-demo', ?, ?, ?, ?)`).run(`evidence-${index}`, evidenceType, bytes(`evidence-${index}`), hash, now);
  }
  db.prepare(`INSERT INTO qtb_receipts
    (receipt_id, candidate_key, lease_id, receipt_bytes, receipt_hash, committed_at)
    VALUES ('receipt-demo', 'candidate-demo', 'lease-demo', ?, ?, ?)`).run(bytes("receipt-demo"), hash, now + 1);
  for (const index of [0, 1, 2, 3, 4]) db.prepare("INSERT INTO qtb_receipt_evidence (receipt_id, evidence_id, ordinal) VALUES ('receipt-demo', ?, ?)").run(`evidence-${index}`, index);
  db.prepare(`INSERT INTO qtb_terminal_pairs
    (terminal_pair_id, candidate_key, receipt_id, owner_session_id, owner_prompt_generation, owner_terminal_id, pair_bytes, pair_hash, committed_at)
    VALUES ('pair-demo', 'candidate-demo', 'receipt-demo', 'session-demo', 1, 'terminal-demo', ?, ?, ?)`).run(bytes("pair-demo"), hash, now + 1);
  expectFailure("qtb-receipt-byte-mutation", () => db.prepare("UPDATE qtb_receipts SET receipt_bytes = ? WHERE receipt_id = 'receipt-demo'").run(bytes("tampered")), "receipt immutable");
  expectFailure("qtb-terminal-pair-byte-mutation", () => db.prepare("UPDATE qtb_terminal_pairs SET pair_bytes = ? WHERE terminal_pair_id = 'pair-demo'").run(bytes("tampered")), "terminal pair immutable");
  expectFailure("qtb-zero-obligation", () => db.prepare(`INSERT INTO qtb_bridge_transactions
    (transaction_id, candidate_key, lease_id, receipt_id, terminal_pair_id, bridge_committed_at)
    VALUES ('bridge-zero-obligation', 'candidate-demo', 'lease-demo', 'receipt-demo', 'pair-demo', ?)`).run(now + 1), "mandatory obligations missing");
  db.prepare(`INSERT INTO qtb_obligations
    (obligation_id, candidate_key, mandatory, status, evidence_id, updated_at)
    VALUES ('qtb.g0.no-mutation-attestation', 'candidate-demo', 1, 'passed', 'evidence-0', ?)`).run(now + 1);
  db.prepare(`INSERT INTO qtb_obligations
    (obligation_id, candidate_key, mandatory, status, evidence_id, updated_at)
    VALUES ('qtb.g0.identity-ledger-smoke', 'candidate-demo', 1, 'passed', 'evidence-1', ?)`).run(now + 1);
  db.prepare("DELETE FROM qtb_receipt_evidence WHERE receipt_id = 'receipt-demo' AND evidence_id = 'evidence-1'").run();
  expectFailure("qtb-missing-evidence", () => db.prepare(`INSERT INTO qtb_bridge_transactions
    (transaction_id, candidate_key, lease_id, receipt_id, terminal_pair_id, bridge_committed_at)
    VALUES ('bridge-missing-evidence', 'candidate-demo', 'lease-demo', 'receipt-demo', 'pair-demo', ?)`).run(now + 1), "mandatory evidence mismatch");
  db.prepare("INSERT INTO qtb_receipt_evidence (receipt_id, evidence_id, ordinal) VALUES ('receipt-demo', 'evidence-1', 1)").run();
  db.prepare("UPDATE qtb_obligations SET obligation_id = 'qtb.g0.wrong-id' WHERE candidate_key = 'candidate-demo' AND obligation_id = 'qtb.g0.identity-ledger-smoke'").run();
  expectFailure("qtb-wrong-obligation-id", () => db.prepare(`INSERT INTO qtb_bridge_transactions
    (transaction_id, candidate_key, lease_id, receipt_id, terminal_pair_id, bridge_committed_at)
    VALUES ('bridge-wrong-id', 'candidate-demo', 'lease-demo', 'receipt-demo', 'pair-demo', ?)`).run(now + 1), "mandatory catalog mismatch");
  db.prepare("UPDATE qtb_obligations SET obligation_id = 'qtb.g0.identity-ledger-smoke' WHERE candidate_key = 'candidate-demo' AND obligation_id = 'qtb.g0.wrong-id'").run();
  db.prepare("DELETE FROM qtb_obligations WHERE candidate_key = 'candidate-demo' AND obligation_id = 'qtb.g0.identity-ledger-smoke'").run();
  expectFailure("qtb-omitted-obligation-id", () => db.prepare(`INSERT INTO qtb_bridge_transactions
    (transaction_id, candidate_key, lease_id, receipt_id, terminal_pair_id, bridge_committed_at)
    VALUES ('bridge-omitted-id', 'candidate-demo', 'lease-demo', 'receipt-demo', 'pair-demo', ?)`).run(now + 1), "mandatory catalog mismatch");
  db.prepare(`INSERT INTO qtb_obligations
    (obligation_id, candidate_key, mandatory, status, evidence_id, updated_at)
    VALUES ('qtb.g0.identity-ledger-smoke', 'candidate-demo', 1, 'passed', 'evidence-1', ?)`).run(now + 1);
  db.prepare(`INSERT INTO qtb_obligations
    (obligation_id, candidate_key, mandatory, status, evidence_id, updated_at)
    VALUES ('qtb.g0.extra-obligation', 'candidate-demo', 1, 'passed', 'evidence-2', ?)`).run(now + 1);
  expectFailure("qtb-extra-obligation-id", () => db.prepare(`INSERT INTO qtb_bridge_transactions
    (transaction_id, candidate_key, lease_id, receipt_id, terminal_pair_id, bridge_committed_at)
    VALUES ('bridge-extra-id', 'candidate-demo', 'lease-demo', 'receipt-demo', 'pair-demo', ?)`).run(now + 1), "mandatory catalog mismatch");
  db.prepare("DELETE FROM qtb_obligations WHERE candidate_key = 'candidate-demo' AND obligation_id = 'qtb.g0.extra-obligation'").run();
  db.prepare("UPDATE qtb_obligations SET evidence_id = 'evidence-0' WHERE candidate_key = 'candidate-demo' AND obligation_id = 'qtb.g0.identity-ledger-smoke'").run();
  expectFailure("qtb-duplicate-evidence", () => db.prepare(`INSERT INTO qtb_bridge_transactions
    (transaction_id, candidate_key, lease_id, receipt_id, terminal_pair_id, bridge_committed_at)
    VALUES ('bridge-duplicate-evidence', 'candidate-demo', 'lease-demo', 'receipt-demo', 'pair-demo', ?)`).run(now + 1), "not one-to-one");
  db.prepare("UPDATE qtb_obligations SET evidence_id = 'evidence-1' WHERE candidate_key = 'candidate-demo' AND obligation_id = 'qtb.g0.identity-ledger-smoke'").run();
  check("qtb-bridge-failures-atomic", (db.prepare("SELECT committed FROM qtb_leases WHERE lease_id = 'lease-demo'").get() as { committed: number }).committed === 0, "failed bridge attempts leave lease uncommitted");
  expectFailure("qtb-backdated-bridge", () => db.prepare(`INSERT INTO qtb_bridge_transactions
    (transaction_id, candidate_key, lease_id, receipt_id, terminal_pair_id, bridge_committed_at)
    VALUES ('bridge-backdated', 'candidate-demo', 'lease-demo', 'receipt-demo', 'pair-demo', ?)`).run(now), "timestamp backdated");
  expectFailure("qtb-expired-bridge", () => db.prepare(`INSERT INTO qtb_bridge_transactions
    (transaction_id, candidate_key, lease_id, receipt_id, terminal_pair_id, bridge_committed_at)
    VALUES ('bridge-expired', 'candidate-demo', 'lease-demo', 'receipt-demo', 'pair-demo', ?)`).run(now + 1_000), "lease stale or expired");
  db.prepare("UPDATE qtb_runs SET candidate_generation = 1 WHERE project_id = ? AND root_objective_id = ?").run(root, objective);
  expectFailure("qtb-stale-fence-bridge", () => db.prepare(`INSERT INTO qtb_bridge_transactions
    (transaction_id, candidate_key, lease_id, receipt_id, terminal_pair_id, bridge_committed_at)
    VALUES ('bridge-stale-fence', 'candidate-demo', 'lease-demo', 'receipt-demo', 'pair-demo', ?)`).run(now + 1), "lease stale or expired");
  db.prepare("UPDATE qtb_runs SET candidate_generation = 0 WHERE project_id = ? AND root_objective_id = ?").run(root, objective);
  db.prepare(`INSERT INTO qtb_bridge_transactions
    (transaction_id, candidate_key, lease_id, receipt_id, terminal_pair_id, bridge_committed_at)
    VALUES ('bridge-demo', 'candidate-demo', 'lease-demo', 'receipt-demo', 'pair-demo', ?)`).run(now + 1);
  check("qtb-bridge-transaction", (db.prepare("SELECT COUNT(*) AS count FROM qtb_bridge_transactions b JOIN qtb_receipts r ON r.receipt_id = b.receipt_id JOIN qtb_terminal_pairs p ON p.terminal_pair_id = b.terminal_pair_id JOIN qtb_receipt_evidence e ON e.receipt_id = r.receipt_id").get() as { count: number }).count === 5, "five evidence rows bind through receipt to terminal pair");
  check("qtb-lease-committed", (db.prepare("SELECT committed FROM qtb_leases WHERE lease_id = 'lease-demo' AND candidate_key = 'candidate-demo'").get() as { committed: number }).committed === 1, "successful exact bridge atomically commits matching lease");
  const committedLeaseRegression = captureFailure(() => db.prepare("UPDATE qtb_leases SET committed = 0 WHERE lease_id = 'lease-demo'").run());
  check("qtb-lease-committed-regression", committedLeaseRegression.includes("lease immutable"), "committed lease cannot regress to uncommitted");
  expectFailure("qtb-pair-receipt", () => db.prepare(`INSERT INTO qtb_terminal_pairs
    (terminal_pair_id, candidate_key, receipt_id, owner_session_id, owner_prompt_generation, owner_terminal_id, pair_bytes, pair_hash, committed_at)
    VALUES ('pair-forged', 'candidate-demo', 'receipt-missing', 'session-demo', 1, 'terminal-demo', ?, ?, ?)`).run(bytes("pair"), otherHash, now + 1));
  expectFailure("qtb-bridge-mismatch", () => db.prepare(`INSERT INTO qtb_bridge_transactions
    (transaction_id, candidate_key, lease_id, receipt_id, terminal_pair_id, bridge_committed_at)
    VALUES ('bridge-forged', 'candidate-demo', 'lease-demo', 'receipt-demo', 'pair-missing', ?)`).run(now + 1));
  db.prepare("INSERT INTO qtb_idempotency (candidate_key, object_type, object_id, object_hash, object_bytes) VALUES ('candidate-demo', 'Receipt', 'receipt-demo', ?, ?)").run(hash, bytes("receipt-demo"));
  db.prepare("INSERT OR IGNORE INTO qtb_idempotency (candidate_key, object_type, object_id, object_hash, object_bytes) VALUES ('candidate-demo', 'Receipt', 'receipt-demo', ?, ?)").run(hash, bytes("receipt-demo"));
  check("qtb-idempotent-replay", (db.prepare("SELECT COUNT(*) AS count FROM qtb_idempotency WHERE candidate_key = 'candidate-demo' AND object_id = 'receipt-demo'").get() as { count: number }).count === 1, "identical replay preserves one immutable object");
  expectFailure("qtb-idempotent-mutation", () => db.prepare("UPDATE qtb_idempotency SET object_bytes = ? WHERE candidate_key = 'candidate-demo' AND object_id = 'receipt-demo'").run(bytes("mutated")), "idempotency record immutable");
  db.exec("BEGIN");
  db.prepare("INSERT INTO qtb_idempotency (candidate_key, object_type, object_id, object_hash, object_bytes) VALUES ('candidate-demo', 'TerminalPair', 'pair-crash', ?, ?)").run(otherHash, bytes("crash"));
  db.exec("ROLLBACK");
  check("qtb-crash-before-bridge", (db.prepare("SELECT COUNT(*) AS count FROM qtb_idempotency WHERE object_id = 'pair-crash'").get() as { count: number }).count === 0, "rolled back bridge preparation leaves no partial object");
  db.close();
};
await runQuiescenceSqlProofs();
const report = {
  format: "quality-contract.sqlite-report.v1",
  authoritySqlSha256: sha256(new TextEncoder().encode(authoritySql)),
  promotionSqlSha256: sha256(new TextEncoder().encode(promotionSql)),
  quiescenceSqlSha256: sha256(new TextEncoder().encode(quiescenceSql)),
  fixturesSha256: sha256(fixtureBytes),
  quiescenceFixturesSha256: sha256(quiescenceFixtureBytes),
  fixtureVersion: fixtures.version,
  quiescenceFixtureVersion: quiescenceFixtures.version,
  windowSeconds: fixtures.windowSeconds,
  assertions,
  passed: assertions.filter((entry) => entry.passed).length,
  failed: assertions.filter((entry) => !entry.passed).length,
};
writeFileSync(new URL("generated/sqlite-report.json", root), JSON.stringify(report, null, 2) + "\n");
if (report.failed !== 0) throw new Error(`${report.failed} SQLite contract assertions failed`);
console.log(JSON.stringify(report));
