# Agent Note: 把手机 swipe 编成 WDA 位移时长手势

Status: implemented

[English](2026-09-02-phone-ios-wda-swipe-gesture.md) | 中文

## 问题

真实 iOS Simulator 会接受「手机」tab 发出的 `device.io.gesture`，但设备 UI 并不滚动。macOS 原生拖动复现同一结果：pointer 与滚轮到达 renderer，坐标到达 mobilecli，其中一条路径还点进了「朗读所选内容」，而不是持续滑动。把坐标放在 `pointerDown` 上，或在终点 move 之前于 `pointerDown` 后 pause，并不是 mobilecli iOS 转换器当作拖动消费的动作列表。

## 决策

GUI 拖动、触控板滚轮与 `device_act` swipe 共用 `@deepseek-ai/dsh-phone-runtime/swipe` 的 `phoneSwipeActions`。该子路径对浏览器安全，并由 client bundle 内联；Host 包根再导出同一函数。列表是五步动作：定位 `pointerMove`、不带坐标的 `pointerDown`、终点 `pointerMove`、150 ms `pause`、`pointerUp`。终点 move 之后的 pause 是位移时长。`pointerDown` 之后的 pause 会延长按下，变成 iOS 长按，包括「朗读所选内容」。按下前的 `pointerMove` 保存接触点，按下后的 `pointerMove` 才是拖动，`pause` 延长上一动作的 duration。中间采样轨迹点不转发；swipe 由起点与松开界定。滚轮突发合并 50 ms 后，沿纵轴发送同一条 swipe。触控映射仍使用 H264 解码显示尺寸或 MJPEG `naturalWidth`/`naturalHeight`，不用 CSS 布局尺寸。

## Alternatives considered

**保留带坐标的 `pointerDown`，并在每个采样点之间插入 16 ms pause。** 拒绝：devicekit 会把带坐标的 `pointerDown` 当成该点的 press，而没有先做定位 move；16 ms 也无法形成持续 iOS 拖动。

**在 `pointerDown` 之后 pause，再 move。** 拒绝：该 pause 会延长按下，变成 iOS 长按而不是拖动。

**改调上游 `device.io.swipe`，不再使用 `device.io.gesture`。** 拒绝：Host io 词表已经向 GUI 与工具暴露 `gesture`；再加一条动词只会拆开编码，并不改变 iOS 转换路径。

**把 WebSocket 发送成功当成滚动成功。** 拒绝：用户验收要求设备 UI 位置发生变化。fixture 只对五步位移时长列表记录滚动偏移变化；点按形态列表，或「朗读所选内容」长按（`pointerDown` 之后、终点 move 之前的 pause），保持偏移不变。

**在 GUI controller 再写一份 WDA 列表。** 拒绝：两份副本会漂移；单一编码器才能从构造上保证 GUI、滚轮与 `device_act` 一致。

## 后果

Android 与 iOS 消费同一份 WDA 形态列表。一次 swipe 现在会在终点 move 之后编码 150 ms pause。滚轮输入是纵向两点 swipe，不是逐像素路径。测试固定编码后的动作列表以及 fixture 滚动偏移变化；fixture 证据不是用户验收。
