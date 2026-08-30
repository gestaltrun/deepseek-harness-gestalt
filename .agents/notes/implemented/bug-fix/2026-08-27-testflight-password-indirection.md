# Agent Note: Keep TestFlight Passwords Out of Process Arguments

Status: implemented

English | [中文](2026-08-27-testflight-password-indirection.zh.md)

## Problem

Passing the App Store app-specific password directly to `altool --password` places the credential value in the uploader process arguments. Process listings and diagnostic captures can then retain the value even when the workflow masks its log output.

## Decision

The protected `mobile-release` Environment supplies `APPLE_APP_SPECIFIC_PASSWORD` only to the TestFlight upload step. The upload script passes the literal `@env:APPLE_APP_SPECIFIC_PASSWORD` selector to `altool`, which reads the credential from its environment without placing the value in process arguments. The script still rejects a missing environment value before invoking the uploader.

## Alternatives considered

**Persist the password in a Keychain item.** Rejected because the workflow already supplies a step-scoped secret, while a persistent Keychain item adds runner provisioning, rotation, cleanup, and access-control obligations.

**Read the password from standard input.** Rejected because `altool` provides an explicit environment selector for non-interactive automation, while stdin ownership and failure behavior would be less visible in the script.

**Migrate this fix to an App Store Connect API key.** Rejected because API-key authentication adds a private-key file and a separate permission and rotation lifecycle. It can be adopted through a separate release-identity decision.

## Consequences

Process arguments contain only the environment-variable selector, so ordinary process inspection cannot disclose the password value. The credential remains readable to the uploader and other same-user processes that can inspect its environment; this decision does not claim host-level secret isolation. A password captured before this mechanism is active must be revoked and replaced outside the repository.

## Testing

A keyless test executes the real upload script with a fake `xcrun`, supplies a non-secret test password through the environment, and verifies that the argument after `--password` is the `@env` selector and that captured arguments and output contain no password value.
