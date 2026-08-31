# Agent Note: Phone settings stack CI convergence

Status: implemented

English | [中文](2026-08-31-phone-settings-stack-ci-convergence.zh.md)

## Problem

The Phone Devices settings section changes the assembled Web settings navigation and removes the phone card from Plugins. Existing Web goldens described the older composition, so the first mismatch left the modal open and caused later pointer-interception failures that obscured the original snapshot difference.

The release-family fixture also created a dynamic client bundle without the source map required by the client build record. V8-instrumented coverage could not observe the complete Host subprocesses started by the Desktop overlay boot suite, and hosted Linux and Windows did not reach their URL announcements under that instrumentation. Removing instrumentation and worker competition was insufficient: the fresh Windows runner still invoked the bare focused Vitest command without the repository artifacts that this artifact-plane test consumes. Local standalone passes had reused existing artifacts and therefore did not reproduce that clean-runner state. Selecting the built CLI then exposed that the CLI installation closure omitted `@deepseek-ai/dsh-phone-stream`, even though the Desktop overlay mounts it when the phone backend is enabled. The Electron runner log test relied on a descendant retaining an inherited pipe after its parent exited, which is a POSIX behavior rather than a portable Windows logging contract.

Phone binary-discovery tests also joined temporary `PATH` entries with the POSIX separator, allowed POSIX npm-prefix and Homebrew expectations to inherit the runner platform, and left `USERPROFILE` plus `npm_config_prefix` visible in the unresolved-service scenario. Those inputs made Windows coverage exercise a different search space from the one named by each test.

## Decision

The affected Web goldens include the top-level Phone Devices navigation row and omit the phone card from Plugins. Replay of the full affected file set verifies that a refreshed golden does not conceal interaction failures.

Release-family fixtures create both the dynamic client bundle and a minimal valid source map before recording the artifact digest. Desktop overlay composed boot belongs to `coverageExemptIsolatedSuites`: the instrumented gate excludes it, then the `gestalt:overlay-boot` artifact-plane command performs a complete build before running the two scenarios with one worker and explicit `lib` launches. The CLI manifest declares phone stream so profile module healing includes every plugin the Desktop overlay can mount. Linux starts that command only after instrumented coverage and the shared heavy gate settle; the native Windows owner starts it after its shared heavy gate. The suite contributes no child-process coverage, and its in-process launcher sources retain complete coverage through their owning tests. The client apply suite covers composition enablement when a ready settings snapshot has no Phone namespace value.

`runLogged` verifies direct late stdout and stderr persistence on every platform. A separate POSIX-only test retains the stronger inherited-descendant-pipe obligation; Windows process-tree termination remains covered through its `taskkill /t` behavior rather than a pipe-inheritance assumption.

The native Windows coverage merge also executes a mocked-child stop-policy test. It advances the existing termination grace period and proves the platform-independent `SIGTERM` then `SIGKILL` obligation without pretending a native Windows child can ignore Node's terminating signal.

Binary-discovery fixtures join `PATH` with the host delimiter. Tests for the POSIX npm-prefix and Homebrew rules select POSIX behavior explicitly, while the unresolved-service test clears and restores every home and prefix environment input that the resolver reads.

## Alternatives considered

**Raise the Host URL timeout.** Rejected because the failed clean-runner command had not prepared its required artifacts; a larger deadline would conceal the source-plane and artifact-plane mismatch.

**Keep the old Web goldens.** Rejected because Phone Devices is an intentional top-level settings section and no longer belongs in Plugins.

**Relax source-map validation for test fixtures.** Rejected because release fixtures must represent the artifact completeness required from production builds.

## Consequences

The repaired gates describe the shipped settings composition, validate a complete client artifact fixture, prepare the artifact plane before running real Host subprocess tests without irrelevant parent instrumentation, and keep binary-discovery assertions independent from unrelated runner environment state. The CLI installation closure repair is a Desktop patch impact; it does not authorize a release or merge to `master`.
