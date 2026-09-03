# Agent Note: Honor H264 VideoFrame rotation and Host logical display

Status: implemented

[English](2026-09-05-android-h264-videoframe-rotation.md) | 中文

## Problem

把 Android 真机转到横屏（issue #551：MI 8，H264）后，圆角框仍是竖的。Clash 横屏 UI 信箱式躺在框里；相对整个竖框（含黑边）的点击会偏离横屏逻辑像素（2248×1080）。

`phone-h264-playback` 的 `paint()` 只用 `VideoFrame.displayWidth`/`displayHeight`，`drawImage` 不应用 `VideoFrame.rotation`。Android `screenrecord` 按物理竖屏（1080×2248）编码，旋转后编码宽高不变。现场 MI 8 `dumpsys display` 报告 `mCurrentOrientation=1` 与 `logicalFrame=Rect(0, 0 - 2248, 1080)`，而 `device.info.screenSize` 仍是 `{width:1080, height:2248}`。这条路径上的 WebCodecs 常见地把 `VideoFrame.rotation` 留在 0。

## Decision

`paint()` 读取 `VideoFrame.rotation` 为顺时针 0/90/180/270（缺省或其他值视为 0）。90/270 交换 canvas 与 `onSurface` 尺寸；绘制用 `translate`+`rotate`，使编码像素铺满旋转后的 canvas。tap 仍经 `surfaceSize()` 映射。

因为 Android screenrecord 常以 `rotation=0` 和竖屏编码尺寸出现，Host `phone-runtime` 从 `adb dumpsys display` 的 `logicalFrame`（绝不用锁死的 `device.info.screenSize`）把当前逻辑像素写到在线 Android 清单行的可选 `logicalDisplay`。`GET /phone/devices` 转发该字段。当 Host 已是横屏而 H264 画面仍是竖屏时，`h264SurfaceForHost` 对调画面框与 tap 空间。横屏逻辑尺寸还会以 `screenrecord --size WxH` 重开系统采集，使像素可以匹配逻辑帧。

## Alternatives considered

**当作又一次 MJPEG `createImageBitmap` 修复。** 否决：iOS MJPEG `#549` 是粘滞的 `naturalWidth`；这条路径是 H264 canvas 与竖屏编码尺寸。

**信任 `device.info.screenSize`。** 否决：现场 MI 8 旋转后仍报告物理竖屏。

**在竖框内按信箱后的图像区域重映射 pointer 坐标。** 否决：展示区必须变成宽大于高。

## Consequences

带 90/270 元数据的 H264 不依赖 Host 即可翻框。`rotation=0` 的 Android screenrecord 在清单 `logicalDisplay` 为横屏时仍会翻框，系统采集也可按该帧重设尺寸。dumpsys 缺失时不写 `logicalDisplay`，继续使用解码尺寸。

## Testing

`phone-h264-playback.client.spec.ts` 用 FakeVideoFrame 的 rotation 90/270/180/0（45 视为 0）断言旋转后 canvas 与 `onSurface` 尺寸。`phone-connection.client.spec.ts` 与 `phone-connected-view.client.spec.tsx` 在 Host `logicalDisplay` 为 2248×1080 时对调竖屏编码帧，并把 tap 映射进横屏。`android-display.spec.ts` 解析现场 MI 8 的 `logicalFrame`。`android-h264-process.spec.ts` 与 `service.spec.ts` 从 dumpsys 或清单逻辑尺寸传入 `--size`。

## Related

画面框、`--phone-surface-ratio` 与 `object-fit: contain` 仍由 [实测画面决策](2026-09-03-phone-frame-follows-measured-surface.zh.md) 持有。WebCodecs 播放所有权仍由 [H264 WebCodecs 笔记](2026-08-30-ui-phone-h264-webcodecs-playback.zh.md) 持有。
