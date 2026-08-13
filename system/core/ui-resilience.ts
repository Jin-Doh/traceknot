import type { Artifact, IndependenceLevel, Producer } from "./qa-core";

export type UiResilienceDecision = "required" | "unknown";
export type UiResilienceProfile =
  | "text-overflow"
  | "resize-text-200"
  | "reflow-320"
  | "text-spacing-wcag"
  | "pseudo-localization"
  | "rtl"
  | "reduced-motion"
  | "hover-focus-content";
export type UiSurfaceCapability =
  | "rendered-text"
  | "responsive-layout"
  | "localized-content"
  | "rtl-content"
  | "truncation"
  | "animation"
  | "hover-focus-content";
export type UiContentFixtureKind = "representative" | "long-natural-language" | "long-unbroken-token" | "pseudo-expanded" | "rtl";
export type UiOverflowPolicy = "no-overflow" | "wrap" | "scroll-x" | "truncate-with-access";

export type UiResilienceViewport = Readonly<{
  id: string;
  width: number;
  height: number;
  devicePixelRatio?: number;
  label?: string;
}>;

export type UiContentFixture = Readonly<{
  fixtureId: string;
  kind: UiContentFixtureKind;
  contentDigest: string;
}>;

export type UiRegionPolicy = Readonly<{
  regionId: string;
  policy: UiOverflowPolicy;
  basisIds: readonly string[];
  maxLines?: number;
}>;

export type UiApplicabilityApprovalReceipt = Readonly<{
  schemaVersion: "ui-applicability-approval-receipt/v1";
  receiptId: string;
  issuer: string;
  keyId: string;
  requestId: string;
  snapshotId: string;
  conditionId: string;
  surfaceId: string;
  profile: UiResilienceProfile;
  basisIds: readonly string[];
  rationale: string;
  signature: string;
}>;

export type UiProfileApplicability = Readonly<{
  profile: UiResilienceProfile;
  status: "required" | "not-applicable" | "unknown";
  basisIds: readonly string[];
  rationale: string;
  approvalReceipt?: UiApplicabilityApprovalReceipt;
}>;

export type UiResilienceSurfaceScope = Readonly<{
  surfaceId: string;
  stateIds: readonly string[];
  viewportIds: readonly string[];
  capabilities: readonly UiSurfaceCapability[];
  fixtures: readonly UiContentFixture[];
  regions: readonly UiRegionPolicy[];
  profileApplicability: readonly UiProfileApplicability[];
}>;

export type UiResilienceScope = Readonly<{
  schemaVersion: "ui-resilience-scope/v1";
  decision: UiResilienceDecision;
  basisIds: readonly string[];
  rationale: string;
  surfaces: readonly UiResilienceSurfaceScope[];
  viewports: readonly UiResilienceViewport[];
}>;

export type UiResilienceRunRequirement = Readonly<{
  surfaceId: string;
  stateId: string;
  viewportId: string;
  profile: UiResilienceProfile;
  fixtureId: string;
  fixtureContentDigest: string;
  regions: readonly UiRegionPolicy[];
}>;
export type UiApplicabilityApprovalSubject = Readonly<{
  requestId: string;
  snapshotId: string;
  conditionId: string;
  surfaceId: string;
  profile: UiResilienceProfile;
  basisIds: readonly string[];
  rationale: string;
  approvalReceipt: UiApplicabilityApprovalReceipt;
  approvalArtifactDigest: string;
}>;

export type UiResilienceRequirement = Readonly<{
  schemaVersion: "ui-resilience-requirement/v1";
  requestId: string;
  snapshotId: string;
  conditionId: string;
  scopeDecision: "required" | "unknown";
  basisIds: readonly string[];
  requiredRuns: readonly UiResilienceRunRequirement[];
  viewports: readonly UiResilienceViewport[];
  applicabilityApprovals: readonly UiApplicabilityApprovalSubject[];
  unknownApplicabilityKeys: readonly string[];
  minimumIndependence: IndependenceLevel;
}>;

export type UiFragmentRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type UiClippingAncestor = Readonly<{
  ancestorId: string;
  clipRect: UiFragmentRect;
  overflowX: "visible" | "hidden" | "clip" | "scroll" | "auto";
  overflowY: "visible" | "hidden" | "clip" | "scroll" | "auto";
}>;
export type UiPaintFeature = "clip-path" | "mask" | "border-radius" | "overflow-clip-margin" | "sibling-overlay";

export type UiFullTextAccessEvidence = Readonly<{
  schemaVersion: "ui-full-text-access/v1";
  evidenceId: string;
  requestId: string;
  snapshotId: string;
  conditionId: string;
  observationId: string;
  regionId: string;
  surfaceId: string;
  stateId: string;
  viewportId: string;
  profile: UiResilienceProfile;
  fixtureId: string;
  kind: "focus" | "activation" | "linked-detail";
  contentDigest: string;
  producer: Producer;
  payloadDigest: string;
  digest: string;
}>;

export type UiVisualReviewApprovalReceipt = Readonly<{
  schemaVersion: "ui-visual-review-approval-receipt/v1";
  receiptId: string;
  issuer: string;
  keyId: string;
  payloadDigest: string;
  signature: string;
}>;

export type UiVisualReview = Readonly<{
  reviewId: string;
  requestId: string;
  snapshotId: string;
  conditionId: string;
  observationId: string;
  surfaceId: string;
  stateId: string;
  viewportId: string;
  profile: UiResilienceProfile;
  fixtureId: string;
  outcome: "PASS" | "FAIL" | "INDETERMINATE";
  rationale: string;
  producer: Producer;
  screenshotDigest: string;
  approvalReceipt: UiVisualReviewApprovalReceipt;
  approvalArtifactDigest: string;
}>;

export type UiResilienceObservation = Readonly<{
  observationId: string;
  regionId: string;
  policy: UiOverflowPolicy;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  fragmentRects: readonly UiFragmentRect[];
  clippingAncestors: readonly UiClippingAncestor[];
  paintFeatures: readonly UiPaintFeature[];
  renderedLineCount: number;
  contentTruncated: boolean;
  truncationIndicatorVisible: boolean;
  screenshotDigest: string;
  fullTextAccess?: UiFullTextAccessEvidence;
  visualReview?: UiVisualReview;
}>;

export type UiProfileEvidence =
  | Readonly<{ profile: "text-overflow" }>
  | Readonly<{ profile: "resize-text-200"; textScalePercent: 200 }>
  | Readonly<{ profile: "reflow-320"; writingMode: "horizontal" | "vertical"; innerWidth: number; innerHeight: number }>
  | Readonly<{ profile: "text-spacing-wcag"; lineHeightRatio: number; paragraphSpacingRatio: number; letterSpacingRatio: number; wordSpacingRatio: number; onlySpacingPropertiesChanged: true }>
  | Readonly<{ profile: "pseudo-localization"; locale: string; expansionRatio: number; pseudoLocale: true }>
  | Readonly<{ profile: "rtl"; direction: "rtl"; locale: string }>
  | Readonly<{ profile: "reduced-motion"; preference: "reduce"; nonEssentialMotionDisabled: boolean }>
  | Readonly<{ profile: "hover-focus-content"; dismissible: boolean; hoverable: boolean; persistent: boolean }>;

export type UiResilienceRun = Readonly<{
  runId: string;
  surfaceId: string;
  stateId: string;
  viewportId: string;
  viewport: UiResilienceViewport;
  fixtureContentDigest: string;
  profile: UiResilienceProfile;
  fixtureId: string;
  browser: string;
  userAgent: string;
  profileEvidence: UiProfileEvidence;
  observations: readonly UiResilienceObservation[];
}>;

export type UiResilienceOracle = Readonly<{
  schemaVersion: "ui-resilience-oracle/v1";
  oracleId: string;
  requestId: string;
  snapshotId: string;
  conditionId: string;
  producer: Producer;
  runs: readonly UiResilienceRun[];
  blockingReasons: readonly string[];
}>;

export type UiResilienceEvaluation = Readonly<{
  schemaVersion: "ui-resilience-evaluation/v1";
  status: "PASS" | "FAIL" | "BLOCKED" | "INCOMPLETE";
  reasons: readonly string[];
  failedObservationIds: readonly string[];
  missingRunKeys: readonly string[];
}>;

const DIGEST = /^[0-9a-f]{64}$/;
const INDEPENDENCE: readonly IndependenceLevel[] = ["self-check", "separate-verification-context", "independent-producer", "external-approval"];
const PRODUCER_KINDS: readonly Producer["kind"][] = ["self", "harness-managed", "deterministic-verifier", "ci", "human", "external-system"];
const PROFILES: readonly UiResilienceProfile[] = ["text-overflow", "resize-text-200", "reflow-320", "text-spacing-wcag", "pseudo-localization", "rtl", "reduced-motion", "hover-focus-content"];
const CAPABILITIES: readonly UiSurfaceCapability[] = ["rendered-text", "responsive-layout", "localized-content", "rtl-content", "truncation", "animation", "hover-focus-content"];
const FIXTURE_KINDS: readonly UiContentFixtureKind[] = ["representative", "long-natural-language", "long-unbroken-token", "pseudo-expanded", "rtl"];
const POLICIES: readonly UiOverflowPolicy[] = ["no-overflow", "wrap", "scroll-x", "truncate-with-access"];
const PAINT_FEATURES: readonly UiPaintFeature[] = ["clip-path", "mask", "border-radius", "overflow-clip-margin", "sibling-overlay"];
const OVERFLOW_VALUES: readonly UiClippingAncestor["overflowX"][] = ["visible", "hidden", "clip", "scroll", "auto"];
const independenceRank: Readonly<Record<IndependenceLevel, number>> = { "self-check": 0, "separate-verification-context": 1, "independent-producer": 2, "external-approval": 3 };
const profileFixtures: Readonly<Record<UiResilienceProfile, readonly UiContentFixtureKind[]>> = {
  "text-overflow": ["representative", "long-natural-language", "long-unbroken-token"],
  "resize-text-200": ["representative", "long-natural-language"],
  "reflow-320": ["representative", "long-natural-language", "long-unbroken-token"],
  "text-spacing-wcag": ["representative", "long-natural-language"],
  "pseudo-localization": ["pseudo-expanded"],
  rtl: ["rtl"],
  "reduced-motion": ["representative"],
  "hover-focus-content": ["representative"],
};

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && keys.every(key => allowed.has(key));
}
function nonEmptyString(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function finiteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function nonNegativeNumber(value: unknown): value is number { return finiteNumber(value) && value >= 0; }
function positiveNumber(value: unknown): value is number { return finiteNumber(value) && value > 0; }
function uniqueStrings(value: unknown, allowEmpty = false): value is readonly string[] { return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(nonEmptyString) && new Set(value).size === value.length; }
function validDigest(value: unknown): value is string { return typeof value === "string" && DIGEST.test(value); }
function validProducer(value: unknown): value is Producer {
  return isRecord(value) && exactKeys(value, ["kind", "identity", "independence"]) && PRODUCER_KINDS.includes(value.kind as Producer["kind"]) && nonEmptyString(value.identity) && INDEPENDENCE.includes(value.independence as IndependenceLevel) && !(value.kind === "self" && value.independence !== "self-check");
}
function validViewport(value: unknown): value is UiResilienceViewport {
  return isRecord(value) && exactKeys(value, ["id", "width", "height"], ["devicePixelRatio", "label"]) && nonEmptyString(value.id) && positiveNumber(value.width) && positiveNumber(value.height) && (value.devicePixelRatio === undefined || positiveNumber(value.devicePixelRatio)) && (value.label === undefined || nonEmptyString(value.label));
}
function validFixture(value: unknown): value is UiContentFixture {
  return isRecord(value) && exactKeys(value, ["fixtureId", "kind", "contentDigest"]) && nonEmptyString(value.fixtureId) && FIXTURE_KINDS.includes(value.kind as UiContentFixtureKind) && validDigest(value.contentDigest);
}
function validRegionPolicy(value: unknown): value is UiRegionPolicy {
  return isRecord(value) && exactKeys(value, ["regionId", "policy", "basisIds"], ["maxLines"]) && nonEmptyString(value.regionId) && POLICIES.includes(value.policy as UiOverflowPolicy) && uniqueStrings(value.basisIds) && (value.maxLines === undefined || (Number.isInteger(value.maxLines) && (value.maxLines as number) > 0)) && (value.policy === "truncate-with-access" ? Number.isInteger(value.maxLines) && (value.maxLines as number) > 0 : value.maxLines === undefined);
}
function sameStrings(left: readonly string[], right: unknown): boolean {
  if (!Array.isArray(right) || !right.every(item => typeof item === "string") || left.length !== right.length) return false;
  const sortedLeft = [...left].sort(compareCodeUnits);
  const sortedRight = [...right].sort(compareCodeUnits);
  return sortedLeft.every((item, index) => item === sortedRight[index]);
}
function requiredProfiles(capabilities: readonly UiSurfaceCapability[]): Set<UiResilienceProfile> {
  const result = new Set<UiResilienceProfile>();
  if (capabilities.includes("rendered-text") || capabilities.includes("truncation")) ["text-overflow", "resize-text-200", "text-spacing-wcag"].forEach(profile => result.add(profile as UiResilienceProfile));
  if (capabilities.includes("responsive-layout")) result.add("reflow-320");
  if (capabilities.includes("localized-content")) result.add("pseudo-localization");
  if (capabilities.includes("rtl-content")) result.add("rtl");
  if (capabilities.includes("animation")) result.add("reduced-motion");
  if (capabilities.includes("hover-focus-content")) result.add("hover-focus-content");
  return result;
}
function validApplicabilityReceipt(value: unknown): value is UiApplicabilityApprovalReceipt {
  return isRecord(value) && exactKeys(value, ["schemaVersion", "receiptId", "issuer", "keyId", "requestId", "snapshotId", "conditionId", "surfaceId", "profile", "basisIds", "rationale", "signature"]) && value.schemaVersion === "ui-applicability-approval-receipt/v1" && nonEmptyString(value.receiptId) && nonEmptyString(value.issuer) && nonEmptyString(value.keyId) && nonEmptyString(value.requestId) && nonEmptyString(value.snapshotId) && nonEmptyString(value.conditionId) && nonEmptyString(value.surfaceId) && PROFILES.includes(value.profile as UiResilienceProfile) && uniqueStrings(value.basisIds) && nonEmptyString(value.rationale) && nonEmptyString(value.signature);
}
function validApplicability(surfaceId: string, value: unknown, required: ReadonlySet<UiResilienceProfile>, scopeBasisIds: ReadonlySet<string>): value is UiProfileApplicability {
  if (!isRecord(value) || !exactKeys(value, ["profile", "status", "basisIds", "rationale"], ["approvalReceipt"]) || !PROFILES.includes(value.profile as UiResilienceProfile) || !["required", "not-applicable", "unknown"].includes(value.status as string) || !uniqueStrings(value.basisIds) || !(value.basisIds as string[]).every(id => scopeBasisIds.has(id)) || !nonEmptyString(value.rationale)) return false;
  const profile = value.profile as UiResilienceProfile;
  if (required.has(profile)) return value.status === "required" && value.approvalReceipt === undefined;
  if (value.status === "not-applicable") {
    if (!validApplicabilityReceipt(value.approvalReceipt)) return false;
    const receipt = value.approvalReceipt;
    return receipt.surfaceId === surfaceId && receipt.profile === profile && sameStrings(receipt.basisIds, value.basisIds) && receipt.rationale === value.rationale;
  }
  return value.status === "unknown" && value.approvalReceipt === undefined;
}
function validSurface(value: unknown, viewportIds: ReadonlySet<string>, scopeBasisIds: ReadonlySet<string>): value is UiResilienceSurfaceScope {
  if (!isRecord(value) || !exactKeys(value, ["surfaceId", "stateIds", "viewportIds", "capabilities", "fixtures", "regions", "profileApplicability"]) || !nonEmptyString(value.surfaceId) || !uniqueStrings(value.stateIds) || !uniqueStrings(value.viewportIds) || !(value.viewportIds as string[]).every(id => viewportIds.has(id)) || !Array.isArray(value.capabilities) || value.capabilities.length === 0 || value.capabilities.some(item => !CAPABILITIES.includes(item as UiSurfaceCapability)) || new Set(value.capabilities).size !== value.capabilities.length || !Array.isArray(value.fixtures) || value.fixtures.length === 0 || value.fixtures.some(item => !validFixture(item)) || !Array.isArray(value.regions) || value.regions.length === 0 || value.regions.some(item => !validRegionPolicy(item)) || !Array.isArray(value.profileApplicability) || value.profileApplicability.length !== PROFILES.length) return false;
  const fixtures = value.fixtures as readonly UiContentFixture[];
  const regions = value.regions as readonly UiRegionPolicy[];
  const applicability = value.profileApplicability as readonly UiProfileApplicability[];
  if (new Set(fixtures.map(item => item.fixtureId)).size !== fixtures.length || new Set(regions.map(item => item.regionId)).size !== regions.length || regions.some(region => region.basisIds.some(id => !scopeBasisIds.has(id)))) return false;
  const required = requiredProfiles(value.capabilities as readonly UiSurfaceCapability[]);
  if (new Set(applicability.map(item => item.profile)).size !== PROFILES.length || applicability.some(item => !validApplicability(value.surfaceId as string, item, required, scopeBasisIds))) return false;
  const fixtureKinds = new Set(fixtures.map(item => item.kind));
  return [...required].every(profile => profileFixtures[profile].every(kind => fixtureKinds.has(kind)));
}

export function isUiResilienceScope(value: unknown): value is UiResilienceScope {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "decision", "basisIds", "rationale", "surfaces", "viewports"]) || value.schemaVersion !== "ui-resilience-scope/v1" || !["required", "unknown"].includes(value.decision as string) || !uniqueStrings(value.basisIds) || !nonEmptyString(value.rationale) || !Array.isArray(value.surfaces) || !Array.isArray(value.viewports) || value.viewports.length === 0 || value.viewports.some(item => !validViewport(item)) || value.surfaces.length === 0) return false;
  const viewports = value.viewports as readonly UiResilienceViewport[];
  const viewportIds = new Set(viewports.map(item => item.id));
  const basisIds = new Set(value.basisIds as readonly string[]);
  return viewportIds.size === viewports.length && value.surfaces.every(item => validSurface(item, viewportIds, basisIds)) && new Set((value.surfaces as readonly UiResilienceSurfaceScope[]).map(item => item.surfaceId)).size === value.surfaces.length;
}

function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function runKey(value: Pick<UiResilienceRunRequirement, "surfaceId" | "stateId" | "viewportId" | "profile" | "fixtureId">): string {
  return JSON.stringify([value.surfaceId, value.stateId, value.viewportId, value.profile, value.fixtureId]);
}
function applicabilityKey(surfaceId: string, profile: UiResilienceProfile): string { return JSON.stringify([surfaceId, profile]); }

export function requirementFromUiResilienceScope(requestId: string, snapshotId: string, conditionId: string, scope: UiResilienceScope, minimumIndependence: IndependenceLevel): UiResilienceRequirement | undefined {
  if (!nonEmptyString(requestId) || !nonEmptyString(snapshotId) || !nonEmptyString(conditionId) || !isUiResilienceScope(scope) || !INDEPENDENCE.includes(minimumIndependence)) return undefined;
  const requiredRuns: UiResilienceRunRequirement[] = [];
  const approvals: UiApplicabilityApprovalSubject[] = [];
  const unknown: string[] = [];
  for (const surface of scope.surfaces) {
    for (const applicability of surface.profileApplicability) {
      if (applicability.status === "not-applicable") {
        const approvalReceipt = applicability.approvalReceipt!;
        if (approvalReceipt.requestId !== requestId || approvalReceipt.snapshotId !== snapshotId || approvalReceipt.conditionId !== conditionId) return undefined;
        approvals.push({ requestId, snapshotId, conditionId, surfaceId: surface.surfaceId, profile: applicability.profile, basisIds: [...applicability.basisIds], rationale: applicability.rationale, approvalReceipt, approvalArtifactDigest: uiApplicabilityApprovalReceiptDigest(approvalReceipt) });
      }
      if (applicability.status === "unknown") unknown.push(applicabilityKey(surface.surfaceId, applicability.profile));
      if (applicability.status !== "required") continue;
      const fixtures = surface.fixtures.filter(item => profileFixtures[applicability.profile].includes(item.kind));
      for (const stateId of surface.stateIds) for (const viewportId of surface.viewportIds) for (const fixture of fixtures) requiredRuns.push({ surfaceId: surface.surfaceId, stateId, viewportId, profile: applicability.profile, fixtureId: fixture.fixtureId, fixtureContentDigest: fixture.contentDigest, regions: surface.regions.map(region => ({ ...region, basisIds: [...region.basisIds] })) });
    }
  }
  requiredRuns.sort((left, right) => compareCodeUnits(runKey(left), runKey(right)));
  approvals.sort((left, right) => compareCodeUnits(applicabilityKey(left.surfaceId, left.profile), applicabilityKey(right.surfaceId, right.profile)));
  return { schemaVersion: "ui-resilience-requirement/v1", requestId, snapshotId, conditionId, scopeDecision: scope.decision, basisIds: [...scope.basisIds], requiredRuns, viewports: [...scope.viewports], applicabilityApprovals: approvals, unknownApplicabilityKeys: unknown.sort(compareCodeUnits), minimumIndependence };
}

function validRunRequirement(value: unknown, viewportIds: ReadonlySet<string>): value is UiResilienceRunRequirement {
  return isRecord(value) && exactKeys(value, ["surfaceId", "stateId", "viewportId", "profile", "fixtureId", "fixtureContentDigest", "regions"]) && nonEmptyString(value.surfaceId) && nonEmptyString(value.stateId) && nonEmptyString(value.viewportId) && viewportIds.has(value.viewportId) && PROFILES.includes(value.profile as UiResilienceProfile) && nonEmptyString(value.fixtureId) && validDigest(value.fixtureContentDigest) && Array.isArray(value.regions) && value.regions.length > 0 && value.regions.every(item => validRegionPolicy(item)) && new Set((value.regions as readonly UiRegionPolicy[]).map(item => item.regionId)).size === value.regions.length;
}
function validApplicabilityApprovalSubject(value: unknown, requirement: Pick<UiResilienceRequirement, "requestId" | "snapshotId" | "conditionId">): value is UiApplicabilityApprovalSubject {
  if (!isRecord(value) || !exactKeys(value, ["requestId", "snapshotId", "conditionId", "surfaceId", "profile", "basisIds", "rationale", "approvalReceipt", "approvalArtifactDigest"]) || value.requestId !== requirement.requestId || value.snapshotId !== requirement.snapshotId || value.conditionId !== requirement.conditionId || !nonEmptyString(value.surfaceId) || !PROFILES.includes(value.profile as UiResilienceProfile) || !uniqueStrings(value.basisIds) || !nonEmptyString(value.rationale) || !validApplicabilityReceipt(value.approvalReceipt) || !validDigest(value.approvalArtifactDigest)) return false;
  const receipt = value.approvalReceipt;
  return receipt.requestId === value.requestId && receipt.snapshotId === value.snapshotId && receipt.conditionId === value.conditionId && receipt.surfaceId === value.surfaceId && receipt.profile === value.profile && sameStrings(receipt.basisIds, value.basisIds) && receipt.rationale === value.rationale && value.approvalArtifactDigest === uiApplicabilityApprovalReceiptDigest(receipt);
}
export function isUiResilienceRequirement(value: unknown): value is UiResilienceRequirement {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "requestId", "snapshotId", "conditionId", "scopeDecision", "basisIds", "requiredRuns", "viewports", "applicabilityApprovals", "unknownApplicabilityKeys", "minimumIndependence"]) || value.schemaVersion !== "ui-resilience-requirement/v1" || !nonEmptyString(value.requestId) || !nonEmptyString(value.snapshotId) || !nonEmptyString(value.conditionId) || !["required", "unknown"].includes(value.scopeDecision as string) || !uniqueStrings(value.basisIds) || !Array.isArray(value.requiredRuns) || !Array.isArray(value.viewports) || value.viewports.length === 0 || value.viewports.some(item => !validViewport(item)) || !Array.isArray(value.applicabilityApprovals) || value.applicabilityApprovals.some(item => !validApplicabilityApprovalSubject(item, value as UiResilienceRequirement)) || !uniqueStrings(value.unknownApplicabilityKeys, true) || !INDEPENDENCE.includes(value.minimumIndependence as IndependenceLevel)) return false;
  const viewportIds = new Set((value.viewports as readonly UiResilienceViewport[]).map(item => item.id));
  const runs = value.requiredRuns as readonly UiResilienceRunRequirement[];
  const approvals = value.applicabilityApprovals as readonly UiApplicabilityApprovalSubject[];
  return viewportIds.size === value.viewports.length && runs.length > 0 && runs.every(item => validRunRequirement(item, viewportIds)) && new Set(runs.map(runKey)).size === runs.length && new Set(approvals.map(item => applicabilityKey(item.surfaceId, item.profile))).size === approvals.length;
}

function validRect(value: unknown): value is UiFragmentRect { return isRecord(value) && exactKeys(value, ["x", "y", "width", "height"]) && finiteNumber(value.x) && finiteNumber(value.y) && nonNegativeNumber(value.width) && nonNegativeNumber(value.height); }
function validAncestor(value: unknown): value is UiClippingAncestor { return isRecord(value) && exactKeys(value, ["ancestorId", "clipRect", "overflowX", "overflowY"]) && nonEmptyString(value.ancestorId) && validRect(value.clipRect) && OVERFLOW_VALUES.includes(value.overflowX as UiClippingAncestor["overflowX"]) && OVERFLOW_VALUES.includes(value.overflowY as UiClippingAncestor["overflowY"]); }
function validFullTextAccess(value: unknown): value is UiFullTextAccessEvidence {
  return isRecord(value)
    && exactKeys(value, ["schemaVersion", "evidenceId", "requestId", "snapshotId", "conditionId", "observationId", "regionId", "surfaceId", "stateId", "viewportId", "profile", "fixtureId", "kind", "contentDigest", "producer", "payloadDigest", "digest"])
    && value.schemaVersion === "ui-full-text-access/v1"
    && nonEmptyString(value.evidenceId)
    && nonEmptyString(value.requestId)
    && nonEmptyString(value.snapshotId)
    && nonEmptyString(value.conditionId)
    && nonEmptyString(value.observationId)
    && nonEmptyString(value.regionId)
    && nonEmptyString(value.surfaceId)
    && nonEmptyString(value.stateId)
    && nonEmptyString(value.viewportId)
    && PROFILES.includes(value.profile as UiResilienceProfile)
    && nonEmptyString(value.fixtureId)
    && ["focus", "activation", "linked-detail"].includes(value.kind as string)
    && validDigest(value.contentDigest)
    && validProducer(value.producer)
    && validDigest(value.payloadDigest)
    && validDigest(value.digest)
    && value.payloadDigest === uiFullTextAccessPayloadDigest(value as UiFullTextAccessEvidence);
}
function validReviewReceipt(value: unknown): value is UiVisualReviewApprovalReceipt {
  return isRecord(value)
    && exactKeys(value, ["schemaVersion", "receiptId", "issuer", "keyId", "payloadDigest", "signature"])
    && value.schemaVersion === "ui-visual-review-approval-receipt/v1"
    && nonEmptyString(value.receiptId)
    && nonEmptyString(value.issuer)
    && nonEmptyString(value.keyId)
    && validDigest(value.payloadDigest)
    && nonEmptyString(value.signature);
}
function validReview(value: unknown): value is UiVisualReview {
  return isRecord(value)
    && exactKeys(value, ["reviewId", "requestId", "snapshotId", "conditionId", "observationId", "surfaceId", "stateId", "viewportId", "profile", "fixtureId", "outcome", "rationale", "producer", "screenshotDigest", "approvalReceipt", "approvalArtifactDigest"])
    && nonEmptyString(value.reviewId)
    && nonEmptyString(value.requestId)
    && nonEmptyString(value.snapshotId)
    && nonEmptyString(value.conditionId)
    && nonEmptyString(value.observationId)
    && nonEmptyString(value.surfaceId)
    && nonEmptyString(value.stateId)
    && nonEmptyString(value.viewportId)
    && PROFILES.includes(value.profile as UiResilienceProfile)
    && nonEmptyString(value.fixtureId)
    && ["PASS", "FAIL", "INDETERMINATE"].includes(value.outcome as string)
    && nonEmptyString(value.rationale)
    && validProducer(value.producer)
    && value.producer.kind === "human"
    && independenceRank[value.producer.independence] >= independenceRank["independent-producer"]
    && validDigest(value.screenshotDigest)
    && validReviewReceipt(value.approvalReceipt)
    && validDigest(value.approvalArtifactDigest)
    && value.approvalReceipt.payloadDigest === uiVisualReviewApprovalPayloadDigest(value as UiVisualReview)
    && value.approvalArtifactDigest === uiVisualReviewApprovalReceiptDigest(value.approvalReceipt);
}
function validObservation(value: unknown): value is UiResilienceObservation {
  return isRecord(value) && exactKeys(value, ["observationId", "regionId", "policy", "clientWidth", "clientHeight", "scrollWidth", "scrollHeight", "fragmentRects", "clippingAncestors", "paintFeatures", "renderedLineCount", "contentTruncated", "truncationIndicatorVisible", "screenshotDigest"], ["fullTextAccess", "visualReview"]) && nonEmptyString(value.observationId) && nonEmptyString(value.regionId) && POLICIES.includes(value.policy as UiOverflowPolicy) && positiveNumber(value.clientWidth) && positiveNumber(value.clientHeight) && positiveNumber(value.scrollWidth) && positiveNumber(value.scrollHeight) && value.scrollWidth >= value.clientWidth && value.scrollHeight >= value.clientHeight && Array.isArray(value.fragmentRects) && value.fragmentRects.length > 0 && value.fragmentRects.every(rect => validRect(rect) && rect.width > 0 && rect.height > 0) && Array.isArray(value.clippingAncestors) && value.clippingAncestors.every(validAncestor) && new Set((value.clippingAncestors as readonly UiClippingAncestor[]).map(item => item.ancestorId)).size === value.clippingAncestors.length && Array.isArray(value.paintFeatures) && value.paintFeatures.every(item => PAINT_FEATURES.includes(item as UiPaintFeature)) && new Set(value.paintFeatures).size === value.paintFeatures.length && Number.isInteger(value.renderedLineCount) && (value.renderedLineCount as number) > 0 && typeof value.contentTruncated === "boolean" && typeof value.truncationIndicatorVisible === "boolean" && validDigest(value.screenshotDigest) && (value.fullTextAccess === undefined || validFullTextAccess(value.fullTextAccess)) && (value.visualReview === undefined || (validReview(value.visualReview) && value.visualReview.screenshotDigest === value.screenshotDigest));
}
function validProfileEvidence(value: unknown, profile: UiResilienceProfile): value is UiProfileEvidence {
  if (!isRecord(value) || value.profile !== profile) return false;
  switch (profile) {
    case "text-overflow": return exactKeys(value, ["profile"]);
    case "resize-text-200": return exactKeys(value, ["profile", "textScalePercent"]) && value.textScalePercent === 200;
    case "reflow-320": return exactKeys(value, ["profile", "writingMode", "innerWidth", "innerHeight"]) && ["horizontal", "vertical"].includes(value.writingMode as string) && positiveNumber(value.innerWidth) && positiveNumber(value.innerHeight) && (value.writingMode === "horizontal" ? value.innerWidth <= 320 : value.innerHeight <= 256);
    case "text-spacing-wcag": return exactKeys(value, ["profile", "lineHeightRatio", "paragraphSpacingRatio", "letterSpacingRatio", "wordSpacingRatio", "onlySpacingPropertiesChanged"]) && finiteNumber(value.lineHeightRatio) && value.lineHeightRatio >= 1.5 && finiteNumber(value.paragraphSpacingRatio) && value.paragraphSpacingRatio >= 2 && finiteNumber(value.letterSpacingRatio) && value.letterSpacingRatio >= 0.12 && finiteNumber(value.wordSpacingRatio) && value.wordSpacingRatio >= 0.16 && value.onlySpacingPropertiesChanged === true;
    case "pseudo-localization": return exactKeys(value, ["profile", "locale", "expansionRatio", "pseudoLocale"]) && nonEmptyString(value.locale) && finiteNumber(value.expansionRatio) && value.expansionRatio >= 1.4 && value.pseudoLocale === true;
    case "rtl": return exactKeys(value, ["profile", "direction", "locale"]) && value.direction === "rtl" && nonEmptyString(value.locale);
    case "reduced-motion": return exactKeys(value, ["profile", "preference", "nonEssentialMotionDisabled"]) && value.preference === "reduce" && typeof value.nonEssentialMotionDisabled === "boolean";
    case "hover-focus-content": return exactKeys(value, ["profile", "dismissible", "hoverable", "persistent"]) && typeof value.dismissible === "boolean" && typeof value.hoverable === "boolean" && typeof value.persistent === "boolean";
  }
}
function validRun(value: unknown): value is UiResilienceRun {
  if (!isRecord(value) || !exactKeys(value, ["runId", "surfaceId", "stateId", "viewportId", "viewport", "fixtureContentDigest", "profile", "fixtureId", "browser", "userAgent", "profileEvidence", "observations"]) || !nonEmptyString(value.runId) || !nonEmptyString(value.surfaceId) || !nonEmptyString(value.stateId) || !nonEmptyString(value.viewportId) || !validViewport(value.viewport) || value.viewport.id !== value.viewportId || !validDigest(value.fixtureContentDigest) || !PROFILES.includes(value.profile as UiResilienceProfile) || !nonEmptyString(value.fixtureId) || !nonEmptyString(value.browser) || !nonEmptyString(value.userAgent) || !validProfileEvidence(value.profileEvidence, value.profile as UiResilienceProfile) || !Array.isArray(value.observations) || value.observations.length === 0 || value.observations.some(item => !validObservation(item))) return false;
  return new Set((value.observations as readonly UiResilienceObservation[]).map(item => item.observationId)).size === value.observations.length && new Set((value.observations as readonly UiResilienceObservation[]).map(item => item.regionId)).size === value.observations.length;
}
export function isUiResilienceOracle(value: unknown): value is UiResilienceOracle {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "oracleId", "requestId", "snapshotId", "conditionId", "producer", "runs", "blockingReasons"]) || value.schemaVersion !== "ui-resilience-oracle/v1" || !nonEmptyString(value.oracleId) || !nonEmptyString(value.requestId) || !nonEmptyString(value.snapshotId) || !nonEmptyString(value.conditionId) || !validProducer(value.producer) || !Array.isArray(value.runs) || value.runs.some(item => !validRun(item)) || !uniqueStrings(value.blockingReasons, true)) return false;
  const runs = value.runs as readonly UiResilienceRun[];
  return new Set(runs.map(item => item.runId)).size === runs.length && new Set(runs.map(runKey)).size === runs.length;
}

export function uiApplicabilityApprovalReceiptPayload(receipt: UiApplicabilityApprovalReceipt): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: receipt.schemaVersion,
    receiptId: receipt.receiptId,
    issuer: receipt.issuer,
    keyId: receipt.keyId,
    requestId: receipt.requestId,
    snapshotId: receipt.snapshotId,
    conditionId: receipt.conditionId,
    surfaceId: receipt.surfaceId,
    profile: receipt.profile,
    basisIds: [...receipt.basisIds].sort(),
    rationale: receipt.rationale,
  };
}

export function uiApplicabilityApprovalReceiptDigest(receipt: UiApplicabilityApprovalReceipt): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify({ ...uiApplicabilityApprovalReceiptPayload(receipt), signature: receipt.signature }));
  return hasher.digest("hex");
}

export function uiApplicabilityApprovalSubjectPayload(subject: UiApplicabilityApprovalSubject): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "ui-applicability-approval-subject/v1",
    requestId: subject.requestId,
    snapshotId: subject.snapshotId,
    conditionId: subject.conditionId,
    surfaceId: subject.surfaceId,
    profile: subject.profile,
    basisIds: [...subject.basisIds].sort(),
    rationale: subject.rationale,
    approvalArtifactDigest: subject.approvalArtifactDigest,
  };
}

export function uiApplicabilityApprovalSubjectDigest(subject: UiApplicabilityApprovalSubject): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(uiApplicabilityApprovalSubjectPayload(subject)));
  return hasher.digest("hex");
}

export function uiFullTextAccessPayload(evidence: Pick<UiFullTextAccessEvidence, "schemaVersion" | "evidenceId" | "requestId" | "snapshotId" | "conditionId" | "observationId" | "regionId" | "surfaceId" | "stateId" | "viewportId" | "profile" | "fixtureId" | "kind" | "contentDigest" | "producer">): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: evidence.schemaVersion,
    evidenceId: evidence.evidenceId,
    requestId: evidence.requestId,
    snapshotId: evidence.snapshotId,
    conditionId: evidence.conditionId,
    observationId: evidence.observationId,
    regionId: evidence.regionId,
    surfaceId: evidence.surfaceId,
    stateId: evidence.stateId,
    viewportId: evidence.viewportId,
    profile: evidence.profile,
    fixtureId: evidence.fixtureId,
    kind: evidence.kind,
    contentDigest: evidence.contentDigest,
    producer: {
      kind: evidence.producer.kind,
      identity: evidence.producer.identity,
      independence: evidence.producer.independence,
    },
  };
}

export function uiFullTextAccessPayloadDigest(evidence: Parameters<typeof uiFullTextAccessPayload>[0]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(uiFullTextAccessPayload(evidence)));
  return hasher.digest("hex");
}

export type UiFullTextAccessArtifact = Readonly<{
  schemaVersion: "ui-full-text-access-artifact/v1";
  payload: ReturnType<typeof uiFullTextAccessPayload>;
  payloadDigest: string;
  text: string;
}>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort(compareCodeUnits).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function isUiFullTextAccessArtifact(value: unknown, expected: UiFullTextAccessEvidence): value is UiFullTextAccessArtifact {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "payload", "payloadDigest", "text"]) || value.schemaVersion !== "ui-full-text-access-artifact/v1" || !isRecord(value.payload) || typeof value.text !== "string" || value.text.length === 0 || !validDigest(value.payloadDigest)) return false;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value.text);
  return value.payloadDigest === expected.payloadDigest
    && value.payloadDigest === uiFullTextAccessPayloadDigest(expected)
    && hasher.digest("hex") === expected.contentDigest
    && canonicalJson(value.payload) === canonicalJson(uiFullTextAccessPayload(expected));
}

export function uiVisualReviewApprovalPayloadDigest(review: Pick<UiVisualReview, "reviewId" | "requestId" | "snapshotId" | "conditionId" | "observationId" | "surfaceId" | "stateId" | "viewportId" | "profile" | "fixtureId" | "outcome" | "rationale" | "producer" | "screenshotDigest">): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify({
    schemaVersion: "ui-visual-review-approval-payload/v1",
    reviewId: review.reviewId,
    requestId: review.requestId,
    snapshotId: review.snapshotId,
    conditionId: review.conditionId,
    observationId: review.observationId,
    outcome: review.outcome,
    surfaceId: review.surfaceId,
    stateId: review.stateId,
    viewportId: review.viewportId,
    profile: review.profile,
    fixtureId: review.fixtureId,
    rationale: review.rationale,
    producer: {
      kind: review.producer.kind,
      identity: review.producer.identity,
      independence: review.producer.independence,
    },
    screenshotDigest: review.screenshotDigest,
  }));
  return hasher.digest("hex");
}

export function uiVisualReviewApprovalReceiptDigest(receipt: UiVisualReviewApprovalReceipt): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    receiptId: receipt.receiptId,
    issuer: receipt.issuer,
    keyId: receipt.keyId,
    payloadDigest: receipt.payloadDigest,
    signature: receipt.signature,
  }));
  return hasher.digest("hex");
}

function rectContained(rect: UiFragmentRect, clip: UiFragmentRect): boolean { return rect.x >= clip.x && rect.y >= clip.y && rect.x + rect.width <= clip.x + clip.width && rect.y + rect.height <= clip.y + clip.height; }
function observationDisposition(observation: UiResilienceObservation, expectedPolicy: UiRegionPolicy, reviewApproved: boolean): "PASS" | "FAIL" | "INCOMPLETE" {
  const horizontalOverflow = observation.scrollWidth > observation.clientWidth;
  const verticalOverflow = observation.scrollHeight > observation.clientHeight;
  const fragmentClipped = observation.fragmentRects.some(rect => observation.clippingAncestors.some(ancestor => {
    const outsideX = rect.x < ancestor.clipRect.x || rect.x + rect.width > ancestor.clipRect.x + ancestor.clipRect.width;
    const outsideY = rect.y < ancestor.clipRect.y || rect.y + rect.height > ancestor.clipRect.y + ancestor.clipRect.height;
    const clipsX = ancestor.overflowX === "hidden" || ancestor.overflowX === "clip"
      || (expectedPolicy.policy !== "scroll-x" && (ancestor.overflowX === "scroll" || ancestor.overflowX === "auto"));
    const clipsY = ancestor.overflowY !== "visible";
    return (outsideX && clipsX) || (outsideY && clipsY);
  }));
  const geometryRisk = horizontalOverflow || verticalOverflow || fragmentClipped;
  const reviewRequired = observation.paintFeatures.length > 0;
  if (reviewApproved && observation.visualReview?.outcome === "FAIL") return "FAIL";
  if (reviewRequired && (!reviewApproved || observation.visualReview?.outcome !== "PASS")) return "INCOMPLETE";
  if (expectedPolicy.policy === "truncate-with-access") {
    const maxLines = expectedPolicy.maxLines!;
    if (observation.renderedLineCount > maxLines || (observation.contentTruncated && observation.renderedLineCount !== maxLines)) return "FAIL";
    if (!observation.contentTruncated) return geometryRisk ? "FAIL" : "PASS";
    return observation.truncationIndicatorVisible && observation.fullTextAccess ? "PASS" : "FAIL";
  }
  if (observation.contentTruncated) return "FAIL";
  if (expectedPolicy.policy === "scroll-x") return verticalOverflow || fragmentClipped ? "FAIL" : "PASS";
  return geometryRisk ? "FAIL" : "PASS";
}
function profileDisposition(run: UiResilienceRun): "PASS" | "FAIL" {
  const evidence = run.profileEvidence;
  if (evidence.profile === "reduced-motion" && !evidence.nonEssentialMotionDisabled) return "FAIL";
  if (evidence.profile === "hover-focus-content" && (!evidence.dismissible || !evidence.hoverable || !evidence.persistent)) return "FAIL";
  return "PASS";
}

export function evaluateUiResilience(requirement: UiResilienceRequirement, oracle: UiResilienceOracle, artifacts: readonly Artifact[] = [], authenticatedReviewApprovalDigests: readonly string[] = [], authenticatedApplicabilityApprovalSubjectDigests: readonly string[] = []): UiResilienceEvaluation {
  const reasons: string[] = [];
  const failedObservationIds: string[] = [];
  const missingRunKeys: string[] = [];
  if (!isUiResilienceRequirement(requirement)) reasons.push("INVALID_REQUIREMENT");
  if (!isUiResilienceOracle(oracle)) reasons.push("INVALID_ORACLE");
  if (reasons.length > 0) return { schemaVersion: "ui-resilience-evaluation/v1", status: "INCOMPLETE", reasons, failedObservationIds, missingRunKeys };
  const bindingReasons: string[] = [];
  if (oracle.requestId !== requirement.requestId) bindingReasons.push("REQUEST_MISMATCH");
  if (oracle.snapshotId !== requirement.snapshotId) bindingReasons.push("SNAPSHOT_MISMATCH");
  if (oracle.conditionId !== requirement.conditionId) bindingReasons.push("CONDITION_MISMATCH");
  if (bindingReasons.length > 0) return { schemaVersion: "ui-resilience-evaluation/v1", status: "INCOMPLETE", reasons: bindingReasons.sort(), failedObservationIds, missingRunKeys };
  const coveredBasisIds = new Set([
    ...requirement.requiredRuns.flatMap(run => run.regions.flatMap(region => region.basisIds)),
    ...requirement.applicabilityApprovals.flatMap(approval => approval.basisIds),
  ]);
  for (const basisId of requirement.basisIds) if (!coveredBasisIds.has(basisId)) reasons.push(`BASIS_UNCOVERED:${basisId}`);
  if (independenceRank[oracle.producer.independence] < independenceRank[requirement.minimumIndependence]) {
    return { schemaVersion: "ui-resilience-evaluation/v1", status: "INCOMPLETE", reasons: ["INDEPENDENCE_NOT_MET"], failedObservationIds, missingRunKeys };
  }
  if (requirement.scopeDecision === "unknown") reasons.push("SCOPE_DECISION_UNKNOWN");
  if (requirement.unknownApplicabilityKeys.length > 0) reasons.push(...requirement.unknownApplicabilityKeys.map(key => `APPLICABILITY_UNKNOWN:${key}`));
  const artifactKeys = new Set(artifacts.map(item => `${item.type}\u0000${item.digest}`));
  const authenticatedReviewApprovals = new Set(authenticatedReviewApprovalDigests);
  const authenticatedApplicabilityApprovals = new Set(authenticatedApplicabilityApprovalSubjectDigests);
  for (const approval of requirement.applicabilityApprovals) {
    if (!artifactKeys.has(`ui-applicability-approval\u0000${approval.approvalArtifactDigest}`)) reasons.push(`APPLICABILITY_APPROVAL_MISSING:${approval.approvalArtifactDigest}`);
    if (!authenticatedApplicabilityApprovals.has(uiApplicabilityApprovalSubjectDigest(approval))) reasons.push(`APPLICABILITY_APPROVAL_UNAUTHENTICATED:${approval.surfaceId}:${approval.profile}`);
  }
  const expectedViewports = new Map(requirement.viewports.map(item => [item.id, item]));
  const expectedRuns = new Map(requirement.requiredRuns.map(item => [runKey(item), item]));
  const actualRuns = new Map(oracle.runs.map(item => [runKey(item), item]));
  for (const key of expectedRuns.keys()) if (!actualRuns.has(key)) missingRunKeys.push(key);
  for (const key of actualRuns.keys()) if (!expectedRuns.has(key)) reasons.push(`UNEXPECTED_RUN:${key}`);
  for (const [key, run] of actualRuns) {
    const expected = expectedRuns.get(key);
    if (!expected) continue;
    if (run.fixtureContentDigest !== expected.fixtureContentDigest) { reasons.push(`FIXTURE_CONTENT_MISMATCH:${key}`); continue; }
    const viewport = expectedViewports.get(run.viewportId);
    if (!viewport || run.viewport.width !== viewport.width || run.viewport.height !== viewport.height || (run.viewport.devicePixelRatio ?? 1) !== (viewport.devicePixelRatio ?? 1)) { reasons.push(`VIEWPORT_MISMATCH:${key}`); continue; }
    const policies = new Map(expected.regions.map(item => [item.regionId, item]));
    const observations = new Map(run.observations.map(item => [item.regionId, item]));
    for (const regionId of policies.keys()) if (!observations.has(regionId)) reasons.push(`REGION_OBSERVATION_MISSING:${key}:${regionId}`);
    for (const regionId of observations.keys()) if (!policies.has(regionId)) reasons.push(`UNEXPECTED_REGION_OBSERVATION:${key}:${regionId}`);
    if (profileDisposition(run) === "FAIL") reasons.push(`PROFILE_CONDITION_FAILED:${key}`);
    for (const observation of run.observations) {
      const policy = policies.get(observation.regionId);
      if (!policy) continue;
      if (observation.fullTextAccess) {
        const accessMatchesSubject = observation.fullTextAccess.requestId === requirement.requestId
          && observation.fullTextAccess.snapshotId === requirement.snapshotId
          && observation.fullTextAccess.conditionId === requirement.conditionId
          && observation.fullTextAccess.observationId === observation.observationId
          && observation.fullTextAccess.regionId === observation.regionId
          && observation.fullTextAccess.surfaceId === run.surfaceId
          && observation.fullTextAccess.stateId === run.stateId
          && observation.fullTextAccess.viewportId === run.viewportId
          && observation.fullTextAccess.profile === run.profile
          && observation.fullTextAccess.fixtureId === run.fixtureId;
        if (!accessMatchesSubject) reasons.push(`FULL_TEXT_ACCESS_SUBJECT_MISMATCH:${observation.observationId}`);
        if (!artifactKeys.has(`ui-full-text-access\u0000${observation.fullTextAccess.digest}`)) reasons.push(`FULL_TEXT_ACCESS_ARTIFACT_MISSING:${observation.observationId}`);
      }
      if (observation.policy !== policy.policy) { reasons.push(`OVERFLOW_POLICY_MISMATCH:${observation.observationId}`); continue; }
      if (!artifactKeys.has(`screenshot\u0000${observation.screenshotDigest}`)) { reasons.push(`SCREENSHOT_ARTIFACT_MISSING:${observation.observationId}`); continue; }
      const reviewMatchesSubject = observation.visualReview !== undefined
        && observation.visualReview.requestId === requirement.requestId
        && observation.visualReview.snapshotId === requirement.snapshotId
        && observation.visualReview.conditionId === requirement.conditionId
        && observation.visualReview.observationId === observation.observationId
        && observation.visualReview.surfaceId === run.surfaceId
        && observation.visualReview.stateId === run.stateId
        && observation.visualReview.viewportId === run.viewportId
        && observation.visualReview.profile === run.profile
        && observation.visualReview.fixtureId === run.fixtureId
        && observation.visualReview.screenshotDigest === observation.screenshotDigest;
      const reviewApproved = reviewMatchesSubject
        && artifactKeys.has(`ui-visual-review-approval-receipt\u0000${observation.visualReview!.approvalArtifactDigest}`)
        && authenticatedReviewApprovals.has(observation.visualReview!.approvalArtifactDigest);
      if (observation.visualReview && !reviewMatchesSubject) reasons.push(`VISUAL_REVIEW_SUBJECT_MISMATCH:${observation.observationId}`);
      if (observation.visualReview && !artifactKeys.has(`ui-visual-review-approval-receipt\u0000${observation.visualReview.approvalArtifactDigest}`)) reasons.push(`VISUAL_REVIEW_APPROVAL_ARTIFACT_MISSING:${observation.observationId}`);
      if (observation.visualReview && !authenticatedReviewApprovals.has(observation.visualReview.approvalArtifactDigest)) reasons.push(`VISUAL_REVIEW_APPROVAL_UNAUTHENTICATED:${observation.observationId}`);
      const disposition = observationDisposition(observation, policy, reviewApproved);
      if (disposition === "FAIL") failedObservationIds.push(observation.observationId);
      if (disposition === "INCOMPLETE") reasons.push(`VISUAL_REVIEW_REQUIRED:${observation.observationId}`);
    }
  }
  missingRunKeys.sort();
  failedObservationIds.sort();
  reasons.sort();
  const status = failedObservationIds.length > 0 || reasons.some(reason => reason.startsWith("PROFILE_CONDITION_FAILED:")) ? "FAIL" : oracle.blockingReasons.length > 0 ? "BLOCKED" : missingRunKeys.length > 0 || reasons.length > 0 ? "INCOMPLETE" : "PASS";
  return { schemaVersion: "ui-resilience-evaluation/v1", status, reasons: oracle.blockingReasons.length > 0 && status === "BLOCKED" ? [...reasons, ...oracle.blockingReasons.map(reason => `BLOCKED:${reason}`)].sort() : reasons, failedObservationIds, missingRunKeys };
}
