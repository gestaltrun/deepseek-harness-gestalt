# Agent Note: Desktop phone Electron e2e lane

Status: implemented

English | [中文](2026-08-31-desktop-phone-electron-e2e-lane.zh.md)

## Problem

The phone tab crosses the Desktop main process, the Host child process, two renderer surfaces, HTTP routes, the phone runtime, the stream proxy, and mobilecli. Browser-only tests and Electron startup smokes do not prove that this assembled chain renders a decoded H264 picture or forwards device input. A test that asserts only the H264 response bytes can pass while Chromium displays no picture.

## Decision

`pnpm run test:e2e-electron` builds the current source and runs two WebdriverIO Electron-service scenarios against `apps/desktop/out/main.mjs`. The runner uses the operated-platform fixture, a fresh `DSH_HOME`, fresh Electron user data and Workspace roots, and the Desktop smoke log as the Host URL authority. It holds distinct loopback leases for the mobilecli and CDP ports until launch, verifies the temporary fake through an attempt-specific ownership token, and retries with a fresh pair only when the drained runner log reports an ownership or bind failure while a handed-off port still accepts connections. The Session Surface and Desktop overlay remain separate WebDriver windows and are selected by the overlay document marker.

The live scenario composes the real Desktop Host with a temporary executable copy of the repository's fakemobilecli fixture. The fixture returns the current device envelope and a 390 by 844 H264 stream. The scenario opens a Workspace-backed Session through the product RPC route, chooses the phone tab through the overlay menu, checks the available-device groups and online-only picker, opens the device, and requires both valid H264 transport and a decoded 390 by 844 rendered picture. It records every `/phone/stream/*` resource and rejects the run unless the set is non-empty, every path ends in `/h264`, and no `/mjpeg` path exists. It then switches devices in the singleton tab and requires each replacement to paint a decoded 390 by 844 picture before forwarding a center tap and Home button to the fake and opening the independent Phone Devices settings section.

The degradation scenario starts the same Desktop composition with an unresolvable mobilecli path and requires the installation guidance while the Host remains alive. Both scenarios require the URL announcement, an HTTP 200 entry page, a rendered Session Surface, and no Desktop smoke-log error after a settle interval.

The runner rebuilds every consumed Host, client, web, and Electron-main artifact before launch. The Electron e2e TypeScript sources compile under a dedicated Desktop compiler face that both the owning package and repository typecheck commands execute. The runner strips ambient credential and Platform Relay variables, supplies a keyless loopback model endpoint, and writes review artifacts only under the gitignored `.artifacts/e2e-electron/` root. Each spawned command owns a detached process tree; interruption or log-write failure terminates the tree and waits for quiescence. Command completion waits for stdio close and serial log-writer flush before build inspection or log audit. Every successful scenario records owned Electron and Host PIDs plus the fake PID where applicable; missing evidence fails cleanup. Teardown force-terminates survivors, settles process, temporary-root, and port obligations independently, records every outcome in `cleanup.json`, and reports their errors together. Electron main/renderer error lines and Desktop smoke errors fail the lane and are written to `log-audit.json`.

`DSH_PHONE_SERVER_PORT` is the Desktop overlay's deployment-varying mobilecli server-port setting. Its default remains `12000`; the e2e runner supplies an ephemeral value so concurrent developer services cannot invalidate the evidence.

## Alternatives considered

**Browser-only automation.** Rejected because it bypasses the Electron main process, overlay WebContentsView, Host child lifecycle, and Electron-specific decoding behavior.

**Transport-only H264 assertions.** Rejected because valid Annex-B bytes do not prove that Chromium decoded and painted a visible picture.

**A fixed mobilecli server port.** Rejected because an unrelated local process can make a correct test fail or route the test to the wrong service.

## Consequences

The lane is keyless but remains a full local Electron acceptance check, not a unit-test substitute. Its evidence distinguishes Host startup, transport bytes, decoded picture visibility, input forwarding, and cleanup. A green repository Electron runtime smoke still does not substitute for this lane, and a green lane does not authorize a product release or a merge to `master`.
