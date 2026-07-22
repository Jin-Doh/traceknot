import { existsSync } from "node:fs";
import { DatabaseSync as Database } from "node:sqlite";
import { createHash } from "node:crypto";

const [filename, barrier, workerId] = process.argv.slice(2);
if (!filename || !barrier || !workerId) throw new Error("usage: sqlite-race-worker <db> <barrier> <worker-id>");

const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const canonicalAuditHash = (event: Uint8Array) => {
	const domain = bytes("quality-contract.audit.v1\0");
	const canonical = new Uint8Array(domain.length + event.length);
	canonical.set(domain, 0);
	canonical.set(event, domain.length);
	return sha256(canonical);
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
		register.call(db, "gjc_receipt_hash", { deterministic: true }, (value) => {
			const domain = bytes("GJC-QUALITY-RECEIPT-HASH\0v1\0");
			const length = new Uint8Array(8);
			new DataView(length.buffer).setBigUint64(0, BigInt(value.byteLength), false);
			const canonical = new Uint8Array(domain.length + length.length + value.length);
			canonical.set(domain, 0);
			canonical.set(length, domain.length);
			canonical.set(value, domain.length + length.length);
			return sha256(canonical);
		});
		register.call(db, "gjc_evidence_hash", { deterministic: true }, sha256);
		register.call(db, "gjc_audit_hash", { deterministic: true }, canonicalAuditHash);
	} catch (error) {
		throw new Error(`SQLite deterministic hash UDF registration failed: ${String(error)}`);
	}
};

const started = Date.now();
while (!existsSync(barrier)) {
	if (Date.now() - started > 5_000) throw new Error("race barrier timeout");
	await new Promise(resolve => setTimeout(resolve, 5));
}

const db = new Database(filename);
registerDeterministicHashFunctions(db);
db.exec("PRAGMA busy_timeout = 5000");
db.exec("BEGIN IMMEDIATE");
try {
	const existing = db.prepare("SELECT receipt_bytes FROM receipts WHERE attempt_id = 'attempt-1' AND slot_key = 'slot-1'").get() as { receipt_bytes: Uint8Array } | null;
	if (existing) {
		db.exec("COMMIT");
		console.log(JSON.stringify({ workerId, created: false, receiptHex: Buffer.from(existing.receipt_bytes).toString("hex") }));
		db.close();
		process.exit(0);
	}
	const grant = db.prepare("SELECT grant_id FROM exception_grants WHERE grant_id = 'grant-1' AND revoked_at IS NULL AND expires_at > 1000000 AND used_count < max_uses").get() as { grant_id: string } | null;
	if (!grant) throw new Error("WATCH grant unavailable");
	const receipt = bytes("{\"attemptId\":\"attempt-1\",\"slotKey\":\"slot-1\",\"verdict\":\"WATCH\"}");
	const domain = bytes("GJC-QUALITY-RECEIPT-HASH\0v1\0");
	const length = new Uint8Array(8);
	new DataView(length.buffer).setBigUint64(0, BigInt(receipt.byteLength), false);
	const canonical = new Uint8Array(domain.length + length.length + receipt.length);
	canonical.set(domain, 0);
	canonical.set(length, domain.length);
	canonical.set(receipt, domain.length + length.length);
	const audit = canonicalAuditHash(receipt);
	db.prepare("INSERT INTO exception_uses (use_id, grant_id, attempt_id, slot_key, used_at) VALUES ('use-slot-1', 'grant-1', 'attempt-1', 'slot-1', 1000000)").run();
	db.prepare("INSERT INTO evidence_objects (evidence_id, content_hash, content_bytes, media_type, captured_at) VALUES ('evidence-slot-1', ?, ?, 'application/receipt', 1000000)").run(sha256(receipt), receipt);
	db.prepare("INSERT INTO evidence_refs (decision_id, evidence_id, ref_kind, ordinal) VALUES ('decision-1', 'evidence-slot-1', 'RECEIPT', 0)").run();
	db.prepare("INSERT INTO audit_events (event_id, event_type, aggregate_id, event_bytes, event_hash, occurred_at) VALUES ('event-slot-1', 'RECEIPT_COMMITTED', 'receipt-slot-1', ?, ?, 1000000)").run(receipt, audit);
	db.prepare("INSERT INTO outbox (outbox_id, event_id, topic, payload_bytes) VALUES ('outbox-slot-1', 'event-slot-1', 'quality-contract.receipt', ?)").run(receipt);
	db.prepare("INSERT INTO receipts (receipt_id, attempt_id, slot_key, receipt_bytes, receipt_hash, exception_use_id, evidence_id, event_id, outbox_id, committed_at) VALUES ('receipt-slot-1', 'attempt-1', 'slot-1', ?, ?, 'use-slot-1', 'evidence-slot-1', 'event-slot-1', 'outbox-slot-1', 1000000)").run(receipt, sha256(canonical));
	await new Promise(resolve => setTimeout(resolve, 150));
	db.exec("COMMIT");
	console.log(JSON.stringify({ workerId, created: true, receiptHex: Buffer.from(receipt).toString("hex") }));
} catch (error) {
	db.exec("ROLLBACK");
	throw error;
} finally {
	db.close();
}
