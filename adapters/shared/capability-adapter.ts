import {
  parseCapabilityHandshakeEnvelope,
  type CapabilityHandshakeRequest,
} from "../../system/runtime/capability-handshake";
import {
  parseCapabilityRecord,
  type CapabilityRecord,
  type CapabilitySet,
} from "../../system/runtime/capability-model";

export type HostCapabilityHandshake = Readonly<{
  sessionId: string;
  snapshotId: string;
  trustedProducerId: string;
  allowedCapabilities: CapabilitySet;
  maxEnvelopeLifetimeMs: number;
  now: () => string;
  readCapabilityEnvelope: (request: CapabilityHandshakeRequest) => Promise<unknown>;
}>;

let nonceSequence = 0;

function nextNonce(host: string): string {
  if (nonceSequence === Number.MAX_SAFE_INTEGER) {
    throw new Error(`${host} capability nonce sequence exhausted`);
  }
  nonceSequence += 1;
  return `${nonceSequence}:${crypto.randomUUID()}`;
}

export async function discoverHostCapabilities(
  host: string,
  staticRecordUrl: URL,
  handshake: HostCapabilityHandshake | undefined,
): Promise<CapabilityRecord> {
  if (handshake === undefined) {
    const value: unknown = JSON.parse(await Bun.file(staticRecordUrl).text());
    return parseCapabilityRecord(value);
  }

  const request = Object.freeze({
    host,
    sessionId: handshake.sessionId,
    snapshotId: handshake.snapshotId,
    nonce: nextNonce(host),
  } satisfies CapabilityHandshakeRequest);
  const envelope = await handshake.readCapabilityEnvelope(request);
  return parseCapabilityHandshakeEnvelope(envelope, {
    request,
    trustedProducerId: handshake.trustedProducerId,
    allowedCapabilities: handshake.allowedCapabilities,
    maxEnvelopeLifetimeMs: handshake.maxEnvelopeLifetimeMs,
    now: handshake.now(),
  });
}
