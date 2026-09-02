# Agent Note: 把手机 swipe 编成 WDA 按住手势

Status: implemented

[English](2026-09-02-phone-ios-wda-swipe-gesture.md) | 中文

## 问题

真实 iOS Simulator 会接受「手机」tab 发出的 `device.io.gesture`，但设备 UI 并不滚动。macOS 原生拖动复现同一结果：pointer 与滚轮到达 renderer，坐标到达 mobilecli，其中一条路径还点进了「朗读所选内容」，而不是持续滑动。把坐标放在 `pointerDown` 上、又不提供按住 pause，并不是 mobilecli iOS 转换器消费的动作列表。

## 决策

GUI 拖动、触控板滚轮与 `device_act` swipe 共用 `phoneSwipeActions`。列表是定位 `pointerMove`、不带坐标的 `pointerDown`、500 ms `pause`、终点 `pointerMove`、200 ms `pause`、`pointerUp`。这与 mobilecli 已发布的自定义手势示例以及 devicekit 转换器一致：按下前的 `pointerMove` 保存接触点，按下后的 `pointerMove` 才是拖动，`pause` 延长上一动作的 duration。中间采样轨迹点不转发；swipe 由起点与松开界定。滚轮突发合并 50 ms 后，沿纵轴发送同一条 swipe。

## Alternatives considered

**保留带坐标的 `pointerDown`，并在每个采样点之间插入 16 ms pause。** 拒绝：devicekit 会把带坐标的 `pointerDown` 当成该点的 press，而没有先做定位 move；16 ms 也无法形成持续 iOS 拖动。

**改调上游 `device.io.swipe`，不再使用 `device.io.gesture`。** 拒绝：Host io 词表已经向 GUI 与工具暴露 `gesture`；再加一条动词只会拆开编码，并不改变 iOS 转换路径。

**把 WebSocket 发送成功当成滚动成功。** 拒绝：用户验收要求设备 UI 位置发生变化。

## 后果

Android 与 iOS 消费同一份 WDA 形态列表。一次 swipe 现在会在松开前编码 700 ms pause。滚轮输入是纵向两点 swipe，不是逐像素路径。测试固定编码后的动作列表；fixture 证据不是用户验收。
