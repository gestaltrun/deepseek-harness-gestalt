# Agent Note: Keep iOS real picture sessions through landscape taps

Status: implemented

English | [中文](2026-09-04-ios-real-tap-keeps-session.zh.md)

## Problem

Tapping a landscape H264 picture of a real iPhone (issue #563: 贝贝猫的iPhone, `00008150-0008545C2608401C`) moved the panel to 「正在检测设备控制代理…」 and then disconnected. The Host IO websocket stayed open; only the JSON-RPC tap reply failed.

Mint marks iOS real sessions `agentManaged: true` with preferred H264. The GUI sends capture pixels from the live H264 surface. Host `io()` divided those pixels by a cached `device.info.screenSize.scale`. Live `device.info` stayed `{width:440, height:956, scale:3}` in portrait logical points while the frame was landscape, so width/3 exceeded 440 and WDA rejected the tap. `PhoneConnectionController.handleFrame` then tore down any non-ok IO on an `agentManaged` session and entered checking-agent. `logicalDisplay` is Android-only; [H264 host swap](2026-09-05-android-h264-videoframe-rotation.md) is not this root cause.

## Decision

Host `ioParams` converts iOS capture pixels with the cached `device.info.screenSize`, not scale alone. Landscape versus portrait WDA bounds are owned by [the live-surface orientation note](2026-09-04-ios-landscape-tap-orientation.md). Android still forwards capture pixels unchanged.

`handleFrame` keeps the live picture on a tap or gesture JSON-RPC error. Agent recovery remains for mint, picture, and socket death. IO `-32010` stays device-offline and unauthorized messages stay unauthorized, including on `agentManaged` sessions.

## Alternatives considered

**Refresh `device.info` on every tap so width/height follow rotation.** Rejected: live `device.info.screenSize` stayed portrait on this handset; extra RPCs would not change the sticky bounds.

**Treat Host landscape `logicalDisplay` as the iOS mapping source.** Rejected: that field is Android `dumpsys display` only.

**Swap GUI `devicePointOf` through `h264SurfaceForHost` for iOS.** Rejected: iOS real H264 already reports landscape display size; the WDA overflow is Host scale-only conversion.

**Keep “any IO error kills a managed Android session.”** Rejected: Host does not close the IO websocket on a tap RPC error; agent recovery is for agent-missing, picture, and socket death.

## Consequences

A landscape iOS real tap JSON-RPC error does not enter checking-agent. Picture and socket death still re-check a managed agent. Left-side landscape mapping is owned by [the live-surface orientation note](2026-09-04-ios-landscape-tap-orientation.md).

## Testing

`phone-connection.client.spec.ts` keeps an `agentManaged` iOS real or Android session live after a tap JSON-RPC error, and still takes device-offline and unauthorized arms. Landscape WDA mapping coverage lives on [the live-surface orientation note](2026-09-04-ios-landscape-tap-orientation.md).

## Related

iOS WDA orientation from the live capture surface is [the landscape tap note](2026-09-04-ios-landscape-tap-orientation.md). Android landscape H264 box swap remains [the VideoFrame rotation note](2026-09-05-android-h264-videoframe-rotation.md).
