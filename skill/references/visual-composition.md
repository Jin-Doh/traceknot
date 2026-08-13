# Visual-composition verification

Visual-composition verification is design-system neutral. A `significant UI change` is a UI change classified as R2/R3 or one that materially affects user-visible behavior; the term does not refer to Google Material Design. For every affected surface in a significant UI change, explicitly decide whether composition-level obligations are required.

For every affected surface in a significant UI change, set `change.uiImpact` and record one composition decision:

- `uiImpact: significant` requires `required`, `not-required`, or `unknown` scope for the affected surfaces;
- `uiImpact: functional-only` requires an explicit `not-required` decision and rationale;
- absence of `uiImpact` preserves compatibility for requests that do not opt into the portable significant-UI contract; such a request MUST NOT claim this composition decision was completed.

The scope decisions mean:

- `required`: derive visual-composition conditions and mandatory evidence obligations;
- `not-required`: record why rendered geometry and hierarchy are unchanged;
- `unknown`: preserve the uncertainty and return a non-PASS result until scope is resolved.

Ordinary browser flow verification remains distinct. Route reachability, overflow, accessibility, and interaction checks do not imply composition coverage.

## Portable vocabulary

Use neutral surface roles such as page, section, region, container, panel, overlay, and repeated-item group. Product or design-system names may appear as opaque metadata, never as core validation branches.

A required composition scope identifies:

- affected surfaces;
- representative states, including populated, empty, loading, and error where materially different;
- concrete viewport width and height for each affected breakpoint;
- whole-page context and focused regions;
- observable relations such as separation, inset, alignment, containment, non-overlap, ordering, size ratio, density, hierarchy, or rhythm.

## Oracle source

Every assertion records its expected value, source, and covered basis IDs. Sources may be an explicit basis item, a resolved design token, an approved reference artifact, or a relation derived from identified basis items. Design-token and approved-reference sources must map explicitly to basis IDs; provenance alone does not imply coverage. Every required visual basis must be covered by at least one assertion. A design-system identifier and token name are opaque provenance. Core validation MUST NOT branch on Material, Fluent, Carbon, Apple, or product-specific system names.

Design-token sources bind the token, system identifier, unit, and resolved value to a stored `design-token-resolution` artifact through the SHA-256 digest of their canonical `design-token-resolution/v1` payload. Approved-reference sources bind the relation, nullable axis, operator, expected value, nullable unit, ordered region IDs, and sorted basis IDs to a stored `approved-visual-reference` artifact through the SHA-256 digest of the canonical compact JSON `approved-visual-reference/v1` payload. Missing artifacts, wrong evidence types, mismatched payload digests, units, or expected values produce `INCOMPLETE`; the verifier must not substitute a default value.

## Evidence contract

A `visual-composition-oracle/v1` record binds the request, snapshot, condition, producer, captures, regions, and assertions. Each required surface-state-viewport tuple needs:

- a stored whole-page screenshot artifact;
- at least one distinct stored focused-region screenshot artifact whose digest does not alias the whole-page capture and whose `regionId` names the measured region it covers;
- measured regions;
- at least one basis-linked assertion with enough distinct regions for its relation; every separation assertion also binds `axis` as `horizontal` or `vertical`;
- expected and actual results;
- representative-state limitations, including an empty list when none remain.

Screenshot evidence entries in the oracle bind a globally unique evidence ID, evidence role, canonical `screenshot` artifact digest, and—for focused evidence—a measured `regionId` to their enclosing capture tuple. A well-formed digest without a matching stored artifact is not evidence. Whole-page and focused-region entries within one capture require different screenshot digests. Oracle captures outside the required surface-state-viewport tuples are rejected as `INCOMPLETE` and do not contribute assertions or basis coverage.

Byte-identical images from distinct capture tuples may share a content digest because their unique evidence IDs preserve the separate capture events. The signed oracle digest binds those events to surface, state, viewport, and role. The shipped CLI accepts the oracle through an absolute manifest `visualCompositionOraclePath`; screenshot, design-token-resolution, and approved-visual-reference files must also be listed in `declaredArtifacts` with their original evidence types. Screenshot declarations accept structurally valid, decodable PNG data only. Whole-page PNG width and minimum height must match the oracle viewport after device-pixel scaling. A focused-region PNG must be at least the bound region's scaled width and height.

For R2/R3 visual acceptance, the producer must satisfy `independent-producer`. A self-check, missing capture, unresolved scope, unlinked basis, snapshot mismatch, or missing stored screenshot cannot establish PASS. An observed relation violation is `FAIL`; unavailable prerequisites are `BLOCKED`; incomplete or insufficiently independent evidence is non-PASS under the existing verdict rules.

## Synthetic example

A public example may use `surface-catalog`, states `populated` and `empty`, and viewports `1440x900` and `390x844`. A design token such as `layout.sectionGap` may resolve to a condition that the vertical (block-axis) separation between `main` and `supporting` is at least `32 css-px`; horizontal distance cannot satisfy that assertion.

The same neutral relation applies whether the source token belongs to Material, Fluent, Carbon, Apple, or a private product system. Public examples and evidence must use synthetic identifiers and must not disclose private repositories, revisions, internal routes, customer data, or deployment details.

A run that proves route reachability, no overflow, accessibility, and keyboard interaction but omits the required composition oracle remains `INCOMPLETE`; those functional checks do not satisfy the visual-composition obligation.
