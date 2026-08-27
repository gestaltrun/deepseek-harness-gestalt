# Agent Note: Settings is one fullscreen page on web and Desktop

Status: implemented

English | [中文](2026-08-27-settings-fullscreen-shell.zh.md)

## Problem

Settings was a centered 800px modal panel floating over a dimming mask inside the Session Surface. The form capped every section at the panel's geometry — the plugin cards, the model editor, and the account administration page the Sub2API sidecar ticket (#346) plans all want room the panel cannot give — and the two product ends rendered two shells: browser `dsh web` opened the panel in-page, while Desktop asked a native overlay view to paint the same panel markup over its own copy. A Codex-style fullscreen settings page needs one shell whose nav and content scale to the whole window on both ends, without breaking the registration protocol every settings card plugin already uses.

## Decision

The settings surface is one full-viewport page owned by ui-settings-general: a left nav column projecting the `settings.section` ledger, and a content column holding the header actions, the close control, and the active section. The page is the output of the existing `sidebar.settings` occupant, rendered as a fixed layer that covers the Session Surface while open; open state and the active section id stay component-local viewing state. The three chrome modes keep their jobs and now differ only in where the page paints, not what it looks like:

- **web** — the sidebar trigger opens the page in-document (browser `dsh web`).
- **desktop-host** — the trigger keeps calling Host chrome (`chromeOverlayShow`), and the Host raises the transparent overlay `WebContentsView` that loads the overlay document, because official pages are sibling native views the main window's DOM cannot overpaint.
- **overlay** — the page subscribes to Host chrome state and paints itself inside the overlay document.

The modal path is removed outright, with no compatibility layer: the mask, the centered panel box, and the mask-click close path cease to exist, while Escape, the header close button, focus-on-open, the `dsh-overlay-lock` handshake, and the Desktop request/result protocol are unchanged. The slot contract (`settings.trigger/header/action/close/section/onboarding/plugins.tab/general.item`) is byte-identical, so every existing registrant — ui-settings-models, ui-settings-plugins, ui-settings-plugin-inventory, ui-agent-preset, and ui-desktop's 手机配对 section — migrates by doing nothing.

## Alternatives considered

**Keep the modal and enlarge the panel.** The panel would still clamp to the viewport with a mask behind it, the account-administration page would live inside a dialog, and the two ends would keep rendering different shells. Rejected: the fullscreen takeover is the product requirement.

**Register the page through `shell.overlay`.** The AppFrame overlay layer hosts transient chrome (the Desktop `+` menu), so the page would have to move its open state into a store and register from an effect, or the layer would need a keyed dispatch the settings domain does not want. The `sidebar.settings` occupant already renders a fixed layer, so no new route was needed. Rejected: fights the slot discipline for zero gain.

**Drop the Desktop overlay view and paint in-page in the main window.** Impossible without a Desktop Host change: official pages are stacked as native `WebContentsView`s above the main web contents, and no in-page layer reaches them. The overlay view stays the Desktop paint vehicle; only its content changed.

## Consequences

Both ends ship the same page, and the assembled evidence covers both: the browser composition goldens in `apps/web/tests/snapshots/settings-chrome/` plus the Desktop composition's overlay-document golden captured under the Host patch overlay. The page is an opaque layer-2 surface, so an open Settings fully covers the Session Surface instead of dimming it — a user looking for the conversation behind the panel no longer finds it, which is the intended takeover. Closing reports through `chromeOverlayResult` on Desktop exactly as before, so `apps/desktop` needed no change.
