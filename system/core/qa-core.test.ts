import { describe, expect, test } from "bun:test";
import { resolveQaVerdict, type VerdictInput } from "./qa-core";

const base = (): VerdictInput => ({
  requestId: "request-1",
  snapshotId: "snapshot-1",
  evaluatedAt: "2026-07-22T00:00:00.000Z",
  obligations: [{ id: "obligation-1", mandatory: true, conditionIds: ["condition-1"], requiredIndependence: "independent-producer" }],
  results: [{ obligationId: "obligation-1", snapshotId: "snapshot-1", status: "PASS", producerIndependence: "independent-producer", evidenceId: "evidence-1" }],
  defects: [],
  coverage: {
    basisIds: ["basis-1"], coveredBasisIds: ["basis-1"],
    riskIds: ["risk-1"], coveredRiskIds: ["risk-1"],
    conditionIds: ["condition-1"], coveredConditionIds: ["condition-1"],
  },
});

describe("resolveQaVerdict", () => {
  test("passes complete mandatory evidence", () => {
    const result = resolveQaVerdict(base());
    expect(result.qaVerdict).toBe("PASS");
    expect(result.authoritative).toBe(false);
  });

  test("fails before blocked and incomplete results", () => {
    const input = base();
    input.obligations = [
      ...input.obligations,
      { id: "obligation-2", mandatory: true, conditionIds: ["condition-1"], requiredIndependence: "self-check" },
      { id: "obligation-3", mandatory: true, conditionIds: ["condition-1"], requiredIndependence: "self-check" },
    ];
    input.results = [
      { ...input.results[0]!, status: "FAIL" },
      { obligationId: "obligation-2", snapshotId: "snapshot-1", status: "BLOCKED", producerIndependence: "self-check" },
    ];
    expect(resolveQaVerdict(input).qaVerdict).toBe("FAIL");
  });

  test("blocks evidence below required independence", () => {
    const input = base();
    input.results = [{ ...input.results[0]!, producerIndependence: "self-check" }];
    expect(resolveQaVerdict(input).qaVerdict).toBe("BLOCKED");
  });

  test("marks missing evidence and coverage incomplete", () => {
    const input = base();
    input.results = [];
    input.coverage.coveredBasisIds = [];
    const result = resolveQaVerdict(input);
    expect(result.qaVerdict).toBe("INCOMPLETE");
    expect(result.coverage.basis.uncoveredIds).toEqual(["basis-1"]);
  });

  test("allows only unexpired accepted material risk", () => {
    const input = base();
    input.defects = [{ id: "defect-1", material: true, disposition: "ACCEPTED_RISK", acceptanceExpiresAt: "2026-08-01T00:00:00.000Z" }];
    expect(resolveQaVerdict(input).qaVerdict).toBe("PASS_WITH_ACCEPTED_RISK");

    input.defects = [{ id: "defect-1", material: true, disposition: "ACCEPTED_RISK", acceptanceExpiresAt: "2026-07-01T00:00:00.000Z" }];
    expect(resolveQaVerdict(input).qaVerdict).toBe("BLOCKED");
  });

  test("rejects evidence from another snapshot", () => {
    const input = base();
    input.results = [{ ...input.results[0]!, snapshotId: "snapshot-2" }];
    expect(() => resolveQaVerdict(input)).toThrow("snapshot mismatch");
  });
});
