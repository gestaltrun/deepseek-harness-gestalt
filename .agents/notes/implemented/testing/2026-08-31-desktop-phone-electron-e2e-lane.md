# Agent Note: Desktop phone Electron e2e lane

Status: implemented

English | [中文](2026-08-31-desktop-phone-electron-e2e-lane.zh.md)

## Problem

The phone tab crosses the Desktop main process, the Host child process, two renderer surfaces, HTTP routes, the phone runtime, the stream proxy, and mobilecli. Browser-only tests and Electron startup smokes do not prove that this assembled chain renders a decoded H264 picture or forwards device input. A test that asserts only the H264 response bytes can pass while Chromium displays no picture.

## Decision

`pnpm run test:e2e-electron` builds the current source and runs three WebdriverIO Electron-service scenarios against `apps/desktop/out/main.mjs`. The runner uses the operated-platform fixture, a fresh `DSH_HOME`, fresh Electron user data and Workspace roots, and the Desktop smoke log as the Host URL authority. It holds distinct loopback leases for the mobilecli and CDP ports until launch and verifies the temporary fake through one ownership token created with that staged fake for the runner invocation and reused across port-handoff retries. The ownership request has a one-second deadline and reports a timeout through the same verification failure. The runner retries with a fresh pair only when the drained runner log reports an ownership or bind failure while a handed-off port still accepts connections. The Session Surface and Desktop overlay remain separate WebDriver windows and are selected by the overlay document marker.

The live scenario composes the real Desktop Host with a temporary executable copy of the repository's fakemobilecli fixture. The fixture returns the current device envelope and a 390 by 844 H264 stream. The scenario opens a Workspace-backed Session through the product RPC route, chooses the phone tab through the overlay menu, checks the available-device groups and online-only picker, opens the device, and requires both valid H264 transport and a decoded 390 by 844 rendered picture. It records every `/phone/stream/*` resource and rejects the run unless the set is non-empty, every path ends in `/h264`, and no `/mjpeg` path exists. It then switches devices in the singleton tab and requires each replacement to paint a decoded 390 by 844 picture before forwarding a center tap and Home button to the fake and opening the independent Phone Devices settings section.

The managed scenario starts with a private empty home, no npm prefix, a PATH containing only a test-owned Node entry, and no executable override. It requires the first environment snapshot to be `missing`, downloads one loopback ZIP with the pinned size and SHA-256 checks, hot-activates the managed runtime and device tools without restarting Desktop, and then proves that disabling the setting stops the child and withdraws the device route.

The degradation scenario starts the same Desktop composition with an unresolvable mobilecli path and requires the installation guidance while the Host remains alive. All three scenarios require the URL announcement, an HTTP 200 entry page, a rendered Session Surface, and no Desktop smoke-log error after a settle interval.

The runner rebuilds every consumed Host, client, web, and Electron-main artifact before launch. The Electron e2e TypeScript sources compile under a dedicated Desktop compiler face that both the owning package and repository typecheck commands execute. The runner bounds Electron Service's release-metadata request so an unavailable metadata host reaches the service's bundled version-map fallback. It strips ambient credential and Platform Relay variables, supplies a keyless loopback model endpoint, and writes review artifacts only under the gitignored `.artifacts/e2e-electron/` root. The phone Electron runner writes a private source-only profile with `windowPresentation: 'hidden'`, sets `DSH_DESKTOP_E2E=1`, and passes `--dsh-e2e-profile=` so the product `BrowserWindow` is constructed with `show: false` and activate/second-instance do not restore or focus it; `CI=true` does not select presentation, packaged and unarmed profiles are rejected, and omitted profiles remain visible. Screenshots captured from a hidden renderer remain valid evidence. This presentation seam is not native process-tree ownership or Host-exit provenance; the [bounded Host-generation fixture ownership policy](2026-09-05-bounded-host-generation-fixture-ownership.md) remains fake-only and does not authorize real fixture execution. POSIX commands launch detached, but their current detached-group handling is best-effort fixture cleanup rather than strict ownership or hard containment. The staged mobilecli launchers are POSIX fixtures, so this lane fails fast on Windows; Windows asset selection and executable naming remain separate package-test responsibilities. Command completion waits for stdio close and serial log-writer flush before build inspection or log audit. The runner records Electron, Host, and fake identifiers where applicable, writes cleanup outcomes to `cleanup.json`, and reports cleanup errors together. Electron main/renderer error lines and Desktop smoke errors fail the lane and are written to `log-audit.json`.

`DSH_PHONE_SERVER_PORT` is the Desktop overlay's deployment-varying mobilecli server-port setting. Its default remains `12000`; the e2e runner supplies an ephemeral value so concurrent developer services cannot invalidate the evidence.

## Alternatives considered

**Browser-only automation.** Rejected because it bypasses the Electron main process, overlay WebContentsView, Host child lifecycle, and Electron-specific decoding behavior.

**Transport-only H264 assertions.** Rejected because valid Annex-B bytes do not prove that Chromium decoded and painted a visible picture.

**A fixed mobilecli server port.** Rejected because an unrelated local process can make a correct test fail or route the test to the wrong service.

## Consequences

The lane is keyless and now arms a source-only hidden BrowserWindow, but that presentation seam is not Issue #572 real-device, same-Host recovery, or native-containment evidence and is not a unit-test substitute. Its evidence distinguishes Host startup, transport bytes, decoded picture visibility, input forwarding, and best-effort cleanup. A green repository Electron runtime smoke does not substitute for this lane, and a green lane authorizes neither a product release nor a merge to `master`.
