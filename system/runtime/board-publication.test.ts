import { describe, expect, test } from "bun:test";
import { CAPABILITY_NAMES, type CapabilitySet } from "./capability-model";
import {
  BOARD_PUBLICATION_REQUIRED_CAPABILITIES,
  DEFAULT_BOARD_PUBLICATION_POLICY,
  parseBoardPublicationPolicy,
  publishBoard,
  resolveBoardPublicationDecision,
  type BoardPublisherInput,
} from "./board-publication";

function capabilities(overrides: Partial<CapabilitySet> = {}): CapabilitySet {
  return Object.freeze(Object.fromEntries(
    CAPABILITY_NAMES.map((name) => [name, overrides[name] ?? false]),
  ) as CapabilitySet);
}

const publisherInput: BoardPublisherInput = {
  rootDir: "/repo",
  requestPath: "/state/request.json",
  manifestPath: "/state/manifest.json",
  stateDir: "/state",
  artifactDir: "/state/artifacts",
  runId: "run-1",
  sessionId: "session-1",
  snapshotId: "snapshot-1",
  sessionHost: "omp",
};

describe("universal Board publication policy", () => {
  test("requires the shared execution, snapshot, and persistence capabilities", () => {
    expect(BOARD_PUBLICATION_REQUIRED_CAPABILITIES).toEqual([
      "executeCommands",
      "bindSnapshot",
      "persistEvidence",
    ]);
    expect(DEFAULT_BOARD_PUBLICATION_POLICY).toEqual({
      schemaVersion: "traceknot-board-policy/v1",
      publication: "required",
      onUnavailable: "report",
      explicitOptOut: "--no-board",
    });
  });

  test("reports unavailable with every missing prerequisite", () => {
    expect(resolveBoardPublicationDecision(capabilities())).toMatchObject({
      status: "unavailable",
      missingCapabilities: ["executeCommands", "bindSnapshot", "persistEvidence"],
    });
  });

  test("is ready only when all shared prerequisites are advertised", () => {
    expect(resolveBoardPublicationDecision(capabilities({
      executeCommands: true,
      bindSnapshot: true,
      persistEvidence: true,
    }))).toMatchObject({
      status: "ready",
      missingCapabilities: [],
    });
  });

  test("records explicit opt-out independently of capabilities", () => {
    expect(resolveBoardPublicationDecision(capabilities(), { explicitOptOut: true })).toMatchObject({
      status: "disabled",
      missingCapabilities: [],
      reason: "--no-board",
    });
  });

  test("rejects policy drift", () => {
    expect(() => parseBoardPublicationPolicy({
      ...DEFAULT_BOARD_PUBLICATION_POLICY,
      publication: "optional",
    })).toThrow("Board publication must be required");
    expect(() => parseBoardPublicationPolicy({
      ...DEFAULT_BOARD_PUBLICATION_POLICY,
      extra: true,
    })).toThrow("keys are invalid");
  });
  test("does not invoke a publisher when capabilities are unavailable", async () => {
    let invoked = false;
    const outcome = await publishBoard(capabilities(), {
      publish: async () => {
        invoked = true;
        throw Error("must not run");
      },
    }, publisherInput);
    expect(invoked).toBe(false);
    expect(outcome).toMatchObject({
      status: "unavailable",
      missingCapabilities: ["executeCommands", "bindSnapshot", "persistEvidence"],
    });
  });

  test("reports a missing publisher without inventing a Board", async () => {
    const outcome = await publishBoard(capabilities({
      executeCommands: true,
      bindSnapshot: true,
      persistEvidence: true,
    }), undefined, publisherInput);
    expect(outcome).toMatchObject({
      status: "unavailable",
      missingCapabilities: [],
      reason: "no Board publisher is available",
    });
  });

  test("keeps publisher failures separate from the QA decision", async () => {
    const outcome = await publishBoard(capabilities({
      executeCommands: true,
      bindSnapshot: true,
      persistEvidence: true,
    }), {
      publish: async () => {
        throw Error("publisher unavailable");
      },
    }, publisherInput);
    expect(outcome).toMatchObject({
      status: "unavailable",
      reason: "Board publisher failed: publisher unavailable",
    });
  });

});
