PRAGMA foreign_keys = ON;

BEGIN;

CREATE TABLE evaluation_runtime_metrics (
  metric_id TEXT PRIMARY KEY,
  ground_truth_key TEXT NOT NULL,
  project_root_identity TEXT NOT NULL,
  root_bundle_sequence INTEGER NOT NULL CHECK (root_bundle_sequence > 0),
  trust_bundle_sequence INTEGER NOT NULL CHECK (trust_bundle_sequence > 0),
  gate_verdict TEXT NOT NULL CHECK (gate_verdict IN ('CLEAR','WATCH','BLOCK')),
  risk TEXT NOT NULL CHECK (risk IN ('R0','R1','R2','R3')),
  checkpoint_key TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  measured_at INTEGER NOT NULL CHECK (measured_at >= 0),
  window_seconds INTEGER NOT NULL CHECK (window_seconds = 1209600),
  expires_at INTEGER NOT NULL CHECK (expires_at = measured_at + 1209600),
  total_count INTEGER NOT NULL CHECK (total_count BETWEEN 0 AND 1000000000),
  blocked_count INTEGER NOT NULL CHECK (blocked_count BETWEEN 0 AND 1000000000 AND blocked_count <= total_count),
  false_accept_count INTEGER NOT NULL CHECK (false_accept_count BETWEEN 0 AND 1000000000),
  missing_count INTEGER NOT NULL CHECK (missing_count BETWEEN 0 AND 1000000000),
  late_count INTEGER NOT NULL CHECK (late_count BETWEEN 0 AND 1000000000),
  conflict_count INTEGER NOT NULL CHECK (conflict_count BETWEEN 0 AND 1000000000),
  unresolved_count INTEGER NOT NULL CHECK (unresolved_count BETWEEN 0 AND 1000000000),
  denominator INTEGER NOT NULL CHECK (denominator BETWEEN 0 AND 1000000000),
  error_ppm INTEGER NOT NULL CHECK (error_ppm BETWEEN 0 AND 1000000 AND error_ppm = CASE WHEN denominator = 0 THEN 0 ELSE (false_accept_count * 1000000 + denominator / 2) / denominator END),
  blocked_ppm INTEGER NOT NULL CHECK (blocked_ppm BETWEEN 0 AND 1000000 AND blocked_ppm = CASE WHEN denominator = 0 THEN 0 ELSE (blocked_count * 1000000 + denominator / 2) / denominator END),
  product_count INTEGER NOT NULL CHECK (product_count BETWEEN 0 AND 1000000000000000),
  CHECK (false_accept_count + missing_count + late_count + conflict_count + unresolved_count <= denominator),
  UNIQUE (ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key)
) STRICT;

CREATE TABLE evaluations (
  evaluation_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  metric_id TEXT NOT NULL,
  ground_truth_key TEXT NOT NULL,
  project_root_identity TEXT NOT NULL,
  root_bundle_sequence INTEGER NOT NULL CHECK (root_bundle_sequence > 0),
  trust_bundle_sequence INTEGER NOT NULL CHECK (trust_bundle_sequence > 0),
  gate_verdict TEXT NOT NULL CHECK (gate_verdict IN ('CLEAR','WATCH','BLOCK')),
  risk TEXT NOT NULL CHECK (risk IN ('R0','R1','R2','R3')),
  checkpoint_key TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  evaluated_at INTEGER NOT NULL CHECK (evaluated_at >= 0),
  metric_expires_at INTEGER NOT NULL CHECK (metric_expires_at > evaluated_at),
  blocked_count INTEGER NOT NULL CHECK (blocked_count BETWEEN 0 AND 1000000000),
  false_accept_count INTEGER NOT NULL CHECK (false_accept_count BETWEEN 0 AND 1000000000),
  missing_count INTEGER NOT NULL CHECK (missing_count BETWEEN 0 AND 1000000000),
  late_count INTEGER NOT NULL CHECK (late_count BETWEEN 0 AND 1000000000),
  conflict_count INTEGER NOT NULL CHECK (conflict_count BETWEEN 0 AND 1000000000),
  unresolved_count INTEGER NOT NULL CHECK (unresolved_count BETWEEN 0 AND 1000000000),
  denominator INTEGER NOT NULL CHECK (denominator BETWEEN 0 AND 1000000000),
  error_ppm INTEGER NOT NULL CHECK (error_ppm BETWEEN 0 AND 1000000 AND error_ppm = CASE WHEN denominator = 0 THEN 0 ELSE (false_accept_count * 1000000 + denominator / 2) / denominator END),
  blocked_ppm INTEGER NOT NULL CHECK (blocked_ppm BETWEEN 0 AND 1000000 AND blocked_ppm = CASE WHEN denominator = 0 THEN 0 ELSE (blocked_count * 1000000 + denominator / 2) / denominator END),
  product_count INTEGER NOT NULL CHECK (product_count BETWEEN 0 AND 1000000000000000),
  CHECK (blocked_count <= denominator),
  CHECK (false_accept_count + missing_count + late_count + conflict_count + unresolved_count <= denominator),
  UNIQUE (ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key),
  UNIQUE (evaluation_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key),
  FOREIGN KEY (decision_id) REFERENCES gate_decisions(decision_id),
  FOREIGN KEY (metric_id) REFERENCES evaluation_runtime_metrics(metric_id),
  FOREIGN KEY (ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key)
    REFERENCES evaluation_runtime_metrics(ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key)
) STRICT;

CREATE TABLE promotions (
  promotion_id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL,
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
  promoted_at INTEGER NOT NULL CHECK (promoted_at >= 0),
  status TEXT NOT NULL CHECK (status IN ('PROMOTED','BLOCKED')),
  reason TEXT NOT NULL CHECK ((status = 'PROMOTED' AND reason = 'verified-allow') OR (status = 'BLOCKED' AND reason = 'blocked')),
  UNIQUE (ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key),
  UNIQUE (promotion_id, evaluation_id),
  FOREIGN KEY (evaluation_id) REFERENCES evaluations(evaluation_id),
  FOREIGN KEY (decision_id) REFERENCES gate_decisions(decision_id),
  FOREIGN KEY (evaluation_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key)
    REFERENCES evaluations(evaluation_id, ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key)
) STRICT;

CREATE TRIGGER evaluation_identity_guard
BEFORE INSERT ON evaluations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM gate_decisions d
    WHERE d.decision_id = NEW.decision_id
      AND d.ground_truth_key = NEW.ground_truth_key
      AND d.project_root_identity = NEW.project_root_identity
      AND d.root_bundle_sequence = NEW.root_bundle_sequence
      AND d.trust_bundle_sequence = NEW.trust_bundle_sequence
      AND d.gate_verdict = NEW.gate_verdict
      AND d.risk = NEW.risk
      AND d.checkpoint_key = NEW.checkpoint_key
      AND d.profile_key = NEW.profile_key
      AND d.stage_key = NEW.stage_key
  ) THEN RAISE(ABORT, 'evaluation decision identity mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evaluation_runtime_metrics m
    WHERE m.metric_id = NEW.metric_id
      AND m.ground_truth_key = NEW.ground_truth_key
      AND m.project_root_identity = NEW.project_root_identity
      AND m.root_bundle_sequence = NEW.root_bundle_sequence
      AND m.trust_bundle_sequence = NEW.trust_bundle_sequence
      AND m.gate_verdict = NEW.gate_verdict
      AND m.risk = NEW.risk
      AND m.checkpoint_key = NEW.checkpoint_key
      AND m.profile_key = NEW.profile_key
      AND m.stage_key = NEW.stage_key
      AND m.expires_at = NEW.metric_expires_at
      AND NEW.evaluated_at >= m.measured_at
      AND NEW.blocked_count = m.blocked_count
      AND NEW.false_accept_count = m.false_accept_count
      AND NEW.missing_count = m.missing_count
      AND NEW.late_count = m.late_count
      AND NEW.conflict_count = m.conflict_count
      AND NEW.unresolved_count = m.unresolved_count
      AND NEW.denominator = m.denominator
      AND NEW.error_ppm = m.error_ppm
      AND NEW.blocked_ppm = m.blocked_ppm
      AND NEW.product_count = m.product_count
  ) THEN RAISE(ABORT, 'evaluation metric identity mismatch') END;
END;

CREATE TRIGGER promotion_identity_guard
BEFORE INSERT ON promotions
WHEN NEW.status = 'PROMOTED'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evaluations e
    WHERE e.evaluation_id = NEW.evaluation_id
      AND e.decision_id = NEW.decision_id
      AND e.ground_truth_key = NEW.ground_truth_key
      AND e.project_root_identity = NEW.project_root_identity
      AND e.root_bundle_sequence = NEW.root_bundle_sequence
      AND e.trust_bundle_sequence = NEW.trust_bundle_sequence
      AND e.gate_verdict = NEW.gate_verdict
      AND e.risk = NEW.risk
      AND e.checkpoint_key = NEW.checkpoint_key
      AND e.profile_key = NEW.profile_key
      AND e.stage_key = NEW.stage_key
      AND e.gate_verdict IN ('CLEAR','WATCH')
      AND (e.risk <> 'R3' OR e.gate_verdict = 'CLEAR')
      AND e.blocked_count > 0
      AND e.denominator > 0
      AND e.metric_expires_at > NEW.promoted_at
      AND e.false_accept_count = 0
      AND e.missing_count = 0
      AND e.late_count = 0
      AND e.conflict_count = 0
      AND e.unresolved_count = 0
  ) THEN RAISE(ABORT, 'promotion predicate failed') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM suspicions s
    WHERE s.decision_id = NEW.decision_id AND s.status <> 'RESOLVED_DENY'
  ) THEN RAISE(ABORT, 'unresolved suspicion') END;
END;

CREATE TRIGGER promotion_adjudication_guard
BEFORE INSERT ON promotions
WHEN NEW.status = 'PROMOTED' AND NEW.risk = 'R3'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM adjudications a
    JOIN gate_decisions d ON d.decision_id = a.decision_id
      AND d.ground_truth_key = NEW.ground_truth_key
      AND d.project_root_identity = NEW.project_root_identity
      AND d.root_bundle_sequence = NEW.root_bundle_sequence
      AND d.trust_bundle_sequence = NEW.trust_bundle_sequence
      AND d.gate_verdict = NEW.gate_verdict
      AND d.risk = NEW.risk
      AND d.checkpoint_key = NEW.checkpoint_key
      AND d.profile_key = NEW.profile_key
      AND d.stage_key = NEW.stage_key
    WHERE a.decision_id = NEW.decision_id
      AND a.adjudication_kind = 'ALLOW'
  ) THEN RAISE(ABORT, 'ALLOW adjudication required for R3 promotion') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM adjudications a
    JOIN gate_decisions d ON d.decision_id = a.decision_id
      AND d.ground_truth_key = NEW.ground_truth_key
      AND d.project_root_identity = NEW.project_root_identity
      AND d.root_bundle_sequence = NEW.root_bundle_sequence
      AND d.trust_bundle_sequence = NEW.trust_bundle_sequence
      AND d.gate_verdict = NEW.gate_verdict
      AND d.risk = NEW.risk
      AND d.checkpoint_key = NEW.checkpoint_key
      AND d.profile_key = NEW.profile_key
      AND d.stage_key = NEW.stage_key
    WHERE a.decision_id = NEW.decision_id
      AND a.adjudication_kind = 'ALLOW'
      AND EXISTS (SELECT 1 FROM adjudication_signers s1 WHERE s1.envelope_id = a.envelope_id AND s1.signer_rank = 1)
      AND EXISTS (SELECT 1 FROM adjudication_signers s2 WHERE s2.envelope_id = a.envelope_id AND s2.signer_rank = 2 AND s2.signer_role = 'SECURITY')
      AND (SELECT COUNT(*) FROM adjudication_signers sx WHERE sx.envelope_id = a.envelope_id) = 2
  ) THEN RAISE(ABORT, 'rank two authorized security signer required') END;
END;

CREATE INDEX idx_metrics_expiry ON evaluation_runtime_metrics(expires_at);
CREATE INDEX idx_evaluations_identity ON evaluations(ground_truth_key, project_root_identity, root_bundle_sequence, trust_bundle_sequence, gate_verdict, risk, checkpoint_key, profile_key, stage_key);

COMMIT;
