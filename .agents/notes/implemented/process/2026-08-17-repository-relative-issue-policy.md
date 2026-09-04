# Agent Note: Repository-relative Issue policy deployment

Status: implemented

English | [中文](2026-08-17-repository-relative-issue-policy.zh.md)

## Problem

Issue policy combines repository checks with an optional organization Project lifecycle projection. Static repository coordinates route checks to the wrong repository when the workflow is installed in another tracker, while unconditional Project token creation makes a deployment without the configured organization Project fail before repository policy can run.

GitHub App installation authority and user ProjectV2 authority are distinct. Treating a repository installation token as access to a personal-account Project would conceal a missing authorization path.

## Decision

Repository policy derives the repository owner and name from the workflow-provided `GITHUB_REPOSITORY`. Pull-request policy uses the repository `GITHUB_TOKEN`, activates for every non-Draft human pull request, and disables Priority synchronization for this personal-account tracker. The Project configuration retains only `projectOrganization`, `projectNumber`, and `projectTitle` as deployment identity; Project-local field names remain optional lifecycle configuration rather than repository coordinates.

Organization Project lifecycle projection runs only when the repository variable `DSH_ISSUE_PROJECT_LIFECYCLE_ENABLED` is exactly `true`. The whole lifecycle job skips before GitHub App token creation when the option is disabled. An enabled deployment requires `projectOrganization` to equal the event repository owner; the workflow checks this after trusted policy checkout and before token creation, while the lifecycle entry checks it again before any API request. The deployment then creates a repository-scoped installation token from the configured App credentials and uses the same owner's organization permission for ProjectV2 operations.

Personal-account trackers keep organization Project lifecycle projection disabled. Supporting a user ProjectV2 requires a separate user-authorization design; it is not represented as installation-token compatibility.

The [event-directed review status decision](2026-08-10-event-directed-pr-review-status.md) continues to own lifecycle event and transition semantics after a deployment enables the projection.

## Verification

[Issue-management tests](../../../../.github/issue-management/policy.test.mjs) run the policy CLI against a local GitHub API, verify repository-relative REST paths and GraphQL variables, exercise audit comment lookup, and reject a lifecycle deployment whose Project and repository owners differ. [Workflow tests](../../../../scripts/ci-workflow.spec.ts) verify the explicit lifecycle option, token scope, and owner validation before token creation.

## Alternatives considered

**Configure the fork's repository coordinates in the policy file.** This repairs one deployment but preserves a second source of truth for values already supplied by every GitHub Actions event.

**Use a personal access token for user ProjectV2.** A long-lived user credential has different authority and lifecycle from the repository GitHub App. Adopting it requires an explicit user-authorization and credential-rotation decision.

**Create a separate installation token for a different Project owner.** Repository policy and Project mutation would then depend on two App installations and two authority scopes. Cross-owner lifecycle projection requires an explicit authentication and failure design rather than implicit token selection.

**Attempt Project synchronization and ignore authorization failures.** Silent degradation makes Project state unreliable and obscures deployment errors.

## Consequences

Repository Issue and pull-request policy follows the repository that emitted the event. A personal tracker can enforce repository policy without a failing organization Project integration, while an organization deployment must explicitly enable lifecycle projection and provide its Project and GitHub App configuration.
