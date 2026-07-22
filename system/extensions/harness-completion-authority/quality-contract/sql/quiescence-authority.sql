PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

BEGIN;

CREATE TABLE qtb_runs (
  project_id TEXT NOT NULL,
  root_objective_id TEXT NOT NULL,
  candidate_generation INTEGER NOT NULL CHECK (candidate_generation >= 0),
  mutation_epoch INTEGER NOT NULL CHECK (mutation_epoch >= 0),
  cancellation_epoch INTEGER NOT NULL CHECK (cancellation_epoch >= 0),
  source_cursor TEXT,
  authoritative_census INTEGER NOT NULL CHECK (authoritative_census IN (0,1)),
  gap INTEGER NOT NULL CHECK (gap IN (0,1)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (project_id, root_objective_id)
) STRICT;

CREATE TABLE qtb_identity_ledger (
  project_id TEXT NOT NULL,
  root_objective_id TEXT NOT NULL,
  action_sequence INTEGER NOT NULL CHECK (action_sequence >= 0),
  actor_key TEXT NOT NULL,
  task_key TEXT NOT NULL,
  delivery_key TEXT NOT NULL,
  actor_state TEXT NOT NULL CHECK (actor_state IN ('active','paused','terminal')),
  task_state TEXT NOT NULL CHECK (task_state IN ('queued','active','complete','failed','required_open')),
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending','delivered','acknowledged')),
  required INTEGER NOT NULL CHECK (required IN (0,1)),
  source_cursor TEXT,
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  PRIMARY KEY (project_id, root_objective_id, actor_key, task_key, delivery_key),
  UNIQUE (project_id, root_objective_id, action_sequence),
  FOREIGN KEY (project_id, root_objective_id) REFERENCES qtb_runs(project_id, root_objective_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE qtb_reconciliations (
  reconciliation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_objective_id TEXT NOT NULL,
  source_cursor TEXT NOT NULL CHECK (length(source_cursor) > 0),
  census_hash TEXT NOT NULL CHECK (length(census_hash) = 64 AND census_hash NOT GLOB '*[^0-9a-f]*'),
  active_actors INTEGER NOT NULL CHECK (active_actors >= 0),
  active_tasks INTEGER NOT NULL CHECK (active_tasks >= 0),
  queued_tasks INTEGER NOT NULL CHECK (queued_tasks >= 0),
  pending_deliveries INTEGER NOT NULL CHECK (pending_deliveries >= 0),
  incomplete_required_tasks INTEGER NOT NULL CHECK (incomplete_required_tasks >= 0),
  complete INTEGER NOT NULL CHECK (complete IN (0,1)),
  reconciled_at INTEGER NOT NULL CHECK (reconciled_at >= 0),
  UNIQUE (project_id, root_objective_id, source_cursor),
  FOREIGN KEY (project_id, root_objective_id) REFERENCES qtb_runs(project_id, root_objective_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE qtb_candidates (
  candidate_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_objective_id TEXT NOT NULL,
  candidate_generation INTEGER NOT NULL CHECK (candidate_generation >= 0),
  mutation_epoch INTEGER NOT NULL CHECK (mutation_epoch >= 0),
  physical_root TEXT NOT NULL CHECK (length(physical_root) > 0),
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
  inventory_hash TEXT NOT NULL CHECK (length(inventory_hash) = 64 AND inventory_hash NOT GLOB '*[^0-9a-f]*'),
  acceptance_hash TEXT NOT NULL CHECK (length(acceptance_hash) = 64 AND acceptance_hash NOT GLOB '*[^0-9a-f]*'),
  materialized_at INTEGER NOT NULL CHECK (materialized_at >= 0),
  UNIQUE (project_id, root_objective_id, candidate_generation, mutation_epoch),
  FOREIGN KEY (project_id, root_objective_id) REFERENCES qtb_runs(project_id, root_objective_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE qtb_profile_obligation_catalog (
  profile_id TEXT NOT NULL CHECK (length(profile_id) > 0),
  catalog_version TEXT NOT NULL CHECK (length(catalog_version) > 0),
  obligation_id TEXT NOT NULL CHECK (length(obligation_id) > 0),
  mandatory INTEGER NOT NULL CHECK (mandatory IN (0,1)),
  PRIMARY KEY (profile_id, catalog_version, obligation_id)
) STRICT;

INSERT INTO qtb_profile_obligation_catalog (profile_id, catalog_version, obligation_id, mandatory)
VALUES
  ('g0-evidence-only', 'verification-obligations/v1', 'qtb.g0.no-mutation-attestation', 1),
  ('g0-evidence-only', 'verification-obligations/v1', 'qtb.g0.identity-ledger-smoke', 1),
  ('js-ts-focused', 'verification-obligations/v1', 'qtb.js-ts.existing-tests', 1),
  ('js-ts-focused', 'verification-obligations/v1', 'qtb.js-ts.independent-smoke', 1),
  ('js-ts-focused', 'verification-obligations/v1', 'qtb.js-ts.adversarial', 1),
  ('js-ts-focused', 'verification-obligations/v1', 'qtb.snapshot.sealed', 1),
  ('js-ts-focused', 'verification-obligations/v1', 'qtb.ledger.integrity', 1),
  ('python-focused', 'verification-obligations/v1', 'qtb.python.existing-tests', 1),
  ('python-focused', 'verification-obligations/v1', 'qtb.python.independent-smoke', 1),
  ('python-focused', 'verification-obligations/v1', 'qtb.python.adversarial', 1),
  ('python-focused', 'verification-obligations/v1', 'qtb.snapshot.sealed', 1),
  ('python-focused', 'verification-obligations/v1', 'qtb.ledger.integrity', 1),
  ('rust-incremental', 'verification-obligations/v1', 'qtb.rust-incremental.existing-tests', 1),
  ('rust-incremental', 'verification-obligations/v1', 'qtb.rust-incremental.independent-smoke', 1),
  ('rust-incremental', 'verification-obligations/v1', 'qtb.rust-incremental.adversarial', 1),
  ('rust-incremental', 'verification-obligations/v1', 'qtb.snapshot.sealed', 1),
  ('rust-incremental', 'verification-obligations/v1', 'qtb.ledger.integrity', 1),
  ('rust-cold', 'verification-obligations/v1', 'qtb.rust-cold.existing-tests', 1),
  ('rust-cold', 'verification-obligations/v1', 'qtb.rust-cold.independent-smoke', 1),
  ('rust-cold', 'verification-obligations/v1', 'qtb.rust-cold.adversarial', 1),
  ('rust-cold', 'verification-obligations/v1', 'qtb.snapshot.sealed', 1),
  ('rust-cold', 'verification-obligations/v1', 'qtb.ledger.integrity', 1),
  ('playwright-focused', 'verification-obligations/v1', 'qtb.playwright.existing-tests', 1),
  ('playwright-focused', 'verification-obligations/v1', 'qtb.playwright.independent-smoke', 1),
  ('playwright-focused', 'verification-obligations/v1', 'qtb.playwright.adversarial', 1),
  ('playwright-focused', 'verification-obligations/v1', 'qtb.snapshot.sealed', 1),
  ('playwright-focused', 'verification-obligations/v1', 'qtb.ledger.integrity', 1);
CREATE TRIGGER qtb_profile_obligation_catalog_insert_immutable
BEFORE INSERT ON qtb_profile_obligation_catalog
BEGIN
  SELECT RAISE(ABORT, 'profile obligation catalog immutable');
END;
CREATE TRIGGER qtb_profile_obligation_catalog_update_immutable
BEFORE UPDATE ON qtb_profile_obligation_catalog
BEGIN
  SELECT RAISE(ABORT, 'profile obligation catalog immutable');
END;
CREATE TRIGGER qtb_profile_obligation_catalog_delete_immutable
BEFORE DELETE ON qtb_profile_obligation_catalog
BEGIN
  SELECT RAISE(ABORT, 'profile obligation catalog immutable');
END;

CREATE TABLE qtb_leases (
  lease_id TEXT PRIMARY KEY,
  candidate_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  root_objective_id TEXT NOT NULL,
  candidate_generation INTEGER NOT NULL CHECK (candidate_generation >= 0),
  mutation_epoch INTEGER NOT NULL CHECK (mutation_epoch >= 0),
  profile_id TEXT NOT NULL CHECK (length(profile_id) > 0),
  fence INTEGER NOT NULL CHECK (fence >= 1),
  claimed_at INTEGER NOT NULL CHECK (claimed_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > claimed_at),
  catalog_version TEXT NOT NULL DEFAULT 'verification-obligations/v1' CHECK (catalog_version = 'verification-obligations/v1'),
  committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0,1)),
  FOREIGN KEY (candidate_key) REFERENCES qtb_candidates(candidate_key),
  FOREIGN KEY (project_id, root_objective_id) REFERENCES qtb_runs(project_id, root_objective_id)
) STRICT;

CREATE TABLE qtb_obligations (
  obligation_id TEXT NOT NULL,
  candidate_key TEXT NOT NULL,
  mandatory INTEGER NOT NULL CHECK (mandatory IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('pending','running','passed','failed')),
  evidence_id TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (candidate_key, obligation_id),
  FOREIGN KEY (candidate_key) REFERENCES qtb_candidates(candidate_key) ON DELETE CASCADE
) STRICT;

CREATE TABLE qtb_evidence (
  evidence_id TEXT PRIMARY KEY,
  candidate_key TEXT NOT NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('acceptance','obligations','outcome','snapshot','timing')),
  object_bytes BLOB NOT NULL CHECK (length(object_bytes) > 0),
  object_hash TEXT NOT NULL CHECK (length(object_hash) = 64 AND object_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (candidate_key, evidence_type),
  FOREIGN KEY (candidate_key) REFERENCES qtb_candidates(candidate_key) ON DELETE CASCADE
) STRICT;

CREATE TABLE qtb_receipts (
  receipt_id TEXT PRIMARY KEY,
  candidate_key TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  receipt_bytes BLOB NOT NULL CHECK (length(receipt_bytes) > 0),
  receipt_hash TEXT NOT NULL CHECK (length(receipt_hash) = 64 AND receipt_hash NOT GLOB '*[^0-9a-f]*'),
  committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
  UNIQUE (candidate_key),
  UNIQUE (receipt_hash),
  FOREIGN KEY (candidate_key) REFERENCES qtb_candidates(candidate_key),
  FOREIGN KEY (lease_id) REFERENCES qtb_leases(lease_id)
) STRICT;

CREATE TABLE qtb_receipt_evidence (
  receipt_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (receipt_id, evidence_id),
  UNIQUE (receipt_id, ordinal),
  FOREIGN KEY (receipt_id) REFERENCES qtb_receipts(receipt_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id) REFERENCES qtb_evidence(evidence_id)
) STRICT;

CREATE TABLE qtb_terminal_pairs (
  terminal_pair_id TEXT PRIMARY KEY,
  candidate_key TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  owner_session_id TEXT NOT NULL,
  owner_prompt_generation INTEGER NOT NULL CHECK (owner_prompt_generation >= 0),
  owner_terminal_id TEXT NOT NULL,
  pair_bytes BLOB NOT NULL CHECK (length(pair_bytes) > 0),
  pair_hash TEXT NOT NULL CHECK (length(pair_hash) = 64 AND pair_hash NOT GLOB '*[^0-9a-f]*'),
  committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
  UNIQUE (candidate_key),
  FOREIGN KEY (candidate_key) REFERENCES qtb_candidates(candidate_key),
  FOREIGN KEY (receipt_id) REFERENCES qtb_receipts(receipt_id)
) STRICT;

CREATE TABLE qtb_bridge_transactions (
  transaction_id TEXT PRIMARY KEY,
  candidate_key TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  terminal_pair_id TEXT NOT NULL,
  bridge_committed_at INTEGER NOT NULL CHECK (bridge_committed_at >= 0),
  UNIQUE (candidate_key),
  UNIQUE (receipt_id, terminal_pair_id),
  FOREIGN KEY (candidate_key) REFERENCES qtb_candidates(candidate_key),
  FOREIGN KEY (lease_id) REFERENCES qtb_leases(lease_id),
  FOREIGN KEY (receipt_id) REFERENCES qtb_receipts(receipt_id),
  FOREIGN KEY (terminal_pair_id) REFERENCES qtb_terminal_pairs(terminal_pair_id)
) STRICT;

CREATE TABLE qtb_idempotency (
  candidate_key TEXT NOT NULL,
  object_type TEXT NOT NULL CHECK (object_type IN ('Evidence','Receipt','TerminalPair')),
  object_id TEXT NOT NULL,
  object_hash TEXT NOT NULL CHECK (length(object_hash) = 64 AND object_hash NOT GLOB '*[^0-9a-f]*'),
  object_bytes BLOB NOT NULL CHECK (length(object_bytes) > 0),
  PRIMARY KEY (candidate_key, object_type, object_id),
  FOREIGN KEY (candidate_key) REFERENCES qtb_candidates(candidate_key) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER qtb_ledger_immutable
BEFORE UPDATE OF actor_key, task_key, delivery_key, actor_state, task_state, delivery_state, required, source_cursor, observed_at ON qtb_identity_ledger
BEGIN SELECT RAISE(ABORT, 'identity ledger immutable'); END;

CREATE TRIGGER qtb_candidate_immutable
BEFORE UPDATE ON qtb_candidates
BEGIN SELECT RAISE(ABORT, 'candidate immutable'); END;

CREATE TRIGGER qtb_lease_binding_guard
BEFORE INSERT ON qtb_leases
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM qtb_candidates c WHERE c.candidate_key = NEW.candidate_key
      AND c.project_id = NEW.project_id AND c.root_objective_id = NEW.root_objective_id
      AND c.candidate_generation = NEW.candidate_generation AND c.mutation_epoch = NEW.mutation_epoch
  ) THEN RAISE(ABORT, 'lease candidate binding mismatch') END;
END;
CREATE TRIGGER qtb_lease_catalog_guard
BEFORE INSERT ON qtb_leases
WHEN NEW.catalog_version <> 'verification-obligations/v1' OR NOT EXISTS (
  SELECT 1 FROM qtb_profile_obligation_catalog c
  WHERE c.profile_id = NEW.profile_id
    AND c.catalog_version = NEW.catalog_version
    AND c.mandatory = 1
)
BEGIN
  SELECT RAISE(ABORT, 'lease profile catalog mismatch');
END;

CREATE TRIGGER qtb_lease_claim_guard
BEFORE INSERT ON qtb_leases
BEGIN
  SELECT CASE WHEN NEW.committed <> 0 THEN RAISE(ABORT, 'lease must begin uncommitted') END;
  SELECT CASE WHEN NEW.fence <= COALESCE((
    SELECT MAX(incumbent.fence)
    FROM qtb_leases incumbent
    WHERE incumbent.candidate_key = NEW.candidate_key
      AND incumbent.project_id = NEW.project_id
      AND incumbent.root_objective_id = NEW.root_objective_id
      AND incumbent.candidate_generation = NEW.candidate_generation
      AND incumbent.mutation_epoch = NEW.mutation_epoch
      AND incumbent.profile_id = NEW.profile_id
  ), 0) THEN RAISE(ABORT, 'lease fence regression') END;
  SELECT CASE WHEN NEW.claimed_at < COALESCE((
    SELECT MAX(incumbent.claimed_at)
    FROM qtb_leases incumbent
    WHERE incumbent.candidate_key = NEW.candidate_key
      AND incumbent.project_id = NEW.project_id
      AND incumbent.root_objective_id = NEW.root_objective_id
      AND incumbent.candidate_generation = NEW.candidate_generation
      AND incumbent.mutation_epoch = NEW.mutation_epoch
      AND incumbent.profile_id = NEW.profile_id
  ), NEW.claimed_at) THEN RAISE(ABORT, 'lease claimed_at regression') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM qtb_leases incumbent
    WHERE incumbent.candidate_key = NEW.candidate_key
      AND incumbent.project_id = NEW.project_id
      AND incumbent.root_objective_id = NEW.root_objective_id
      AND incumbent.candidate_generation = NEW.candidate_generation
      AND incumbent.mutation_epoch = NEW.mutation_epoch
      AND incumbent.profile_id = NEW.profile_id
      AND incumbent.committed = 0
      AND NEW.claimed_at < incumbent.expires_at
  ) THEN RAISE(ABORT, 'lease incumbent still live') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM qtb_leases incumbent
    WHERE incumbent.candidate_key = NEW.candidate_key
      AND incumbent.project_id = NEW.project_id
      AND incumbent.root_objective_id = NEW.root_objective_id
      AND incumbent.candidate_generation = NEW.candidate_generation
      AND incumbent.mutation_epoch = NEW.mutation_epoch
      AND incumbent.profile_id = NEW.profile_id
      AND incumbent.committed = 1
  ) THEN RAISE(ABORT, 'lease candidate already committed') END;
END;
CREATE TRIGGER qtb_lease_immutable
BEFORE UPDATE ON qtb_leases
WHEN OLD.committed <> 0
  OR NEW.committed <> 1
  OR OLD.lease_id IS NOT NEW.lease_id
  OR OLD.candidate_key IS NOT NEW.candidate_key
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.root_objective_id IS NOT NEW.root_objective_id
  OR OLD.candidate_generation IS NOT NEW.candidate_generation
  OR OLD.mutation_epoch IS NOT NEW.mutation_epoch
  OR OLD.profile_id IS NOT NEW.profile_id
  OR OLD.fence IS NOT NEW.fence
  OR OLD.claimed_at IS NOT NEW.claimed_at
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.catalog_version IS NOT NEW.catalog_version
  OR NOT EXISTS (
    SELECT 1
    FROM qtb_bridge_transactions bridge
    WHERE bridge.lease_id = OLD.lease_id
      AND bridge.candidate_key = OLD.candidate_key
  )
BEGIN
  SELECT RAISE(ABORT, 'lease immutable');
END;
CREATE TRIGGER qtb_lease_delete_immutable
BEFORE DELETE ON qtb_leases
BEGIN
  SELECT RAISE(ABORT, 'lease immutable');
END;

CREATE VIEW qtb_current_leases AS
SELECT l.*
FROM qtb_leases l
WHERE l.committed = 0
  AND l.fence = (
    SELECT MAX(current.fence)
    FROM qtb_leases current
    WHERE current.candidate_key = l.candidate_key
      AND current.project_id = l.project_id
      AND current.root_objective_id = l.root_objective_id
      AND current.candidate_generation = l.candidate_generation
      AND current.mutation_epoch = l.mutation_epoch
      AND current.profile_id = l.profile_id
  );

CREATE TRIGGER qtb_lease_expiry_guard
BEFORE INSERT ON qtb_bridge_transactions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM qtb_leases l
    WHERE l.lease_id = NEW.lease_id
      AND l.candidate_key = NEW.candidate_key
      AND l.claimed_at <= NEW.bridge_committed_at
      AND NEW.bridge_committed_at < l.expires_at
  ) THEN RAISE(ABORT, 'bridge lease stale or expired') END;
END;

CREATE TRIGGER qtb_receipt_lease_guard
BEFORE INSERT ON qtb_receipts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM qtb_leases l
    WHERE l.lease_id = NEW.lease_id
      AND l.candidate_key = NEW.candidate_key
      AND l.committed = 0
      AND NEW.committed_at >= l.claimed_at
      AND NEW.committed_at < l.expires_at
      AND l.fence = (
        SELECT MAX(current.fence)
        FROM qtb_leases current
        WHERE current.candidate_key = l.candidate_key
          AND current.project_id = l.project_id
          AND current.root_objective_id = l.root_objective_id
          AND current.candidate_generation = l.candidate_generation
          AND current.mutation_epoch = l.mutation_epoch
          AND current.profile_id = l.profile_id
      )
  ) THEN RAISE(ABORT, 'receipt fence mismatch') END;
END;

CREATE TRIGGER qtb_pair_receipt_guard
BEFORE INSERT ON qtb_terminal_pairs
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM qtb_receipts r WHERE r.receipt_id = NEW.receipt_id AND r.candidate_key = NEW.candidate_key
      AND NEW.committed_at >= r.committed_at
  ) THEN RAISE(ABORT, 'terminal pair receipt mismatch') END;
END;

CREATE TRIGGER qtb_bridge_guard
BEFORE INSERT ON qtb_bridge_transactions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM qtb_leases l JOIN qtb_receipts r ON r.lease_id = l.lease_id AND r.receipt_id = NEW.receipt_id
      JOIN qtb_terminal_pairs p ON p.receipt_id = r.receipt_id AND p.terminal_pair_id = NEW.terminal_pair_id AND p.candidate_key = NEW.candidate_key
    WHERE l.lease_id = NEW.lease_id AND l.candidate_key = NEW.candidate_key
  ) THEN RAISE(ABORT, 'bridge relation mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM qtb_leases l
    JOIN qtb_runs run
      ON run.project_id = l.project_id
      AND run.root_objective_id = l.root_objective_id
      AND run.candidate_generation = l.candidate_generation
      AND run.mutation_epoch = l.mutation_epoch
    WHERE l.lease_id = NEW.lease_id
      AND l.candidate_key = NEW.candidate_key
      AND l.committed = 0
      AND l.claimed_at <= NEW.bridge_committed_at
      AND NEW.bridge_committed_at < l.expires_at
      AND l.fence = (
        SELECT MAX(incumbent.fence)
        FROM qtb_leases incumbent
        WHERE incumbent.candidate_key = l.candidate_key
          AND incumbent.project_id = l.project_id
          AND incumbent.root_objective_id = l.root_objective_id
          AND incumbent.candidate_generation = l.candidate_generation
          AND incumbent.mutation_epoch = l.mutation_epoch
          AND incumbent.profile_id = l.profile_id
      )
  ) THEN RAISE(ABORT, 'bridge lease stale or expired') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM qtb_receipts r
    JOIN qtb_terminal_pairs p ON p.receipt_id = r.receipt_id
    WHERE r.receipt_id = NEW.receipt_id
      AND p.terminal_pair_id = NEW.terminal_pair_id
      AND (NEW.bridge_committed_at < r.committed_at OR NEW.bridge_committed_at < p.committed_at)
  ) THEN RAISE(ABORT, 'bridge timestamp backdated') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM qtb_obligations o
    WHERE o.candidate_key = NEW.candidate_key AND o.mandatory = 1
  ) THEN RAISE(ABORT, 'bridge mandatory obligations missing') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM qtb_profile_obligation_catalog c
    WHERE c.profile_id = (
      SELECT l.profile_id FROM qtb_leases l WHERE l.lease_id = NEW.lease_id
    )
      AND c.catalog_version = (
        SELECT l.catalog_version FROM qtb_leases l WHERE l.lease_id = NEW.lease_id
      )
      AND c.mandatory = 1
  ) THEN RAISE(ABORT, 'bridge profile obligation catalog missing') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM qtb_profile_obligation_catalog c
    JOIN qtb_leases l
      ON l.profile_id = c.profile_id
      AND l.catalog_version = c.catalog_version
    WHERE l.lease_id = NEW.lease_id
      AND c.mandatory = 1
      AND NOT EXISTS (
        SELECT 1
        FROM qtb_obligations o
        WHERE o.candidate_key = NEW.candidate_key
          AND o.mandatory = 1
          AND o.obligation_id = c.obligation_id
      )
  ) OR EXISTS (
    SELECT 1
    FROM qtb_obligations o
    WHERE o.candidate_key = NEW.candidate_key
      AND o.mandatory = 1
      AND NOT EXISTS (
        SELECT 1
        FROM qtb_profile_obligation_catalog c
        JOIN qtb_leases l
          ON l.profile_id = c.profile_id
          AND l.catalog_version = c.catalog_version
        WHERE l.lease_id = NEW.lease_id
          AND c.mandatory = 1
          AND c.obligation_id = o.obligation_id
      )
  ) OR (
    SELECT COUNT(*)
    FROM qtb_obligations o
    WHERE o.candidate_key = NEW.candidate_key AND o.mandatory = 1
  ) <> (
    SELECT COUNT(*)
    FROM qtb_profile_obligation_catalog c
    JOIN qtb_leases l
      ON l.profile_id = c.profile_id
      AND l.catalog_version = c.catalog_version
    WHERE l.lease_id = NEW.lease_id AND c.mandatory = 1
  )
  THEN RAISE(ABORT, 'bridge mandatory catalog mismatch') END;
  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM qtb_obligations o
    WHERE o.candidate_key = NEW.candidate_key AND o.mandatory = 1
  ) <> (
    SELECT COUNT(DISTINCT o.evidence_id)
    FROM qtb_obligations o
    WHERE o.candidate_key = NEW.candidate_key AND o.mandatory = 1
  ) THEN RAISE(ABORT, 'bridge mandatory evidence not one-to-one') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM qtb_obligations o
    WHERE o.candidate_key = NEW.candidate_key
      AND o.mandatory = 1
      AND (o.status <> 'passed' OR o.evidence_id IS NULL)
  ) THEN RAISE(ABORT, 'bridge mandatory obligations incomplete') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM qtb_obligations o
    WHERE o.candidate_key = NEW.candidate_key AND o.mandatory = 1
      AND NOT EXISTS (
        SELECT 1
        FROM qtb_receipt_evidence re
        JOIN qtb_evidence e ON e.evidence_id = re.evidence_id
        WHERE re.receipt_id = NEW.receipt_id
          AND e.evidence_id = o.evidence_id
          AND e.candidate_key = NEW.candidate_key
      )
  ) THEN RAISE(ABORT, 'bridge mandatory evidence mismatch') END;
  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM qtb_receipt_evidence re
    JOIN qtb_evidence e ON e.evidence_id = re.evidence_id
    WHERE re.receipt_id = NEW.receipt_id
  ) <> 5 OR (
    SELECT COUNT(*)
    FROM qtb_receipt_evidence re
    JOIN qtb_evidence e ON e.evidence_id = re.evidence_id
    WHERE re.receipt_id = NEW.receipt_id AND e.candidate_key = NEW.candidate_key
  ) <> 5 OR (
    SELECT COUNT(DISTINCT e.evidence_type)
    FROM qtb_receipt_evidence re
    JOIN qtb_evidence e ON e.evidence_id = re.evidence_id
    WHERE re.receipt_id = NEW.receipt_id AND e.candidate_key = NEW.candidate_key
  ) <> 5
  THEN RAISE(ABORT, 'bridge evidence set mismatch') END;
END;
CREATE TRIGGER qtb_bridge_commit_lease
AFTER INSERT ON qtb_bridge_transactions
BEGIN
  UPDATE qtb_leases
  SET committed = 1
  WHERE lease_id = NEW.lease_id
    AND candidate_key = NEW.candidate_key
    AND committed = 0;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'bridge lease commit failed') END;
END;

CREATE TRIGGER qtb_idempotency_immutable

BEFORE UPDATE ON qtb_idempotency
BEGIN SELECT RAISE(ABORT, 'idempotency record immutable'); END;
CREATE TRIGGER qtb_receipt_immutable
BEFORE UPDATE ON qtb_receipts
BEGIN SELECT RAISE(ABORT, 'receipt immutable'); END;

CREATE TRIGGER qtb_terminal_pair_immutable
BEFORE UPDATE ON qtb_terminal_pairs
BEGIN SELECT RAISE(ABORT, 'terminal pair immutable'); END;

CREATE TRIGGER qtb_evidence_immutable
BEFORE UPDATE ON qtb_evidence
BEGIN SELECT RAISE(ABORT, 'evidence immutable'); END;

CREATE TRIGGER qtb_bridge_immutable
BEFORE UPDATE ON qtb_bridge_transactions
BEGIN SELECT RAISE(ABORT, 'bridge transaction immutable'); END;
COMMIT;

