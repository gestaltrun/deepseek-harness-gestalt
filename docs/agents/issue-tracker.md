# Issue tracker: GitHub

English | [中文](issue-tracker.zh.md)

DeepSeek Gestalt product specs and tickets live in GitHub Issues on `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt`. Use the `gh` CLI with `--repo BeiKeJieDeLiuLangMao/deepseek-harness-gestalt` for every operation. The `deepseek-ai/deepseek-harness` upstream repository is not the Gestalt product tracker.

## Operations

- Create: `gh issue create --repo BeiKeJieDeLiuLangMao/deepseek-harness-gestalt --title "..." --body "..."`
- Read: `gh issue view <number> --repo BeiKeJieDeLiuLangMao/deepseek-harness-gestalt --comments`
- List: `gh issue list --repo BeiKeJieDeLiuLangMao/deepseek-harness-gestalt --state open`
- Comment: `gh issue comment <number> --repo BeiKeJieDeLiuLangMao/deepseek-harness-gestalt --body "..."`
- Apply or remove labels: use `gh issue edit <number> --repo BeiKeJieDeLiuLangMao/deepseek-harness-gestalt`
- Close: `gh issue close <number> --repo BeiKeJieDeLiuLangMao/deepseek-harness-gestalt --comment "..."`

GitHub shares one number space across issues and pull requests. Resolve an ambiguous number with `gh pr view` and fall back to `gh issue view`.

## Supported pull-request creation

Use `pnpm pr:create --issue <number> --kind <kind/*> --area <area/*> --title "..." --body-file <path> --base <branch>` from the branch to publish. The command verifies the Issue in the `origin` repository, computes the same CI plan used by preflight, creates a Draft PR with exactly one explicit kind, unions explicit areas with every planner-selected area, and appends an informational same-repository Issue reference. Repeat `--area` for cross-cutting intent that the current risk catalog cannot infer.

Use `pnpm ci:plan --event pull_request --readiness draft --base <branch> --head HEAD` to inspect the versioned plan without creating a PR. Unknown refs, paths, events, or repository inputs select exhaustive evidence and record the escalation reason.

## Workflow deployment

Issue policy resolves its repository from the workflow-provided `GITHUB_REPOSITORY`; repository owner and name are not deployment configuration.

Pull-request policy read authentication is an explicit deployment option in `.github/issue-management/config.json`. Set `pullRequestReadAuthentication` to `token` to send `GH_TOKEN` or `GITHUB_TOKEN` as a Bearer token; the command fails before its first request when neither exists. `anonymous` omits `Authorization` from all pull-request and referenced-Issue reads and is valid only when every endpoint required by the selected activation mode supports unauthenticated access. API errors remain fatal in both modes. The personal-account tracker uses its workflow token because the workflow explicitly grants and has verified pull-request and Issue read permissions. Unauthenticated ordinary reads have shown intermittent `504` responses in this deployment, so `anonymous` with `non-draft` would still depend on public-only access with observed availability problems.

Pull-request policy activation is a separate strict deployment option. Both modes stop Draft, Bot, and App pull requests after the initial pull-request read and before review, referenced-Issue, or Priority reads. `pullRequestPolicyActivation: non-draft` validates every remaining PR and never requests requested reviewers or reviews. `review-activity` preserves activation after a review request or review and therefore reads both endpoints. The personal-account tracker uses `non-draft`; invalid or blank values fail before API access.

CI preflight validates Draft and ready PR metadata independently from lifecycle activation. It requires one same-repository Issue reference, exactly one supported `kind/*`, at least one `area/*`, and every area selected by the CI plan before expensive evidence jobs start.

Issue Priority synchronization is an explicit deployment option in `.github/issue-management/config.json`. Set `priorityField` to an organization Issue field name only when the repository supports that field; the policy then reads every referenced Issue's value and fails on API errors. Set it to `null` to disable the integration: the policy makes no Issue field request and treats referenced Issues as having no Priority. Personal-account trackers use `null` because GitHub Issue fields are unavailable for user-owned repositories.

Organization Project lifecycle projection is an explicit deployment option. Set the repository variable `DSH_ISSUE_PROJECT_LIFECYCLE_ENABLED` to `true` only when the repository owner matches `projectOrganization` in `.github/issue-management/config.json`, that configuration names the target organization Project, and the repository provides `DSH_ISSUE_APP_CLIENT_ID` and `DSH_ISSUE_APP_PRIVATE_KEY` for an installed GitHub App with the required repository and organization permissions. The workflow validates the shared owner before requesting an installation token. When the variable is absent or not `true`, the lifecycle job skips before that validation. Lifecycle and audit requests always require the App token; `pullRequestReadAuthentication` never makes their reads or writes anonymous. Personal-account trackers leave this option disabled because an installation token does not grant access to a user's ProjectV2.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Pull requests implement or relate to tickets; they do not enter the Matt triage queue as new product requests.

## Skill operations

When a skill says “publish to the issue tracker,” create a GitHub issue in the Gestalt repository. When it says “fetch the relevant ticket,” read the issue body, labels, and comments.

`to-tickets` publishes blockers before dependents. Use GitHub sub-issues and native issue dependencies when available. Otherwise, put `Part of #<parent>` and `Blocked by: #<number>` in the dependent issue body.

Each implementation must start from its ticket, preserve its acceptance criteria, and reference the issue from its commit or pull request. Update the ticket with verification evidence before closing it.
