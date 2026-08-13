import { describe, expect, test } from "bun:test";
import {
  evaluateUiResilience,
  isUiResilienceOracle,
  uiVisualReviewApprovalPayloadDigest,
  uiVisualReviewApprovalReceiptDigest,
  type UiResilienceOracle,
  type UiResilienceRequirement,
  type UiVisualReview,
  type UiVisualReviewApprovalReceipt,
} from "./ui-resilience";

const SCREENSHOT_DIGEST = "a".repeat(64);
const FIXTURE_DIGEST = "c".repeat(64);
const producer = {
  kind: "human",
  identity: "reviewer:ui-quality",
  independence: "independent-producer",
} as const;

const requirement: UiResilienceRequirement = {
  schemaVersion: "ui-resilience-requirement/v1",
  requestId: "request:ui-resilience",
  snapshotId: "snapshot:ui-resilience",
  conditionId: "condition:ui-resilience",
  scopeDecision: "required",
  basisIds: ["basis:content-resilience"],
  requiredRuns: [{
    surfaceId: "surface:catalog",
    stateId: "state:populated",
    viewportId: "viewport:desktop",
    profile: "text-overflow",
    fixtureId: "fixture:long-token",
    fixtureContentDigest: FIXTURE_DIGEST,
    regions: [{
      regionId: "region:label",
      policy: "no-overflow",
      basisIds: ["basis:content-resilience"],
    }],
  }],
  viewports: [{ id: "viewport:desktop", width: 1440, height: 900 }],
  applicabilityApprovals: [],
  unknownApplicabilityKeys: [],
  minimumIndependence: "independent-producer",
};

function visualReview(outcome: UiVisualReview["outcome"] = "PASS"): UiVisualReview {
  const payload = {
    reviewId: "review:catalog-label",
    requestId: requirement.requestId,
    snapshotId: requirement.snapshotId,
    conditionId: requirement.conditionId,
    observationId: "observation:catalog-label",
    outcome,
    rationale: "The screenshot shows the complete label without paint clipping.",
    producer,
    screenshotDigest: SCREENSHOT_DIGEST,
  } as const;
  const approvalReceipt: UiVisualReviewApprovalReceipt = {
    schemaVersion: "ui-visual-review-approval-receipt/v1",
    receiptId: "receipt:catalog-label",
    issuer: "trusted-ui-review-service",
    keyId: "ed25519:review-key-1",
    payloadDigest: uiVisualReviewApprovalPayloadDigest(payload),
    signature: "authenticated-signature-from-trusted-boundary",
  };
  return {
    ...payload,
    approvalReceipt,
    approvalArtifactDigest: uiVisualReviewApprovalReceiptDigest(approvalReceipt),
  };
}

function oracle(review = visualReview()): UiResilienceOracle {
  return {
    schemaVersion: "ui-resilience-oracle/v1",
    oracleId: "oracle:ui-resilience",
    requestId: requirement.requestId,
    snapshotId: requirement.snapshotId,
    conditionId: requirement.conditionId,
    producer,
    runs: [{
      runId: "run:catalog-label",
      surfaceId: "surface:catalog",
      stateId: "state:populated",
      viewportId: "viewport:desktop",
      viewport: { id: "viewport:desktop", width: 1440, height: 900 },
      profile: "text-overflow",
      fixtureId: "fixture:long-token",
      fixtureContentDigest: FIXTURE_DIGEST,
      browser: "Chromium 140",
      userAgent: "test-agent",
      profileEvidence: { profile: "text-overflow" },
      observations: [{
        observationId: "observation:catalog-label",
        regionId: "region:label",
        policy: "no-overflow",
        clientWidth: 320,
        clientHeight: 40,
        scrollWidth: 320,
        scrollHeight: 40,
        fragmentRects: [{ x: 0, y: 0, width: 300, height: 20 }],
        clippingAncestors: [],
        paintFeatures: ["mask"],
        renderedLineCount: 1,
        contentTruncated: false,
        truncationIndicatorVisible: false,
        screenshotDigest: SCREENSHOT_DIGEST,
        visualReview: review,
      }],
    }],
    blockingReasons: [],
  };
}

describe("UI resilience visual review approval binding", () => {
  test("accepts only the exact persisted receipt digest authenticated by the trusted boundary", () => {
    const candidate = oracle();
    const review = candidate.runs[0]!.observations[0]!.visualReview!;
    const result = evaluateUiResilience(requirement, candidate, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
      { type: "ui-visual-review-approval-receipt", digest: review.approvalArtifactDigest },
    ], [review.approvalArtifactDigest]);

    expect(result).toEqual({
      schemaVersion: "ui-resilience-evaluation/v1",
      status: "PASS",
      reasons: [],
      failedObservationIds: [],
      missingRunKeys: [],
    });
  });

  test("does not trust a matching stored digest without independent authentication", () => {
    const candidate = oracle();
    const review = candidate.runs[0]!.observations[0]!.visualReview!;
    const result = evaluateUiResilience(requirement, candidate, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
      { type: "ui-visual-review-approval-receipt", digest: review.approvalArtifactDigest },
    ]);

    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain("VISUAL_REVIEW_APPROVAL_UNAUTHENTICATED:observation:catalog-label");
    expect(result.reasons).toContain("VISUAL_REVIEW_REQUIRED:observation:catalog-label");
  });

  test("does not authenticate a different receipt that reuses a verified receipt id", () => {
    const approved = visualReview();
    const differentReceipt = { ...approved.approvalReceipt, issuer: "untrusted-review-service" };
    const different = {
      ...approved,
      approvalReceipt: differentReceipt,
      approvalArtifactDigest: uiVisualReviewApprovalReceiptDigest(differentReceipt),
    };
    const candidate = oracle(different);
    const result = evaluateUiResilience(requirement, candidate, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
      { type: "ui-visual-review-approval-receipt", digest: different.approvalArtifactDigest },
    ], [approved.approvalArtifactDigest]);

    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain("VISUAL_REVIEW_APPROVAL_UNAUTHENTICATED:observation:catalog-label");
  });

  test("rejects review fields altered after the receipt payload was signed", () => {
    const approved = visualReview("PASS");
    const fabricated = { ...approved, outcome: "FAIL" as const };
    const candidate = oracle(fabricated);

    expect(isUiResilienceOracle(candidate)).toBe(false);
    expect(evaluateUiResilience(requirement, candidate, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
      { type: "ui-visual-review-approval-receipt", digest: approved.approvalArtifactDigest },
    ], [approved.approvalArtifactDigest])).toMatchObject({ status: "INCOMPLETE", reasons: ["INVALID_ORACLE"] });
  });

  test("rejects a review receipt bound to a different screenshot", () => {
    const candidate = oracle();
    const run = candidate.runs[0]!;
    const observation = run.observations[0]!;
    const mismatched = { ...candidate, runs: [{ ...run, observations: [{ ...observation, screenshotDigest: "c".repeat(64) }] }] };
    expect(isUiResilienceOracle(mismatched)).toBe(false);
    expect(evaluateUiResilience(requirement, mismatched, [
      { type: "screenshot", digest: "c".repeat(64) },
      { type: "ui-visual-review-approval-receipt", digest: observation.visualReview!.approvalArtifactDigest },
    ], [observation.visualReview!.approvalArtifactDigest])).toMatchObject({ status: "INCOMPLETE", reasons: ["INVALID_ORACLE"] });
  });
});

  test("rejects an authentic review replayed under a different request subject", () => {
    const replayRequirement = { ...requirement, requestId: "request:later-snapshot" };
    const candidate = { ...oracle(), requestId: replayRequirement.requestId };
    const review = candidate.runs[0]!.observations[0]!.visualReview!;
    const result = evaluateUiResilience(replayRequirement, candidate, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
      { type: "ui-visual-review-approval-receipt", digest: review.approvalArtifactDigest },
    ], [review.approvalArtifactDigest]);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain("VISUAL_REVIEW_SUBJECT_MISMATCH:observation:catalog-label");
  });

describe("UI resilience scope binding and traceability", () => {
  test("does not convert a foreign failing oracle into a current-request failure", () => {
    const foreign = oracle(visualReview("FAIL"));
    const current = { ...requirement, requestId: "request:current" };
    expect(evaluateUiResilience(current, foreign, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
    ])).toEqual({
      schemaVersion: "ui-resilience-evaluation/v1",
      status: "INCOMPLETE",
      reasons: ["REQUEST_MISMATCH"],
      failedObservationIds: [],
      missingRunKeys: [],
    });
  });

  test("requires every scoped basis to reach a region or approved non-applicability subject", () => {
    const uncovered = { ...requirement, basisIds: [...requirement.basisIds, "basis:localization"] };
    const candidate = oracle();
    const review = candidate.runs[0]!.observations[0]!.visualReview!;
    const result = evaluateUiResilience(uncovered, candidate, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
      { type: "ui-visual-review-approval-receipt", digest: review.approvalArtifactDigest },
    ], [review.approvalArtifactDigest]);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain("BASIS_UNCOVERED:basis:localization");
  });
});

const FULL_TEXT_DIGEST = "b".repeat(64);
const truncationRequirement: UiResilienceRequirement = {
  ...requirement,
  requiredRuns: [{
    ...requirement.requiredRuns[0]!,
    regions: [{ ...requirement.requiredRuns[0]!.regions[0]!, policy: "truncate-with-access", maxLines: 2 }],
  }],
};

function truncationOracle(contentTruncated: boolean, withAccess: boolean, scrollWidth = 320): UiResilienceOracle {
  const candidate = oracle();
  const run = candidate.runs[0]!;
  const { visualReview: _visualReview, ...observation } = run.observations[0]!;
  return {
    ...candidate,
    runs: [{
      ...run,
      observations: [{
        ...observation,
        policy: "truncate-with-access",
        paintFeatures: [],
        renderedLineCount: contentTruncated ? 2 : 1,
        contentTruncated,
        truncationIndicatorVisible: contentTruncated,
        scrollWidth,
        ...(withAccess ? { fullTextAccess: { kind: "focus" as const, evidenceId: "full-text:catalog-label", digest: FULL_TEXT_DIGEST } } : {}),
      }],
    }],
  };
}

describe("UI resilience truncation evidence", () => {
  test("requires full-text access only when content is actually truncated", () => {
    const truncated = truncationOracle(true, true, 420);
    expect(evaluateUiResilience(truncationRequirement, truncated, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
      { type: "ui-full-text-access", digest: FULL_TEXT_DIGEST },
    ])).toMatchObject({ status: "PASS", failedObservationIds: [] });

    const missingAccess = truncationOracle(true, false, 420);
    expect(evaluateUiResilience(truncationRequirement, missingAccess, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
    ])).toMatchObject({ status: "FAIL", failedObservationIds: ["observation:catalog-label"] });

    const fitting = truncationOracle(false, false);
    expect(evaluateUiResilience(truncationRequirement, fitting, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
    ])).toMatchObject({ status: "PASS", failedObservationIds: [] });
  });

  test("rejects a non-truncated claim that contradicts overflow geometry", () => {
    expect(evaluateUiResilience(truncationRequirement, truncationOracle(false, false, 321), [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
    ])).toMatchObject({ status: "FAIL", failedObservationIds: ["observation:catalog-label"] });
  });
});
