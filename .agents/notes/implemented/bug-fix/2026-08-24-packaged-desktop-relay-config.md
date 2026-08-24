# Agent Note: Package the operated Desktop Relay configuration

Status: implemented

English | [中文](2026-08-24-packaged-desktop-relay-config.zh.md)

## Problem

The signed Desktop embedded its operated Account identity but read the public Relay endpoint and limits from the final user's process environment. Finder and Start menu launches do not inherit GitHub Actions runner variables, so a valid package could fail before opening a window. Adding a required negotiation deadline made the missing artifact authority visible but was not the underlying cause.

## Decision

The release workflow writes the public Relay WSS endpoint and all Relay deadlines and admission limits into `operated-platform.json` beside the bundled main entry. The WSS endpoint is derived from the validated production HTTPS origin. GitHub Environment variables own every deployment-varying number; the repository supplies no hidden runtime defaults. Build-time and startup parsers reject unknown fields, non-WSS endpoints, invalid integers, and an inbound byte limit below one maximum Relay message. Product composition receives the typed Relay configuration rather than reading ambient `DSH_REMOTE_RELAY_*` values.

## Verification

The config-writer test creates the release artifact from public variables and verifies the derived WSS endpoint and limits. The packaged bundle test verifies the exact public artifact. Packaged Electron smokes remove both Platform and Relay runtime variables before launch, proving that the shipped artifact is sufficient.

## Alternatives considered

**Set Relay variables only on packaging runners.** Rejected because runner variables would make the smoke pass without reaching Finder or Start menu launches.

**Add code defaults.** Rejected because Relay deadlines and admission limits vary by deployment and must remain explicit configuration.

## Consequences

Desktop releases fail during configuration projection or packaging when the operated Relay configuration is incomplete. Installed applications start with the reviewed public configuration and contain no OAuth secret or Relay credential.
