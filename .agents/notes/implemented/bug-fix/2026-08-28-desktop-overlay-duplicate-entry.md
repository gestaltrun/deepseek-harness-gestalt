# Agent Note: the Desktop overlay must not re-insert roster rows, and the composed boot proves it

Status: implemented

English | [中文](2026-08-28-desktop-overlay-duplicate-entry.zh.md)

## Problem

The #438 Desktop overlay inserted a `ui-phone` loader row that the web-app roster already carries. Composing the overlay onto the roster then aborted at Loader instantiation with `TypeError: duplicate loader entry id: ui-phone`, so the Desktop Host exited before announcing any URL. The defect slipped through because the overlay's existing verification (`overlay-isolation.spec.ts`) composes config text with `--dump-config`, which never instantiates entries — a duplicate entry id is invisible at that stage.

## Decision

The Desktop overlay no longer inserts `ui-phone`: the web-app roster is the row's only provider, and the overlay keeps only the `DSH_PHONE_MOBILECLI`-gated `phone-runtime` / `phone-stream` / `tool-phone` inserts. The regression is a composed boot, not a text comparison: `apps/desktop/tests/overlay-boot.spec.ts` spawns the roster + overlay composition through `spawnWebHost`, requires the `dsh web:` loopback URL announcement, and requires the entry page to answer 200. The Loader instantiates every composed entry id during that boot, so a duplicate id kills the process before any announcement and the failure output carries the child's tail.

## Alternatives considered

**Assert statically that the overlay inserts no roster id.** Rejected: two hand-kept id lists drift, and a future roster row would reopen the hole; the boot observes the actual Loader contract.

**Extend the `--dump-config` composition test.** Rejected: dump-time composition is exactly the blind spot that let the duplicate through; it proves nothing about entry instantiation.

## Consequences

Any overlay/roster id collision now fails keyless in the unit lane within seconds, before packaging or a real Desktop launch. The `--dump-config` assertions stay for ordering and semantics checks, but they no longer stand as the overlay's load-time guard.
