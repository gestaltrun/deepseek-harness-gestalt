# Agent Note: 手机语义输入遵循精确采集旋转

Status: implemented

[English](2026-09-04-ios-semantic-input-rotation.md) | 中文

## Problem

在 iOS 已报告交换后的物理尺寸后，DeviceKit 仍会对 `device.io.tap` 及任意 WDA action-list 路径再次应用错误的横屏变换。因此实时画面可以正确显示，而已接受的操作仍会错过可见控件。早期滑动实验也会在未滚动时返回成功，并可能在按下后暂停时触发“朗读所选项”；RPC 成功、WebSocket 发送和 fake 计数都不能证明设备输入生效。

`device.info.screenSize` 始终是竖屏逻辑尺寸。Landscape Left 与 Landscape Right 尺寸相同，但可见画面的左侧、中心和右侧点需要不同变换；宽高比、溢出或固定偏移都不能识别精确方向。Android `logicalDisplay` 仅是 Android 证据，不是 iOS 旋转来源。

## Decision

`PhoneDevices.io()` 统一拥有 tap、swipe、text 与 button 的闭合语义动作及平台转换。采集源的 `x`/`y` 与 `captureWidth`/`captureHeight` 仍是解码平面。Android 采集源 tap 与 swipe 把两轴缩放到当前 incarnation 的 `logicalDisplay`；缺少逻辑边界或宽高比不兼容时，在 RPC 之前以 `PHONE_PROTOCOL` 失败。Android fresh-probe 像素原样转发。每个 iOS 坐标端点都从当前显示截图平面缩放到竖屏逻辑边界，再按精确的 `0 | 90 | 180 | 270` 旋转执行逆变换。0 度 tap 使用 `device.io.tap`；旋转后的 tap 使用零距离 `device.io.swipe`；所有语义 swipe 都使用变换后的端点调用 `device.io.swipe`，并沿用上游默认时长。

浏览器坐标操作携带唯一的活跃采集身份、格式、显示尺寸，以及适用时的精确 H264 `VideoFrame.rotation`。Host 仅在对应签名采集管道活跃期间接受这些证据。MJPEG 旋转来自按采集身份隔离的有界结构化 JPEG 观察器。模型操作省略采集身份，从竖屏逻辑尺寸与 scale 推导显示的 `device_screenshot` 范围，并使用属于当前 runtime generation 的全新 MJPEG 探测。runtime 替换、设备移除、采集关闭与 dispose 都会撤销观察并排空探测。

浏览器与 Service 公开请求只使用语义 `swipe { x1, y1, x2, y2 }`；任意 WDA action list 与 `gesture` wire 输入不存在。GUI 拖动以按下原点和释放点作为端点；滚轮 burst 合并到同一语义端点。隐藏、取消、设备替换或 renderer 替换会丢弃未完成输入。普通操作错误保持画面在线可见；更新请求的结果按单调顺序覆盖旧回复。

## Alternatives considered

**保留 WDA action list，或把坐标移动到 pointer-down。** action list 最初用于表达按下、移动、暂停与释放，但 DeviceKit 会对该路径应用错误方向转换。把坐标移到 pointer-down 不能证明滚动，而按下后暂停可能触发“朗读所选项”。

**把成功发送、RPC 结果或 fake 计数视为验收。** 这些观察只证明传输。验收必须通过真实生产路径引起新鲜 UI 状态或滚动状态变化，同时采集仍可用。

**使用固定横屏偏移或溢出补偿。** 修正量随方向和点位变化；相反旋转甚至可能要求非法坐标。左侧、中心与右侧点证据否定了单一溢出规则。

**从宽高比推断旋转，或每次操作刷新 `device.info`。** 两个横屏方向尺寸相同，而 `device.info.screenSize` 始终为竖屏。重复读取只增加工作，不能提供精确方向。

**把 Android `logicalDisplay` 当作 iOS 旋转来源，或让 phone-stream 拥有投影。** `logicalDisplay` 仅适用于 Android，是 Android 采集平面到逻辑坐标的缩放目标，不是 iOS 旋转来源。语义平台转换属于 phone fleet Service；phone-stream 只认证当前采集证据并转发字节，不解释用户坐标。Android 转换见[采集到逻辑输入决策](2026-09-05-android-capture-logical-input.zh.md)。

**为高级调用者保留任意 gesture。** 当前 Consumer 不需要它，保留损坏的平台专用程序会形成第二套输入约定。只有当真实语义动作无法由 tap、swipe、text 或 button 表达，并且在每个支持平台上有真实 UI 状态验证时，才可重新引入。

## Consequences

GUI 拖动、滚轮与 `device_act` 共用一条语义 swipe 路径。开放的 MJPEG 采集可在 EXIF 变化时更新方向，无需重连；旧采集不能发布或删除另一采集的观察。模型坐标操作需要一次有界的新鲜探测。实现放弃任意 WDA 程序与仅按宽高比的回退，换取一套可测试的坐标约定。

验证覆盖精确变换、全分辨率与缩放截图、畸形屏幕信息、采集身份隔离、结构化 JPEG framing、探测取消与新鲜度、响应头后过期采集的有界取消、H264 同尺寸反向旋转、含 send 先发布后回滚的操作回复顺序、GUI 语义输入、精确 mobilecli RPC 方法与参数，以及已移除 gesture wire 格式的拒绝。产品验收仍要求无头真实 UIKit UI 状态变化，而不是 RPC、send 或 fake 计数成功；Issue #567 拥有该验证通道。
