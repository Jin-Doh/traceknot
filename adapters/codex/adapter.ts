import {
  parseCapabilityHandshakeEnvelope,
  type CapabilityHandshakeRequest,
} from "../../system/runtime/capability-handshake";
import {
  parseCapabilityRecord,
  type CapabilityRecord,
  type CapabilitySet,
} from "../../system/runtime/capability-model";

export type CodexCapabilityHandshake = Readonly<{
  sessionId: string;
  snapshotId: string;
  trustedProducerId: string;
  allowedCapabilities: CapabilitySet;
  now: () => string;
  createNonce: () => string;
  readCapabilityEnvelope: (request: CapabilityHandshakeRequest) => Promise<unknown>;
}>;

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
    nonce: handshake.createNonce(),
  } satisfies CapabilityHandshakeRequest);
  const envelope = await handshake.readCapabilityEnvelope(request);
  return parseCapabilityHandshakeEnvelope(envelope, {
    request,
    trustedProducerId: handshake.trustedProducerId,
    allowedCapabilities: handshake.allowedCapabilities,
    now: handshake.now(),
  });
}
