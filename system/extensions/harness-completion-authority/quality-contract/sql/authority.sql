PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

BEGIN;

CREATE TABLE commit_sequences (
  ground_truth_key TEXT NOT NULL,
  project_root_identity TEXT NOT NULL,
  root_bundle_sequence INTEGER NOT NULL CHECK (root_bundle_sequence > 0),
  trust_bundle_sequence INTEGER NOT NULL CHECK (trust_bundle_sequence > 0),
  checkpoint_key TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
  PRIMARY KEY (ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence),
  UNIQUE (ground_truth_key, project_root_identity, root_bundle_sequence),
  UNIQUE (ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, checkpoint_key, profile_key, stage_key)
) STRICT;

CREATE TABLE attempts (
  attempt_id TEXT PRIMARY KEY,
  ground_truth_key TEXT NOT NULL,
  project_root_identity TEXT NOT NULL,
  root_bundle_sequence INTEGER NOT NULL CHECK (root_bundle_sequence > 0),
  trust_bundle_sequence INTEGER NOT NULL CHECK (trust_bundle_sequence > 0),
  gate_verdict TEXT NOT NULL CHECK (gate_verdict IN ('CLEAR','WATCH','BLOCK')),
  risk TEXT NOT NULL CHECK (risk IN ('R0','R1','R2','R3')),
  checkpoint_key TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  finished_at INTEGER CHECK (finished_at IS NULL OR finished_at >= started_at),
  UNIQUE (attempt_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk),
  UNIQUE (ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key, slot_key),
  FOREIGN KEY (ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence)
    REFERENCES commit_sequences(ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence)
) STRICT;

CREATE TABLE gate_decisions (
  decision_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  ground_truth_key TEXT NOT NULL,
  project_root_identity TEXT NOT NULL,
  root_bundle_sequence INTEGER NOT NULL CHECK (root_bundle_sequence > 0),
  trust_bundle_sequence INTEGER NOT NULL CHECK (trust_bundle_sequence > 0),
  gate_verdict TEXT NOT NULL CHECK (gate_verdict IN ('CLEAR','WATCH','BLOCK')),
  risk TEXT NOT NULL CHECK (risk IN ('R0','R1','R2','R3')),
  checkpoint_key TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  decided_at INTEGER NOT NULL CHECK (decided_at >= 0),
  decision_bytes BLOB NOT NULL CHECK (length(decision_bytes) > 0),
  UNIQUE (ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk),
  UNIQUE (decision_id, attempt_id),
  UNIQUE (decision_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key),
  FOREIGN KEY (attempt_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk)
    REFERENCES attempts(attempt_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk),
  FOREIGN KEY (ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, checkpoint_key, profile_key, stage_key)
    REFERENCES commit_sequences(ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, checkpoint_key, profile_key, stage_key)
) STRICT;

CREATE TABLE authorizations (
  authorization_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL CHECK (principal_id = lower(trim(principal_id))),
  authorization_kind TEXT NOT NULL CHECK (authorization_kind IN ('APPROVER','ADJUDICATOR')),
  authorization_role TEXT NOT NULL CHECK (authorization_role IN ('OPERATOR','REVIEWER','SECURITY','AUDITOR')),
  decision_id TEXT NOT NULL,
  ground_truth_key TEXT NOT NULL,
  project_root_identity TEXT NOT NULL,
  root_bundle_sequence INTEGER NOT NULL CHECK (root_bundle_sequence > 0),
  trust_bundle_sequence INTEGER NOT NULL CHECK (trust_bundle_sequence > 0),
  gate_verdict TEXT NOT NULL CHECK (gate_verdict IN ('CLEAR','WATCH','BLOCK')),
  risk TEXT NOT NULL CHECK (risk IN ('R0','R1','R2','R3')),
  checkpoint_key TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  authorized_from INTEGER NOT NULL CHECK (authorized_from >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > authorized_from),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR (revoked_at >= authorized_from AND revoked_at <= expires_at)),
  UNIQUE (principal_id, authorization_kind, decision_id, scope_key),
  UNIQUE (authorization_id, principal_id, authorization_kind, authorization_role, decision_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key, scope_key),
  FOREIGN KEY (decision_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key)
    REFERENCES gate_decisions(decision_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key)
) STRICT;

CREATE TABLE evidence_objects (
  evidence_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  content_bytes BLOB NOT NULL CHECK (length(content_bytes) > 0),
  media_type TEXT NOT NULL,
  captured_at INTEGER NOT NULL CHECK (captured_at >= 0)
) STRICT;

CREATE TABLE evidence_refs (
  decision_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('INPUT','OUTPUT','AUDIT','RECEIPT')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (decision_id, evidence_id, ref_kind),
  UNIQUE (decision_id, ref_kind, ordinal),
  FOREIGN KEY (decision_id) REFERENCES gate_decisions(decision_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id) REFERENCES evidence_objects(evidence_id)
) STRICT;

CREATE TABLE exception_grants (
  grant_id TEXT PRIMARY KEY,
  approver_authorization_id TEXT NOT NULL,
  ground_truth_key TEXT NOT NULL,
  project_root_identity TEXT NOT NULL,
  root_bundle_sequence INTEGER NOT NULL CHECK (root_bundle_sequence > 0),
  trust_bundle_sequence INTEGER NOT NULL CHECK (trust_bundle_sequence > 0),
  gate_verdict TEXT NOT NULL CHECK (gate_verdict = 'WATCH'),
  risk TEXT NOT NULL CHECK (risk IN ('R0','R1','R2')),
  checkpoint_key TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses > 0 AND max_uses <= 1000000),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
  created_at INTEGER NOT NULL CHECK (created_at >= 0 AND created_at < expires_at),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR (revoked_at >= created_at AND revoked_at <= expires_at)),
  UNIQUE (ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, checkpoint_key, profile_key, stage_key, scope_key),
  FOREIGN KEY (approver_authorization_id) REFERENCES authorizations(authorization_id),
  FOREIGN KEY (ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk)
    REFERENCES gate_decisions(ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk)
) STRICT;

CREATE TABLE exception_uses (
  use_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  used_at INTEGER NOT NULL CHECK (used_at >= 0),
  UNIQUE (grant_id, attempt_id, slot_key),
  FOREIGN KEY (grant_id) REFERENCES exception_grants(grant_id),
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id)
) STRICT;
CREATE TABLE receipts (
  receipt_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  receipt_bytes BLOB NOT NULL CHECK (length(receipt_bytes) > 0),
  receipt_hash TEXT NOT NULL CHECK (length(receipt_hash) > 0),
  exception_use_id TEXT,
  evidence_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
  UNIQUE (attempt_id, slot_key),
  UNIQUE (receipt_hash),
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id),
  FOREIGN KEY (exception_use_id) REFERENCES exception_uses(use_id),
  FOREIGN KEY (evidence_id) REFERENCES evidence_objects(evidence_id),
  FOREIGN KEY (event_id) REFERENCES audit_events(event_id),
  FOREIGN KEY (outbox_id) REFERENCES outbox(outbox_id)
) STRICT;


CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_bytes BLOB NOT NULL CHECK (length(event_bytes) > 0),
  event_hash TEXT NOT NULL UNIQUE,
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
) STRICT;
CREATE TRIGGER authorization_scope_guard
BEFORE INSERT ON authorizations
BEGIN
  SELECT CASE WHEN NEW.revoked_at IS NOT NULL AND NEW.revoked_at < NEW.authorized_from THEN RAISE(ABORT, 'authorization revoked before start') END;
END;

CREATE TABLE outbox (
  outbox_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  payload_bytes BLOB NOT NULL CHECK (length(payload_bytes) > 0),
  published_at INTEGER CHECK (published_at IS NULL OR published_at >= 0),
  FOREIGN KEY (event_id) REFERENCES audit_events(event_id)
) STRICT;

CREATE TABLE receipt_bindings (
  receipt_id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  receipt_bytes BLOB NOT NULL CHECK (length(receipt_bytes) > 0),
  receipt_hash TEXT NOT NULL CHECK (length(receipt_hash) > 0),
  evidence_bytes BLOB NOT NULL CHECK (length(evidence_bytes) > 0),
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) > 0),
  audit_bytes BLOB NOT NULL CHECK (length(audit_bytes) > 0),
  audit_hash TEXT NOT NULL CHECK (length(audit_hash) > 0),
  outbox_bytes BLOB NOT NULL CHECK (length(outbox_bytes) > 0),
  FOREIGN KEY (receipt_id) REFERENCES receipts(receipt_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE adjudications (
  envelope_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  adjudicator_authorization_id TEXT NOT NULL,
  adjudication_kind TEXT NOT NULL CHECK (adjudication_kind IN ('ALLOW','DENY','RESOLVE')),
  payload_bytes BLOB NOT NULL CHECK (length(payload_bytes) > 0),
  payload_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (decision_id) REFERENCES gate_decisions(decision_id),
  FOREIGN KEY (adjudicator_authorization_id) REFERENCES authorizations(authorization_id)
) STRICT;

CREATE TABLE adjudication_signers (
  envelope_id TEXT NOT NULL,
  signer_id TEXT NOT NULL,
  signer_id_normalized TEXT NOT NULL CHECK (signer_id_normalized = lower(trim(signer_id))),
  authorization_id TEXT NOT NULL,
  signer_role TEXT NOT NULL CHECK (signer_role IN ('OPERATOR','REVIEWER','SECURITY','AUDITOR')),
  signer_rank INTEGER NOT NULL CHECK (signer_rank IN (1,2)),
  signature_bytes BLOB NOT NULL CHECK (length(signature_bytes) > 0),
  signed_at INTEGER NOT NULL CHECK (signed_at >= 0),
  PRIMARY KEY (envelope_id, signer_id_normalized),
  UNIQUE (envelope_id, signer_rank),
  FOREIGN KEY (envelope_id) REFERENCES adjudications(envelope_id) ON DELETE CASCADE,
  FOREIGN KEY (authorization_id) REFERENCES authorizations(authorization_id)
) STRICT;

CREATE TABLE suspicions (
  suspicion_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  suspicion_kind TEXT NOT NULL CHECK (suspicion_kind IN ('MISSING','LATE','CONFLICT','FALSE_ACCEPT','UNRESOLVED')),
  status TEXT NOT NULL CHECK (status IN ('OPEN','RESOLVED_ALLOW','RESOLVED_DENY')),
  opened_at INTEGER NOT NULL CHECK (opened_at >= 0),
  resolved_at INTEGER CHECK (resolved_at IS NULL OR resolved_at >= opened_at),
  CHECK ((status = 'OPEN' AND resolved_at IS NULL) OR (status <> 'OPEN' AND resolved_at IS NOT NULL)),
  UNIQUE (decision_id, suspicion_kind),
  FOREIGN KEY (decision_id) REFERENCES gate_decisions(decision_id) ON DELETE CASCADE
) STRICT;


CREATE TRIGGER grant_authorization_guard
BEFORE INSERT ON exception_grants
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM authorizations a
    WHERE a.authorization_id = NEW.approver_authorization_id
      AND a.authorization_kind = 'APPROVER'
      AND a.decision_id = (SELECT decision_id FROM gate_decisions WHERE ground_truth_key = NEW.ground_truth_key AND project_root_identity = NEW.project_root_identity AND root_bundle_sequence = NEW.root_bundle_sequence AND trust_bundle_sequence = NEW.trust_bundle_sequence AND gate_verdict = NEW.gate_verdict AND risk = NEW.risk)
      AND a.ground_truth_key = NEW.ground_truth_key
      AND a.project_root_identity = NEW.project_root_identity
      AND a.root_bundle_sequence = NEW.root_bundle_sequence
      AND a.trust_bundle_sequence = NEW.trust_bundle_sequence
      AND a.checkpoint_key = NEW.checkpoint_key
      AND a.profile_key = NEW.profile_key
      AND a.stage_key = NEW.stage_key
      AND a.scope_key = NEW.scope_key
      AND a.authorized_from <= NEW.created_at
      AND a.expires_at > NEW.created_at
      AND (a.revoked_at IS NULL OR a.revoked_at > NEW.created_at)
  ) THEN RAISE(ABORT, 'scoped approver authorization required') END;
END;

CREATE TRIGGER exception_use_guard
BEFORE INSERT ON exception_uses
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM exception_grants g
    JOIN attempts a
      ON a.attempt_id = NEW.attempt_id
     AND a.ground_truth_key = g.ground_truth_key
     AND a.project_root_identity = g.project_root_identity
     AND a.root_bundle_sequence = g.root_bundle_sequence
     AND a.trust_bundle_sequence = g.trust_bundle_sequence
     AND a.gate_verdict = g.gate_verdict
     AND a.risk = g.risk
     AND a.checkpoint_key = g.checkpoint_key
     AND a.profile_key = g.profile_key
     AND a.stage_key = g.stage_key
     AND a.slot_key = NEW.slot_key
    WHERE g.grant_id = NEW.grant_id
      AND g.created_at <= NEW.used_at
      AND g.expires_at > NEW.used_at
      AND (g.revoked_at IS NULL OR g.revoked_at > NEW.used_at)
      AND NOT EXISTS (
        SELECT 1 FROM authorizations auth
        WHERE auth.authorization_id = g.approver_authorization_id
          AND auth.authorization_kind = 'APPROVER'
          AND auth.authorized_from <= NEW.used_at
          AND auth.expires_at > NEW.used_at
          AND (auth.revoked_at IS NULL OR auth.revoked_at > NEW.used_at)
      )
  ) THEN RAISE(ABORT, 'exception authorization unavailable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM exception_grants g
    JOIN attempts a
      ON a.attempt_id = NEW.attempt_id
     AND a.ground_truth_key = g.ground_truth_key
     AND a.project_root_identity = g.project_root_identity
     AND a.root_bundle_sequence = g.root_bundle_sequence
     AND a.trust_bundle_sequence = g.trust_bundle_sequence
     AND a.gate_verdict = g.gate_verdict
     AND a.risk = g.risk
     AND a.checkpoint_key = g.checkpoint_key
     AND a.profile_key = g.profile_key
     AND a.stage_key = g.stage_key
     AND a.slot_key = NEW.slot_key
    JOIN authorizations auth ON auth.authorization_id = g.approver_authorization_id
    WHERE g.grant_id = NEW.grant_id
      AND g.created_at <= NEW.used_at
      AND g.expires_at > NEW.used_at
      AND (g.revoked_at IS NULL OR g.revoked_at > NEW.used_at)
      AND auth.authorization_kind = 'APPROVER'
      AND auth.authorized_from <= NEW.used_at
      AND auth.expires_at > NEW.used_at
      AND (auth.revoked_at IS NULL OR auth.revoked_at > NEW.used_at)
      AND (SELECT COUNT(*) FROM exception_uses used WHERE used.grant_id = g.grant_id) < g.max_uses
  ) THEN RAISE(ABORT, 'exception grant unavailable') END;
END;
CREATE TRIGGER exception_use_reconcile_before
BEFORE INSERT ON exception_uses
BEGIN
  UPDATE exception_grants
  SET used_count = (SELECT COUNT(*) FROM exception_uses WHERE grant_id = NEW.grant_id)
  WHERE grant_id = NEW.grant_id;
END;

CREATE TRIGGER exception_use_reconcile
AFTER INSERT ON exception_uses
BEGIN
  UPDATE exception_grants
  SET used_count = (SELECT COUNT(*) FROM exception_uses WHERE grant_id = NEW.grant_id)
  WHERE grant_id = NEW.grant_id;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM exception_grants
    WHERE grant_id = NEW.grant_id AND used_count > max_uses
  ) THEN RAISE(ABORT, 'exception grant overuse') END;
END;

CREATE TRIGGER adjudication_authorization_guard
BEFORE INSERT ON adjudications
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM authorizations a JOIN gate_decisions d ON d.decision_id = NEW.decision_id
    WHERE a.authorization_id = NEW.adjudicator_authorization_id
      AND a.authorization_kind = 'ADJUDICATOR'
      AND a.decision_id = d.decision_id
      AND a.ground_truth_key = d.ground_truth_key
      AND a.project_root_identity = d.project_root_identity
      AND a.root_bundle_sequence = d.root_bundle_sequence
      AND a.trust_bundle_sequence = d.trust_bundle_sequence
      AND a.gate_verdict = d.gate_verdict
      AND a.risk = d.risk
      AND a.checkpoint_key = d.checkpoint_key
      AND a.profile_key = d.profile_key
      AND a.stage_key = d.stage_key
      AND a.authorized_from <= NEW.created_at
      AND (a.revoked_at IS NULL OR a.revoked_at > NEW.created_at)
      AND a.expires_at > NEW.created_at
  ) THEN RAISE(ABORT, 'scoped adjudicator authorization required') END;
END;

CREATE TRIGGER signer_authorization_guard
BEFORE INSERT ON adjudication_signers
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM authorizations a JOIN adjudications ad ON ad.envelope_id = NEW.envelope_id
      JOIN gate_decisions d ON d.decision_id = ad.decision_id
    WHERE a.authorization_id = NEW.authorization_id
      AND a.authorization_kind = 'ADJUDICATOR'
      AND a.principal_id = NEW.signer_id_normalized
      AND a.authorization_role = NEW.signer_role
      AND a.decision_id = d.decision_id
      AND a.ground_truth_key = d.ground_truth_key
      AND a.project_root_identity = d.project_root_identity
      AND a.root_bundle_sequence = d.root_bundle_sequence
      AND a.trust_bundle_sequence = d.trust_bundle_sequence
      AND a.gate_verdict = d.gate_verdict
      AND a.risk = d.risk
      AND a.checkpoint_key = d.checkpoint_key
      AND a.profile_key = d.profile_key
      AND a.stage_key = d.stage_key
      AND a.authorized_from <= NEW.signed_at
      AND (a.revoked_at IS NULL OR a.revoked_at > NEW.signed_at)
      AND a.expires_at > NEW.signed_at
  ) THEN RAISE(ABORT, 'authorized normalized signer required') END;
  SELECT CASE WHEN NEW.signer_rank = 2 AND NEW.signer_role <> 'SECURITY' THEN RAISE(ABORT, 'rank two signer must be security') END;
END;

CREATE TRIGGER receipt_binding_guard
BEFORE INSERT ON receipts
BEGIN
  SELECT CASE WHEN (SELECT gate_verdict FROM attempts WHERE attempt_id = NEW.attempt_id) = 'WATCH' AND NEW.exception_use_id IS NULL THEN RAISE(ABORT, 'WATCH receipt requires exception use') END;
  SELECT CASE WHEN (SELECT gate_verdict FROM attempts WHERE attempt_id = NEW.attempt_id) IN ('CLEAR','BLOCK') AND NEW.exception_use_id IS NOT NULL THEN RAISE(ABORT, 'exception use forbidden for CLEAR/BLOCK receipt') END;
  SELECT CASE WHEN length(NEW.receipt_hash) = 0 THEN RAISE(ABORT, 'receipt hash required') END;
  SELECT CASE WHEN length(NEW.receipt_hash) <> 64 OR NEW.receipt_hash GLOB '*[^0-9a-f]*' THEN RAISE(ABORT, 'receipt hash must be canonical sha256') END;
  SELECT CASE WHEN NEW.receipt_hash <> gjc_receipt_hash(NEW.receipt_bytes) THEN RAISE(ABORT, 'receipt hash mismatch') END;
  SELECT CASE WHEN NEW.exception_use_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM exception_uses u
    JOIN attempts a ON a.attempt_id = u.attempt_id
    WHERE u.use_id = NEW.exception_use_id
      AND a.attempt_id = NEW.attempt_id
      AND a.slot_key = NEW.slot_key
  ) THEN RAISE(ABORT, 'receipt use does not match attempt slot') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM outbox o
    JOIN audit_events e ON e.event_id = o.event_id
    WHERE o.outbox_id = NEW.outbox_id
      AND o.event_id = NEW.event_id
      AND e.aggregate_id = NEW.receipt_id
      AND o.topic = 'quality-contract.receipt'
      AND e.event_bytes = NEW.receipt_bytes
      AND o.payload_bytes = NEW.receipt_bytes
      AND length(e.event_hash) > 0
  ) THEN RAISE(ABORT, 'receipt audit outbox binding required') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evidence_objects e
    JOIN attempts a ON a.attempt_id = NEW.attempt_id
    JOIN evidence_refs r ON r.decision_id = (SELECT decision_id FROM gate_decisions WHERE attempt_id = a.attempt_id)
      AND r.evidence_id = e.evidence_id
      AND r.ref_kind = 'RECEIPT'
    WHERE e.evidence_id = NEW.evidence_id
      AND e.content_bytes = NEW.receipt_bytes
      AND length(e.content_hash) > 0
      AND (NEW.exception_use_id IS NULL OR EXISTS (
        SELECT 1 FROM exception_uses u
        WHERE u.use_id = NEW.exception_use_id
          AND u.attempt_id = a.attempt_id
          AND u.slot_key = NEW.slot_key
      ))
  ) THEN RAISE(ABORT, 'receipt evidence binding required') END;
END;
CREATE TRIGGER evidence_hash_shape_guard
BEFORE INSERT ON evidence_objects
BEGIN
  SELECT CASE WHEN length(NEW.content_hash) <> 64 OR NEW.content_hash GLOB '*[^0-9a-f]*' THEN RAISE(ABORT, 'evidence hash must be canonical sha256') END;
  SELECT CASE WHEN NEW.content_hash <> gjc_evidence_hash(NEW.content_bytes) THEN RAISE(ABORT, 'evidence hash mismatch') END;
END;

CREATE TRIGGER audit_hash_shape_guard
BEFORE INSERT ON audit_events
BEGIN
  SELECT CASE WHEN length(NEW.event_hash) <> 64 OR NEW.event_hash GLOB '*[^0-9a-f]*' THEN RAISE(ABORT, 'audit hash must be canonical sha256') END;
  SELECT CASE WHEN NEW.event_hash <> gjc_audit_hash(NEW.event_bytes) THEN RAISE(ABORT, 'audit hash mismatch') END;
END;
CREATE TRIGGER evidence_hash_update_guard
BEFORE UPDATE OF content_bytes, content_hash ON evidence_objects
BEGIN
  SELECT CASE WHEN length(NEW.content_hash) <> 64 OR NEW.content_hash GLOB '*[^0-9a-f]*' THEN RAISE(ABORT, 'evidence hash must be canonical sha256') END;
  SELECT CASE WHEN NEW.content_hash <> gjc_evidence_hash(NEW.content_bytes) THEN RAISE(ABORT, 'evidence hash mismatch') END;
END;

CREATE TRIGGER audit_hash_update_guard
BEFORE UPDATE OF event_bytes, event_hash ON audit_events
BEGIN
  SELECT CASE WHEN length(NEW.event_hash) <> 64 OR NEW.event_hash GLOB '*[^0-9a-f]*' THEN RAISE(ABORT, 'audit hash must be canonical sha256') END;
  SELECT CASE WHEN NEW.event_hash <> gjc_audit_hash(NEW.event_bytes) THEN RAISE(ABORT, 'audit hash mismatch') END;
END;

CREATE TRIGGER receipt_binding_snapshot
AFTER INSERT ON receipts
BEGIN
  INSERT INTO receipt_bindings (
    receipt_id, evidence_id, event_id, outbox_id, receipt_bytes, receipt_hash,
    evidence_bytes, evidence_hash, audit_bytes, audit_hash, outbox_bytes
  )
  SELECT NEW.receipt_id, NEW.evidence_id, NEW.event_id, NEW.outbox_id, NEW.receipt_bytes, NEW.receipt_hash,
    e.content_bytes, e.content_hash, a.event_bytes, a.event_hash, o.payload_bytes
  FROM evidence_objects e
  JOIN audit_events a ON a.event_id = NEW.event_id
  JOIN outbox o ON o.outbox_id = NEW.outbox_id
  WHERE e.evidence_id = NEW.evidence_id;
END;

CREATE TRIGGER receipt_mutation_guard
BEFORE UPDATE ON receipts
WHEN EXISTS (SELECT 1 FROM receipt_bindings b WHERE b.receipt_id = OLD.receipt_id)
BEGIN
  SELECT CASE WHEN NEW.receipt_id <> OLD.receipt_id
    OR NEW.attempt_id <> OLD.attempt_id
    OR NEW.slot_key <> OLD.slot_key
    OR NEW.receipt_bytes <> OLD.receipt_bytes
    OR NEW.receipt_hash <> OLD.receipt_hash
    OR NEW.exception_use_id IS NOT OLD.exception_use_id
    OR NEW.evidence_id <> OLD.evidence_id
    OR NEW.event_id <> OLD.event_id
    OR NEW.outbox_id <> OLD.outbox_id
    OR NEW.committed_at <> OLD.committed_at
    THEN RAISE(ABORT, 'committed receipt is immutable') END;
END;

CREATE TRIGGER receipt_binding_evidence_guard
BEFORE UPDATE OF content_bytes, content_hash ON evidence_objects
WHEN EXISTS (SELECT 1 FROM receipt_bindings b WHERE b.evidence_id = OLD.evidence_id)
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM receipt_bindings b
    WHERE b.evidence_id = OLD.evidence_id
      AND (NEW.content_bytes <> b.evidence_bytes OR NEW.content_hash <> b.evidence_hash)
  ) THEN RAISE(ABORT, 'receipt evidence binding is immutable') END;
END;

CREATE TRIGGER receipt_binding_audit_guard
BEFORE UPDATE OF event_bytes, event_hash ON audit_events
WHEN EXISTS (SELECT 1 FROM receipt_bindings b WHERE b.event_id = OLD.event_id)
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM receipt_bindings b
    WHERE b.event_id = OLD.event_id
      AND (NEW.event_bytes <> b.audit_bytes OR NEW.event_hash <> b.audit_hash)
  ) THEN RAISE(ABORT, 'receipt audit binding is immutable') END;
END;

CREATE TRIGGER receipt_binding_outbox_guard
BEFORE UPDATE OF payload_bytes ON outbox
WHEN EXISTS (SELECT 1 FROM receipt_bindings b WHERE b.outbox_id = OLD.outbox_id)
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM receipt_bindings b
    WHERE b.outbox_id = OLD.outbox_id
      AND NEW.payload_bytes <> b.outbox_bytes
  ) THEN RAISE(ABORT, 'receipt outbox binding is immutable') END;
END;

CREATE TRIGGER receipt_binding_snapshot_update_guard
BEFORE UPDATE ON receipt_bindings
BEGIN
  SELECT RAISE(ABORT, 'receipt binding snapshot is immutable');
END;

CREATE TRIGGER receipt_binding_snapshot_delete_guard
BEFORE DELETE ON receipt_bindings
BEGIN
  SELECT RAISE(ABORT, 'receipt binding snapshot is immutable');
END;

CREATE INDEX idx_attempts_identity ON attempts(ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key);
CREATE INDEX idx_evidence_refs_decision ON evidence_refs(decision_id);
CREATE INDEX idx_suspicions_decision_status ON suspicions(decision_id, status);

COMMIT;
