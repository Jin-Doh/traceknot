import { describe, expect, test } from "bun:test";
import {
  assertSkillEgressAllowed,
  decideSkillEgress,
  executeSkillEgress,
  SkillEgressDeniedError,
  type SkillEgressPolicyInput,
} from "./skill-egress-policy";

const base: SkillEgressPolicyInput = {
  origin: "user-task",
  destination: "https://example.test/qa",
  transport: "https",
  dataClasses: ["public"],
  authorizationBasisId: "basis-public-qa",
  authorizedDestination: "https://example.test/qa",
};

describe("Skill-origin egress policy", () => {
  test("allows an explicitly authorized public user-task request", () => {
    expect(decideSkillEgress(base)).toMatchObject({
      decision: "allow",
      reason: "AUTHORIZED_USER_TASK",
      origin: "user-task",
    });
  });

  test("denies every Skill-origin transport before destination authorization", () => {
    for (const transport of ["dns", "tcp", "udp", "http", "https", "websocket", "browser", "subprocess"] as const) {
      expect(decideSkillEgress({
        ...base,
        origin: "skill",
        transport,
        dataClasses: ["public"],
        authorizationBasisId: "basis-public-qa",
      })).toMatchObject({ decision: "deny", reason: "SKILL_ORIGIN_EGRESS" });
    }
  });

  test("binds mandatory denials to a canonical failed obligation", () => {
    const observation = decideSkillEgress({
      ...base,
      origin: "skill",
      requestId: "request-1",
      obligationId: "obligation-1",
      mandatory: true,
    });
    expect(observation).toMatchObject({
      decision: "deny",
      requestId: "request-1",
      obligationId: "obligation-1",
      failure: {
        status: "FAIL",
        requestId: "request-1",
        obligationId: "obligation-1",
        reason: "SKILL_ORIGIN_EGRESS",
      },
    });
  });

  test("blocks an unattributed request in the hardened profile", () => {
    expect(decideSkillEgress({ ...base, origin: "unknown" })).toMatchObject({
      decision: "blocked",
      reason: "ORIGIN_UNATTRIBUTABLE",
    });
  });

  test("keeps updater traffic outside the Skill decision boundary", () => {
    expect(decideSkillEgress({ ...base, origin: "updater" })).toMatchObject({
      decision: "out-of-scope",
      reason: "UPDATER_TRUST_BOUNDARY",
    });
  });

  test("denies a request without an exact authorized destination", () => {
    expect(decideSkillEgress({ ...base, authorizedDestination: "https://other.test/qa" })).toMatchObject({
      decision: "deny",
      reason: "MISSING_AUTHORIZATION",
    });
  });

  test("denies sensitive data without explicit sensitive-data authorization", () => {
    expect(decideSkillEgress({ ...base, dataClasses: ["repository", "environment"] })).toMatchObject({
      decision: "deny",
      reason: "SENSITIVE_DATA_UNAUTHORIZED",
    });
    expect(decideSkillEgress({
      ...base,
      dataClasses: ["conversation"],
      sensitiveDataAuthorized: true,
    })).toMatchObject({ decision: "allow", reason: "AUTHORIZED_USER_TASK" });
  });

  test("does not expose policy-only input fields in observations", () => {
    const observation = decideSkillEgress({ ...base, sensitiveDataAuthorized: true });
    expect(observation).not.toHaveProperty("authorizedDestination");
    expect(observation).not.toHaveProperty("sensitiveDataAuthorized");
  });

  test("throws a typed error for denied and blocked requests", () => {
    for (const origin of ["skill", "unknown"] as const) {
      expect(() => assertSkillEgressAllowed({ ...base, origin })).toThrow(SkillEgressDeniedError);
    }
  });

  test("does not invoke the transmitter for Skill-origin requests", async () => {
    let transmitted = false;
    await expect(executeSkillEgress(
      { ...base, origin: "skill" },
      async () => {
        transmitted = true;
        return "unexpected";
      },
    )).rejects.toBeInstanceOf(SkillEgressDeniedError);
    expect(transmitted).toBe(false);
  });

  test("rejects untrimmed policy identifiers", () => {
    expect(() => decideSkillEgress({ ...base, authorizationBasisId: " basis-public-qa" })).toThrow("authorizationBasisId");
    expect(() => decideSkillEgress({ ...base, destination: " https://example.test/qa" })).toThrow("destination");
  });

  test("rejects unknown or empty data inputs", () => {
    expect(() => decideSkillEgress({ ...base, dataClasses: [] })).toThrow("dataClasses");
    expect(() => decideSkillEgress({
      ...base,
      dataClasses: ["public", "unknown" as never],
    })).toThrow("dataClasses");
  });
  test("returns the bound failure through the denied error without transmitting", async () => {
    let transmitted = false;
    await expect(executeSkillEgress(
      {
        ...base,
        origin: "skill",
        requestId: "request-2",
        obligationId: "obligation-2",
        mandatory: true,
      },
      async () => {
        transmitted = true;
        return "unexpected";
      },
    )).rejects.toMatchObject({
      observation: {
        failure: {
          status: "FAIL",
          requestId: "request-2",
          obligationId: "obligation-2",
        },
      },
    });
    expect(transmitted).toBe(false);
  });
  test("requires identity for mandatory requests", () => {
    expect(() => decideSkillEgress({ ...base, origin: "skill", mandatory: true })).toThrow("requestId and obligationId");
    expect(() => decideSkillEgress({ ...base, origin: "skill", mandatory: true, requestId: "request-1" })).toThrow("requestId and obligationId");
  });
});
