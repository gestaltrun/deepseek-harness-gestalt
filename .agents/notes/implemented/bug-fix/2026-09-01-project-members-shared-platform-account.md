# Agent Note: Gate Project Members on the shared Platform Account

Status: implemented

English | [中文](2026-09-01-project-members-shared-platform-account.zh.md)

## Problem

Workspace Settings can render Project Membership operations while the Desktop installation has no active Platform Account session. Starting a membership request in that state exposes an Account transport failure in the product UI and offers no route to authorize the installation.

## Decision

`@deepseek-ai/dsh-project-membership-client` owns the credential-free `ProjectMembershipAccess` composition face. It projects the current installation as unavailable, signed out, signing in, signed in, or signing out, publishes state changes, and exposes navigation to the owning sign-in surface.

The Desktop client adapts its existing Account source to this face and preserves each projected snapshot object until the Account source changes. The Workspace plugin accepts that observable only through its injected hooks compartment; business components receive the framework-bound hook result instead of subscribing to an external store directly. The sign-in action opens the existing Mobile Pairing Settings section, which retains privacy acceptance, GitHub authorization, Account session keys, and sign-out ownership. Workspace Settings performs no Project Membership read until the shared source reports `signed-in`; it then recovers the bound Project without reopening the modal. Each recovered Project is keyed to the exact authorization snapshot that started its request, so an Account transition hides the preceding Account's roster and controls before any replacement request completes. Account failures render inside the authorization gate instead of as project lookup failures.

Compositions that provide Project Membership operations but own authorization outside Desktop may omit the access face and retain their preauthorized behavior.

## Alternatives considered

- **Add a second GitHub login flow to Workspace Settings** — rejected because one Desktop installation holds one Platform Account session and the existing Settings section owns authorization and privacy disclosure.
- **Translate `SESSION_REVOKED` after starting a membership request** — rejected because transport errors do not provide a complete Account lifecycle and still leave the user without a sign-in route.
- **Add a global sidebar Account entry** — rejected because Workspace Settings needs a local recovery action and the established Account surface remains Mobile Pairing Settings.

## Consequences

Mobile Pairing and Project Members observe and mutate one current-installation Platform Account session. Signing out or switching Accounts gates Project Membership immediately, signing in resumes the pending settings view, and Account credentials remain outside renderer state. Focused UI and composition tests cover every projected state, stable snapshot identity, sign-in navigation, lookup suppression, Account switching, and recovery; operated acceptance still requires two real GitHub accounts against the real Platform and Electron surfaces.
