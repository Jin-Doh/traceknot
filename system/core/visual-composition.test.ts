import { describe, expect, test } from "bun:test";
import {
  evaluateVisualComposition,
  isVisualCompositionOracle,
  isVisualCompositionRequirement,
  isVisualCompositionScope,
  requirementFromVisualCompositionScope,
  type VisualCompositionAssertion,
  type VisualCompositionOracle,
  type VisualCompositionRequirement,
  type VisualCompositionScope,
} from "./visual-composition";

const SCREENSHOT = "a".repeat(64);
const FOCUSED_SCREENSHOT = "b".repeat(64);
const SNAPSHOT_ID = "snapshot-public-example";
const REQUEST_ID = "request-public-example";
const CONDITION_ID = "condition:request-visual-composition";

const scope = (decision: VisualCompositionScope["decision"] = "required"): VisualCompositionScope => ({
  schemaVersion: "visual-composition-scope/v1",
  decision,
  basisIds: ["basis-layout"],
  rationale: decision === "not-required" ? "The change preserves rendered geometry." : "The change modifies section spacing and responsive panel hierarchy.",
  surfaces: decision === "not-required" ? [] : [{ surfaceId: "surface-catalog", stateIds: ["populated", "empty"], viewportIds: ["desktop", "mobile"] }],
  viewports: decision === "not-required" ? [] : [
    { id: "desktop", width: 1440, height: 900, label: "wide" },
    { id: "mobile", width: 390, height: 844, devicePixelRatio: 3, label: "narrow" },
  ],
});

const requirement = (decision: "required" | "unknown" = "required"): VisualCompositionRequirement => {
  const result = requirementFromVisualCompositionScope(REQUEST_ID, SNAPSHOT_ID, CONDITION_ID, scope(decision), "independent-producer");
  if (!result) throw new Error("missing fixture requirement");
  return result;
};

const tokenResolutionDigest = (systemId: string, value = 32) => new Bun.CryptoHasher("sha256")
  .update(JSON.stringify({ schemaVersion: "design-token-resolution/v1", systemId, token: "layout.sectionGap", unit: "css-px", value }))
  .digest("hex");
const screenshotDigest = (role: string, viewportId: string, stateId: string) => new Bun.CryptoHasher("sha256").update(`${role}:${viewportId}:${stateId}`).digest("hex");
const approvedReferenceDigest = (item: VisualCompositionAssertion, basisIds = ["basis-layout"]) => new Bun.CryptoHasher("sha256")
  .update(JSON.stringify({ schemaVersion: "approved-visual-reference/v1", relation: item.relation, operator: item.operator, expected: item.expected, unit: item.unit ?? null, regionIds: item.regionIds, basisIds: [...basisIds].sort() }))
  .digest("hex");


const assertion = (systemId = "synthetic-system", actual = 32): VisualCompositionAssertion => ({
  assertionId: `section-gap-${systemId}`,
  relation: "separation",
  regionIds: ["main", "secondary"],
  operator: "greater-than-or-equal",
  expected: 32,
  actual,
  unit: "css-px",
  source: { kind: "design-token", systemId, token: "layout.sectionGap", unit: "css-px", resolvedValue: 32, resolutionArtifactDigest: tokenResolutionDigest(systemId), basisIds: ["basis-layout"] },
});

const oracle = (overrides: Partial<VisualCompositionOracle> = {}, systemId = "synthetic-system"): VisualCompositionOracle => ({
  schemaVersion: "visual-composition-oracle/v1",
  oracleId: "oracle-public-example",
  requestId: REQUEST_ID,
  snapshotId: SNAPSHOT_ID,
  conditionId: CONDITION_ID,
  producer: { kind: "ci", identity: "public-visual-verifier", independence: "independent-producer" },
  captures: ["desktop", "mobile"].flatMap(viewportId => ["populated", "empty"].map(stateId => ({
    captureId: `capture-${viewportId}-${stateId}`,
    surfaceId: "surface-catalog",
    stateId,
    viewportId,
    viewport: viewportId === "desktop" ? { id: "desktop", width: 1440, height: 900, label: "wide" } : { id: "mobile", width: 390, height: 844, devicePixelRatio: 3, label: "narrow" },
    screenshots: [
      { evidenceId: `evidence-full-page-${viewportId}-${stateId}`, role: "full-page", digest: screenshotDigest("full-page", viewportId, stateId) },
      { evidenceId: `evidence-focused-region-${viewportId}-${stateId}`, role: "focused-region", regionId: "main", digest: screenshotDigest("focused-region", viewportId, stateId) },
    ],
    regions: [
      { regionId: "main", role: "primary", x: 0, y: 0, width: viewportId === "desktop" ? 900 : 390, height: 500 },
      { regionId: "secondary", role: "supporting", x: 0, y: 532, width: viewportId === "desktop" ? 900 : 390, height: 200 },
    ],
    assertions: [assertion(`${systemId}-${viewportId}-${stateId}`)],
  }))),
  representativeStateLimitations: [],
  blockingReasons: [],
  ...overrides,
});

const screenshotArtifacts = (candidateOracle: VisualCompositionOracle) => candidateOracle.captures.flatMap(capture =>
  capture.screenshots.map(screenshot => ({ type: "screenshot", digest: screenshot.digest })),
);

const evaluateWithStoredScreenshots = (candidateRequirement: VisualCompositionRequirement, candidateOracle: VisualCompositionOracle) => {
  const tokenArtifacts = candidateOracle.captures.flatMap(capture => capture.assertions.flatMap(item => item.source.kind === "design-token" ? [{ type: "design-token-resolution", digest: item.source.resolutionArtifactDigest }] : []));
  return evaluateVisualComposition(candidateRequirement, candidateOracle, [...screenshotArtifacts(candidateOracle), ...tokenArtifacts]);
};

describe("visual composition contracts", () => {
  test("accepts explicit required and not-required scope decisions", () => {
    expect(isVisualCompositionScope(scope())).toBe(true);
    expect(isVisualCompositionScope(scope("not-required"))).toBe(true);
  });

  test("rejects required scope without surfaces and viewports", () => {
    expect(isVisualCompositionScope({ ...scope(), surfaces: [], viewports: [] })).toBe(false);
  });

  test("derives the complete surface-state-viewport capture product", () => {
    const result = requirement();
    expect(isVisualCompositionRequirement(result)).toBe(true);
    expect(result.requiredCaptures).toEqual([
      { surfaceId: "surface-catalog", stateId: "populated", viewportId: "desktop" },
      { surfaceId: "surface-catalog", stateId: "populated", viewportId: "mobile" },
      { surfaceId: "surface-catalog", stateId: "empty", viewportId: "desktop" },
      { surfaceId: "surface-catalog", stateId: "empty", viewportId: "mobile" },
    ]);
  });

  test.each(["material-like", "fluent-like", "carbon-like", "custom-product"])("treats %s design tokens as opaque oracle provenance", systemId => {
    expect(evaluateWithStoredScreenshots(requirement(), oracle({}, systemId))).toEqual({
      schemaVersion: "visual-composition-evaluation/v1",
      status: "PASS",
      reasons: [],
      failedAssertionIds: [],
      missingCaptureKeys: [],
    });
  });

  test("normalizes omitted device-pixel ratio to one", () => {
    const candidate = oracle();
    const explicitOracle = { ...candidate, captures: candidate.captures.map(capture => capture.viewportId === "desktop" ? { ...capture, viewport: { ...capture.viewport, devicePixelRatio: 1 } } : capture) };
    expect(evaluateWithStoredScreenshots(requirement(), explicitOracle).status).toBe("PASS");
    const candidateRequirement = requirement();
    const explicitRequirement = { ...candidateRequirement, viewports: candidateRequirement.viewports.map(viewport => viewport.id === "desktop" ? { ...viewport, devicePixelRatio: 1 } : viewport) };
    expect(evaluateWithStoredScreenshots(explicitRequirement, candidate).status).toBe("PASS");
  });
  test("does not evaluate assertions from a mismatched viewport", () => {
    const candidate = oracle();
    const captures = candidate.captures.map((capture, index) => index === 0 ? {
      ...capture,
      viewport: { ...capture.viewport, width: capture.viewport.width + 1 },
      assertions: capture.assertions.map(item => ({ ...item, actual: 0 })),
    } : capture);
    const result = evaluateWithStoredScreenshots(requirement(), { ...candidate, captures });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain("VIEWPORT_MISMATCH");
    expect(result.failedAssertionIds).toEqual([]);
  });


  test("requires whole-page and focused-region screenshot evidence", () => {
    const candidate = oracle();
    const missingFocused = { ...candidate, captures: candidate.captures.map((capture, index) => index === 0 ? { ...capture, screenshots: capture.screenshots.filter(screenshot => screenshot.role !== "focused-region") } : capture) };
    expect(isVisualCompositionOracle(missingFocused)).toBe(false);
    expect(evaluateWithStoredScreenshots(requirement(), missingFocused as VisualCompositionOracle).status).toBe("INCOMPLETE");
  });

  test("rejects a focused screenshot that aliases the whole-page artifact", () => {
    const candidate = oracle();
    const aliased = { ...candidate, captures: candidate.captures.map((capture, index) => index === 0 ? { ...capture, screenshots: capture.screenshots.map(screenshot => screenshot.role === "focused-region" ? { ...screenshot, digest: capture.screenshots.find(item => item.role === "full-page")!.digest } : screenshot) } : capture) };
    expect(isVisualCompositionOracle(aliased)).toBe(false);
    expect(evaluateWithStoredScreenshots(requirement(), aliased as VisualCompositionOracle).status).toBe("INCOMPLETE");
  });

  test("allows byte-identical images across distinct capture evidence events", () => {
    const candidate = oracle();
    const first = candidate.captures[0]!;
    const firstDigests = first.screenshots.map(screenshot => screenshot.digest);
    const reused = { ...candidate, captures: candidate.captures.map((capture, index) => index === 1 ? { ...capture, screenshots: capture.screenshots.map((screenshot, screenshotIndex) => ({ ...screenshot, digest: firstDigests[screenshotIndex]! })) } : capture) };
    expect(isVisualCompositionOracle(reused)).toBe(true);
    expect(evaluateWithStoredScreenshots(requirement(), reused).status).toBe("PASS");
  });

  test("requires every screenshot digest to identify a stored screenshot artifact", () => {
    const candidate = oracle();
    const result = evaluateVisualComposition(requirement(), candidate, [
      { type: "verification-result", digest: SCREENSHOT },
      { type: "screenshot", digest: FOCUSED_SCREENSHOT },
    ]);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain("SCREENSHOT_ARTIFACT_MISSING");
  });

  test("binds observed viewport geometry to each required breakpoint", () => {
    const candidate = oracle();
    const wrongViewport = {
      ...candidate,
      captures: candidate.captures.map((capture, index) => index === 0 ? { ...capture, viewport: { ...capture.viewport, width: capture.viewport.width - 1 } } : capture),
    };
    const result = evaluateWithStoredScreenshots(requirement(), wrongViewport);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain("VIEWPORT_MISMATCH");
  });

  test("reports every missing representative state and viewport capture", () => {
    const candidate = oracle();
    const desktopPopulatedOnly = { ...candidate, captures: [candidate.captures[0]!] };
    expect(evaluateWithStoredScreenshots(requirement(), desktopPopulatedOnly)).toEqual({
      schemaVersion: "visual-composition-evaluation/v1",
      status: "INCOMPLETE",
      reasons: ["REQUIRED_CAPTURE_MISSING"],
      failedAssertionIds: [],
      missingCaptureKeys: [
        "surface-catalog\u0000empty\u0000desktop",
        "surface-catalog\u0000empty\u0000mobile",
        "surface-catalog\u0000populated\u0000mobile",
      ],
    });
  });

  test("fails an objective composition relation", () => {
    const candidate = oracle();
    const captures = candidate.captures.map((capture, index) => index === 0 ? { ...capture, assertions: [assertion("custom-product", 12)] } : capture);
    const result = evaluateWithStoredScreenshots(requirement(), { ...candidate, captures });
    expect(result.status).toBe("FAIL");
    expect(result.reasons).toEqual(["COMPOSITION_ASSERTION_FAILED"]);
    expect(result.failedAssertionIds).toEqual(["section-gap-custom-product"]);
  });

  test("fails reported separation that contradicts overlapping captured regions", () => {
    const candidate = oracle();
    const captures = candidate.captures.map((capture, index) => index === 0 ? {
      ...capture,
      regions: capture.regions.map(region => region.regionId === "secondary" ? { ...region, y: 400 } : region),
    } : capture);
    const result = evaluateWithStoredScreenshots(requirement(), { ...candidate, captures });
    expect(result.status).toBe("FAIL");
    expect(result.reasons).toContain("COMPOSITION_ASSERTION_FAILED");
    expect(result.failedAssertionIds).toContain(candidate.captures[0]!.assertions[0]!.assertionId);
  });

  test("treats overlap as negative separation at the zero threshold", () => {
    const candidate = oracle();
    const captures = candidate.captures.map((capture, index) => index === 0 ? {
      ...capture,
      regions: capture.regions.map(region => region.regionId === "secondary" ? { ...region, y: 400 } : region),
      assertions: capture.assertions.map(item => ({ ...item, expected: 0, actual: 0, unit: "css-px", source: { kind: "explicit-basis" as const, basisId: "basis-layout" } })),
    } : capture);
    const result = evaluateWithStoredScreenshots(requirement(), { ...candidate, captures });
    expect(result.status).toBe("FAIL");
    expect(result.failedAssertionIds).toContain(captures[0]!.assertions[0]!.assertionId);
  });

  test("rejects a design token expected value not bound to its stored resolution digest", () => {
    const candidate = oracle();
    const captures = candidate.captures.map((capture, index) => index === 0 ? {
      ...capture,
      assertions: capture.assertions.map(item => ({ ...item, expected: 40, actual: 32 })),
    } : capture);
    const result = evaluateWithStoredScreenshots(requirement(), { ...candidate, captures });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain(`DESIGN_TOKEN_RESOLUTION_INVALID:${captures[0]!.assertions[0]!.assertionId}`);
    expect(result.failedAssertionIds).toEqual([]);
  });

  test("preserves assertion failure precedence when the oracle also reports a blocker", () => {
    const candidate = oracle({ blockingReasons: ["reference service unavailable"] });
    const captures = candidate.captures.map((capture, index) => index === 0 ? { ...capture, assertions: [assertion("blocked-with-failure", 12)] } : capture);
    const result = evaluateWithStoredScreenshots(requirement(), { ...candidate, captures });
    expect(result.status).toBe("FAIL");
    expect(result.reasons).toContain("COMPOSITION_ASSERTION_FAILED");
    expect(result.reasons).toContain("BLOCKED:reference service unavailable");
  });

  test("binds approved-reference expected values to canonical stored artifacts", () => {
    const candidate = oracle();
    const captures = candidate.captures.map(capture => ({
      ...capture,
      assertions: capture.assertions.map(item => ({ ...item, source: { kind: "approved-reference" as const, artifactDigest: approvedReferenceDigest(item), basisIds: ["basis-layout"] } })),
    }));
    const referenceDigest = captures[0]!.assertions[0]!.source.kind === "approved-reference" ? captures[0]!.assertions[0]!.source.artifactDigest : "";
    const unrelated = evaluateVisualComposition(requirement(), { ...candidate, captures }, [...screenshotArtifacts(candidate), { type: "verification-result", digest: referenceDigest }]);
    expect(unrelated.status).toBe("INCOMPLETE");
    expect(unrelated.reasons).toContain(`APPROVED_REFERENCE_ARTIFACT_INVALID:${captures[0]!.assertions[0]!.assertionId}`);
    const stored = evaluateVisualComposition(requirement(), { ...candidate, captures }, [...screenshotArtifacts(candidate), { type: "approved-visual-reference", digest: referenceDigest }]);
    expect(stored.status).toBe("PASS");
    const changedExpected = captures.map((capture, index) => index === 0 ? { ...capture, assertions: capture.assertions.map(item => ({ ...item, expected: 33 })) } : capture);
    const tampered = evaluateVisualComposition(requirement(), { ...candidate, captures: changedExpected }, [...screenshotArtifacts(candidate), { type: "approved-visual-reference", digest: referenceDigest }]);
    expect(tampered.status).toBe("INCOMPLETE");
    expect(tampered.failedAssertionIds).toEqual([]);
  });
  test("does not evaluate assertions from a cross-context oracle", () => {
    const candidate = oracle({ requestId: "other-request", snapshotId: "other-snapshot", conditionId: "other-condition" });
    const captures = candidate.captures.map((capture, index) => index === 0 ? { ...capture, assertions: [assertion("cross-context-failure", 0)] } : capture);
    const result = evaluateWithStoredScreenshots(requirement(), { ...candidate, captures });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toEqual(["REQUEST_MISMATCH", "SNAPSHOT_MISMATCH", "CONDITION_MISMATCH"]);
    expect(result.failedAssertionIds).toEqual([]);
  });

  test("does not evaluate assertions sourced from an unrelated basis", () => {
    const candidate = oracle();
    const captures = candidate.captures.map((capture, index) => index === 0 ? {
      ...capture,
      assertions: [{ ...assertion("unlinked-basis-failure", 0), source: { kind: "explicit-basis" as const, basisId: "other-basis" } }],
    } : capture);
    const result = evaluateWithStoredScreenshots(requirement(), { ...candidate, captures });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain(`UNLINKED_ORACLE_SOURCE:${captures[0]!.assertions[0]!.assertionId}`);
    expect(result.failedAssertionIds).toEqual([]);
  });


  test("requires assertions to cover every visual composition basis", () => {
    const candidateRequirement = { ...requirement(), basisIds: ["basis-layout", "basis-secondary"] };
    const result = evaluateWithStoredScreenshots(candidateRequirement, oracle());
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain("UNCOVERED_VISUAL_BASIS:basis-secondary");
    expect(result.reasons).not.toContain("UNCOVERED_VISUAL_BASIS:basis-layout");
  });

  test("does not evaluate captures outside the required scope", () => {
    const candidate = oracle();
    const base = candidate.captures[0]!;
    const unexpected = {
      ...base,
      captureId: "capture-unexpected",
      stateId: "unexpected",
      screenshots: base.screenshots.map(screenshot => ({ ...screenshot, evidenceId: `${screenshot.evidenceId}-unexpected`, digest: screenshotDigest(screenshot.role, base.viewportId, "unexpected") })),
      assertions: base.assertions.map(item => ({ ...item, actual: 0 })),
    };
    const expanded = { ...candidate, captures: [...candidate.captures, unexpected] };
    const result = evaluateWithStoredScreenshots(requirement(), expanded);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain("UNEXPECTED_CAPTURE:surface-catalog\u0000unexpected\u0000desktop");
    expect(result.failedAssertionIds).toEqual([]);
  });
  test("requires one shared alignment guide across every referenced region", () => {
    const candidate = oracle();

    const captures = candidate.captures.map((capture, index) => index === 0 ? {
      ...capture,
      regions: [...capture.regions, { regionId: "third", role: "supporting", x: 1000, y: 0, width: 100, height: 100 }],
      assertions: [{
        ...capture.assertions[0]!,
        assertionId: "shared-alignment",
        relation: "alignment" as const,
        regionIds: ["main", "secondary", "third"],
        operator: "equals" as const,
        expected: 0,
        actual: 0,
        source: { kind: "explicit-basis" as const, basisId: "basis-layout" },
      }],
    } : capture);
    const result = evaluateWithStoredScreenshots(requirement(), { ...candidate, captures });
    expect(result.status).toBe("FAIL");
    expect(result.failedAssertionIds).toContain("shared-alignment");
  });

  test.each(["alignment", "ordering"] as const)("rejects vacuous one-region %s assertions", relation => {
    const candidate = oracle();
    const common = { assertionId: `vacuous-${relation}`, relation, regionIds: ["main"], operator: "equals" as const, source: { kind: "explicit-basis" as const, basisId: "basis-layout" } };
    const vacuousAssertion: VisualCompositionAssertion = relation === "alignment"
      ? { ...common, expected: 0, actual: 0, unit: "css-px" }
      : { ...common, expected: true, actual: true };
    const vacuous = {
      ...candidate,
      captures: candidate.captures.map((capture, index) => index === 0 ? { ...capture, assertions: [vacuousAssertion] } : capture),
    };
    const nonVacuous = { ...vacuous, captures: vacuous.captures.map((capture, index) => index === 0 ? { ...capture, assertions: [{ ...vacuousAssertion, regionIds: ["main", "secondary"] }] } : capture) };
    expect(isVisualCompositionOracle(nonVacuous)).toBe(true);
    expect(isVisualCompositionOracle(vacuous)).toBe(false);
    expect(evaluateWithStoredScreenshots(requirement(), vacuous).status).toBe("INCOMPLETE");
  });
  test.each([
    ["separation", true],
    ["containment", "contained"],
    ["non-overlap", "separate"],
    ["ordering", "ordered"],
  ] as const)("rejects %s assertions with an incompatible scalar type", (relation, scalar) => {
    const candidate = oracle();
    const invalid = {
      ...candidate,
      captures: candidate.captures.map((capture, index) => index === 0 ? {
        ...capture,
        assertions: [{ ...capture.assertions[0]!, relation, expected: scalar, actual: scalar, operator: "equals" as const, unit: undefined }],
      } : capture),
    };
    expect(isVisualCompositionOracle(invalid)).toBe(false);
    expect(evaluateWithStoredScreenshots(requirement(), invalid as VisualCompositionOracle).status).toBe("INCOMPLETE");
  });

  test("rejects zero-area regions before evaluating geometry", () => {
    const candidate = oracle();
    const captures = candidate.captures.map((capture, index) => index === 0 ? {
      ...capture,
      regions: capture.regions.map(region => region.regionId === "secondary" ? { ...region, width: 0 } : region),
    } : capture);
    const invalid = { ...candidate, captures };
    expect(isVisualCompositionOracle(invalid)).toBe(false);
    expect(evaluateWithStoredScreenshots(requirement(), invalid as VisualCompositionOracle).status).toBe("INCOMPLETE");
  });

  test("rejects assertions that reference absent regions or unrelated basis", () => {
    const candidate = oracle();
    const invalidRegion = { ...candidate, captures: candidate.captures.map((capture, index) => index === 0 ? { ...capture, assertions: [{ ...capture.assertions[0]!, regionIds: ["missing"] }] } : capture) };
    expect(isVisualCompositionOracle(invalidRegion)).toBe(false);
    const unrelatedBasis = { ...candidate, captures: candidate.captures.map(capture => ({ ...capture, assertions: capture.assertions.map(item => ({ ...item, source: { kind: "explicit-basis" as const, basisId: "private-basis" } })) })) };
    expect(evaluateWithStoredScreenshots(requirement(), unrelatedBasis).reasons).toContain(`UNLINKED_ORACLE_SOURCE:${unrelatedBasis.captures[0]!.assertions[0]!.assertionId}`);
  });

  test("does not evaluate assertions from an insufficiently independent producer", () => {
    expect(evaluateWithStoredScreenshots(requirement("unknown"), oracle()).status).toBe("INCOMPLETE");
    const candidate = oracle({ producer: { kind: "self", identity: "implementer", independence: "self-check" } });
    const failing = { ...candidate, captures: candidate.captures.map(capture => ({ ...capture, assertions: capture.assertions.map(item => ({ ...item, actual: 0 })) })) };
    expect(evaluateWithStoredScreenshots(requirement(), failing)).toEqual(expect.objectContaining({
      status: "INCOMPLETE",
      reasons: ["INDEPENDENCE_NOT_MET"],
      failedAssertionIds: [],
    }));
  });

  test("reports unavailable token resolution or capture capability as blocked", () => {
    expect(evaluateWithStoredScreenshots(requirement(), oracle({ blockingReasons: ["design token could not be resolved"] }))).toEqual(expect.objectContaining({
      status: "BLOCKED",
      reasons: ["BLOCKED:design token could not be resolved"],
    }));
  });

  test("rejects cross-snapshot and cross-condition evidence", () => {
    expect(evaluateWithStoredScreenshots(requirement(), oracle({ snapshotId: "other-snapshot" })).reasons).toContain("SNAPSHOT_MISMATCH");
    expect(evaluateWithStoredScreenshots(requirement(), oracle({ conditionId: "other-condition" })).reasons).toContain("CONDITION_MISMATCH");
  });
});
