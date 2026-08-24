# Agent Note: Select one retained Paired Desktop explicitly

Status: implemented

English | [中文](2026-08-24-explicit-mobile-paired-desktop-selection.zh.md)

## Problem

Mobile retained more than one Personal Pairing key and Relay grant, but the product implicitly used the last inserted record. The page could neither list nor choose another Paired Desktop, and unpair erased every retained pairing in the signed-in Account scope. A later pairing could therefore replace the effective Session authority without a named user choice, while removing one Desktop destroyed unrelated authorization.

## Decision

The account-scoped protected pairing document is version 2. It atomically stores a bounded set of independent pairing records plus an optional selected pairing id. Each complete record owns its Personal Pairing id, Mobile Relay grant, Snow reconnect state, attachment key, and an optional Desktop name learned only from authenticated `foreground-sync`. The document rejects another version, a selected id without complete authority, malformed secret bytes, and more than the retained-pairing limit. Account selection serializes load and save, copies each secret into the active scope, and zeroes the transferred buffers.

Completing a Personal Pairing selects that new Desktop because the pairing action itself is explicit. Later selection is a separate person-triggered action. Before it persists or attaches another grant, `MobilePairingController` invalidates current mutation authority, releases the previous projection and cache binding without deleting stored content, and drains the old Relay lifecycle. It then persists the selected pairing, configures only that pairing's grant, completes a fresh pairing-specific Snow IK channel, and accepts Session projection only from that channel. A failure leaves mutation authority disabled and visible; it cannot continue using the old channel under the new selection label.

The Mobile page lists every retained pairing in stable order, marks exactly one selected Desktop, uses only an authenticated Desktop name, and shows the opaque pairing id until that name has been observed. It offers pairing another Desktop without deleting existing records. Unpair revokes only the selected Personal Pairing, deletes only its Companion Cache and Operation Receipts, zeroes only its local secrets, and leaves no automatic fallback selection. Other pairings remain listed until the person selects one.

Paired Desktop selection is endpoint-local. It adds no Relay or Encrypted Companion message and never merges Session, Workspace, cache, receipt, or attachment authority across Desktops. The selected pairing's grant chooses one route and pairing selector before Relay attachment; every mutation remains bound to the current authenticated physical generation.

## Verification

Vault tests persist two independent grants, names, keys, reconnect records, and an explicit selection through both IndexedDB and native protected-storage adapters; they also prove selected-only release and account isolation. Controller tests prove old projection and Relay release before new grant activation, selected-only Platform revocation, preservation of the other pairing, and no implicit selection after removal. The authenticated receiver test proves that only the encrypted Desktop projection supplies the retained name. The bundled Mobile snapshot renders the selected and unselected Desktop controls before executing the shared Session and conversation components.

## Alternatives considered

**Keep using the most recently inserted pairing.** Rejected because insertion order is not user intent, changes across recovery and repair, and makes the authority behind a mutation ambiguous.

**Attach every retained Desktop and merge their Sessions.** Rejected because it would combine independent Session authorities, caches, receipts, and connection generations into a new aggregate state model forbidden by Mobile Companion.

**Automatically select another pairing after unpair or connection failure.** Rejected because an operation must name one Paired Desktop. The person explicitly chooses the next authority instead of inheriting a fallback chosen by storage order or availability.

## Consequences

One Mobile Installation can retain and display multiple independent Paired Desktops while one selected record drives its Relay, Snow channel, cache, and Session projection. Selection and unpair may leave the product with retained pairings but no active Desktop, so the page keeps mutations unavailable until another explicit choice.

Version 2 deliberately has no pre-release compatibility decoder. An older protected pairing document fails loud and requires removing the retained protected value and pairing again. Android uninstall removes that application data; iOS Keychain may survive uninstall, so reinstall alone is not a reliable way to remove an incompatible document.
