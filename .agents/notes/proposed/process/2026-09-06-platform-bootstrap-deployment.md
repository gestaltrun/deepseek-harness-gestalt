# Agent Note: Protected Platform bootstrap deployment

Status: proposed

English | [中文](2026-09-06-platform-bootstrap-deployment.zh.md)

## Problem

The production Platform workflow assumes both target hosts already run a predecessor that can be renamed and restored. The replacement ECS pair for [the filed-domain cutover](2026-09-05-filed-platform-domain-cutover.md) is bare, so that assumption would either reject the deployment or encourage an unreviewed manual install outside the immutable Product Release path.

Pre-DNS acceptance must also prove each new address independently without weakening certificate or hostname verification, and an operational bootstrap may need to finish before a GitHub Release is published.

## Proposal

Platform Deploy gains an explicit `bootstrap` mode that defaults to false. The workflow checks both hosts for the absence of `dsh-platform`, `dsh-platform-candidate`, `dsh-platform-rollback`, and the candidate environment before preparing either host. Bootstrap activation never renames a predecessor. Its failure path removes only the candidate container, a Platform container labeled as owned by that bootstrap candidate, and the candidate environment. Rolling deployment retains its predecessor verification, replacement, rollback, cutover, and cleanup sequence.

Bootstrap readiness accepts exactly two distinct IPv4 EIP addresses. Each request connects directly to its EIP while the canonical Platform hostname remains the HTTPS authority, TLS SNI name, certificate verification name, and HTTP Host. The two responses must report `ok`, OSS attachment storage, and `relay-1` then `relay-2`. Public DNS is not used for this proof.

A separate `publish_release` boolean controls GitHub tag and Release creation. Product Release passes `publish_release: true`, while a direct bootstrap dispatch defaults it to false. Candidate SHA, image provenance, and executing workflow trust remain the existing merged-candidate checks; the candidate containing this workflow builds the new immutable Platform image, so no second workflow-commit input is introduced.

Durable deployment state is version 2 and records `mode: rolling | bootstrap`. Recovery dispatches bootstrap state only to candidate cleanup or candidate finalization and preserves version 1 rolling recovery. Unknown mode and phase combinations fail instead of selecting a rollback strategy by inference.

## Alternatives considered

**Add a separate workflow commit input.** Rejected because the reviewed Product Release candidate contains both the scripts and image source. A second commit authority would permit candidate/workflow skew without strengthening the existing requirement that `github.sha` and the candidate are reachable from master.

**Create a dedicated bootstrap workflow.** Rejected because it would duplicate production Environment authority, OIDC, Cloud Assistant, artifact staging, provenance, and recovery logic.

**Treat a missing predecessor as bootstrap automatically.** Rejected because an absent or partially damaged deployment is ambiguous. Bootstrap remains an explicit protected mode and rolling behavior remains fail-closed.

**Probe `https://<EIP>` with only a Host header.** Rejected because TLS SNI and certificate hostname validation would still use the IP address.

## Acceptance criteria

- Bootstrap defaults false and Product Release explicitly keeps release-publishing rolling behavior.
- Both hosts pass the bare check before either candidate is prepared.
- Bootstrap failure reaches quiescence without deleting or renaming a predecessor or unrelated resource.
- Bootstrap readiness accepts exactly two distinct addresses and proves `relay-1`, `relay-2`, and OSS with ordinary TLS verification against the canonical hostname.
- Durable recovery refuses ambiguous mode or phase data and preserves version 1 rolling recovery.
- Deployment-only mode records candidate-bound evidence without creating or moving a Platform tag.

## Risks

Host cleanup relies on a container ownership label written during bootstrap activation; losing that label makes cleanup fail closed and leaves durable recovery state for an operator. The EIP pair is a narrow dispatch input rather than a global inventory and remains valid only for the reviewed bootstrap transaction. Infrastructure readiness remains external. Before dispatch, each host must reach the deployment OSS endpoints for signed candidate artifacts, its configured OS package repositories for Docker and OpenSSL, the named Alibaba Cloud LoongCollector registry unless that exact image is cached, PostgreSQL, and Redis; certificates plus EIP routing must also be ready. Generic internet, public resolver, GitHub, or DockerHub connectivity is not required by the source path. This workflow does not provision or repair these dependencies.
