import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseCapabilityRecord } from "../../system/runtime/capability-model";
import {
  CodexCapabilityHandshakeError,
  discoverCodexCapabilities,
} from "./adapter";

function runtimeRecord(executeCommands: boolean, host = "codex"): unknown {
  return {
    schemaVersion: "quality-capability/v2",
    host,
    adapterVersion: "codex-runtime-v1",
    capabilities: {
      executeCommands,
      executeBrowser: false,
      captureArtifacts: false,
      bindSnapshot: false,
      provideIndependentEvidence: false,
      persistEvidence: false,
      approveExceptions: false,
      isolatedReadOnlyReview: false,
      enforcedStructuredOutput: false,
    },
    limitations: [],
  };
}

describe("Codex capability adapter", () => {
  test("uses the conservative static record when no handshake exists", async () => {
    const staticRecord = parseCapabilityRecord(
      JSON.parse(await Bun.file(resolve("adapters/codex/capability.json")).text()),
    );

    expect(await discoverCodexCapabilities(undefined)).toEqual(staticRecord);
    expect(Object.values(staticRecord.capabilities).every((enabled) => !enabled)).toBe(true);
  });

  test("reads a fresh runtime handshake for every discovery", async () => {
    let calls = 0;
    const handshake = {
      readCapabilityRecord: async (): Promise<unknown> => runtimeRecord(++calls === 2),
    };

    expect((await discoverCodexCapabilities(handshake)).capabilities.executeCommands).toBe(false);
    expect((await discoverCodexCapabilities(handshake)).capabilities.executeCommands).toBe(true);
    expect(calls).toBe(2);
  });

  test("rejects capability records for a different host", async () => {
    const handshake = {
      readCapabilityRecord: async (): Promise<unknown> => runtimeRecord(true, "claude-code"),
    };

    await expect(discoverCodexCapabilities(handshake)).rejects.toBeInstanceOf(
      CodexCapabilityHandshakeError,
    );
  });

  test("rejects malformed handshake records instead of granting capabilities", async () => {
    const handshake = {
      readCapabilityRecord: async (): Promise<unknown> => ({
        schemaVersion: "quality-capability/v2",
        host: "codex",
        adapterVersion: "codex-runtime-v1",
        capabilities: {},
      }),
    };

    await expect(discoverCodexCapabilities(handshake)).rejects.toBeInstanceOf(Error);
  });

  test("preserves runtime handshake failures", async () => {
    const failure = new TypeError("handshake unavailable");
    const handshake = {
      readCapabilityRecord: async (): Promise<unknown> => {
        throw failure;
      },
    };

    await expect(discoverCodexCapabilities(handshake)).rejects.toBe(failure);
  });
});
