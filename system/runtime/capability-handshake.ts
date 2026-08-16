import {
  addMillisecondsToCanonicalUtcTimestamp,
  compareCanonicalUtcTimestamps,
  isCanonicalUtcTimestamp,
} from "../core/canonical-time";
import {
  CAPABILITY_NAMES,
  isHardenedEgressProfile,
  parseCapabilityRecord,
  parseEnforcementProfile,
  type CapabilityRecord,
  type CapabilitySet,
  type EgressEnforcementProfile,
} from "./capability-model";

const ENVELOPE_KEYS = [
  "record",
  "sessionId",
  "snapshotId",
  "producerId",
  "nonce",
  "issuedAt",
  "expiresAt",
] as const;

export type CapabilityHandshakeRequest = Readonly<{
  host: string;
  sessionId: string;
  snapshotId: string;
  nonce: string;
}>;

export type CapabilityHandshakeExpectation = Readonly<{
  request: CapabilityHandshakeRequest;
  trustedProducerId: string;
  allowedCapabilities: CapabilitySet;
  allowedEnforcementProfile?: EgressEnforcementProfile;
  maxEnvelopeLifetimeMs: number;
  now: string;
}>;

export type CapabilityHandshakeErrorCode =
  | "MALFORMED_ENVELOPE"
  | "HOST_MISMATCH"
  | "SESSION_MISMATCH"
  | "SNAPSHOT_MISMATCH"
  | "PRODUCER_MISMATCH"
  | "NONCE_MISMATCH"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "LIFETIME_EXCEEDED"
  | "CAPABILITY_ESCALATION";

export class CapabilityHandshakeError extends Error {
  constructor(
    readonly code: CapabilityHandshakeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityHandshakeError";
  }
}

function fail(code: CapabilityHandshakeErrorCode, message: string): never {
  throw new CapabilityHandshakeError(code, message);
}

function recordInput(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("MALFORMED_ENVELOPE", "capability handshake envelope must be an object");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (
    keys.length !== ENVELOPE_KEYS.length
    || ENVELOPE_KEYS.some((key) => !Object.hasOwn(input, key))
  ) {
    return fail("MALFORMED_ENVELOPE", "capability handshake envelope keys are invalid");
  }
  return input;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    return fail("MALFORMED_ENVELOPE", `${field} must be a non-empty trimmed string`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (!isCanonicalUtcTimestamp(value)) {
    return fail("MALFORMED_ENVELOPE", `${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function expectEqual(
  actual: string,
  expected: string,
  code: CapabilityHandshakeErrorCode,
  field: string,
): void {
  if (actual !== expected) fail(code, `${field} does not match the trusted request context`);
}

function profileExceeds(
  advertised: EgressEnforcementProfile,
  allowed: EgressEnforcementProfile | undefined,
): boolean {
  if (allowed === undefined) {
    return advertised.originAttribution !== "none"
      || advertised.toolMediation !== "none"
      || advertised.processIsolation !== "none"
      || advertised.auditDurability !== "none";
  }
  const rank = {
    originAttribution: { none: 0, "session-scope": 1, "host-attested": 2 },
    toolMediation: { none: 0, "known-network-tools": 1, "all-tool-calls": 2 },
    processIsolation: { none: 0, "managed-egress": 1, "network-denied": 2 },
    auditDurability: { none: 0, "best-effort": 1, "pre-transmit-durable": 2 },
  } as const;
  return rank.originAttribution[advertised.originAttribution] > rank.originAttribution[allowed.originAttribution]
    || rank.toolMediation[advertised.toolMediation] > rank.toolMediation[allowed.toolMediation]
    || rank.processIsolation[advertised.processIsolation] > rank.processIsolation[allowed.processIsolation]
    || rank.auditDurability[advertised.auditDurability] > rank.auditDurability[allowed.auditDurability];
}

export function parseCapabilityHandshakeEnvelope(
  value: unknown,
  expectation: CapabilityHandshakeExpectation,
): CapabilityRecord {
  if (
    !Number.isSafeInteger(expectation.maxEnvelopeLifetimeMs)
    || expectation.maxEnvelopeLifetimeMs <= 0
  ) {
    return fail("MALFORMED_ENVELOPE", "maxEnvelopeLifetimeMs must be a positive safe integer");
  }
  const input = recordInput(value);
  const sessionId = nonEmptyString(input.sessionId, "sessionId");
  const snapshotId = nonEmptyString(input.snapshotId, "snapshotId");
  const producerId = nonEmptyString(input.producerId, "producerId");
  const nonce = nonEmptyString(input.nonce, "nonce");
  const issuedAt = canonicalTimestamp(input.issuedAt, "issuedAt");
  const expiresAt = canonicalTimestamp(input.expiresAt, "expiresAt");
  const now = canonicalTimestamp(expectation.now, "now");
  const record = parseCapabilityRecord(input.record);

  expectEqual(record.host, expectation.request.host, "HOST_MISMATCH", "host");
  expectEqual(sessionId, expectation.request.sessionId, "SESSION_MISMATCH", "sessionId");
  expectEqual(snapshotId, expectation.request.snapshotId, "SNAPSHOT_MISMATCH", "snapshotId");
  expectEqual(producerId, expectation.trustedProducerId, "PRODUCER_MISMATCH", "producerId");
  expectEqual(nonce, expectation.request.nonce, "NONCE_MISMATCH", "nonce");

  if (compareCanonicalUtcTimestamps(issuedAt, expiresAt) >= 0) {
    fail("MALFORMED_ENVELOPE", "issuedAt must precede expiresAt");
  }
  let maximumExpiry: string;
  try {
    maximumExpiry = addMillisecondsToCanonicalUtcTimestamp(
      issuedAt,
      expectation.maxEnvelopeLifetimeMs,
    );
  } catch (error) {
    fail(
      "MALFORMED_ENVELOPE",
      `maxEnvelopeLifetimeMs is not representable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (compareCanonicalUtcTimestamps(expiresAt, maximumExpiry) > 0) {
    fail("LIFETIME_EXCEEDED", "capability handshake envelope exceeds the trusted lifetime");
  }
  if (compareCanonicalUtcTimestamps(issuedAt, now) > 0) {
    fail("NOT_YET_VALID", "capability handshake envelope is not yet valid");
  }
  if (compareCanonicalUtcTimestamps(expiresAt, now) <= 0) {
    fail("EXPIRED", "capability handshake envelope has expired");
  }
  let allowedEnforcementProfile: EgressEnforcementProfile | undefined;
  if (expectation.allowedEnforcementProfile !== undefined) {
    try {
      allowedEnforcementProfile = parseEnforcementProfile(expectation.allowedEnforcementProfile);
    } catch (error) {
      fail(
        "MALFORMED_ENVELOPE",
        `allowedEnforcementProfile is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const name of CAPABILITY_NAMES) {
    const advertised = name === "enforceSkillOriginEgressDeny"
      ? ("enforcementProfile" in record
        ? isHardenedEgressProfile(record.enforcementProfile)
        : false)
      : record.capabilities[name];
    if (name === "enforceSkillOriginEgressDeny"
      && !("enforcementProfile" in record)
      && record.capabilities[name]) {
      fail("CAPABILITY_ESCALATION", "legacy capability records cannot advertise Skill-origin egress enforcement");
    }
    if (advertised && !expectation.allowedCapabilities[name]) {
      fail("CAPABILITY_ESCALATION", `capability ${name} exceeds the trusted integration ceiling`);
    }
  }
  if ("enforcementProfile" in record && profileExceeds(record.enforcementProfile, allowedEnforcementProfile)) {
    fail("CAPABILITY_ESCALATION", "enforcementProfile exceeds the trusted integration ceiling");
  }
  return record;
}
