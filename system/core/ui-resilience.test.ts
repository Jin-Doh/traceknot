import { describe, expect, test } from "bun:test";
import {
  evaluateUiResilience,
  isUiResilienceOracle,
  isUiResilienceScope,
  uiFullTextAccessPayloadDigest,
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
    surfaceId: "surface:catalog",
    stateId: "state:populated",
    viewportId: "viewport:desktop",
    profile: "text-overflow",
    fixtureId: "fixture:long-token",
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

  test("honors an authenticated failing review without paint-risk flags", () => {
    const candidate = oracle(visualReview("FAIL"));
    const run = candidate.runs[0]!;
    const observation = run.observations[0]!;
    const review = observation.visualReview!;
    const withoutPaintFlags = { ...candidate, runs: [{ ...run, observations: [{ ...observation, paintFeatures: [] }] }] };
    const result = evaluateUiResilience(requirement, withoutPaintFlags, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
      { type: "ui-visual-review-approval-receipt", digest: review.approvalArtifactDigest },
    ], [review.approvalArtifactDigest]);
    expect(result.status).toBe("FAIL");
    expect(result.failedObservationIds).toEqual(["observation:catalog-label"]);
  });

  test("does not evaluate observations from an insufficiently independent producer", () => {
    const candidate = oracle();
    const run = candidate.runs[0]!;
    const observation = run.observations[0]!;
    const selfProduced = {
      ...candidate,
      producer: { kind: "self" as const, identity: "implementer", independence: "self-check" as const },
      runs: [{ ...run, observations: [{ ...observation, scrollWidth: 400 }] }],
    };
    const result = evaluateUiResilience(requirement, selfProduced, [{ type: "screenshot", digest: SCREENSHOT_DIGEST }]);
    expect(result).toEqual(expect.objectContaining({
      status: "INCOMPLETE",
      reasons: ["INDEPENDENCE_NOT_MET"],
      failedObservationIds: [],
    }));
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

  test("rejects a signed review whose run subject differs from the enclosing run", () => {
    const candidate = oracle();
    const review = candidate.runs[0]!.observations[0]!.visualReview!;
    const changedPayload = { ...review, surfaceId: "surface:other" };
    const changedReceipt = {
      ...review.approvalReceipt,
      payloadDigest: uiVisualReviewApprovalPayloadDigest(changedPayload),
    };
    const changedReview = {
      ...changedPayload,
      approvalReceipt: changedReceipt,
      approvalArtifactDigest: uiVisualReviewApprovalReceiptDigest(changedReceipt),
    };
    const mismatched = oracle(changedReview);
    const result = evaluateUiResilience(requirement, mismatched, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
      { type: "ui-visual-review-approval-receipt", digest: changedReview.approvalArtifactDigest },
    ], [changedReview.approvalArtifactDigest]);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain("VISUAL_REVIEW_SUBJECT_MISMATCH:observation:catalog-label");
  });

  test("rejects one screenshot digest reused across distinct required runs", () => {
    const candidate = oracle();
    const secondRun = {
      ...candidate.runs[0]!,
      runId: "run:catalog-label-mobile",
      viewportId: "viewport:mobile",
      viewport: { id: "viewport:mobile", width: 320, height: 640 },
      profile: "reflow-320" as const,
      fixtureId: "fixture:long-natural",
      profileEvidence: { profile: "reflow-320" as const, writingMode: "horizontal" as const, innerWidth: 320, innerHeight: 640 },
      observations: [{ ...candidate.runs[0]!.observations[0]!, observationId: "observation:catalog-mobile" }],
    };
    const expandedRequirement = {
      ...requirement,
      viewports: [...requirement.viewports, secondRun.viewport],
      requiredRuns: [...requirement.requiredRuns, {
        surfaceId: secondRun.surfaceId,
        stateId: secondRun.stateId,
        viewportId: secondRun.viewportId,
        profile: secondRun.profile,
        fixtureId: secondRun.fixtureId,
        fixtureContentDigest: secondRun.fixtureContentDigest,
        regions: requirement.requiredRuns[0]!.regions,
      }],
    };
    const result = evaluateUiResilience(expandedRequirement, { ...candidate, runs: [...candidate.runs, secondRun] }, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
      { type: "ui-visual-review-approval-receipt", digest: candidate.runs[0]!.observations[0]!.visualReview!.approvalArtifactDigest },
    ], [candidate.runs[0]!.observations[0]!.visualReview!.approvalArtifactDigest]);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain(`SCREENSHOT_REUSED_ACROSS_RUNS:${SCREENSHOT_DIGEST}`);
  });

  test("treats scrolling ancestors as clipping except for policy-authorized horizontal scrolling", () => {
    const candidate = oracle();
    const review = candidate.runs[0]!.observations[0]!.visualReview!;
    const artifacts = [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
      { type: "ui-visual-review-approval-receipt", digest: review.approvalArtifactDigest },
    ];
    const baseObservation = candidate.runs[0]!.observations[0]!;
    const horizontalAncestor = {
      ancestorId: "ancestor:horizontal-scroll",
      clipRect: { x: 0, y: 0, width: 200, height: 40 },
      overflowX: "auto" as const,
      overflowY: "visible" as const,
    };
    const clipped = {
      ...candidate,
      runs: [{ ...candidate.runs[0]!, observations: [{ ...baseObservation, clippingAncestors: [horizontalAncestor] }] }],
    };
    expect(evaluateUiResilience(requirement, clipped, artifacts, [review.approvalArtifactDigest])).toMatchObject({
      status: "FAIL",
      failedObservationIds: [baseObservation.observationId],
    });

    const scrollRequirement = {
      ...requirement,
      requiredRuns: [{
        ...requirement.requiredRuns[0]!,
        regions: [{ ...requirement.requiredRuns[0]!.regions[0]!, policy: "scroll-x" as const }],
      }],
    };
    const scrollCandidate = {
      ...candidate,
      runs: [{
        ...candidate.runs[0]!,
        observations: [{ ...baseObservation, policy: "scroll-x" as const, clippingAncestors: [horizontalAncestor] }],
      }],
    };
    expect(evaluateUiResilience(scrollRequirement, scrollCandidate, artifacts, [review.approvalArtifactDigest]).status).toBe("PASS");

    const verticalScrollCandidate = {
      ...scrollCandidate,
      runs: [{
        ...scrollCandidate.runs[0]!,
        observations: [{
          ...scrollCandidate.runs[0]!.observations[0]!,
          fragmentRects: [{ x: 0, y: 0, width: 180, height: 60 }],
          clippingAncestors: [{
            ancestorId: "ancestor:vertical-scroll",
            clipRect: { x: 0, y: 0, width: 200, height: 40 },
            overflowX: "visible" as const,
            overflowY: "scroll" as const,
          }],
        }],
      }],
    };
    expect(evaluateUiResilience(scrollRequirement, verticalScrollCandidate, artifacts, [review.approvalArtifactDigest])).toMatchObject({
      status: "FAIL",
      failedObservationIds: [baseObservation.observationId],
    });
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

describe("UI resilience applicability scope", () => {
  test("accepts signed applicability basis IDs in a different order", () => {
    const basisIds = ["basis:first", "basis:second"];
    const requiredProfiles = new Set(["text-overflow", "resize-text-200", "text-spacing-wcag"]);
    const profiles = ["text-overflow", "resize-text-200", "reflow-320", "text-spacing-wcag", "pseudo-localization", "rtl", "reduced-motion", "hover-focus-content"] as const;
    const scope = {
      schemaVersion: "ui-resilience-scope/v1",
      decision: "required",
      basisIds,
      rationale: "Rendered text must remain usable.",
      viewports: [{ id: "desktop", width: 1440, height: 900 }],
      surfaces: [{
        surfaceId: "catalog",
        stateIds: ["populated"],
        viewportIds: ["desktop"],
        capabilities: ["rendered-text"],
        fixtures: [
          { fixtureId: "representative", kind: "representative", contentDigest: "1".repeat(64) },
          { fixtureId: "natural", kind: "long-natural-language", contentDigest: "2".repeat(64) },
          { fixtureId: "token", kind: "long-unbroken-token", contentDigest: "3".repeat(64) },
        ],
        regions: [{ regionId: "label", policy: "no-overflow", basisIds }],
        profileApplicability: profiles.map(profile => {
          const rationale = `${profile} applicability is explicit.`;
          if (requiredProfiles.has(profile)) return { profile, status: "required", basisIds, rationale };
          return {
            profile,
            status: "not-applicable",
            basisIds,
            rationale,
            approvalReceipt: {
              schemaVersion: "ui-applicability-approval-receipt/v1",
              receiptId: `receipt:${profile}`,
              issuer: "trusted-applicability-service",
              keyId: "key:1",
              requestId: requirement.requestId,
              snapshotId: requirement.snapshotId,
              conditionId: requirement.conditionId,
              surfaceId: "catalog",
              profile,
              basisIds: [...basisIds].reverse(),
              rationale,
              signature: "signed",
            },
          };
        }),
      }],
    };
    expect(isUiResilienceScope(scope)).toBe(true);
  });
});

const FULL_TEXT_ARTIFACT_DIGEST = "b".repeat(64);
const FULL_TEXT_CONTENT_DIGEST = new Bun.CryptoHasher("sha256").update("Complete catalog label").digest("hex");
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
  const accessPayload = {
    schemaVersion: "ui-full-text-access/v1" as const,
    evidenceId: "full-text:catalog-label",
    requestId: requirement.requestId,
    snapshotId: requirement.snapshotId,
    conditionId: requirement.conditionId,
    observationId: observation.observationId,
    regionId: observation.regionId,
    surfaceId: run.surfaceId,
    stateId: run.stateId,
    viewportId: run.viewportId,
    profile: run.profile,
    fixtureId: run.fixtureId,
    kind: "focus" as const,
    contentDigest: FULL_TEXT_CONTENT_DIGEST,
    producer,
  };
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
        ...(withAccess ? { fullTextAccess: { ...accessPayload, payloadDigest: uiFullTextAccessPayloadDigest(accessPayload), digest: FULL_TEXT_ARTIFACT_DIGEST } } : {}),
      }],
    }],
  };
}

describe("UI resilience truncation evidence", () => {
  test("requires full-text access only when content is actually truncated", () => {
    const truncated = truncationOracle(true, true, 420);
    expect(evaluateUiResilience(truncationRequirement, truncated, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
      { type: "ui-full-text-access", digest: FULL_TEXT_ARTIFACT_DIGEST },
    ])).toMatchObject({ status: "PASS", failedObservationIds: [] });
    const missingArtifact = evaluateUiResilience(truncationRequirement, truncated, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
    ]);
    expect(missingArtifact.reasons.filter(reason => reason === "FULL_TEXT_ACCESS_ARTIFACT_MISSING:observation:catalog-label")).toHaveLength(1);

    const missingAccess = truncationOracle(true, false, 420);
    expect(evaluateUiResilience(truncationRequirement, missingAccess, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
    ])).toMatchObject({ status: "FAIL", failedObservationIds: ["observation:catalog-label"] });

    const fitting = truncationOracle(false, false);
    expect(evaluateUiResilience(truncationRequirement, fitting, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
    ])).toMatchObject({ status: "PASS", failedObservationIds: [] });
  });

  test("rejects full-text access replayed under another run subject", () => {
    const candidate = truncationOracle(true, true, 420);
    const run = candidate.runs[0]!;
    const observation = run.observations[0]!;
    const access = observation.fullTextAccess!;
    const changedPayload = { ...access, surfaceId: "surface:other" };
    const changedAccess = { ...changedPayload, payloadDigest: uiFullTextAccessPayloadDigest(changedPayload) };
    const replayed = { ...candidate, runs: [{ ...run, observations: [{ ...observation, fullTextAccess: changedAccess }] }] };
    expect(isUiResilienceOracle(replayed)).toBe(true);
    const result = evaluateUiResilience(truncationRequirement, replayed, [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
      { type: "ui-full-text-access", digest: FULL_TEXT_ARTIFACT_DIGEST },
    ]);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.reasons).toContain("FULL_TEXT_ACCESS_SUBJECT_MISMATCH:observation:catalog-label");
  });

  test("rejects a non-truncated claim that contradicts overflow geometry", () => {
    expect(evaluateUiResilience(truncationRequirement, truncationOracle(false, false, 321), [
      { type: "screenshot", digest: SCREENSHOT_DIGEST },
    ])).toMatchObject({ status: "FAIL", failedObservationIds: ["observation:catalog-label"] });
  });
});
