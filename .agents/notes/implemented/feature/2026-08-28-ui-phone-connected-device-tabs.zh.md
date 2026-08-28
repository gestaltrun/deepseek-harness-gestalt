# Agent Note: ui-phone 已连接视图与每设备多 tab

Status: implemented

[English](2026-08-28-ui-phone-connected-device-tabs.md) | 中文

## 问题

移动设备 dock（#355）推进到 GUI 子票 #361 时，Host 侧能力已合入（`ctx.phoneDevices`、同源 `phone-stream` 反向代理），而 `ui-phone` tab 还是一个 `single: true` 的空态骨架。dock 需要：每台已连接设备一个 tab 且聚焦而不重建、在 better-sidebar 面板内出流的已连接内容、真机故障模式的错误臂——并且不引入 `react-device-view` 或任何新 npm 依赖。

## 决策

`phone` tab 类型承载两种实例形态，按 `meta` 分流。选择器（id `phone`，无 serial）渲染已锁空态；每台被打开的设备铸造 id `phone:<serial>`、meta `{ kind: 'device', serial, name }`、标题 `手机·<name>` 的实例。`dedupeKey` 返回 serial，重复打开已连接设备即聚焦既有 tab；选择器经宿主的 id 安全网保持单例。设备 tab 经由 seed 携带的默认打开铸造——`installPhoneTab` 内接线的同一个 opener 调 `openTab({ type: 'phone', id: 'phone:<serial>', title, meta })`——而不走 `createTab`：`TabDescriptor.createTab` 只收得到 `SidebarState`，基于 createTab 的铸造拿不到发起方的 serial；而「先记下请求再 openTab」的旁路通道是两次调用之间的隐式状态。

已连接内容用纯浏览器原语消费 Host `phone-stream` 通道：`POST /phone/session` 铸造签名采集地址，`/phone/ws/io` 承载 JSON-RPC `tap` / `gesture` / `text` / `button`，MJPEG 用原生 `<img>` 播放并以图片自然尺寸作为触控坐标面。全部连接决策收敛在 `PhoneConnectionController`——每 tab 一实例的无 React 对象：铸造 → io 打开 → live；`visible: false` 暂停拉流，恢复即重新铸造（签名地址短时效）；中断进入有界自动重连（3 次线性退避）；终态臂——设备离线（铸造 404 或 io `-32010`）、真机调试未授权（上游报文）、被拒绝（403）——渲染已锁稿状态 ④ 的错误卡与唯一「重新连接」动作。画面框锁定 1:2（决策矩阵轴 3 格 B），img 填满框体，归一化触控坐标对学到的设备像素面做线性映射。`ui-phone.enabled` 关闭时在 opener——唯一做决策的位置——拒绝设备 tab 的打开。

## Alternatives considered

**用 `createTab(state)` 加 pending-request 通道铸造每设备 tab。** 拒绝：打开意图要靠 `request()` 与 `openTab()` 之间的隐藏可变状态传递，任何其他 `openTab({ type: 'phone' })` 调用方都会踩到残留请求。seed 携带的默认铸造显式带上 id/title/meta，正是 editor 内建按资源多开的既有先例。

**采用 `react-device-view`。** 票面否决：为这层 UI 引入新 npm 依赖，而 CSS Modules、`--dsw-*` token、原生 `<img>` 与 WebSocket 足以表达。controller/gateway 缝保留了该库标榜的可测性。

**用 `<video>` 播签名 H264 地址。** 现阶段拒绝：Host 反代的是裸 `avc` 基本流，浏览器 `<video>` 不经 MSE/WebCodecs 封装无法解码。该徽标以 tooltip 禁用渲染；控制器按会话钉住格式，解码子票只需替换这一臂。

**无预算自动重连。** 拒绝：抖动流会让转圈永远循环。三次线性尝试后落到 interrupted 错误卡，其动作即重置预算。

## Consequences

多设备按 tab 并存监视、聚焦去重可用；已连接视图经同源通道触达设备且零新依赖。插件仍不拥有设备发现：随包的 `NULL_PHONE_BADGE_SOURCE` 之下，选择器在引擎子票发布真实 source 之前清单为空；「截图」与 H264 播放以可见禁用加原因的方式保留。徽标契约依旧无法定向单个 tab 实例，每个手机 tab 显示的是全队在线台数。
