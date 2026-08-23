# `@deepseek-ai/dsh-client-ui-desktop`

English | [中文](README.zh.md)

Desktop-only Session Surface chrome and Mobile Pairing Settings. The Desktop Host `--patch` overlay inserts this row; browser `dsh web` does not. It elects the GESTALT wordmark on `sidebar.brand`, fills `sidebar.chrome.drag`, registers the Update Control on `sidebar.footer.action`, and contributes the `手机配对` Settings section. The preload bridge also carries `chromeOverlayShow` so Host chrome can ask a native overlay `WebContentsView` to paint Settings and the sidebar `+` menu. That section projects Host-owned current-installation Account and Personal Pairing state, displays both privacy languages before authorization, and sends Account and pairing verbs through `window.dshDesktop`; no private or pairing key enters the renderer. Its pairing panel owns the Mobile Access toggle, complete QR/link invitation, authentication-word confirmation, rejection, and paired-device list. The normal sidebar gains no Account or pairing entry. The Update Control mounts for an available, downloading, preparing, downloaded, or installing update and for an error after version discovery; disabled, idle, checking, and pre-discovery errors occupy no sidebar seat. Inactive phases expose their phase only through a hidden `data-desktop-updater-state` marker with no text or accessibility role; visible phases expose `data-desktop-update-control` on the button. All updater and window verbs also go through the preload bridge.

The macOS chrome reserves 28px above the unchanged DSH sidebar header and center Session content for the native traffic lights. The Windows row spans the viewport and keeps its three caption buttons outside the drag region without changing the Session content inset. Other development platforms render no custom Window Chrome and keep their system frame.

## Model Experience

None, as this package draws Desktop chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The plugin is a no-op without `window.dshDesktop`** — Mobile Pairing Account state, Update Control, and Window Chrome render nothing; their sources stay in initial states.
- **Assembled Desktop Web E2E installs `installDesktopBridgeFixture`** — a required preload member missing from that fixture fails typecheck instead of a browser timeout ([typed DesktopBridge fixture](../../../.agents/notes/implemented/testing/2026-08-21-typed-desktop-bridge-e2e-fixture.md)).
- **Product pairing remains fail-closed** — the Host reports Mobile Access unavailable until the independent Noise review admits a reviewed handshake adapter.
