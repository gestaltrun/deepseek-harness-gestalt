# Agent Note: Platform production-only release CI

Status: implemented

English | [中文](2026-08-20-platform-production-release-ci.zh.md)

## Problem

The Platform listen process and its GitHub Actions workflows need one operated environment. A second development origin, OAuth App, database, and identity namespace would add a staging selector and a second credential namespace that nobody will operate. The deploy workflow also applied ECS as soon as Environment `production` was approved, so a missing name or a dry-run intent could still SSH.

## Decision

The operated Platform is production only. [`apps/platform/src/production-env.ts`](../../../../apps/platform/src/production-env.ts) names the listen-process secrets, treats an unset `PLATFORM_ENVIRONMENT` as production, and refuses any other selection before [`boot.ts`](../../../../apps/platform/src/boot.ts) loads one complete operated identity. The listen entry has no development identity or fallback credential, database, or namespace.

GitHub Actions uses Environment `production` only. [Platform Image](../../../../.github/workflows/platform-image.yml) builds on pull requests and matching master pushes, and pushes to GHCR only on `workflow_dispatch` with `inputs.push`. [Platform Deploy](../../../../.github/workflows/platform-deploy.yml) always validates the production and ECS names through [`production-env-cli.ts`](../../../../apps/platform/src/production-env-cli.ts) (`node --experimental-strip-types`) and SSHes only when `inputs.deploy` is true. The CLI entry is not bundled into `boot.mjs`.

Desktop and Mobile parse the same single production identity and reject localhost before product work ([operated Companion Platform identity](../architecture/2026-08-22-operated-companion-platform-identity.md)). Generic environment-pair validation remains available to bounded capability tests, not product entries.

## Alternatives considered

**Operate a second development Platform.** Rejected: the product operator will not provision a second origin, OAuth App, database, or identity namespace. A staging selector would also reopen arbitrary-endpoint selection that Companion packaging already forbids.

**Keep pair validation by running development on the same hosts.** Rejected: shared hosts would collapse the identity namespaces the pair validator exists to keep apart, and the listen process would still need a development secret set.

**Validate production names with a bash checklist in the workflow only.** Rejected: the listen process and the workflow would drift. One TypeScript entry owns the names; the workflow invokes it, and tests pin both the functions and the YAML.

**Push the image on every master build.** Rejected: GHCR publication is a release mutation and stays behind explicit dispatch.

## Consequences

A missing production name fails validation without printing values. Setting `PLATFORM_ENVIRONMENT=development` fails the listen process. Image publication and ECS apply remain manual, Environment-protected steps. The listen process writes startup and error lines to container stdout/stderr; Docker `json-file` rotation (`20m` × `3` files) bounds that volume on each ECS host. The apply step also starts LoongCollector with user-defined id `gestalt-platform` so those lines can reach SLS project `gestalt` logstore `application`. The collector reads the Aliyun account id from hardened ECS metadata at `100.100.100.200`, and falls back to Environment `production` `PLATFORM_SLS_ACCOUNT_ID` when metadata is empty. OSS blobs, CloudMonitor, and pairing/Relay HTTP stay outside this workflow until those capabilities are mounted. Listen migrates the shared pairing-authority and route tables; it does not mount pairing HTTP or Relay WSS.

## Testing

[`apps/platform/tests/production-env.spec.ts`](../../../../apps/platform/tests/production-env.spec.ts) pins operated-environment selection, missing-name order, hex-key rejection, CLI stderr that lists names without values, `boot.ts` calling `assertOperatedPlatformEnvironment` without importing the CLI entry, listen migrating the pairing and route stores without a pairing or Relay provider, the Deploy workflow's validate-then-`inputs.deploy` split, `json-file` rotation options, and LoongCollector registration for SLS `gestalt`/`application`, and Platform Image's master-push build without GHCR push.
