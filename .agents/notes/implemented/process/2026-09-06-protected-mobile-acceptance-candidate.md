# Agent Note: Protected signed Mobile acceptance candidate

Status: implemented

English | [中文](2026-09-06-protected-mobile-acceptance-candidate.zh.md)

## Problem

Mobile signing required a completed operated acceptance run, while physical Android acceptance of the release-signed application required an installable candidate produced with the protected release key. Exporting that key or weakening the acceptance requirement would move signing authority outside the `mobile-release` Environment or fabricate release evidence.

## Decision

`Mobile Release` has an explicit `candidate_build_only` mode that defaults to false. It accepts only the exact current `master` Product Release Plan candidate, its source-owned version and build, and explicit candidate-scoped transport-risk acceptance. The mode rejects an acceptance run id, artifact recovery, TestFlight upload, and GitHub publication before signing starts.

The protected `mobile-release` Environment builds one release-signed Android APK through the existing packaging script. The workflow uploads the APK and a manifest as the repository-accessible `mobile-acceptance-candidate-<candidate_sha>` Actions artifact. The manifest binds the candidate commit, plan, version, build, repository workflow run, APK digest, signing-certificate digest, and digests of the operated Platform origin and packaging script. The workflow immediately recomputes and validates those fields before upload. The manifest contains no credential or origin value. Candidate-build-only produces no iOS artifact, tag, Release, TestFlight upload, release acceptance, or publication evidence.

Ordinary Mobile signing, TestFlight, GitHub prerelease publication, and artifact recovery still require a successful candidate-bound Mobile Companion Acceptance run plus dispatch-scoped transport-risk acceptance. The recovery producer allowlist excludes the acceptance-candidate artifact, so a build-only run cannot become publication input. Product Release explicitly keeps `candidate_build_only` false.

## Alternatives considered

**Export the Android release key for a local physical build.** Rejected because release credentials remain owned by the protected Environment and must not enter local workstations or user-visible artifacts.

**Use a debug application id.** Rejected because it would test different native identity and protected-storage namespaces and would not prove an in-place update of the release application.

**Allow candidate artifacts into publication recovery.** Rejected because physical acceptance must produce a separate immutable verdict before the signed artifact can be promoted.

## Consequences

A release-signed APK can be installed for physical acceptance without publishing it or uploading an iOS build. Repository readers with Actions artifact access can download the candidate; GitHub Actions artifacts have no private toggle. The exact current-master restriction prevents signing a branch or stale candidate, while the final publication remains blocked until operated evidence exists for the same candidate. A candidate change requires a new build-only artifact and new acceptance evidence.

## Testing

Workflow tests pin the default-false mode, protected Environment, Android-only artifact, identity manifest, absence of publication commands, and explicit Product Release default. Executable mode-matrix tests reject missing transport-risk acceptance and every acceptance, recovery, TestFlight, or GitHub publication input in candidate-build-only mode while retaining the ordinary acceptance-run requirement.
