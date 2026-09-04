# Agent Note: Repository-relative Issue policy deployment

Status: implemented

English | [中文](2026-08-17-repository-relative-issue-policy.zh.md)

## Problem

Issue policy combines repository checks with an optional organization Project lifecycle projection. Static repository coordinates route checks to the wrong repository when the workflow is installed in another tracker, while unconditional Project token creation makes a deployment without the configured organization Project fail before repository policy can run.

Repository GitHub App installation authority and organization ProjectV2 authority are distinct. Treating a repository installation token as access to an unconfigured Project would conceal a missing authorization path.

## Decision

Repository policy derives the repository owner and name from the workflow-provided `GITHUB_REPOSITORY`. Pull-request policy uses the repository `GITHUB_TOKEN`, activates for every non-Draft human pull request, and disables Priority synchronization because this deployment has no configured Issue-field authorization. The Project configuration retains only `projectOrganization`, `projectNumber`, and `projectTitle` as deployment identity; Project-local field names remain optional lifecycle configuration rather than repository coordinates.

Organization Project lifecycle projection runs only when the repository variable `DSH_ISSUE_PROJECT_LIFECYCLE_ENABLED` is exactly `true`. When disabled, owner validation, token creation, and mutation steps skip while the lifecycle job remains successful. An enabled deployment requires `projectOrganization` to equal the event repository owner; the workflow checks this after trusted policy checkout and before token creation, while the lifecycle entry checks it again before any API request. The deployment then creates a repository-scoped installation token from the configured App credentials and uses the same owner's organization permission for ProjectV2 operations.

The Gestalt organization tracker keeps Project lifecycle projection disabled because no owner-matching Project and GitHub App authorization are configured. Its intentionally mismatched `projectOrganization` makes accidental activation fail before token creation.

The [event-directed review status decision](2026-08-10-event-directed-pr-review-status.md) continues to own lifecycle event and transition semantics after a deployment enables the projection.

## Verification

[Issue-management tests](../../../../.github/issue-management/policy.test.mjs) run the policy CLI against a local GitHub API, verify repository-relative REST paths and GraphQL variables, exercise audit comment lookup, and reject a lifecycle deployment whose Project and repository owners differ. [Workflow tests](../../../../scripts/ci-workflow.spec.ts) verify the explicit lifecycle option, token scope, and owner validation before token creation.

## Alternatives considered

**Configure the fork's repository coordinates in the policy file.** This repairs one deployment but preserves a second source of truth for values already supplied by every GitHub Actions event.

**Use a separate Project credential without configuring the deployment.** A second credential would have independent authority and rotation obligations while leaving Project identity ambiguous. Adopting it requires explicit Project ownership and credential configuration.

**Create a separate installation token for a different Project owner.** Repository policy and Project mutation would then depend on two App installations and two authority scopes. Cross-owner lifecycle projection requires an explicit authentication and failure design rather than implicit token selection.

**Attempt Project synchronization and ignore authorization failures.** Silent degradation makes Project state unreliable and obscures deployment errors.

## Consequences

Repository Issue and pull-request policy follows the repository that emitted the event. The Gestalt tracker can enforce repository policy without an unconfigured Project integration, while any deployment enabling lifecycle projection must provide an owner-matching Project and GitHub App configuration.
