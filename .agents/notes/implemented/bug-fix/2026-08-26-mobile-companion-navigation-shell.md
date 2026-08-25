# Agent Note: Mobile Companion navigation shell

Status: implemented

English | [中文](2026-08-26-mobile-companion-navigation-shell.zh.md)

## Problem

The signed-in Mobile root mounted the current Installation account, Personal Pairing, and Session browser in one scrolling document. Account and pairing controls appeared beside the Session product instead of occupying their own navigation destinations, and opening pairing transferred controller lifecycle ownership to a view that could be mounted together with the home screen.

## Decision

`MobileAccount` owns one signed-in screen state: home, account, or pairing. Home contains the approved phone-density account header, selected Desktop status, shared Workspace and Session rows, authoritative search, and Workspace or Ungrouped Session creation. Account and Personal Pairing occupy separate full-height pages with explicit back navigation. The shell submits activation and deactivation at each Account transition; the pairing controller serializes those operations by generation, so a slow old activation and cleanup cannot stop the next signed-in generation. `MobilePairing` disables its own lifecycle ownership when mounted inside that shell.

Conversation detail remains a full-screen destination over the shared `ui-conversation` components and the shared `ui-workspace` Session rows. The design prototype supplies layout reference only. Bundled-entry snapshots and checked-in Capacitor applications remain the product acceptance entries; `prototype-companion` and ports 5173/5174 provide no acceptance evidence.

## Alternatives considered

**Keep one scrolling signed-in page.** Rejected because it removes the information hierarchy and navigation destinations required for phone use, and it lets account or pairing work compete with the Session list for the same viewport.

**Restore the prototype runtime as product code.** Rejected because its fixture identity, local state, and proof-only transport are not product authority. The shipped shell wraps the operated Account, Personal Pairing, Relay, and Desktop-authoritative projection instead.

**Rebuild conversation detail from prototype markup.** Rejected because Desktop and Mobile intentionally share Session rows, conversation nodes, Approval, Ask User, image, Tool, and composer presentation. The Mobile shell owns navigation and phone layout, not a second conversation implementation.

## Consequences

Signed-in navigation is local presentation state and resets to home on sign-out. Pairing progress and selected Desktop authority survive navigation because their controller remains active independently of the visible page. Focused lifecycle coverage races slow activation, sign-out, and immediate re-login and leaves only the newest generation active. The 390-pixel bundled-entry snapshot verifies separated account and pairing destinations, shared detail behavior, and zero horizontal overflow; native WebView and operated end-to-end acceptance remain separate required evidence.
