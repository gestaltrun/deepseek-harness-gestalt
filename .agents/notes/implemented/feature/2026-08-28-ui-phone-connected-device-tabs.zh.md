# Agent Note: ui-phone 已连接视图

Status: implemented

[English](2026-08-28-ui-phone-connected-device-tabs.md) | 中文

## 问题

移动设备 dock（#355）推进到 GUI 子票 #361 时，Host 侧能力已合入（`ctx.phoneDevices`、同源 `phone-stream` 反向代理），而 `ui-phone` tab 还是一个 `single: true` 的空态骨架。dock 需要：每台已连接设备一个 tab 且聚焦而不重建、在 better-sidebar 面板内出流的已连接内容、真机故障模式的错误臂——并且不引入 `react-device-view` 或任何新 npm 依赖。

## 决策

`phone` tab 类型按 `meta` 分流两种内容。选择器（id `phone`，无 serial）渲染已锁空态；占用一台设备会把同一 tab 的 meta 改成 `{ kind: 'device', serial, name }`、标题改成 `手机·<name>`（见[单 tab 改定](2026-08-29-ui-phone-single-tab-h264.zh.md)）。设备切换由 `installPhoneTab` 接线的同一个 switcher 调 `updateTab`。「选择设备」调用 `showPhonePicker`，写入 `meta: {}`，从而再次渲染带「重新检测环境」的选择器（见[实时清单](../bug-fix/2026-09-04-ui-phone-sidebar-picker-live-listing.zh.md)）。`ui-phone.enabled` 关闭时在该唯一决策点拒绝切换。

已连接内容用纯浏览器原语消费 Host `phone-stream` 通道：`POST /phone/session` 以 `format: 'avc'` 铸造签名采集地址，`/phone/ws/io` 承载 JSON-RPC `tap` / `swipe` / `text` / `button`，[`PhoneH264Surface`](../bug-fix/2026-08-30-ui-phone-h264-webcodecs-playback.zh.md)拉取签名 H264 URL，经 WebCodecs 解码流式 Annex-B access unit，并绘制 canvas；解码后的显示尺寸成为触控坐标面。全部连接决策收敛在 `PhoneConnectionController`——占用设备持有的无 React 对象：铸造 → io 打开 → live；`visible: false` 暂停拉流，恢复即重新铸造（签名地址短时效）；中断进入有界自动重连（3 次线性退避）；终态臂——设备离线（铸造 404 或 io `-32010`）、真机调试未授权（上游报文）、被拒绝（403）——渲染已锁稿状态 ④ 的错误卡与唯一「重新连接」动作。画面框跟随实测画面宽高比（[画面框跟随实测面](../bug-fix/2026-09-03-phone-frame-follows-measured-surface.zh.md)），画面按比例一致的框体信箱式呈现，锁稿的 1:2（决策矩阵轴 3 格 B）仅作为首次测量前的占位，归一化触控坐标对学到的设备像素面做线性映射。

## Alternatives considered

**用 `createTab(state)` 加 pending-request 通道铸造每设备 tab。** 拒绝：打开意图要靠 `request()` 与 `openTab()` 之间的隐藏可变状态传递。后续验收彻底改定了每设备一 tab 模型（见[单 tab 改定](2026-08-29-ui-phone-single-tab-h264.zh.md)）。

**采用 `react-device-view`。** 票面否决：为这层 UI 引入新 npm 依赖，而 CSS Modules、`--dsw-*` token、canvas 与 WebSocket 足以表达。controller/gateway seam 保留了该库标榜的可测性。

**用 `<video>` 播签名 H264 地址。** 拒绝：Host 反代的是裸 `avc` 基本流，浏览器 `<video>` 没有容器就无法解码。客户端 WebCodecs 播放决策及其资源所有权见[H264 播放笔记](../bug-fix/2026-08-30-ui-phone-h264-webcodecs-playback.zh.md)。

**无预算自动重连。** 拒绝：抖动流会让转圈永远循环。三次线性尝试后落到 interrupted 错误卡，其动作即重置预算。

## Consequences

已连接视图经同源通道触达占用设备且零新依赖。插件自身仍不拥有设备发现：选择器列出随包 `PhoneListingSource` 从 Host 清单路由应答的内容（见[清单路由笔记](2026-08-28-phone-device-listing-route.zh.md)）。「截图」保持禁用，直到会话附件存储就绪。徽标契约依旧无法定向单个 tab 实例，单例手机 tab 显示的是全队在线台数。tab 模型与仅请求 H264 见[单 tab 改定](2026-08-29-ui-phone-single-tab-h264.zh.md)；canvas 播放生命周期见[H264 播放笔记](../bug-fix/2026-08-30-ui-phone-h264-webcodecs-playback.zh.md)。
