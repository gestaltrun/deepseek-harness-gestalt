# Agent Note: iOS real-device link in the phone fleet Service

Status: implemented

English | [中文](2026-08-28-phone-ios-real-device-link.zh.md)

## Problem

The device dock's real group (#355, #362) listed physical handsets, but nothing kept an iOS handset drivable: the on-device agent that mobilecli needs for taps, text, buttons, and capture had to be installed manually, re-signing needed the operator to run the upstream command by hand, and failures arrived as free-form text with no structure a Consumer could branch on. Free-team signing also expires silently after 7 days, leaving the link broken with no prompt and no re-run entry.

## Decision

`ctx.phoneDevices` owns the real-device path, on the same folded Service:

- `agentStatus` and `installAgent` run the upstream `agent status` / `agent install` commands as one-shot children of the already-resolved executable, with the credential-scrubbed parent environment and an `agentTimeoutMs` ceiling. The Service still never downloads or vendors agent artifacts — mobilecli fetches them; the FSL dependency edge is unchanged.
- Idempotency is ours: without `force`, a status probe answers an installed agent and no install child spawns, so repeated calls converge. `force` is the re-sign entry. Real handsets require the configured `provisioningProfilePath` upstream, which fails loudly through the normal upstream-error path rather than an invented local arm.
- Every answer about an installed, re-signed real handset carries `FREE_SIGNING_PROFILE_REMINDER`: free-team profiles expire after 7 days and `installAgent(id, { force: true })` is the re-run entry.
- Failure output from both carriers — agent-command text and upstream JSON-RPC error messages — is classified by one function onto the closed arm union `device-locked` / `cert-untrusted` / `profile-expired` / `tunnel-failed` / `device-unplugged`, carried as `PHONE_REAL_DEVICE_ISSUE` with the arm on `PhoneDevicesError.issue`. Upstream `-32010` is deliberately never classified, so `phone-stream`'s device-absent 404 semantics survive.

Classification is pattern priority, not semantics: the first matching arm wins, with profile expiry ahead of certificate wording because the expiry names the root cause. Messages that name no arm keep their transport-level code.

## Alternatives considered

**Classify `-32010` too.** Rejected: `phone-stream` maps `PHONE_DEVICE_NOT_FOUND` onto its device-absent reply; re-routing vanished-device errors onto the unplugged arm would change a shipped Consumer's public semantics for marginal classification gain.

**A local profile-required refusal for real targets.** Rejected: the requirement is upstream's and its message is already precise; a parallel local check would duplicate the rule and could drift from the upstream command.

**Parsing the provisioning profile for a concrete expiry date.** Rejected: decoding a `.mobileprovision` means CMS tooling at this boundary for a fact the reminder conveys more cheaply; the profile stays opaque.

## Consequences

Consumers can branch on `PhoneRealDeviceIssue` without string matching, and operators get the 7-day prompt with a concrete re-run entry. CI pins the link only against the fake mobilecli double; the hardware-in-the-loop suite self-skips without `DSH_PHONE_REAL_UDID` and stays out of coverage. Real-iPhone tunnel behavior remains whatever the installed mobilecli does — the Service surfaces `tunnel-failed` but owns no tunnel.
