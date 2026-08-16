import { describe, expect, test } from "bun:test";
import {
  canonicalizeDestination,
  evaluateGovernedEgress,
  executeGovernedEgress,
  executeUpdaterEgress,
  GovernedEgressDeniedError,
  type DurableEgressEvidenceStore,
  type EgressAuthorization,
  type EgressIntent,
  type GovernedTransport,
  type TrustedExecutionScope,
  UpdaterAuthority,
} from "./skill-egress-policy";

const destination = canonicalizeDestination("https://example.test/qa");
const scope: TrustedExecutionScope = {
  scopeId: "scope-user-task",
  origin: "user-task",
  issuedBy: "host-runtime",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const intent: EgressIntent = {
  destination,
  protocol: "https",
  executionSurface: "native-http-client",
  dataClasses: ["public"],
};
const authorization: EgressAuthorization = {
  authorizationId: "auth-public-qa",
  scopeId: scope.scopeId,
  destination,
  protocol: "https",
  executionSurface: "native-http-client",
  dataClasses: ["public"],
  sensitiveDataAuthorized: false,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

class Evidence implements DurableEgressEvidenceStore {
  events: string[] = [];
  async prepared(): Promise<void> { this.events.push("PREPARED"); }
  async completed(): Promise<void> { this.events.push("COMPLETED"); }
  async failed(): Promise<void> { this.events.push("FAILED"); }
}

const transport = (result: unknown, calls: string[] = []): GovernedTransport<string, unknown> => ({
  async send(received, payload) {
    calls.push(`${received.destination.hostname}:${payload}`);
    return result;
  },
});

describe("governed Skill egress boundary", () => {
  test("canonicalizes destination identity and separates protocol from execution surface", () => {
    expect(destination).toEqual({ scheme: "https", hostname: "example.test", port: 443, pathPrefix: "/qa" });
    expect(intent.protocol).toBe("https");
    expect(intent.executionSurface).toBe("native-http-client");
  });

  test("denies Skill scope before invoking a transmitter", async () => {
    const calls: string[] = [];
    const skillScope = { ...scope, scopeId: "scope-skill", origin: "skill" as const };
    const observation = evaluateGovernedEgress(skillScope, intent, authorization);
    expect(observation).toMatchObject({ decision: "deny", reason: "SKILL_ORIGIN_EGRESS" });
    await expect(executeGovernedEgress(skillScope, intent, authorization, transport("sent", calls), "payload", new Evidence())).rejects.toBeInstanceOf(GovernedEgressDeniedError);
    expect(calls).toEqual([]);
  });

  test("blocks an unattributed scope and binds mandatory failure", () => {
    const observation = evaluateGovernedEgress(
      { ...scope, origin: "unknown", scopeId: "scope-unknown" },
      { ...intent, mandatory: true, requestId: "request-unknown", obligationId: "obligation-unknown" },
      authorization,
    );
    expect(observation).toMatchObject({ decision: "blocked", reason: "ORIGIN_UNATTRIBUTABLE", failure: { status: "BLOCKED" } });
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.failure)).toBe(true);
  });

  test.each([
    ["destination", { ...authorization, destination: canonicalizeDestination("https://other.test/qa") }],
    ["protocol", { ...authorization, protocol: "http" as const }],
    ["scope", { ...authorization, scopeId: "other-scope" }],
  ])("rejects mismatched %s authorization", (_label: string, mismatched: EgressAuthorization) => {
    expect(evaluateGovernedEgress(scope, intent, mismatched)).toMatchObject({ decision: "deny" });
  });

  test("requires explicit approval for repository, artifact, log, conversation, environment, and credential data", () => {
    for (const dataClass of ["repository", "artifact", "log", "conversation", "environment", "credential"] as const) {
      const result = evaluateGovernedEgress(scope, { ...intent, dataClasses: [dataClass] }, { ...authorization, dataClasses: [dataClass] });
      expect(result).toMatchObject({ decision: "deny", reason: "SENSITIVE_DATA_UNAUTHORIZED" });
    }
  });

  test("snapshots and freezes caller-owned data classes", () => {
    const dataClasses = ["public"] as const;
    const observation = evaluateGovernedEgress(scope, { ...intent, dataClasses }, authorization);
    expect(observation.dataClasses).toEqual(["public"]);
    expect(Object.isFrozen(observation.dataClasses)).toBe(true);
  });

  test("persists PREPARED before transmission and terminal evidence after success", async () => {
    const evidence = new Evidence();
    const calls: string[] = [];
    const result = await executeGovernedEgress(scope, intent, authorization, transport("sent", calls), "payload", evidence);
    expect(result.value).toBe("sent");
    expect(calls).toEqual(["example.test:payload"]);
    expect(evidence.events).toEqual(["PREPARED", "COMPLETED"]);
  });

  test("records FAILED evidence when transport fails", async () => {
    const evidence = new Evidence();
    const failing: GovernedTransport<string, unknown> = { async send() { throw new Error("network failed"); } };
    await expect(executeGovernedEgress(scope, intent, authorization, failing, "payload", evidence)).rejects.toThrow("network failed");
    expect(evidence.events).toEqual(["PREPARED", "FAILED"]);
  });

  test("requires fresh authorization for redirects instead of following them", async () => {
    const evidence = new Evidence();
    const redirect = { kind: "redirect" as const, destination: canonicalizeDestination("https://other.test/qa") };
    await expect(executeGovernedEgress(scope, intent, authorization, transport(redirect), "payload", evidence)).rejects.toBeInstanceOf(GovernedEgressDeniedError);
    expect(evidence.events).toEqual(["PREPARED", "FAILED"]);
  });

  test("keeps updater execution on a separate authority API", async () => {
    const authority = UpdaterAuthority.issue();
    const calls: string[] = [];
    const result = await executeUpdaterEgress(authority, {
      destination,
      protocol: "https",
      payload: "release",
    }, transport("updated", calls));
    expect(result).toBe("updated");
    expect(calls).toEqual(["example.test:release"]);
  });
  test("does not attach failure to an allowed observation", () => {
    const observation = evaluateGovernedEgress(scope, intent, authorization);
    expect(observation.decision).toBe("allow");
    expect(observation.failure).toBeUndefined();
  });

  test("rejects expired scopes and malformed authorization expirations", () => {
    expect(() => evaluateGovernedEgress(
      { ...scope, expiresAt: new Date(Date.now() - 1_000).toISOString() },
      intent,
      authorization,
    )).toThrow("scope.expiresAt is expired");
    expect(evaluateGovernedEgress(scope, intent, {
      ...authorization,
      expiresAt: "not-a-timestamp",
    }).reason).toBe("MISSING_AUTHORIZATION");
  });

  test("records malformed mandatory Skill attempts before rethrowing validation errors", async () => {
    const evidence = new Evidence();
    const malformedIntent = { ...intent, executionSurface: "invalid", mandatory: true, requestId: "request-1", obligationId: "obligation-1" } as unknown as EgressIntent;
    await expect(executeGovernedEgress(
      { ...scope, origin: "skill" },
      malformedIntent,
      authorization,
      transport("sent"),
      "payload",
      evidence,
    )).rejects.toThrow("executionSurface is invalid");
    expect(evidence.events).toEqual(["FAILED"]);
  });

  test("binds authorization to the execution surface", () => {
    expect(evaluateGovernedEgress(scope, { ...intent, executionSurface: "browser" }, authorization)).toMatchObject({
      decision: "deny",
      reason: "MISSING_AUTHORIZATION",
    });
  });
  test("denies malformed authorization on mandatory Skill requests before dereferencing it", async () => {
    const evidence = new Evidence();
    const malformedAuthorization = { ...authorization, dataClasses: undefined } as unknown as EgressAuthorization;
    await expect(executeGovernedEgress(
      { ...scope, origin: "skill" },
      { ...intent, mandatory: true, requestId: "request-2", obligationId: "obligation-2" },
      malformedAuthorization,
      transport("sent"),
      "payload",
      evidence,
    )).rejects.toBeInstanceOf(GovernedEgressDeniedError);
    expect(evidence.events).toEqual(["FAILED"]);
  });

  test("records unattributed mandatory failures before dereferencing malformed authorization", async () => {
    const evidence = new Evidence();
    const malformedAuthorization = { ...authorization, dataClasses: undefined } as unknown as EgressAuthorization;
    await expect(executeGovernedEgress(
      { ...scope, origin: "unknown" },
      { ...intent, mandatory: true, requestId: "request-3", obligationId: "obligation-3" },
      malformedAuthorization,
      transport("sent"),
      "payload",
      evidence,
    )).rejects.toBeInstanceOf(GovernedEgressDeniedError);
    expect(evidence.events).toEqual(["FAILED"]);
  });

  test("does not persist fallback failures for malformed obligation identifiers", async () => {
    const evidence = new Evidence();
    const malformedIntent = { ...intent, mandatory: true, requestId: " request-4", obligationId: "obligation-4" };
    await expect(executeGovernedEgress(
      { ...scope, origin: "skill" },
      malformedIntent,
      authorization,
      transport("sent"),
      "payload",
      evidence,
    )).rejects.toThrow("requestId must be a non-empty trimmed string");
    expect(evidence.events).toEqual([]);
  });

  test("rejects non-boolean sensitive authorization flags", () => {
    expect(evaluateGovernedEgress(scope, { ...intent, dataClasses: ["credential"] }, {
      ...authorization,
      dataClasses: ["credential"],
      sensitiveDataAuthorized: "false",
    } as unknown as EgressAuthorization)).toMatchObject({
      decision: "deny",
      reason: "MISSING_AUTHORIZATION",
    });
  });

  test("rechecks freshness after prepared evidence", async () => {
    let now = Date.now();
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const evidence: DurableEgressEvidenceStore = {
        async prepared() {
          now += 60_000;
        },
        async completed() {},
        async failed() {},
      };
      const calls: string[] = [];
      await expect(executeGovernedEgress(scope, intent, authorization, transport("sent", calls), "payload", evidence)).rejects.toBeInstanceOf(GovernedEgressDeniedError);
      expect(calls).toEqual([]);
    } finally {
      Date.now = originalNow;
    }
  });

  test("snapshots destinations in observations", () => {
    const mutableDestination = { ...destination };
    const observation = evaluateGovernedEgress(scope, { ...intent, destination: mutableDestination }, authorization);
    mutableDestination.hostname = "attacker.test";
    expect(observation.destination.hostname).toBe("example.test");
    expect(Object.isFrozen(observation.destination)).toBe(true);
  });

  test("snapshots payload before prepared evidence", async () => {
    const payload = { body: "public" };
    const evidence: DurableEgressEvidenceStore = {
      async prepared() {
        payload.body = "credential";
      },
      async completed() {},
      async failed() {},
    };
    let received: { body: string } | undefined;
    await executeGovernedEgress(scope, intent, authorization, {
      async send(_receivedAuthorization, receivedPayload) {
        received = receivedPayload;
        return "sent";
      },
    }, payload, evidence);
    expect(received).toEqual({ body: "public" });
    expect(Object.isFrozen(received)).toBe(true);
  });


  test("snapshots authorization before prepared evidence can mutate it", async () => {
    const mutableAuthorization = {
      ...authorization,
      destination: { ...authorization.destination },
    } as EgressAuthorization & { destination: { hostname: string } };
    const evidence: DurableEgressEvidenceStore = {
      async prepared() {
        mutableAuthorization.destination.hostname = "attacker.test";
      },
      async completed() {},
      async failed() {},
    };
    const destinations: string[] = [];
    await executeGovernedEgress(scope, intent, mutableAuthorization, {
      async send(received) {
        destinations.push(received.destination.hostname);
        return "sent";
      },
    }, "payload", evidence);
    expect(destinations).toEqual(["example.test"]);
  });
});
