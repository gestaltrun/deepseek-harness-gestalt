# Agent Note: Require Explicit Companion Transport Risk Acceptance per Release

Status: implemented

English | [中文](2026-08-25-explicit-companion-transport-risk-acceptance.zh.md)

## Problem

Mobile release validation required a boolean claiming an independent Noise security review, but the signing workflow did not consume that evidence. The first distribution has an operator decision to proceed with the repository's cross-runtime, vector, tamper, replay, ordering, resource-limit, and real product-path evidence without commissioning a separate external review. Retaining an unverified boolean would misstate evidence without controlling TestFlight or APK production.

## Decision

Repository and operated native transport tests remain mandatory release evidence. Approved Android Emulators and iOS Simulators can supply device evidence; fixture Web pages and `prototype-companion` cannot. Independent external review is not a first-distribution prerequisite. The acceptance verdict runs behind the protected `mobile-release` Environment, so operator-supplied evidence cannot become a release artifact before the configured reviewer approves it. A successful Mobile Companion Acceptance run validates the exact flow and device vocabulary, upgrade preservation, phone-size UI, assembled failures, and transport decision, then publishes one immutable artifact named for the tested `master` commit.

Every Mobile Release dispatch supplies that acceptance run id and the candidate-scoped `accept_transport_risk` input. The authorization job binds the source run's workflow id and path to `.github/workflows/mobile-companion-acceptance.yml`, then verifies its event and named verdict, a unique unexpired artifact, repository, source run id, commit, Git tree, complete evidence, and risk acceptance before Android or iOS receives signing secrets. The verifier calls the in-process distribution helper; another workflow and workflow syntax cannot bypass the same readiness rule.

## Alternatives considered

**Treat the operator decision as a completed independent review.** Rejected because authorization to accept risk and evidence from an independent reviewer are different facts.

**Remove the review boolean without adding an executable acknowledgment.** Rejected because signing would then have no candidate-specific record that the release owner accepted the remaining external-review gap.

**Keep the unconsumed helper-only gate.** Rejected because a pure utility that the workflow never invokes cannot control signing or upload.

## Consequences

The first TestFlight and signed APK candidate can proceed after the documented operator decision without fabricating an independent-review result. GitHub retains the protected-Environment approval, a candidate-bound operated acceptance artifact, and the exact release dispatch and transport-risk input. Signing cannot proceed with unapproved, stale, foreign, partial, duplicated, or vocabulary-expanding evidence. A future independent review can add evidence or restore a stronger release prerequisite without changing the endpoint-owned Snow protocol.

## Testing

Release-helper coverage rejects missing, duplicated, unknown, stale-candidate, foreign-repository, foreign-workflow, wrong-run, and risk-unaccepted evidence while retaining every product and device requirement. CLI behavior coverage resolves the workflow identity, source run, named verdict, artifact listing, and download through `gh`. Workflow coverage requires the protected Environment and acceptance run id, executes the verifier, publishes evidence only after the named verdict succeeds, and makes both signing jobs depend on authorization.
