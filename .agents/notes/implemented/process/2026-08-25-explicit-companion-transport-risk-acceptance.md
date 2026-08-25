# Agent Note: Require Explicit Companion Transport Risk Acceptance per Release

Status: implemented

English | [中文](2026-08-25-explicit-companion-transport-risk-acceptance.zh.md)

## Problem

Mobile release validation required a boolean claiming an independent Noise security review, but the signing workflow did not consume that evidence. The first distribution has an operator decision to proceed with the repository's cross-runtime, vector, tamper, replay, ordering, resource-limit, and real product-path evidence without commissioning a separate external review. Retaining an unverified boolean would misstate evidence without controlling TestFlight or APK production.

## Decision

Repository and real-device transport tests remain mandatory release evidence. Independent external review is not a first-distribution prerequisite. Every Mobile Release dispatch must instead set the candidate-scoped `accept_transport_risk` input; an authorization job fails before Android or iOS receives signing secrets when the input is false.

The in-process release helper applies the same rule. Product flows, both native platform matrices, upgrade preservation, phone-size UI, and assembled failure acceptance determine readiness. A request to authorize TestFlight or Android APK additionally requires `transportRiskAccepted: true`.

## Alternatives considered

**Treat the operator decision as a completed independent review.** Rejected because authorization to accept risk and evidence from an independent reviewer are different facts.

**Remove the review boolean without adding an executable acknowledgment.** Rejected because signing would then have no candidate-specific record that the release owner accepted the remaining external-review gap.

**Keep the unconsumed helper-only gate.** Rejected because a pure utility that the workflow never invokes cannot control signing or upload.

## Consequences

The first TestFlight and signed APK candidate can proceed after the documented operator decision without fabricating an independent-review result. GitHub records the exact candidate SHA and explicit transport-risk input for each dispatch. A future independent review can add evidence or restore a stronger release prerequisite without changing the endpoint-owned Snow protocol.

## Testing

Release-helper coverage rejects distribution without explicit risk acceptance while retaining every product and device evidence requirement. Workflow coverage requires the manual input and makes both signing jobs depend on the authorization job.
