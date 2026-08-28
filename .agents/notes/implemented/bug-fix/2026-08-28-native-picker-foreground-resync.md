# Agent Note: Retain native picker files until foreground resynchronization

Status: implemented

English | [中文](2026-08-28-native-picker-foreground-resync.zh.md)

## Problem

Android DocumentsUI backgrounds the Capacitor application while a user selects a file. The browser returns the selected `File` during foreground restoration, when the current Companion generation may not yet be synchronized and mutation controls are disabled. Discarding the change event at that point loses a valid user selection even though the native picker completed successfully.

## Decision

Opening the native picker still requires current foreground mutation authority. The Session browse owner may retain one returned browser `File` in component memory while mutation authority is temporarily closed, then submit it through the ordinary attachment callback after foreground synchronization restores authority. This owner survives conversation-detail remounts during native foreground restoration, clears the pending reference before submission, and releases it when the user leaves the conversation or Desktop removes the authoritative Session without persistence.

The attachment surface, current-generation permit, encrypted upload, and Desktop confirmation remain unchanged. A pending selection cannot start an upload, create an operation id, or bypass the foreground-generation check while Mobile is offline.

## Alternatives considered

- **Ignore a selection returned while mutation controls are disabled** — rejected because a native picker routinely causes that state during normal Android foreground restoration.
- **Submit immediately without current authority** — rejected because attachment authorization and encrypted delivery belong to the synchronized physical generation.
- **Persist the selected bytes across navigation or restart** — rejected because attachment bytes do not belong in the Companion Cache or protected pairing document.

## Consequences

Android native file selection survives the picker-induced foreground synchronization interval. Leaving the conversation abandons an unsent selection, so the user must choose the file again after returning. Focused presentation coverage models picker launch, disabled callback delivery, restored authority, and unmount cleanup; operated acceptance still verifies the native picker and the resulting Desktop `session/attachment-admitted` event.
