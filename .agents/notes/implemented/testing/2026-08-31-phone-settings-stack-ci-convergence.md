# Agent Note: Phone settings stack CI convergence

Status: implemented

English | [中文](2026-08-31-phone-settings-stack-ci-convergence.zh.md)

## Problem

The Phone Devices settings section changes the assembled Web settings navigation and removes the phone card from Plugins. Existing Web goldens described the older composition, so the first mismatch left the modal open and caused later pointer-interception failures that obscured the original snapshot difference.

The release-family fixture also created a dynamic client bundle without the source map required by the client build record. Under partitioned coverage, the Desktop overlay boot suite competed with ordinary instrumented tests even though it starts complete Host subprocesses. The Electron runner log test relied on a descendant retaining an inherited pipe after its parent exited, which is a POSIX behavior rather than a portable Windows logging contract.

## Decision

The affected Web goldens include the top-level Phone Devices navigation row and omit the phone card from Plugins. Replay of the full affected file set verifies that a refreshed golden does not conceal interaction failures.

Release-family fixtures create both the dynamic client bundle and a minimal valid source map before recording the artifact digest. Desktop overlay composed-boot coverage belongs to `coverageProcessBoundSuites`, so the coordinator excludes it from concurrent partitions and runs it once with the other serialized process-bound suites.

`runLogged` verifies direct late stdout and stderr persistence on every platform. A separate POSIX-only test retains the stronger inherited-descendant-pipe obligation; Windows process-tree termination remains covered through its `taskkill /t` behavior rather than a pipe-inheritance assumption.

## Alternatives considered

**Raise the Host URL timeout.** Rejected because both overlay scenarios complete quickly when they do not compete with ordinary coverage partitions.

**Keep the old Web goldens.** Rejected because Phone Devices is an intentional top-level settings section and no longer belongs in Plugins.

**Relax source-map validation for test fixtures.** Rejected because release fixtures must represent the artifact completeness required from production builds.

## Consequences

The repaired gates describe the shipped settings composition, validate a complete client artifact fixture, and schedule real Host subprocess tests according to their resource ownership. These changes affect test evidence only and do not authorize a release or merge to `master`.
