# Agent Note: phone-stream device listing route and the ui-phone listing source

Status: implemented

English | [中文](2026-08-28-phone-device-listing-route.zh.md)

## Problem

The mobile device dock reached ticket #407 with the Host exposing only `POST /phone/session`: nothing served the fleet listing, so `ui-phone` shipped the no-op `NULL_PHONE_BADGE_SOURCE` and the picker rows, the connected dropdown, and the strip badge count stayed dark. The listing route had to feed a browser tab without tokens, without changing `phone-runtime` or `tool-phone` public semantics, and without letting one Consumer dictate the service contract.

## Decision

`phone-stream` serves `GET /phone/devices` behind the same `/api` trust fence as session minting (GET-only, exact path): the handler calls `ctx.phoneDevices.listDevices()` and projects each ref onto the documented `id` / `name` / `kind` / `online` response fields plus the optional `unauthorized` flag and `osVersion` caption the GUI error arm consumes, grouped as `android` / `ios.simulators` / `ios.reals`. Projection is explicit because the runtime's grouped entries physically carry the upstream `platform` field that the public `PhoneDeviceRef` type already erases; forwarding verbatim would bake that internal into a new response body.

`ui-phone` replaces the null source with `PhoneListingSource` (`getBadge`, `snapshot`, `refresh`, `subscribe`), consumed from the route by `createHttpPhoneListingSource`. A refresh validates the response fields, maps emulator and simulator kinds onto the 模拟器 group and real handsets onto USB 真机, and commits only on success — `snapshot()` keeps one frozen reference between commits, so both tab bodies seat it in `useSyncExternalStore` (the same owning-observable precedent as the per-tab connection controller; better-sidebar tab hosts have no slot hook channel). The picker pulls on mount only while the enable gate is on (a disabled deployment still discovers nothing) and re-pulls from the now-enabled 重新检测环境 control; a connected tab pulls on mount so a layout-restored dropdown lights up without a picker visit.

## Alternatives considered

**Signing the listing URL like capture URLs.** Rejected: tokens protect cross-origin frame loads, while the listing feeds same-origin render code that the `/api` fence already gates; a signature would add mint round trips for no threat the fence does not cover.

**Forwarding `listDevices()` verbatim.** Rejected: the grouped runtime entries physically include the upstream `platform` field; baking it into the response body would couple the route to provider internals the public type already dropped.

**Keeping the synchronous `listDevices(platform)` face and a local refresh counter in `PhoneTab`.** Rejected: an async fleet needs a commit notification anyway; a tick counter would leave the connected dropdown stale until an unrelated re-render, and split one listing across two update paths.

## Consequences

The picker rows (meta OS·state, unauthorized warn arm), 打开 actions, connected dropdown, and badge online count read real fleet data with no new dependency and no `phone-runtime` change. Refresh failures keep the committed listing and re-arm the control; the badge value still updates only when the strip re-renders (the documented better-sidebar pill limitation). The Plugins-tab environment card still reads `PhoneEnvironmentSource` — the environment wizard and the fleet listing are separate seams.
