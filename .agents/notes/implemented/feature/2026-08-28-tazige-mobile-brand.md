# Agent Note: 獭子哥 Mobile brand

Status: implemented

English | [中文](2026-08-28-tazige-mobile-brand.zh.md)

## Problem

The Mobile Companion's technical identity and consumer brand were represented by the same DeepSeek Gestalt label. The installed application, native launchers, browser title, pre-login header, and store record therefore had no distinct human-facing identity even though the application remains one access surface for a Paired Desktop.

## Decision

`獭子哥` is the single consumer-facing application name and the approved otter is its visual identity. iOS `CFBundleDisplayName`, Android launcher and activity labels, Capacitor application name, browser document title, pre-login product label, native launcher assets, and the App Store Connect record use that identity.

Mobile Companion remains the technical product term, DeepSeek Gestalt remains the Paired Desktop and product family, and `com.alibaba.gestalt.mobile` remains the bundle id. Platform Account, Personal Pairing, Relay, cache, wire, and credential identifiers do not adopt the consumer brand.

The source icon is an opaque square master without text, a watermark, a baked corner mask, or reference-sheet layout. iOS consumes the 1024-pixel master, while Android consumes reviewed legacy, round, and adaptive launcher derivatives at every checked-in density. Release builds execute focused brand validation before native compilation.

## Alternatives considered

**Keep DeepSeek Gestalt as the installed application name.** Rejected because the approved product direction gives the phone application its own recognizable consumer identity while retaining the technical relationship in documentation and architecture.

**Reuse the 千机-Gestalt store name or legacy visual identity.** Rejected because the approved identity is 獭子哥 and its otter, not a migrated 千机 brand. The bundle id remains stable because it is signing and pairing infrastructure rather than user-facing copy.

**Localize the brand into different application names.** Rejected because one canonical proper name keeps the installed icon, store listing, screenshots, and support references aligned across locales.

## Verification

Mobile tests validate every user-facing name owner, the 1024-pixel opaque iOS icon, Android launcher dimensions and alpha requirements, and failure on invalid branding input. The iOS and Android release scripts run that validation before producing signed artifacts. Product-entry snapshots and operated native acceptance verify the visible label and installed launcher result.

## Consequences

Reviewers and release automation must update every listed name owner and native launcher family together. A candidate carrying another name or icon cannot enter external Beta distribution even when its pairing and Relay evidence remains valid. The distinct consumer brand does not create another Mobile state model, Platform identity, bundle id, or Desktop authority.
