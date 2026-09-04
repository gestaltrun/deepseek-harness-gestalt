# Agent Note: MJPEG surface size is the currently painted JPEG

Status: implemented

[English](2026-09-04-mjpeg-current-frame-size.md) | 中文

## Problem

画面框开始跟随实测画面（[issue #547](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/547)）之后，把 iOS Simulator 转到横屏，圆角框仍是竖的。横屏 UI 以 `object-fit: contain` 信箱式躺在锁稿的 1:2 框里；相对整个竖框（含黑边）的点击或拖拽会偏离设备像素（[issue #549](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/549)）。

iOS 采集走 MJPEG `<img>`。Chromium 与 Electron 会把 `naturalWidth`/`naturalHeight` 锁在 `multipart/x-mixed-replace` 的第一帧 JPEG，即使后续 JPEG 已翻转方向并仍在绘制。读取这两项属性的 500ms 轮询因此空转，`--phone-surface-ratio` 停在 `0.5` 占位。H264 canvas 路径不受影响：解码显示尺寸会写入 `canvas.width`/`canvas.height`。

## Decision

`measureMjpegCurrentFrame` 对 live 的 MJPEG `<img>` 调用 `createImageBitmap`，在 `close()` 之后返回该 bitmap 的设备像素尺寸。缺少 `createImageBitmap`、抛错（尚无 JPEG，或源被污染）、以及非正或非有限尺寸都返回 `undefined`；现有的 500ms live 轮询会重试。`PhoneConnectedView.applyMjpegSurface` 递增 generation token，因此更新的测量开始之后、或 MJPEG 离开 live 之后，进行中的测量不能再调用 `noteSurface`。`onLoad` 与轮询都走这个 helper，从不读取 `naturalWidth`/`naturalHeight`。

画面框仍跟随 `surfaceSize()`，由 [实测画面笔记](2026-09-03-phone-frame-follows-measured-surface.zh.md) 持有。横屏 JPEG 会把 `--phone-surface-ratio` 设为大于 1，框本身变成宽大于高，`object-fit: contain` 不再出现信箱黑边。

## Alternatives considered

**继续轮询 `naturalWidth`/`naturalHeight`。** 否决：Chromium 把这两项锁在 multipart 的第一帧 JPEG；后续横屏帧会绘制，但不会翻转这两项属性。

**在竖框内按信箱后的图像区域重映射 pointer 坐标。** 否决：展示区必须变成宽大于高；绕开黑边映射仍留下竖屏铬框并缩小画面。

**从 multipart 字节解码 JPEG SOF。** 否决：`createImageBitmap` 已经报告当前绘制的 bitmap；SOF 解析器会重复浏览器解码器，并且仍需要轮询或字节观察。

**把 `<img>` 画到一次性 canvas 再读 `canvas.width`/`height`。** 否决：canvas 尺寸由调用方设定，绘制并不能揭示源 JPEG 尺寸。`createImageBitmap` 直接返回 bitmap 尺寸。

## Consequences

live 的 MJPEG 旋转会在没有新 load 事件的情况下翻转画面框。失败或空测量会保留上一份已学习画面，或 1:2 占位，直到下一拍。每次轮询对 live 的 multipart `<img>` 支付一次 `createImageBitmap`。

## Testing

`measure-mjpeg-current-frame.client.spec.ts` 在 `naturalWidth` 仍停在第一帧 JPEG 时返回当前 bitmap 尺寸；在缺少 `createImageBitmap`、抛错、或给出空/非有限尺寸时返回 `undefined`（若已创建 bitmap 仍会 `close`）。`phone-connected-view.client.spec.tsx` 把 `naturalWidth` 锁在竖屏，经当前帧 stub 驱动横屏再竖屏，要求 `--phone-surface-ratio` 先大于 1 再小于 1，并把 tap 映射进横屏画面。

## Related

画面框、`--phone-surface-ratio` 与 `object-fit: contain` 仍由 [实测画面决策](2026-09-03-phone-frame-follows-measured-surface.zh.md) 持有。本笔记只持有如何测量 MJPEG `<img>`。
