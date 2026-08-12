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

const assertion = (systemId = "synthetic-system", actual = 32): VisualCompositionAssertion => ({
  assertionId: `section-gap-${systemId}`,
  relation: "separation",
  regionIds: ["main", "secondary"],
  operator: "greater-than-or-equal",
  expected: 32,
  actual,
  unit: "css-px",
  source: { kind: "design-token", systemId, token: "layout.sectionGap", basisIds: ["basis-layout"] },
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
    fullPageScreenshotDigest: SCREENSHOT,
    focusedRegionScreenshotDigests: [FOCUSED_SCREENSHOT],
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

const STORED_SCREENSHOTS = [
  { type: "screenshot", digest: SCREENSHOT },
  { type: "screenshot", digest: FOCUSED_SCREENSHOT },
] as const;

const evaluateWithStoredScreenshots = (candidateRequirement: VisualCompositionRequirement, candidateOracle: VisualCompositionOracle) =>
  evaluateVisualComposition(candidateRequirement, candidateOracle, STORED_SCREENSHOTS);

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

  test("requires whole-page and focused-region screenshot evidence", () => {
    const candidate = oracle();
    const missingFocused = { ...candidate, captures: candidate.captures.map((capture, index) => index === 0 ? { ...capture, focusedRegionScreenshotDigests: [] } : capture) };
    expect(isVisualCompositionOracle(missingFocused)).toBe(false);
    expect(evaluateWithStoredScreenshots(requirement(), missingFocused as VisualCompositionOracle).status).toBe("INCOMPLETE");
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

  test("preserves assertion failure precedence when the oracle also reports a blocker", () => {
    const candidate = oracle({ blockingReasons: ["reference service unavailable"] });
    const captures = candidate.captures.map((capture, index) => index === 0 ? { ...capture, assertions: [assertion("blocked-with-failure", 12)] } : capture);
    const result = evaluateWithStoredScreenshots(requirement(), { ...candidate, captures });
    expect(result.status).toBe("FAIL");
    expect(result.reasons).toContain("COMPOSITION_ASSERTION_FAILED");
    expect(result.reasons).toContain("BLOCKED:reference service unavailable");
  });

  test("requires approved-reference provenance to identify a stored artifact", () => {
    const referenceDigest = "e".repeat(64);
    const candidate = oracle();
    const captures = candidate.captures.map(capture => ({
      ...capture,
      assertions: capture.assertions.map(item => ({ ...item, source: { kind: "approved-reference" as const, artifactDigest: referenceDigest, basisIds: ["basis-layout"] } })),
    }));
    const missing = evaluateWithStoredScreenshots(requirement(), { ...candidate, captures });
    expect(missing.status).toBe("INCOMPLETE");
    expect(missing.reasons).toContain(`APPROVED_REFERENCE_ARTIFACT_MISSING:${captures[0]!.assertions[0]!.assertionId}`);
    const stored = evaluateVisualComposition(requirement(), { ...candidate, captures }, [...STORED_SCREENSHOTS, { type: "verification-result", digest: referenceDigest }]);
    expect(stored.status).toBe("PASS");
  });

  test("requires assertions to cover every visual composition basis", () => {
    const candidateRequirement = { ...requirement(), basisIds: ["basis-layout", "basis-secondary"] };
    const result = evaluateWithStoredScreenshots(candidateRequirement, oracle());
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain("UNCOVERED_VISUAL_BASIS:basis-secondary");
    expect(result.reasons).not.toContain("UNCOVERED_VISUAL_BASIS:basis-layout");
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
      }],
    } : capture);
    const result = evaluateWithStoredScreenshots(requirement(), { ...candidate, captures });
    expect(result.status).toBe("FAIL");
    expect(result.failedAssertionIds).toContain("shared-alignment");
  });

  test("rejects a size ratio with a zero-area denominator", () => {
    const candidate = oracle();
    const captures = candidate.captures.map((capture, index) => index === 0 ? {
      ...capture,
      regions: capture.regions.map(region => region.regionId === "secondary" ? { ...region, width: 0 } : region),
      assertions: [{
        ...capture.assertions[0]!,
        assertionId: "zero-size-ratio",
        relation: "size-ratio" as const,
        operator: "equals" as const,
        expected: 1,
        actual: 1,
      }],
    } : capture);
    const result = evaluateWithStoredScreenshots(requirement(), { ...candidate, captures });
    expect(result.status).toBe("FAIL");
    expect(result.failedAssertionIds).toContain("zero-size-ratio");
  });

  test("rejects assertions that reference absent regions or unrelated basis", () => {
    const candidate = oracle();
    const invalidRegion = { ...candidate, captures: candidate.captures.map((capture, index) => index === 0 ? { ...capture, assertions: [{ ...capture.assertions[0]!, regionIds: ["missing"] }] } : capture) };
    expect(isVisualCompositionOracle(invalidRegion)).toBe(false);
    const unrelatedBasis = { ...candidate, captures: candidate.captures.map(capture => ({ ...capture, assertions: capture.assertions.map(item => ({ ...item, source: { kind: "explicit-basis" as const, basisId: "private-basis" } })) })) };
    expect(evaluateWithStoredScreenshots(requirement(), unrelatedBasis).reasons).toContain(`UNLINKED_ORACLE_SOURCE:${unrelatedBasis.captures[0]!.assertions[0]!.assertionId}`);
  });

  test("does not accept unknown scope or insufficient producer independence", () => {
    expect(evaluateWithStoredScreenshots(requirement("unknown"), oracle()).status).toBe("INCOMPLETE");
    const selfProduced = oracle({ producer: { kind: "self", identity: "implementer", independence: "self-check" } });
    expect(evaluateWithStoredScreenshots(requirement(), selfProduced)).toEqual(expect.objectContaining({ status: "INCOMPLETE", reasons: ["INDEPENDENCE_NOT_MET"] }));
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
