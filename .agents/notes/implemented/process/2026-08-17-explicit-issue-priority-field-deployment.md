# Agent Note: Explicit Issue Priority field deployment

Status: implemented

English | [中文](2026-08-17-explicit-issue-priority-field-deployment.zh.md)

## Problem

Pull-request policy reads the organization Issue field configured as `priorityField` for every referenced Issue so it can compare Issue and PR Priority. GitHub does not provide organization Issue fields for user-owned repositories; the field-values endpoint returns `404` there even to a repository-authorized user token. Treating every `404` as an absent value would also hide an unsupported field, missing permission, or wrong deployment in a repository that intends to use Priority synchronization.

Issue Priority synchronization and organization Project lifecycle projection have different APIs, credentials, and effects. One deployment switch cannot accurately represent both capabilities.

## Decision

`.github/issue-management/config.json` declares Issue Priority integration through `priorityField`. A non-empty string enables the integration and names the organization Issue field. The policy requests field values for every referenced Issue; any API failure remains fatal. `null` disables the integration, prevents the field-values request, and records the referenced Issue's Priority as absent for PR validation.

The Gestalt organization tracker sets `priorityField` to `null` because Issue-field authorization for Priority synchronization is not configured. Its PR policy continues to validate Issue references and PR labels without Priority synchronization. This setting does not synthesize native Issue Types or enable Project lifecycle projection; the [repository-relative Issue policy decision](2026-08-17-repository-relative-issue-policy.md) owns that separate deployment option.

The policy rejects any `priorityField` value other than `null` or a non-empty string at startup so a malformed deployment cannot silently disable enforcement.

## Verification

The Issue-management test executes the real `policy.mjs pr` CLI against a local fake GitHub API with separate configuration files. The disabled path completes without an Issue field request. The enabled path observes the field-values request and verifies that a `404` still terminates the command with the API error.

## Alternatives considered

**Treat `404` as an absent Priority.** Rejected because the same response can identify a misconfigured or unauthorized enabled deployment, which must fail loud.

**Use the Project lifecycle option to disable Priority reads.** Rejected because PR Priority comparison does not mutate Project state and may be useful in a deployment that does not run lifecycle automation.

**Infer support from the repository owner type.** Rejected because availability and authorization belong to deployment configuration, while owner classification does not prove that a particular organization field exists or is readable.

## Consequences

Gestalt PR checks do not depend on an unconfigured Issue-field API. Deployments opt in by naming the field and retain strict failure behavior. A disabled deployment gives up automatic PR Priority alignment because every referenced Issue enters validation with no Priority.
