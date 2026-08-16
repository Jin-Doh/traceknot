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
    expect(evidence.events).toEqual(["PREPARED", "FAILED", "FAILED"]);
  });

  test("keeps updater execution on a separate authority API", async () => {
    const authority = new UpdaterAuthority();
    const calls: string[] = [];
    const result = await executeUpdaterEgress(authority, {
      destination,
      protocol: "https",
      payload: "release",
    }, transport("updated", calls));
    expect(result).toBe("updated");
    expect(calls).toEqual(["example.test:release"]);
  });
});
