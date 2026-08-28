# Agent Note: Product release orchestration

Status: implemented

English | [中文](2026-08-28-product-release-orchestration.zh.md)

## Problem

Desktop Bundle publication, Mobile Companion signing and TestFlight distribution, and operated Platform deployment use independent workflows and version inputs. The repository cannot determine from one reviewed change whether any of those release units must move together, so a successful release of one unit can leave an affected peer or production service on an older implementation.

GitHub workflow path filters do not understand pnpm dependencies, packaged build inputs, or wire compatibility. Mutable Environment variables also keep the Mobile Marketing Version and build number outside the reviewed source candidate.

## Decision

Treat Desktop, Mobile, and Platform as independent product release units governed by one source-owned Product Release Plan. Keep the existing [dsh, vendor, and native npm release families](../../implemented/process/2026-08-10-npm-release-sequences.md), [Desktop Personal Release Channel](../../implemented/architecture/2026-08-16-deepseek-gestalt-desktop-host.md), and [production-only Platform deployment](../../implemented/process/2026-08-20-platform-production-release-ci.md) independent.

Each product-affecting pull request adds a versioned release-intent record with validated English and Chinese summaries and `major`, `minor`, `patch`, or `none` for each product release unit. A repository script compares newly added, unique, unconsumed intents with changed paths, each application package's workspace dependency closure, and an explicit catalog of native, packaging, workflow, lockfile, and deployment inputs. Pull requests normally add one intent, while merge groups deterministically aggregate their additions. CI rejects modified, duplicated, consumed, or under-reporting intents and permits conservative over-reporting.

After intents merge to `master`, `Product Release Plan` creates or updates `automation/product-release`. The Draft Product Release PR consumes each intent once, applies the highest requested bump to every selected unit, increments the source-owned Mobile build number, filters bilingual summaries by selected release unit, and commits release notes plus a numbered plan under `product-releases/`. CI recomputes this transaction from the base ledger, versions, Mobile build, and unconsumed intents, then rejects any forged plan, state, version, tag, bump, summary, build, or Desktop note. Application versions remain in their owning package manifests. `apps/mobile/release.json` owns the monotonic Mobile build number; native packaging reads the Marketing Version from `apps/mobile/package.json` and the build number from that tracked file rather than GitHub Environment variables.

One `Product Release` coordinator checks out the explicit full candidate commit, verifies that it remains the latest valid plan in the reachable master ledger, validates every source-owned version, and then calls independent reusable Desktop, Mobile, Platform Image, and Platform Deploy workflows. Each workflow builds once at the plan commit, records artifact or full OCI digests, and promotes those exact bytes after its owning GitHub Environment approves the release action. Recovery is an explicit input. Every prior run must be completed in the same repository through an allowed workflow, while the exact named producer job must have succeeded and its candidate-named artifact must remain unexpired. A later lane failure or coordinator head commit therefore does not invalidate already-produced bytes. Downloaded manifests and recomputed digests bind Desktop and Mobile artifacts to the requested candidate; Mobile can upload the validated prior IPA and preserve validated prior TestFlight evidence. Platform recovers image and deployment identity only from the corresponding successful producer and candidate-bound metadata; requested identity is never evidence. Requested channel publication failures fail the direct lane workflow, while the coordinator uses its final `always()` job to record released, skipped, and blocked units, require a reason for every blocked unit, separate Actions run URLs from Release URLs, and record a TestFlight build only when an evidenced upload ran.

Desktop keeps the `gestalt-v*` Personal Release Channel and its atomic installer, blockmap, and update-feed asset set. Mobile publishes a component prerelease with the signed Android APK, `SHA256SUMS`, TestFlight link, candidate commit, build identity, and acceptance evidence; the App Store IPA remains controlled release evidence rather than a public installation asset. Platform publishes a full immutable GHCR digest bound to the image build's recorded source commit and records production deployment separately; production promotion never accepts a tag, short digest, or candidate-mismatched image.

## Alternatives considered

**Make one version and always release all three units.** This removes impact analysis but creates unnecessary signing and production deployment, couples unrelated release cadence, and obscures which artifact changed.

**Use GitHub Actions path filters as the release decision.** Path filters can avoid runs, but they cannot prove transitive application impact or protocol compatibility and therefore cannot own a fail-closed release decision.

**Adopt Release Please or Changesets as the whole-repository version owner.** Both provide established release-PR models, but replacing the verified dsh, vendor, native, Desktop, Mobile, and Platform sequences introduces a second migration problem. The implementation keeps those sequences and adds the explicit intent and version-PR model through repository scripts.

**Put affected units and versions in an agent skill.** A skill is not an executed, reviewed state machine. It cannot provide deterministic CI rejection, candidate binding, Environment protection, or retry-safe artifact promotion.

**Build again after approval.** Rebuilding can promote bytes different from the verified candidate. The approved operation must consume the recorded artifact or image digest from the same plan execution.

## Testing

- [`product.spec.ts`](../../../../scripts/release/product.spec.ts) pins bilingual release-intent parsing, unknown-field rejection, application dependency closure, explicit input mapping, under-report rejection, scoped aggregate exceptions, unique unconsumed additions, merge-group aggregation, base-ledger plan and state recomputation, generated-field isolation, latest-master candidate validation, named producer and artifact provenance, signed-candidate digests, per-surface summaries, Mobile build increments, candidate-bound full Platform digests, and final manifest rendering.
- [`product-workflows.spec.ts`](../../../../scripts/release/product-workflows.spec.ts) pins CI validation, Product Release PR generation without publication, least-required reusable-workflow permissions, exact candidate and version inputs, named-artifact recovery, direct channel failure propagation, durable Mobile prereleases, Platform deploy and publish-only recovery, selected-lane invocation, and final manifest artifacts.
- Existing Desktop, Mobile, and Platform workflow tests continue to pin installer and update assets, native identities and signing inputs, production readiness, rollback, and recovery behavior.

## Consequences

Dependency closure does not infer every compatibility or operational reason to release a unit. The explicit intent remains authoritative for requested SemVer impact, while the computed set is a conservative lower bound that prevents omissions. Unknown production paths select all units, and reviewed compatibility exceptions carry their reason in the intent.

Automated Product Release PR creation uses a dedicated GitHub App installation with repository Contents and Pull requests write permission plus Issues read permission, so its branch and PR events trigger ordinary CI. Publication credentials and production authority remain isolated in protected Environments and are not granted to the planning workflow.

The Product Release PR adds one review step before promotion and source history retains numbered plans and consumed intents. Every release unit keeps its independent version and approval cadence. Reusable-workflow caller jobs grant only the token permissions required by their lane, while signing and deployment credentials remain in protected Environments. The coordinator can finish with blocked units; maintainers read the manifest and retry the owning manual workflow with the prior artifact, image, or deployment identity without rebuilding or changing the approved candidate.
