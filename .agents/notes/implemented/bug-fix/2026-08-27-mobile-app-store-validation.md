# Agent Note: Make Mobile App Store Validation Deterministic

Status: implemented

English | [中文](2026-08-27-mobile-app-store-validation.zh.md)

## Problem

The universal iOS application declares iPhone and iPad support. A portrait-only iPad orientation list does not satisfy App Store multitasking validation, while a provisioning profile date rendered with a local time-zone abbreviation cannot be parsed reliably by the release script.

## Decision

The iPhone application remains portrait-only. The iPad application declares portrait, portrait upside down, landscape left, and landscape right so the universal bundle supports iPad multitasking. The iOS release script reads `ExpirationDate` through `plutil` as an ISO 8601 UTC value and compares its epoch independently of the runner locale and time zone.

## Alternatives considered

**Restrict the application to iPhone.** Rejected because the checked-in Xcode target deliberately supports both iPhone and iPad, and narrowing the device family would remove an existing distribution target.

**Set `UIRequiresFullScreen`.** Rejected because Apple treats it as a deprecated compatibility mode and intends to ignore it in a future release.

**Require a UTC release runner.** Rejected because profile validity belongs to the release script and must not depend on an undocumented host setting.

## Consequences

The iPad interface can rotate and resize across every orientation accepted by App Store multitasking validation, while phone presentation remains portrait-only. Release runners in different locales interpret the same profile expiration identically. Mobile UI changes must remain usable at iPad landscape and multitasking sizes.

## Testing

The Companion release test pins the distinct phone and iPad orientation lists and the UTC profile-date parser. The signed release workflow supplies the final App Store bundle validation and TestFlight upload evidence.
