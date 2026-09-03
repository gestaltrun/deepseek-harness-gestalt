# Agent Note: Phone frame box follows the measured surface aspect

Status: implemented

[English](2026-09-03-phone-frame-follows-measured-surface.md) | 中文

## Problem

设备旋转后（issue #547：iOS 模拟器横屏）实时画面被拉伸到无法阅读。`PhoneConnectedView.module.css` 把 `.screenFrame` 锁成竖屏 1:2（`width: min(100cqw, 50cqh)`），`.stream` 用 `object-fit: fill`，任何帧宽高比都被硬拉进框里。`PhoneConnectionController.noteSurface` 早已为触控映射学到真实帧尺寸（H264 解码显示尺寸、当前 MJPEG JPEG），但画面框从未消费它。

## Decision

画面框宽高比跟随实测画面。控制器发布 `surfaceSize()`，`noteSurface` 仅在尺寸真正变化时通知订阅者，视图经 `useSyncExternalStore` 读取画面尺寸。视图内联设置 `--phone-surface-ratio` 自定义属性（宽/高）；`.screenFrame` 从容器单位推导两轴，取显示区内能放下的最大等比矩形（`min(100cqw, 100cqh * ratio)` × `min(100cqh, 100cqw / ratio)`），`0.5` 回退在首次测量前保持锁稿的 1:2 占位。`.stream` 用 `object-fit: contain`，绝不用 `fill`。H264 播放的 `onSurface` 报告旋转后显示尺寸，Host 横屏 `logicalDisplay` 还可以把仍为竖屏编码的帧对调（[H264 旋转](2026-09-05-android-h264-videoframe-rotation.zh.md)）；MJPEG 图像在 live 期间按 500ms 节拍重新测量，因为后续 multipart JPEG 会替换已绘制画面且不触发新的 load 事件。Chromium 把 `naturalWidth`/`naturalHeight` 锁在第一帧 JPEG，因此轮询读取 live `<img>` 的 `createImageBitmap`（[当前帧测量](2026-09-04-mjpeg-current-frame-size.zh.md)）。

## Alternatives considered

**在固定 1:2 框内用 `object-fit: contain`。** 否决：横屏画面仍信箱式躺在竖框里，浪费面板且缩小画面；issue 要求框本身跟随画面。

**用 ResizeObserver 观察图像替代轮询。** 否决：ResizeObserver 报告的是布局框，而布局框由 CSS 驱动；它观察不到已绘制 JPEG 的尺寸，方向翻转没有任何信号。

**在流 session 或 io 通道里携带帧尺寸。** 否决：流契约没有尺寸字段，且采集元素本就是两种渲染器用于触控映射的权威测量来源。

## Consequences

设备旋转时画面框在横竖屏间实时翻转且不拉伸像素；触控保持命中，因为 pointer 归一化测量的是画面框，而 `devicePointOf` 消费同一份实测画面尺寸。live 的 MJPEG 流付出一个 500ms interval，尺寸不变时为空转；重复的相同测量永远不会触发视图重渲染。

## Testing

`phone-connected-view.client.spec.tsx` 要求框比跟随 H264 解码面、在假解码器发出旋转帧时实时翻转、在首次 MJPEG 测量前保持占位，并在 `naturalWidth` 仍为竖屏时按当前 JPEG 翻转 MJPEG 框——每条臂都断言 tap 映射到当前方向的坐标。`phone-connection.client.spec.ts` 钉住 `surfaceSize()` 发布、仅在变化时通知、横屏 tap 映射。`connected-view-styles.client.spec.ts` 钉住带 0.5 回退的比例变量尺寸与 `object-fit: contain`。

## Related

如何测量 MJPEG `<img>` 由 [当前帧笔记](2026-09-04-mjpeg-current-frame-size.zh.md) 持有。
