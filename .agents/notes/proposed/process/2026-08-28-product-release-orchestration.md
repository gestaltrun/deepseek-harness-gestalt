# Agent Note: Product release orchestration

Status: proposed

English | [中文](2026-08-28-product-release-orchestration.zh.md)

## Problem

Desktop Bundle publication, Mobile Companion signing and TestFlight distribution, and operated Platform deployment use independent workflows and version inputs. The repository cannot determine from one reviewed change whether any of those release units must move together, so a successful release of one unit can leave an affected peer or production service on an older implementation.

GitHub workflow path filters do not understand pnpm dependencies, packaged build inputs, or wire compatibility. Mutable Environment variables also keep the Mobile Marketing Version and build number outside the reviewed source candidate.

## Proposal

Treat Desktop, Mobile, and Platform as independent product release units governed by one source-owned Product Release Plan. Keep the existing [dsh, vendor, and native npm release families](../../implemented/process/2026-08-10-npm-release-sequences.md), [Desktop Personal Release Channel](../../implemented/architecture/2026-08-16-deepseek-gestalt-desktop-host.md), and [production-only Platform deployment](../../implemented/process/2026-08-20-platform-production-release-ci.md) independent.

Each product-affecting pull request adds one versioned release-intent record with a user-visible summary and `major`, `minor`, `patch`, or `none` for each product release unit. A repository script compares the intent with changed paths, each application package's workspace dependency closure, and an explicit catalog of native, packaging, workflow, lockfile, and deployment inputs. CI rejects an intent that omits a possibly affected unit and permits conservative over-reporting.

After intents merge to `master`, a Product Release PR consumes them, applies the highest requested bump to each selected unit, increments the source-owned Mobile build number, and records release notes plus the exact plan. Application versions remain in their owning package manifests. Mobile native metadata reads the Marketing Version and monotonic build number from reviewed repository state rather than GitHub Environment variables.

One coordinator reads the merged plan and calls independent reusable Desktop, Mobile, and Platform workflows. Each workflow builds once at the plan commit, records artifact or OCI digests, and promotes those exact bytes after its owning GitHub Environment approves the release action. Manual dispatch remains a recovery entry point. The coordinator records released, skipped, and blocked units without describing an unpromoted image or candidate as released.

Desktop keeps the `gestalt-v*` Personal Release Channel and its atomic installer, blockmap, and update-feed asset set. Mobile publishes a component prerelease with the signed Android APK, `SHA256SUMS`, TestFlight link, candidate commit, build identity, and acceptance evidence; the App Store IPA remains controlled release evidence rather than a public installation asset. Platform publishes an immutable GHCR digest and records production deployment separately; production promotion never accepts `latest` as candidate identity.

## Alternatives considered

**Make one version and always release all three units.** This removes impact analysis but creates unnecessary signing and production deployment, couples unrelated release cadence, and obscures which artifact changed.

**Use GitHub Actions path filters as the release decision.** Path filters can avoid runs, but they cannot prove transitive application impact or protocol compatibility and therefore cannot own a fail-closed release decision.

**Adopt Release Please or Changesets as the whole-repository version owner.** Both provide established release-PR models, but replacing the verified dsh, vendor, native, Desktop, Mobile, and Platform sequences introduces a second migration problem. The proposal adopts an explicit intent and version-PR model behind existing repository scripts first.

**Put affected units and versions in an agent skill.** A skill is not an executed, reviewed state machine. It cannot provide deterministic CI rejection, candidate binding, Environment protection, or retry-safe artifact promotion.

**Build again after approval.** Rebuilding can promote bytes different from the verified candidate. The approved operation must consume the recorded artifact or image digest from the same plan execution.

## Acceptance criteria

- Release-intent parsing, application dependency closure, explicit input mapping, under-report rejection, bump aggregation, Mobile build increments, and final plan rendering have focused positive and negative tests.
- Pull-request CI validates release intent, while a master workflow creates or updates the Product Release PR without publishing a product.
- Desktop, Mobile, and Platform workflows accept typed reusable-workflow inputs and retain manual recovery dispatches.
- The coordinator invokes only selected units and produces a machine-readable final manifest containing versions, tags, candidate commit, artifact or image digests, run links, TestFlight build, deployment state, and explicit skipped or blocked results.
- Mobile release versions come from tracked repository files; Android `versionCode` and iOS `CFBundleVersion` share the tracked monotonic build number.
- GitHub Releases use draft, complete asset upload, digest verification, then publication. TestFlight is documented as a rolling beta channel; Actions artifacts are not the durable public download surface.
- Platform production deployment accepts an immutable image identity and retains Environment approval, rolling readiness, rollback, and recovery.
- Current Desktop, Mobile, and Platform release documentation and agent instructions link the repository-owned plan instead of duplicating its decisions.

## Risks

Dependency closure cannot infer every compatibility or operational reason to release a unit. The explicit intent remains authoritative for requested SemVer impact, while the computed set is a conservative lower bound that prevents omissions.

Automated Product Release PR creation needs repository write authority. Publication credentials and production authority remain isolated in protected Environments and are not granted to the planning workflow.

A workflow conversion can weaken a verified release transaction if it rebuilds after approval or drops a recovery path. Each existing lane must retain its current signing, smoke, asset, readiness, rollback, and recovery evidence while its invocation interface changes.
