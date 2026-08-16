import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseCapabilityRecord, type CapabilitySet } from "../../system/runtime/capability-model";
import {
  discoverClaudeCodeCapabilities,
  type ClaudeCodeCapabilityHandshake,
} from "./adapter";

const ALL_FALSE = Object.freeze({
  executeCommands: false,
  executeBrowser: false,
  captureArtifacts: false,
  bindSnapshot: false,
  provideIndependentEvidence: false,
  persistEvidence: false,
  approveExceptions: false,
  isolatedReadOnlyReview: false,
  enforcedStructuredOutput: false,
  enforceSkillOriginEgressDeny: false,
} satisfies CapabilitySet);

function capabilities(overrides: Partial<CapabilitySet> = {}): CapabilitySet {
  return Object.freeze({ ...ALL_FALSE, ...overrides });
}

function record(value: CapabilitySet, host = "claude-code"): unknown {
  return {
    schemaVersion: "quality-capability/v2",
    host,
    adapterVersion: "claude-code-runtime-v1",
    capabilities: value,
    limitations: [],
  };
}

function envelope(
  request: Readonly<{ sessionId: string; snapshotId: string; nonce: string }>,
  capabilityRecord: unknown,
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    record: capabilityRecord,
    sessionId: request.sessionId,
    snapshotId: request.snapshotId,
    producerId: "claude-code-native-adapter",
    nonce: request.nonce,
    issuedAt: "2026-08-10T05:59:00Z",
    expiresAt: "2026-08-10T06:01:00Z",
    ...overrides,
  };
}

function handshake(
  readCapabilityEnvelope: ClaudeCodeCapabilityHandshake["readCapabilityEnvelope"],
): ClaudeCodeCapabilityHandshake {
  return {
    sessionId: "claude-session",
    snapshotId: "snapshot-1",
    trustedProducerId: "claude-code-native-adapter",
    allowedCapabilities: capabilities({
      executeCommands: true,
      enforcedStructuredOutput: true,
    }),
    maxEnvelopeLifetimeMs: 5 * 60 * 1_000,
    now: () => "2026-08-10T06:00:00Z",
    readCapabilityEnvelope,
  };
}

describe("Claude Code capability adapter", () => {
  test("loads the conservative checked-in record without a handshake", async () => {
    const staticRecord = parseCapabilityRecord(
      JSON.parse(await Bun.file(resolve("adapters/claude-code/capability.json")).text()),
    );

    expect(await discoverClaudeCodeCapabilities(undefined)).toEqual(staticRecord);
    expect(Object.values(staticRecord.capabilities).every((enabled) => !enabled)).toBe(true);
  });

  test("binds each discovery to a distinct challenge", async () => {
    const nonces: string[] = [];
    const runtime = handshake(async (request) => {
      nonces.push(request.nonce);
      return envelope(
        request,
        record(capabilities({ executeCommands: true, enforcedStructuredOutput: true })),
      );
    });

    expect((await discoverClaudeCodeCapabilities(runtime)).capabilities).toMatchObject({
      executeCommands: true,
      enforcedStructuredOutput: true,
    });
    await discoverClaudeCodeCapabilities(runtime);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  test("rejects a cached envelope replay", async () => {
    let cached: unknown;
    const runtime = handshake(async (request) => {
      cached ??= envelope(request, record(ALL_FALSE));
      return cached;
    });

    await expect(discoverClaudeCodeCapabilities(runtime)).resolves.toMatchObject({
      host: "claude-code",
    });
    await expect(discoverClaudeCodeCapabilities(runtime)).rejects.toMatchObject({
      code: "NONCE_MISMATCH",
    });
  });

  test("rejects another host and an untrusted producer", async () => {
    const wrongHost = handshake(async (request) =>
      envelope(request, record(ALL_FALSE, "codex")));
    const wrongProducer = handshake(async (request) =>
      envelope(request, record(ALL_FALSE), { producerId: "hook-event" }));

    await expect(discoverClaudeCodeCapabilities(wrongHost)).rejects.toMatchObject({
      code: "HOST_MISMATCH",
    });
    await expect(discoverClaudeCodeCapabilities(wrongProducer)).rejects.toMatchObject({
      code: "PRODUCER_MISMATCH",
    });
  });

  test("rejects capabilities above the integration ceiling", async () => {
    const runtime = handshake(async (request) =>
      envelope(request, record(capabilities({ approveExceptions: true }))));

    await expect(discoverClaudeCodeCapabilities(runtime)).rejects.toMatchObject({
      code: "CAPABILITY_ESCALATION",
    });
  });

  test("rejects unverified Skill-origin egress enforcement claims", async () => {
    const runtime = handshake(async (request) =>
      envelope(request, record(capabilities({ enforceSkillOriginEgressDeny: true }))));

    await expect(discoverClaudeCodeCapabilities(runtime)).rejects.toMatchObject({
      code: "CAPABILITY_ESCALATION",
    });
  });

  test("rejects overlong or malformed envelopes", async () => {
    const overlong = handshake(async (request) =>
      envelope(request, record(ALL_FALSE), {
        issuedAt: "2026-08-10T05:00:00Z",
        expiresAt: "2026-08-10T07:00:00Z",
      }));
    const malformed = handshake(async (request) =>
      envelope(request, {
        schemaVersion: "quality-capability/v2",
        host: "claude-code",
        adapterVersion: "claude-code-runtime-v1",
        capabilities: {},
      }));

    await expect(discoverClaudeCodeCapabilities(overlong)).rejects.toMatchObject({
      code: "LIFETIME_EXCEEDED",
    });
    await expect(discoverClaudeCodeCapabilities(malformed)).rejects.toBeInstanceOf(Error);
  });
});
