# Agent Note: Project Desktop State into the Settings Overlay

Status: implemented

English | [中文](2026-08-25-desktop-settings-overlay-state-projection.zh.md)

## Problem

Desktop Settings renders in a separate `WebContentsView`, while Platform Account, Personal Pairing, and updater state changes were sent only to the main `BrowserWindow`. An overlay that mounted before GitHub authorization therefore retained its signed-out snapshot after the Account controller became signed in. The same transport omission prevented challenge, pending-confirmation, paired-device, and updater changes from appearing without reopening Settings.

## Decision

Desktop state owners project each Account, Personal Pairing, and updater snapshot to both current renderer surfaces through one helper. Projection admits each distinct non-destroyed `WebContents` once. The main process supplies only its current main window and overlay references, so a disposed or replaced overlay is not retained as an event target.

## Alternatives considered

**Refresh state only when Settings opens.** Rejected because login polling, pairing mailbox delivery, Relay presence, and update download progress can all change while the overlay remains open.

**Poll every controller from the renderer.** Rejected because the preload event channels already define push-based ownership, and polling would add stale intervals and duplicate lifecycle policy in the UI.

**Send these events only to the overlay.** Rejected because the preload bridge is installed on both Desktop renderer surfaces; projection policy must not depend on which surface currently consumes a state family.

## Consequences

An open Settings overlay follows Account authorization, pairing challenge creation, Mobile confirmation, device projection, and updater progress without a close-and-reopen cycle. Renderer replacement stays bounded to the current Electron owners, and duplicate references cannot produce duplicate state callbacks.

## Testing

The renderer-projection regression sends one event to both active targets, rejects destroyed targets, and de-duplicates an active target. Packaged Desktop acceptance signs in with GitHub and continues through the live Personal Pairing state changes while Settings remains open.
