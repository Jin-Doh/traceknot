import {
  parseCapabilityRecord,
  type CapabilityRecord,
  type CapabilitySet,
} from "../../system/runtime/capability-model";

export type CodexCapabilityHandshake = Readonly<{
  readCapabilityRecord: () => Promise<unknown>;
}>;

export class CodexCapabilityHandshakeError extends Error {
  readonly code = "HOST_MISMATCH";
  readonly actualHost: string;

  constructor(actualHost: string) {
    super(`Codex capability handshake returned host ${actualHost}`);
    this.name = "CodexCapabilityHandshakeError";
    this.actualHost = actualHost;
  }
}

const STATIC_CAPABILITIES = Object.freeze({
  executeCommands: false,
  executeBrowser: false,
  captureArtifacts: false,
  bindSnapshot: false,
  provideIndependentEvidence: false,
  persistEvidence: false,
  approveExceptions: false,
  isolatedReadOnlyReview: false,
  enforcedStructuredOutput: false,
} satisfies CapabilitySet);

const STATIC_CODEX_CAPABILITY_RECORD = Object.freeze({
  schemaVersion: "quality-capability/v2",
  host: "codex",
  adapterVersion: "portable-v1",
  capabilities: STATIC_CAPABILITIES,
  limitations: Object.freeze([
    "Capabilities must be supplied by a runtime handshake; the host name grants none.",
    "Codex owns subagents, models, turns, tools, retries, and completion.",
    "Hooks and app-server lifecycle notifications are observations only.",
  ]),
} satisfies CapabilityRecord);

export async function discoverCodexCapabilities(
  handshake: CodexCapabilityHandshake | undefined,
): Promise<CapabilityRecord> {
  if (handshake === undefined) return STATIC_CODEX_CAPABILITY_RECORD;

  const record = parseCapabilityRecord(await handshake.readCapabilityRecord());
  if (record.host !== "codex") throw new CodexCapabilityHandshakeError(record.host);
  return record;
}
