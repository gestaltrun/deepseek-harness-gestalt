# Agent Note: Ship the ui-phone tab skeleton behind the enable gate

Status: implemented

English | [中文](2026-08-27-ui-phone-tab-skeleton.zh.md)

## Problem

Issue #356 locks the 「手机」 tab skeleton — always-reachable entry, state-① empty state, two-arm badge — to land ahead of the mobilecli engine, but three constraints shape the seam: the better-sidebar snapshot is pinned upstream and is not a composite project in the client typecheck graph, its badge contract renders one neutral pill around a string or number (no dot or color path), and the skeleton must guarantee register/dispose symmetry as an executed runtime gate, not a suite-only claim.

## Decision

`packages/client/ui-phone` registers through `ctx.betterSidebar` inside a `ctx.effect`, so the disposer rides the plugin fiber (HMR-safe). The descriptor is `id: 'phone'`, title 手机, a package-owned monochrome SVG icon, `order: 55` after the built-in browser, and an `available` that never refuses (the `single: true` sugar gave way to the per-device instance model in [the connected-tabs note](../feature/2026-08-28-ui-phone-connected-device-tabs.md)) (decision axis 2: the entry routes first-run guidance into the tab body instead of a disabled menu row). `Config.enabled` (schemastery, default `false`) is a contract placeholder: registration is unconditional, and the disabled arm pins a 「手机连接未启用」 strip in the body — read reactively through the gate source, so toggling the switch refreshes the mounted strip on the same invalidation tick — while discovery, spawn, and stream routing stay out of the package. Both the badge and the body list read one injected `PhoneListingSource`; the shipped implementation consumes the Host `GET /phone/devices` route ([the listing-route note](../feature/2026-08-28-phone-device-listing-route.md)), and the strip value maps to `null` (quiet) versus the online count. The Node-face invariant companion drives a provider-then-dependent fiber pair on the registration's own child context, settles on the fake registry's register/unregister facts, and yields when the hosting root already publishes `betterSidebar` (the package suites exercise registration themselves); the probe lives in the CSS-free `registry.ts` so the Node face never imports the styled body or React runtime code.

## Alternatives considered

**Import the descriptor and service types from `@deepseek-ai/dsh-client-ui-better-sidebar`.** Rejected: the pinned snapshot is excluded from the composite client graph, so referencing its project poisons the aggregate (`TS6306` on its own non-composite reference). Consumers declare the structural face locally — the ui-workbench adapter precedent — with `service.ts` staying the contract owner.

**Encode the gray dot as a pill glyph (for example `·`).** Rejected: a magic glyph inside the brand-colored pill neither matches the mockup's gray dot nor reads as a documented state; the quiet arm stays `null` and the fidelity gap is recorded in the package README until the badge contract extends.

**Ship an empty invariant companion with a registry pointer.** Rejected: the ticket requires the register/dispose relationship as a runtime invariant, and disposal symmetry is exactly the relationship this package owns — the empty shape would hide a real regression behind a justified reason.

**Open the tab persistently at boot.** Rejected: 常驻 binds the descriptor's registration, not an open tab; the + menu entry stays the single open path, matching the terminal and browser builtins.

## Consequences

The fleet listing rides the shipped `PhoneListingSource` ([the listing-route note](../feature/2026-08-28-phone-device-listing-route.md)); `Config.enabled` remains the composition default the picker body pins. Per-device tabs are shipped in [the connected-tabs note](../feature/2026-08-28-ui-phone-connected-device-tabs.md): seed-carried `phone:<serial>` opens with a serial `dedupeKey`, without touching this registration path. The badge dot styling lands only when better-sidebar extends its pill contract. The hosting-root yield keeps the shared test invariant host deterministic for suites that provide their own `betterSidebar`; a regression that drops the registration in any other environment fails the companion at activation (`the "phone" tab is missing after the plugin fiber activated`). The Plugins-tab wizard card and the Host `ui-phone` namespace live in [the settings-wizard note](2026-08-28-ui-phone-settings-wizard-card.md).
