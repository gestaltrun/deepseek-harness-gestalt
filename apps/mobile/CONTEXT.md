# Mobile Companion

Human-operated mobile access to a person's DeepSeek Gestalt work while its Paired Desktop is online. This context excludes agent-operated mobile-device automation.

## Language

**Mobile Companion**:
The human-facing mobile product that provides remote access to a Paired Desktop from any network.
_Avoid_: mobile connector, device automation, mobile client

**Personal Pairing**:
An independently revocable authorization relationship between a person-controlled mobile device and a person-controlled DeepSeek Gestalt installation. Desktop and Mobile must authenticate the same GitHub-backed Platform Account before pairing, but each pairing still grants one Device Principal rather than account-wide Desktop authority. One person may keep multiple Personal Pairings, but each Companion operation selects one Paired Desktop.
_Avoid_: organization membership, team sharing, account-wide Desktop access

**Pairing Challenge**:
A short-lived, single-use invitation displayed by a Desktop so a nearby person can establish Personal Pairing. Completion requires confirmation on that Desktop.
_Avoid_: login code, permanent QR code, device password

**Paired Desktop**:
The DeepSeek Gestalt installation selected through Personal Pairing and required to be online for Mobile Companion operations.
_Avoid_: cloud agent, mobile backend

**Device Principal**:
The identity of one personally paired mobile device. Its authority is limited to Companion Surface operations and does not inherit full Desktop access.
_Avoid_: Desktop user, Platform Account, bearer device

**Remote Online**:
The state in which mobile access is enabled, the DeepSeek Gestalt window is open, and the Paired Desktop can accept Companion operations.
_Avoid_: background service, remote wake, always online

**Remote Offline**:
The state entered when the DeepSeek Gestalt window closes, the application exits, the computer sleeps, or mobile access is disabled. Companion mutations are unavailable in this state.
_Avoid_: dormant agent, queued access, cloud continuation

**Companion Cache**:
The last Desktop-confirmed content retained on a mobile device for read-only viewing while Remote Offline. It is neither Session authority nor a mutation queue.
_Avoid_: mobile replica, offline outbox, synchronized Session store

**Operation Receipt**:
The durable record that one Companion mutation was sent but its Desktop result is not yet known. Reconnection resolves the same operation id before any deliberate retry; the receipt never authorizes automatic or offline replay.
_Avoid_: offline outbox, queued mutation, retry job

**Foreground Synchronization**:
The authenticated refresh that Mobile Companion completes after opening or returning to the foreground before it enables Companion mutations. It reads current state from the selected Paired Desktop and does not depend on push delivery, a background socket, or stale notification authority.
_Avoid_: push wake, background sync, silent wake

**Companion Surface**:
The mobile interaction surface for Workspace and Session browsing, history and streaming, prompts and cancellation, attachments, approvals, and human questions. It does not include the full Desktop settings, credentials, plugin configuration, terminal, or tool-inspection experience.
_Avoid_: responsive Desktop page, full Desktop parity, read-only viewer
