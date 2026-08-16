import {
  parseCapabilityHandshakeEnvelope,
  type CapabilityHandshakeRequest,
} from "../../system/runtime/capability-handshake";
import {
  parseCapabilityRecord,
  type CapabilityRecord,
  type CapabilitySet,
  type EgressEnforcementProfile,
} from "../../system/runtime/capability-model";

export type CodexCapabilityHandshake = Readonly<{
  sessionId: string;
  snapshotId: string;
  trustedProducerId: string;
  allowedCapabilities: CapabilitySet;
  allowedEnforcementProfile?: EgressEnforcementProfile;
  maxEnvelopeLifetimeMs: number;
  now: () => string;
  readCapabilityEnvelope: (request: CapabilityHandshakeRequest) => Promise<unknown>;
}>;

let nonceSequence = 0;

function nextNonce(): string {
  if (nonceSequence === Number.MAX_SAFE_INTEGER) {
    throw new Error("Codex capability nonce sequence exhausted");
  }
  nonceSequence += 1;
  return `${nonceSequence}:${crypto.randomUUID()}`;
}

async function staticCodexCapabilityRecord(): Promise<CapabilityRecord> {
  const value: unknown = JSON.parse(
    await Bun.file(new URL("./capability.json", import.meta.url)).text(),
  );
  return parseCapabilityRecord(value);
}

export async function discoverCodexCapabilities(
  handshake: CodexCapabilityHandshake | undefined,
): Promise<CapabilityRecord> {
  if (handshake === undefined) return staticCodexCapabilityRecord();

  const request = Object.freeze({
    host: "codex",
    sessionId: handshake.sessionId,
    snapshotId: handshake.snapshotId,
    nonce: nextNonce(),
  } satisfies CapabilityHandshakeRequest);
  const envelope = await handshake.readCapabilityEnvelope(request);
  return parseCapabilityHandshakeEnvelope(envelope, {
    request,
    trustedProducerId: handshake.trustedProducerId,
    allowedCapabilities: handshake.allowedCapabilities,
    allowedEnforcementProfile: handshake.allowedEnforcementProfile,
    maxEnvelopeLifetimeMs: handshake.maxEnvelopeLifetimeMs,
    now: handshake.now(),
  });
}
