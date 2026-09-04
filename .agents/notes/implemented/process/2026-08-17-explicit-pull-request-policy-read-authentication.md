# Agent Note: Explicit pull-request policy read authentication and activation

Status: implemented

English | [中文](2026-08-17-explicit-pull-request-policy-read-authentication.zh.md)

## Problem

Pull-request policy reads pull-request metadata, referenced Issues, and optionally Issue field values. The Gestalt organization tracker has observed intermittent `504` responses for ordinary unauthenticated pull-request and Issue reads. Its workflow already declares pull-request and Issue read permissions, and the workflow token is the verified authorization path for these reads. Authentication remains an explicit deployment choice because other trackers can have different access requirements.

Review requests and reviews supply only an activation signal; they do not participate in metadata validation. Making them mandatory for activation adds endpoint availability and authorization requirements without strengthening the validation result.

Pull-request policy reads, Issue Priority integration, and Project lifecycle automation have different availability and authorization requirements. Authentication for one cannot safely imply authentication for the others.

## Decision

`.github/issue-management/config.json` declares `pullRequestReadAuthentication` as the exact value `anonymous` or `token`. The `pr` command passes that choice to every REST read of pull-request or referenced-Issue data. Anonymous mode omits `Authorization` even when a token is present in the environment. Token mode sends `GH_TOKEN` or `GITHUB_TOKEN` as a Bearer token and fails before the first API request when neither variable is set.

The same configuration declares `pullRequestPolicyActivation` as `non-draft` or `review-activity`. Both modes classify Draft, Bot, and App pull requests from the initial pull-request response and return before reading review activity, referenced Issues, or Priority. `non-draft` applies metadata policy to every remaining PR and never requests requested reviewers or reviews. `review-activity` retains activation after a review request or review and reads both endpoints. Invalid or blank values fail at startup.

The Gestalt organization tracker selects `token` because the workflow grants the required read permissions and that path has been verified for its ordinary pull-request and Issue reads. It selects `non-draft` independently because review activity does not contribute to metadata validation. These choices do not make API access infallible; failures remain visible.

API errors remain fatal for every authentication and activation combination. The policy never retries a failed authenticated request anonymously and never converts `404` into absent metadata.

The generic API client remains token-authenticated by default. Lifecycle, Project GraphQL, and audit read or write operations do not consume `pullRequestReadAuthentication`; they require the GitHub App token supplied by the lifecycle workflow. The [Issue Priority field decision](2026-08-17-explicit-issue-priority-field-deployment.md) and [repository-relative lifecycle decision](2026-08-17-repository-relative-issue-policy.md) own those independent deployment choices.

## Verification

Issue-management tests execute the real `policy.mjs pr` and `policy.mjs lifecycle` commands against a local fake GitHub API. They inspect exact request lists and headers for both activation modes, prove that Draft, Bot, and App pull requests stop after the initial pull-request read, prove that eligible `non-draft` requests succeed without review endpoints, verify zero-request failures for missing tokens and invalid configuration, preserve API failures, and exercise a token-authenticated lifecycle mutation.

## Alternatives considered

**Use `anonymous` with `non-draft` for the Gestalt organization tracker.** Rejected because it would avoid review endpoints but retain dependence on public-only access for ordinary reads, which has shown intermittent `504` responses in this deployment. Anonymous mode remains available to deployments that verify their required endpoints.

**Store a personal access token secret.** Rejected because the workflow token already reads the required ordinary PR and Issue resources, while a PAT would expand secret ownership and rotation obligations.

**Require or expand GitHub App Pull requests permission.** Rejected because lifecycle authorization is independent of read-only pull-request policy and repository configuration cannot verify the installed App permission set.

**Retry `404` without authentication.** Rejected because the same response can identify a private repository, missing permission, wrong repository, or nonexistent resource. Authentication fallback would turn configuration failures into ambiguous behavior.

**Keep review activity as the Gestalt organization tracker activation signal.** Rejected because review counts do not validate metadata, and reading them adds an authorization dependency without strengthening policy results.

## Consequences

The Gestalt organization tracker enforces metadata from the first non-Draft human PR event using its workflow token and no review endpoint. Deployments that select `review-activity` retain the review-driven timing and its endpoint requirements. Anonymous mode remains confined to `pr` reads in deployments that verify every required endpoint supports it; lifecycle and audit operations always require a token.
