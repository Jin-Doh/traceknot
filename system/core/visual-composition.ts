import type { Artifact, IndependenceLevel, Producer } from "./qa-core";

export type VisualCompositionScopeDecision = "required" | "not-required" | "unknown";

export type VisualCompositionViewport = Readonly<{
  id: string;
  width: number;
  height: number;
  devicePixelRatio?: number;
  label?: string;
}>;

export type VisualCompositionSurfaceScope = Readonly<{
  surfaceId: string;
  stateIds: readonly string[];
  viewportIds: readonly string[];
}>;

export type VisualCompositionScope = Readonly<{
  schemaVersion: "visual-composition-scope/v1";
  decision: VisualCompositionScopeDecision;
  basisIds: readonly string[];
  rationale: string;
  surfaces: readonly VisualCompositionSurfaceScope[];
  viewports: readonly VisualCompositionViewport[];
}>;

export type VisualCompositionCaptureRequirement = Readonly<{
  surfaceId: string;
  stateId: string;
  viewportId: string;
}>;

export type VisualCompositionRequirement = Readonly<{
  schemaVersion: "visual-composition-requirement/v1";
  requestId: string;
  snapshotId: string;
  conditionId: string;
  scopeDecision: "required" | "unknown";
  basisIds: readonly string[];
  requiredCaptures: readonly VisualCompositionCaptureRequirement[];
  viewports: readonly VisualCompositionViewport[];
  minimumIndependence: IndependenceLevel;
}>;

export type VisualCompositionRegion = Readonly<{
  regionId: string;
  role: string;
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type VisualOracleSource =
  | Readonly<{ kind: "explicit-basis"; basisId: string }>
  | Readonly<{ kind: "design-token"; token: string; systemId?: string }>
  | Readonly<{ kind: "approved-reference"; artifactDigest: string }>
  | Readonly<{ kind: "derived-relation"; basisIds: readonly string[] }>;

export type VisualCompositionRelation =
  | "separation"
  | "inset"
  | "alignment"
  | "containment"
  | "non-overlap"
  | "ordering"
  | "size-ratio"
  | "density"
  | "hierarchy-review"
  | "rhythm-review";

export type VisualCompositionAssertion = Readonly<{
  assertionId: string;
  relation: VisualCompositionRelation;
  regionIds: readonly string[];
  operator: "equals" | "not-equals" | "less-than-or-equal" | "greater-than-or-equal" | "contains";
  expected: string | number | boolean;
  actual: string | number | boolean;
  unit?: string;
  source: VisualOracleSource;
}>;

export type VisualCompositionCapture = Readonly<{
  captureId: string;
  surfaceId: string;
  stateId: string;
  viewportId: string;
  viewport: VisualCompositionViewport;
  fullPageScreenshotDigest: string;
  focusedRegionScreenshotDigests: readonly string[];
  regions: readonly VisualCompositionRegion[];
  assertions: readonly VisualCompositionAssertion[];
}>;

export type VisualCompositionOracle = Readonly<{
  schemaVersion: "visual-composition-oracle/v1";
  oracleId: string;
  requestId: string;
  snapshotId: string;
  conditionId: string;
  producer: Producer;
  captures: readonly VisualCompositionCapture[];
  representativeStateLimitations: readonly string[];
  blockingReasons: readonly string[];
}>;

export type VisualCompositionEvaluation = Readonly<{
  schemaVersion: "visual-composition-evaluation/v1";
  status: "PASS" | "FAIL" | "BLOCKED" | "INCOMPLETE";
  reasons: readonly string[];
  failedAssertionIds: readonly string[];
  missingCaptureKeys: readonly string[];
}>;

const DIGEST = /^[0-9a-f]{64}$/;
const INDEPENDENCE: readonly IndependenceLevel[] = ["self-check", "separate-verification-context", "independent-producer", "external-approval"];
const RELATIONS: readonly VisualCompositionRelation[] = ["separation", "inset", "alignment", "containment", "non-overlap", "ordering", "size-ratio", "density", "hierarchy-review", "rhythm-review"];
const OPERATORS: readonly VisualCompositionAssertion["operator"][] = ["equals", "not-equals", "less-than-or-equal", "greater-than-or-equal", "contains"];
const PRODUCER_KINDS: readonly Producer["kind"][] = ["self", "harness-managed", "deterministic-verifier", "ci", "human", "external-system"];
const independenceRank: Readonly<Record<IndependenceLevel, number>> = { "self-check": 0, "separate-verification-context": 1, "independent-producer": 2, "external-approval": 3 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && keys.every(key => allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function uniqueNonEmptyStrings(value: unknown, allowEmpty = false): value is readonly string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(nonEmptyString) && new Set(value).size === value.length;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validViewport(value: unknown): value is VisualCompositionViewport {
  return isRecord(value) && exactKeys(value, ["id", "width", "height"], ["devicePixelRatio", "label"]) && nonEmptyString(value.id) && positiveNumber(value.width) && positiveNumber(value.height) && (value.devicePixelRatio === undefined || positiveNumber(value.devicePixelRatio)) && (value.label === undefined || nonEmptyString(value.label));
}

function validProducer(value: unknown): value is Producer {
  return isRecord(value) && exactKeys(value, ["kind", "identity", "independence"]) && PRODUCER_KINDS.includes(value.kind as Producer["kind"]) && nonEmptyString(value.identity) && INDEPENDENCE.includes(value.independence as IndependenceLevel) && !(value.kind === "self" && value.independence !== "self-check");
}

function validRegion(value: unknown): value is VisualCompositionRegion {
  return isRecord(value) && exactKeys(value, ["regionId", "role", "x", "y", "width", "height"]) && nonEmptyString(value.regionId) && nonEmptyString(value.role) && finiteNumber(value.x) && finiteNumber(value.y) && finiteNumber(value.width) && value.width >= 0 && finiteNumber(value.height) && value.height >= 0;
}

function validOracleSource(value: unknown): value is VisualOracleSource {
  if (!isRecord(value) || !nonEmptyString(value.kind)) return false;
  if (value.kind === "explicit-basis") return exactKeys(value, ["kind", "basisId"]) && nonEmptyString(value.basisId);
  if (value.kind === "design-token") return exactKeys(value, ["kind", "token"], ["systemId"]) && nonEmptyString(value.token) && (value.systemId === undefined || nonEmptyString(value.systemId));
  if (value.kind === "approved-reference") return exactKeys(value, ["kind", "artifactDigest"]) && typeof value.artifactDigest === "string" && DIGEST.test(value.artifactDigest);
  if (value.kind === "derived-relation") return exactKeys(value, ["kind", "basisIds"]) && uniqueNonEmptyStrings(value.basisIds);
  return false;
}

function validScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" || finiteNumber(value);
}

function validAssertion(value: unknown): value is VisualCompositionAssertion {
  if (!isRecord(value) || !exactKeys(value, ["assertionId", "relation", "regionIds", "operator", "expected", "actual", "source"], ["unit"]) || !nonEmptyString(value.assertionId) || !RELATIONS.includes(value.relation as VisualCompositionRelation) || !uniqueNonEmptyStrings(value.regionIds) || !OPERATORS.includes(value.operator as VisualCompositionAssertion["operator"]) || !validScalar(value.expected) || !validScalar(value.actual) || !validOracleSource(value.source) || (value.unit !== undefined && !nonEmptyString(value.unit))) return false;
  if ((value.operator === "less-than-or-equal" || value.operator === "greater-than-or-equal") && (typeof value.expected !== "number" || typeof value.actual !== "number")) return false;
  if (value.operator === "contains" && (typeof value.expected !== "string" || typeof value.actual !== "string")) return false;
  if ((typeof value.expected === "number" || typeof value.actual === "number") && typeof value.unit !== "string") return false;
  return typeof value.expected === typeof value.actual;
}

function validCapture(value: unknown): value is VisualCompositionCapture {
  if (!isRecord(value) || !exactKeys(value, ["captureId", "surfaceId", "stateId", "viewportId", "viewport", "fullPageScreenshotDigest", "focusedRegionScreenshotDigests", "regions", "assertions"]) || !nonEmptyString(value.captureId) || !nonEmptyString(value.surfaceId) || !nonEmptyString(value.stateId) || !nonEmptyString(value.viewportId) || !validViewport(value.viewport) || value.viewport.id !== value.viewportId || typeof value.fullPageScreenshotDigest !== "string" || !DIGEST.test(value.fullPageScreenshotDigest) || !uniqueNonEmptyStrings(value.focusedRegionScreenshotDigests) || !Array.isArray(value.regions) || value.regions.length === 0 || value.regions.some(region => !validRegion(region)) || !Array.isArray(value.assertions) || value.assertions.length === 0 || value.assertions.some(assertion => !validAssertion(assertion))) return false;
  const regions = value.regions as readonly VisualCompositionRegion[];
  const assertions = value.assertions as readonly VisualCompositionAssertion[];
  const regionIds = new Set(regions.map(region => region.regionId));
  return regionIds.size === regions.length && new Set(assertions.map(assertion => assertion.assertionId)).size === assertions.length && assertions.every(assertion => assertion.regionIds.every(regionId => regionIds.has(regionId)));
}

export function isVisualCompositionScope(value: unknown): value is VisualCompositionScope {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "decision", "basisIds", "rationale", "surfaces", "viewports"]) || value.schemaVersion !== "visual-composition-scope/v1" || !["required", "not-required", "unknown"].includes(value.decision as string) || !uniqueNonEmptyStrings(value.basisIds) || !nonEmptyString(value.rationale) || !Array.isArray(value.surfaces) || !Array.isArray(value.viewports) || value.viewports.some(viewport => !validViewport(viewport))) return false;
  const surfaces = value.surfaces as readonly unknown[];
  const viewports = value.viewports as readonly VisualCompositionViewport[];
  if (new Set(viewports.map(viewport => viewport.id)).size !== viewports.length) return false;
  const viewportIds = new Set(viewports.map(viewport => viewport.id));
  const validSurfaces = surfaces.every(surface => isRecord(surface) && exactKeys(surface, ["surfaceId", "stateIds", "viewportIds"]) && nonEmptyString(surface.surfaceId) && uniqueNonEmptyStrings(surface.stateIds) && uniqueNonEmptyStrings(surface.viewportIds) && surface.viewportIds.every(viewportId => viewportIds.has(viewportId)));
  if (!validSurfaces || new Set(surfaces.map(surface => (surface as VisualCompositionSurfaceScope).surfaceId)).size !== surfaces.length) return false;
  return value.decision === "not-required" || (surfaces.length > 0 && viewports.length > 0);
}

export function isVisualCompositionRequirement(value: unknown): value is VisualCompositionRequirement {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "requestId", "snapshotId", "conditionId", "scopeDecision", "basisIds", "requiredCaptures", "viewports", "minimumIndependence"]) || value.schemaVersion !== "visual-composition-requirement/v1" || !nonEmptyString(value.requestId) || !nonEmptyString(value.snapshotId) || !nonEmptyString(value.conditionId) || !["required", "unknown"].includes(value.scopeDecision as string) || !uniqueNonEmptyStrings(value.basisIds) || !Array.isArray(value.requiredCaptures) || value.requiredCaptures.length === 0 || !Array.isArray(value.viewports) || value.viewports.length === 0 || value.viewports.some(viewport => !validViewport(viewport)) || !INDEPENDENCE.includes(value.minimumIndependence as IndependenceLevel)) return false;
  const captures = value.requiredCaptures as readonly unknown[];
  const viewports = value.viewports as readonly VisualCompositionViewport[];
  const viewportIds = new Set(viewports.map(viewport => viewport.id));
  if (viewportIds.size !== viewports.length) return false;
  if (!captures.every(capture => isRecord(capture) && exactKeys(capture, ["surfaceId", "stateId", "viewportId"]) && nonEmptyString(capture.surfaceId) && nonEmptyString(capture.stateId) && nonEmptyString(capture.viewportId) && viewportIds.has(capture.viewportId))) return false;
  return new Set(captures.map(capture => captureKey(capture as VisualCompositionCaptureRequirement))).size === captures.length;
}

export function isVisualCompositionOracle(value: unknown): value is VisualCompositionOracle {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "oracleId", "requestId", "snapshotId", "conditionId", "producer", "captures", "representativeStateLimitations", "blockingReasons"]) || value.schemaVersion !== "visual-composition-oracle/v1" || !nonEmptyString(value.oracleId) || !nonEmptyString(value.requestId) || !nonEmptyString(value.snapshotId) || !nonEmptyString(value.conditionId) || !validProducer(value.producer) || !Array.isArray(value.captures) || value.captures.some(capture => !validCapture(capture)) || !uniqueNonEmptyStrings(value.representativeStateLimitations, true) || !uniqueNonEmptyStrings(value.blockingReasons, true)) return false;
  const captures = value.captures as readonly VisualCompositionCapture[];
  return new Set(captures.map(capture => capture.captureId)).size === captures.length && new Set(captures.map(captureKey)).size === captures.length;
}

export function requirementFromVisualCompositionScope(requestId: string, snapshotId: string, conditionId: string, scope: VisualCompositionScope, minimumIndependence: IndependenceLevel): VisualCompositionRequirement | undefined {
  if (!nonEmptyString(requestId) || !nonEmptyString(snapshotId) || !nonEmptyString(conditionId) || !isVisualCompositionScope(scope) || scope.decision === "not-required" || !INDEPENDENCE.includes(minimumIndependence)) return undefined;
  const requiredCaptures = scope.surfaces.flatMap(surface => surface.stateIds.flatMap(stateId => surface.viewportIds.map(viewportId => ({ surfaceId: surface.surfaceId, stateId, viewportId }))));
  return {
    schemaVersion: "visual-composition-requirement/v1",
    requestId,
    snapshotId,
    conditionId,
    scopeDecision: scope.decision,
    basisIds: [...scope.basisIds],
    requiredCaptures,
    viewports: [...scope.viewports],
    minimumIndependence,
  };
}

function captureKey(value: VisualCompositionCaptureRequirement | VisualCompositionCapture): string {
  return `${value.surfaceId}\u0000${value.stateId}\u0000${value.viewportId}`;
}

function assertionPasses(assertion: VisualCompositionAssertion, actual: string | number | boolean = assertion.actual): boolean {
  switch (assertion.operator) {
    case "equals": return actual === assertion.expected;
    case "not-equals": return actual !== assertion.expected;
    case "less-than-or-equal": return (actual as number) <= (assertion.expected as number);
    case "greater-than-or-equal": return (actual as number) >= (assertion.expected as number);
    case "contains": return (actual as string).includes(assertion.expected as string);
  }
}

const GEOMETRIC_RELATIONS = new Set<VisualCompositionRelation>(["separation", "inset", "alignment", "containment", "non-overlap", "ordering", "size-ratio", "density"]);

function derivedGeometryActual(assertion: VisualCompositionAssertion, regions: ReadonlyMap<string, VisualCompositionRegion>, viewport: VisualCompositionViewport): number | boolean | undefined {
  const selected = assertion.regionIds.map(regionId => regions.get(regionId)).filter((region): region is VisualCompositionRegion => region !== undefined);
  if (selected.length !== assertion.regionIds.length || selected.length < 1) return undefined;
  const first = selected[0]!;
  if (assertion.relation === "separation" || assertion.relation === "non-overlap") {
    if (selected.length < 2) return undefined;
    let minimumGap = Number.POSITIVE_INFINITY;
    let nonOverlapping = true;
    for (let leftIndex = 0; leftIndex < selected.length - 1; leftIndex++) {
      const left = selected[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < selected.length; rightIndex++) {
        const right = selected[rightIndex]!;
        const separated = left.x + left.width <= right.x || right.x + right.width <= left.x || left.y + left.height <= right.y || right.y + right.height <= left.y;
        nonOverlapping &&= separated;
        minimumGap = Math.min(minimumGap, Math.max(left.x - (right.x + right.width), right.x - (left.x + left.width), left.y - (right.y + right.height), right.y - (left.y + left.height), 0));
      }
    }
    return assertion.relation === "separation" ? minimumGap : nonOverlapping;
  }
  const rest = selected.slice(1);
  if (assertion.relation === "containment") return rest.length > 0 && rest.every(region => first.x <= region.x && first.y <= region.y && first.x + first.width >= region.x + region.width && first.y + first.height >= region.y + region.height);
  if (assertion.relation === "inset") return rest.length > 0 ? Math.min(...rest.flatMap(region => [region.x - first.x, region.y - first.y, first.x + first.width - (region.x + region.width), first.y + first.height - (region.y + region.height)])) : undefined;
  if (assertion.relation === "alignment") {
    const guides = [
      selected.map(region => region.x),
      selected.map(region => region.x + region.width),
      selected.map(region => region.x + region.width / 2),
      selected.map(region => region.y),
      selected.map(region => region.y + region.height),
      selected.map(region => region.y + region.height / 2),
    ];
    return Math.min(...guides.map(values => Math.max(...values) - Math.min(...values)));
  }
  if (assertion.relation === "ordering") return selected.every((region, index) => index === 0 || selected[index - 1]!.y < region.y || selected[index - 1]!.y === region.y && selected[index - 1]!.x <= region.x);
  if (assertion.relation === "size-ratio") {
    if (selected.length !== 2) return undefined;
    const denominator = selected[1]!.width * selected[1]!.height;
    return denominator > 0 ? first.width * first.height / denominator : undefined;
  }
  if (assertion.relation === "density") return selected.reduce((area, region) => area + region.width * region.height, 0) / (viewport.width * viewport.height);
  return undefined;
}

function sourceUsesBasis(source: VisualOracleSource, basisIds: ReadonlySet<string>): boolean {
  if (source.kind === "explicit-basis") return basisIds.has(source.basisId);
  if (source.kind === "derived-relation") return source.basisIds.every(basisId => basisIds.has(basisId));
  return true;
}

export function evaluateVisualComposition(requirement: VisualCompositionRequirement, oracle: VisualCompositionOracle, artifacts: readonly Artifact[] = []): VisualCompositionEvaluation {
  const reasons: string[] = [];
  const failedAssertionIds: string[] = [];
  const missingCaptureKeys: string[] = [];
  if (!isVisualCompositionRequirement(requirement)) reasons.push("INVALID_REQUIREMENT");
  if (!isVisualCompositionOracle(oracle)) reasons.push("INVALID_ORACLE");
  if (reasons.length > 0) return { schemaVersion: "visual-composition-evaluation/v1", status: "INCOMPLETE", reasons, failedAssertionIds, missingCaptureKeys };
  if (oracle.requestId !== requirement.requestId) reasons.push("REQUEST_MISMATCH");
  if (oracle.snapshotId !== requirement.snapshotId) reasons.push("SNAPSHOT_MISMATCH");
  if (oracle.conditionId !== requirement.conditionId) reasons.push("CONDITION_MISMATCH");
  if (requirement.scopeDecision === "unknown") reasons.push("SCOPE_DECISION_UNKNOWN");
  if (independenceRank[oracle.producer.independence] < independenceRank[requirement.minimumIndependence]) reasons.push("INDEPENDENCE_NOT_MET");
  if (oracle.blockingReasons.length > 0) reasons.push(...oracle.blockingReasons.map(reason => `BLOCKED:${reason}`));
  const storedArtifacts = new Set(artifacts.filter(artifact => DIGEST.test(artifact.digest)).map(artifact => artifact.digest));
  const storedScreenshots = new Set(artifacts.filter(artifact => artifact.type === "screenshot" && DIGEST.test(artifact.digest)).map(artifact => artifact.digest));
  const requiredScreenshotDigests = oracle.captures.flatMap(capture => [capture.fullPageScreenshotDigest, ...capture.focusedRegionScreenshotDigests]);
  if (requiredScreenshotDigests.some(digest => !storedScreenshots.has(digest))) reasons.push("SCREENSHOT_ARTIFACT_MISSING");
  const expectedViewports = new Map(requirement.viewports.map(viewport => [viewport.id, viewport]));
  if (oracle.captures.some(capture => {
    const expected = expectedViewports.get(capture.viewportId);
    return !expected || capture.viewport.width !== expected.width || capture.viewport.height !== expected.height || capture.viewport.devicePixelRatio !== expected.devicePixelRatio;
  })) reasons.push("VIEWPORT_MISMATCH");
  const captures = new Map(oracle.captures.map(capture => [captureKey(capture), capture]));
  for (const required of requirement.requiredCaptures) if (!captures.has(captureKey(required))) missingCaptureKeys.push(captureKey(required));
  if (missingCaptureKeys.length > 0) reasons.push("REQUIRED_CAPTURE_MISSING");
  const basisIds = new Set(requirement.basisIds);
  for (const capture of oracle.captures) {
    const regions = new Map(capture.regions.map(region => [region.regionId, region]));
    for (const assertion of capture.assertions) {
      if (!sourceUsesBasis(assertion.source, basisIds)) reasons.push(`UNLINKED_ORACLE_SOURCE:${assertion.assertionId}`);
      if (assertion.source.kind === "approved-reference" && !storedArtifacts.has(assertion.source.artifactDigest)) reasons.push(`APPROVED_REFERENCE_ARTIFACT_MISSING:${assertion.assertionId}`);
      const derivedActual = derivedGeometryActual(assertion, regions, capture.viewport);
      const missingDerivation = GEOMETRIC_RELATIONS.has(assertion.relation) && derivedActual === undefined;
      if (missingDerivation || (derivedActual !== undefined && derivedActual !== assertion.actual) || !assertionPasses(assertion, derivedActual ?? assertion.actual)) failedAssertionIds.push(assertion.assertionId);
    }
  }
  if (failedAssertionIds.length > 0) reasons.push("COMPOSITION_ASSERTION_FAILED");
  const status = failedAssertionIds.length > 0 ? "FAIL" : oracle.blockingReasons.length > 0 ? "BLOCKED" : reasons.length > 0 ? "INCOMPLETE" : "PASS";
  return {
    schemaVersion: "visual-composition-evaluation/v1",
    status,
    reasons: [...new Set(reasons)].sort(),
    failedAssertionIds: [...new Set(failedAssertionIds)].sort(),
    missingCaptureKeys: [...new Set(missingCaptureKeys)].sort(),
  };
}
