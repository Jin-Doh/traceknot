import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseCapabilityRecord, type CapabilitySet } from "../../system/runtime/capability-model";
import { CapabilityHandshakeError } from "../../system/runtime/capability-handshake";
import {
  discoverCodexCapabilities,
  type CodexCapabilityHandshake,
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
} satisfies CapabilitySet);

function runtimeRecord(capabilities: CapabilitySet, host = "codex"): unknown {
  return {
    schemaVersion: "quality-capability/v2",
    host,
    adapterVersion: "codex-runtime-v1",
    capabilities,
    limitations: [],
  };
}

function runtimeCapabilities(overrides: Partial<CapabilitySet> = {}): CapabilitySet {
  return Object.freeze({ ...ALL_FALSE, ...overrides });
}

function runtimeHandshake(
  readCapabilityEnvelope: CodexCapabilityHandshake["readCapabilityEnvelope"],
  overrides: Partial<Omit<CodexCapabilityHandshake, "readCapabilityEnvelope">> = {},
): CodexCapabilityHandshake {
  return {
    sessionId: "session-1",
    snapshotId: "snapshot-1",
    trustedProducerId: "codex-native-adapter",
    allowedCapabilities: runtimeCapabilities({ executeCommands: true }),
    maxEnvelopeLifetimeMs: 5 * 60 * 1_000,
    now: () => "2026-08-10T05:00:00Z",
    readCapabilityEnvelope,
    ...overrides,
  };
}

function envelope(
  request: Readonly<{ sessionId: string; snapshotId: string; nonce: string }>,
  record: unknown,
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    record,
    sessionId: request.sessionId,
    snapshotId: request.snapshotId,
    producerId: "codex-native-adapter",
    nonce: request.nonce,
    issuedAt: "2026-08-10T04:59:00Z",
    expiresAt: "2026-08-10T05:01:00Z",
    ...overrides,
  };
}

describe("Codex capability adapter", () => {
  test("loads the conservative checked-in record when no handshake exists", async () => {
    const staticRecord = parseCapabilityRecord(
      JSON.parse(await Bun.file(resolve("adapters/codex/capability.json")).text()),
    );

    expect(await discoverCodexCapabilities(undefined)).toEqual(staticRecord);
    expect(Object.values(staticRecord.capabilities).every((enabled) => !enabled)).toBe(true);
  });

  test("binds every discovery to a fresh nonce and runtime context", async () => {
    let calls = 0;
    const requests: string[] = [];
    const handshake = runtimeHandshake(
      async (request): Promise<unknown> => {
        requests.push(request.nonce);
        return envelope(
          request,
          runtimeRecord(runtimeCapabilities({ executeCommands: ++calls === 2 })),
        );
      },
    );

    expect((await discoverCodexCapabilities(handshake)).capabilities.executeCommands).toBe(false);
    expect((await discoverCodexCapabilities(handshake)).capabilities.executeCommands).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toBe(requests[1]);
  });

  test("rejects records for another host", async () => {
    const handshake = runtimeHandshake(async (request) =>
      envelope(request, runtimeRecord(ALL_FALSE, "claude-code")));

    await expect(discoverCodexCapabilities(handshake)).rejects.toMatchObject({
      code: "HOST_MISMATCH",
    });
  });

  test("rejects replayed envelopes", async () => {
    let cached: unknown;
    const handshake = runtimeHandshake(async (request) => {
      cached ??= envelope(request, runtimeRecord(ALL_FALSE));
      return cached;
    });

    await expect(discoverCodexCapabilities(handshake)).resolves.toMatchObject({ host: "codex" });
    await expect(discoverCodexCapabilities(handshake)).rejects.toMatchObject({
      code: "NONCE_MISMATCH",
    });
  });

  test("rejects expired envelopes", async () => {
    const handshake = runtimeHandshake(async (request) =>
      envelope(request, runtimeRecord(ALL_FALSE), {
        issuedAt: "2026-08-10T03:59:00Z",
        expiresAt: "2026-08-10T04:00:00Z",
      }));

    await expect(discoverCodexCapabilities(handshake)).rejects.toMatchObject({
      code: "EXPIRED",
    });
  });

  test("rejects validity windows above the trusted maximum lifetime", async () => {
    const handshake = runtimeHandshake(async (request) =>
      envelope(request, runtimeRecord(ALL_FALSE), {
        issuedAt: "2026-08-10T04:00:00Z",
        expiresAt: "2026-08-10T06:00:00Z",
      }));

    await expect(discoverCodexCapabilities(handshake)).rejects.toMatchObject({
      code: "LIFETIME_EXCEEDED",
    });
  });

  test("rejects envelopes from an untrusted producer", async () => {
    const handshake = runtimeHandshake(async (request) =>
      envelope(request, runtimeRecord(ALL_FALSE), {
        producerId: "self-declared-producer",
      }));

    await expect(discoverCodexCapabilities(handshake)).rejects.toBeInstanceOf(
      CapabilityHandshakeError,
    );
    await expect(discoverCodexCapabilities(handshake)).rejects.toMatchObject({
      code: "PRODUCER_MISMATCH",
    });
  });

  test("rejects capabilities above the trusted integration ceiling", async () => {
    const handshake = runtimeHandshake(async (request) =>
      envelope(
        request,
        runtimeRecord(runtimeCapabilities({ approveExceptions: true })),
      ));

    await expect(discoverCodexCapabilities(handshake)).rejects.toMatchObject({
      code: "CAPABILITY_ESCALATION",
    });
  });

  test("rejects malformed handshake records instead of granting capabilities", async () => {
    const handshake = runtimeHandshake(async (request) =>
      envelope(request, {
        schemaVersion: "quality-capability/v2",
        host: "codex",
        adapterVersion: "codex-runtime-v1",
        capabilities: {},
      }));

    await expect(discoverCodexCapabilities(handshake)).rejects.toBeInstanceOf(Error);
  });

  test("preserves trusted integration failures", async () => {
    const failure = new TypeError("handshake unavailable");
    const handshake = runtimeHandshake(async () => {
      throw failure;
    });

    await expect(discoverCodexCapabilities(handshake)).rejects.toBe(failure);
  });
});
