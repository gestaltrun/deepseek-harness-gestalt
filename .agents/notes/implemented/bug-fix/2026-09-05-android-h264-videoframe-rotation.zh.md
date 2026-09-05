# Agent Note: Honor H264 VideoFrame rotation and Host logical display

Status: implemented

[English](2026-09-05-android-h264-videoframe-rotation.md) | 中文

## Problem

把 Android 真机转到横屏（issue #551：MI 8，H264）后，圆角框仍是竖的。Clash 横屏 UI 信箱式躺在框里；相对整个竖框（含黑边）的点击会偏离横屏逻辑像素（2248×1080）。

`phone-h264-playback` 的 `paint()` 只用 `VideoFrame.displayWidth`/`displayHeight`，`drawImage` 不应用 `VideoFrame.rotation`。Android `screenrecord` 按物理竖屏（1080×2248）编码，旋转后编码宽高不变。现场 MI 8 `dumpsys display` 报告 `mCurrentOrientation=1` 与 `logicalFrame=Rect(0, 0 - 2248, 1080)`，而 `device.info.screenSize` 仍是 `{width:1080, height:2248}`。这条路径上的 WebCodecs 常见地把 `VideoFrame.rotation` 留在 0。

## Decision

`paint()` 读取 `VideoFrame.rotation` 为顺时针 0/90/180/270（缺省或其他值视为 0）。90/270 交换 canvas 与 `onSurface` 尺寸；绘制用 `translate`+`rotate`，使编码像素铺满旋转后的 canvas。tap 仍经 `surfaceSize()` 映射。

因为 Android screenrecord 常以 `rotation=0` 和竖屏编码尺寸出现，Host `phone-runtime` 从 `adb dumpsys display` 的 `logicalFrame`（绝不用锁死的 `device.info.screenSize`）把当前逻辑像素写到在线 Android 清单行的可选 `logicalDisplay`。`GET /phone/devices` 转发该字段。`PhoneConnectedView` 只从 `listing.android` 把该字段转给 `PhoneConnectionController.noteLogicalDisplay`。后续宽高数字变化仅在 live H264 时经 `refresh` 重新铸造。live MJPEG（首选编码或 H264 fallback）只记录尺寸并保留同一份采集。connecting 把最新观察尺寸相对铸造快照记下，该铸造打开 live H264 且二者不同时再铸造一次。画面框与 tap/swipe 的 x/y 以及 `source.captureWidth`/`captureHeight` 跟随当前采集的 H264 解码显示尺寸。Host 把 Android 采集源坐标映射到当前 `logicalDisplay`；Android 缺少该字段（dumpsys 未命中）时拦截 tap/swipe。iOS 清单行不要求 `logicalDisplay`。仍为竖屏的解码不会被拉成横屏清单。横屏逻辑尺寸还会以 `screenrecord --size WxH` 重开系统采集，使重新铸造的采集可以匹配逻辑帧。初始横屏 native-fallback 解码尺寸仍开放：没有横屏解码时，重新铸造不会填满信箱像素。

## Alternatives considered

**当作又一次 MJPEG `createImageBitmap` 修复。** 否决：iOS MJPEG `#549` 是粘滞的 `naturalWidth`；这条路径是 H264 canvas 与竖屏编码尺寸。

**信任 `device.info.screenSize`。** 否决：现场 MI 8 旋转后仍报告物理竖屏。

**在竖框内按信箱后的图像区域重映射 pointer 坐标。** 否决：展示区必须变成宽大于高。

**只按清单 `logicalDisplay` 对调画面框与 tap 空间、不重新铸造。** 否决：Host Android 采集是一次性的；仍在播的竖屏 H264 URL 不会变成横屏像素。

**把现有 canvas 裁切或旋转到新的逻辑尺寸。** 否决：本次经 `refresh` 替换签名采集，不发明解码侧变换。

**清单尺寸变化时重新铸造 live MJPEG。** 否决：那会撤销 H264→MJPEG fallback，并重启已经跟随 JPEG 帧的采集。

## Consequences

带 90/270 元数据的 H264 不依赖 Host 即可翻框。`rotation=0` 的 Android screenrecord 在清单 `logicalDisplay` 宽高变化时重新铸造签名 H264 采集。live MJPEG 与 iOS 清单行不重新铸造。对仍为竖屏的已解码帧做对调不能替代这次重新铸造。dumpsys 缺失时不写 `logicalDisplay`，继续使用解码尺寸。初始横屏 native-fallback 信箱仍在。

## Testing

`phone-h264-playback.client.spec.ts` 用 FakeVideoFrame 的 rotation 90/270/180/0（45 视为 0）断言旋转后 canvas 与 `onSurface` 尺寸。`phone-connection.client.spec.ts` 记下首次 `logicalDisplay`、在 live H264 数字变化时重新铸造、忽略相同轮询与 live MJPEG、connecting 变化后铸造一次，并在清单回到竖屏时丢弃过期横屏铸造。`phone-connected-view.client.spec.tsx` 在 Android 清单竖屏→横屏时替换 live H264 URL，相同轮询、隐藏 tab、live MJPEG、H264→MJPEG fallback 与 iOS 清单横屏保持铸造次数，并断言重新铸造后的 `emitFrame` canvas 尺寸。`android-display.spec.ts` 解析现场 MI 8 的 `logicalFrame`。`android-h264-process.spec.ts` 与 `service.spec.ts` 从 dumpsys 或清单逻辑尺寸传入 `--size`。

## Related

画面框、`--phone-surface-ratio` 与 `object-fit: contain` 仍由 [实测画面决策](2026-09-03-phone-frame-follows-measured-surface.zh.md) 持有。WebCodecs 播放所有权仍由 [H264 WebCodecs 笔记](2026-08-30-ui-phone-h264-webcodecs-playback.zh.md) 持有。
