# Agent Note: Android 采集输入缩放到当前逻辑显示

Status: implemented

[English](2026-09-05-android-capture-logical-input.md) | 中文

## Problem

横屏 Android H264 流可能解码为 1124×540，而 `dumpsys display` 的 `logicalFrame` 是 2248×1080。采集源 `x`/`y` 仍是解码像素，且 `PhoneDevices.io()` 此前原样转发 Android 坐标。因此解码中心点 562,270 会错过逻辑中心 1124,540。竖屏编码帧对照横屏逻辑显示没有已证明的内容映射。

## Decision

`PhoneDevices.io()` / `upstreamIo()` 拥有 Android 采集到逻辑坐标的转换。采集源的 `x`/`y` 与 `captureWidth`/`captureHeight` 留在解码平面。tap 与 swipe 的两轴都缩放到当前 incarnation 的 `logicalDisplay`。缺少逻辑边界，或采集平面不满足整帧均匀缩放假设时，会在 RPC 之前以 `PHONE_PROTOCOL` 失败。相同宽高比假定整帧均匀缩放：每条重建的逻辑轴取整后须落在已知显示的 1 个逻辑像素内。该界限来自整数重建，不是比例 epsilon，也不能证明无黑边；绝不从像素推断裁剪或旋转。相对 2248×1080，接受的编码器尺寸包括 1124×540 与偶数编码 1078×518。400×192 重建偏差超过 1 个逻辑像素，予以拒绝；不放宽 1 像素界限。Android fresh-probe 像素原样转发。button 与 text 保持独立。iOS 精确旋转投影不变。采集授权、generation 与 incarnation 栅栏仍在 RPC 之前执行。上次已知逻辑尺寸是 incarnation 身份，与当前映射可用性分开。dumpsys 缺失会去掉清单 `logicalDisplay`，采集源 io 失败关闭且不发 RPC。缺失的上次已知尺寸对上之后的已知尺寸时，可以保留有效授权；当前边界与宽高比仍在 io 校验。A→miss→B 通过保留的已知尺寸撤销旧授权；B 上的新采集可以映射。不声称一侧 undefined、一侧已知的运算数不可能出现。

## Alternatives considered

**让浏览器预先缩放到逻辑像素。** 否决：采集源字段会谎报解码平面，Host 也无法拒绝未证明的竖屏编码映射。

**从宽高比猜测裁剪或 90/270 旋转。** 否决：相同宽高比只表示整帧均匀缩放。横屏框里的信箱竖屏内容不是已映射的坐标平面。

**因为 `screenrecord --size` 应当匹配而保持 Android 原样转发。** 否决：解码尺寸仍可能是逻辑帧的均匀下采样，例如 1124×540 对 2248×1080。

## Consequences

由 runtime 而非 controller 拥有 Android 采集缩放。调用方保留真实解码范围。坐标 io 在缺少或不兼容的 logical display 时拒绝，而不是静默点偏。产品铺满画面与采集 remint 仍是独立路径。

## Testing

`io.spec.ts` 把解码 1124×540 的中心 562,270 与 swipe 端点映射到 2248×1080，接受偶数编码 1078×518 与 1082×520 的重建轴取整，并拒绝 1084×520、400×192、竖屏不匹配与缺失 logical display，同时 fresh-probe 与 button 保持不缩放。`service.spec.ts` 通过 `PhoneDevices.io()` 覆盖同样的缩放、无 RPC 的不匹配、缺失 logical display、已知尺寸 incarnation 变化后的过期采集，以及一条参数化的 A→miss→A / A→miss→B 序列（缺失时失败关闭，按上次已知尺寸恢复或撤销，B 上新采集可映射）。这些 service 测试从 `../src/index.ts` import `PhoneDevices`，并 mock `../src/android-h264-process.ts`，因此横屏采集不会启动宿主 `adb`。

## Related

平台转换所有权仍由[语义输入笔记](2026-09-04-ios-semantic-input-rotation.zh.md)持有。Host `logicalDisplay` 发布仍由 [H264 旋转笔记](2026-09-05-android-h264-videoframe-rotation.zh.md)持有。
