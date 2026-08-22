# Agent Note: 将配对设备展示绑定到 Mobile Installation 身份

Status: implemented

[English](2026-08-22-authenticated-mobile-installation-camera-pairing.md) | 中文

## Problem

Personal Pairing 会在完成请求中接受手机名称与平台，但 Platform 只鉴别 Installation id 与类型。因此，Mobile 调用方可以独立于其 Account Session 选择 Desktop Settings 显示的设备信息。Mobile 页面还把 QR 捕获委托给一个可选的 window hook，导致发布的 Web 入口没有相机流程，也无法区分浏览器不支持相机 API 与用户拒绝授权。

## Decision

Mobile 使用 Capacitor Device adapter 读取名称及 iOS 或 Android 平台，并以有界字段开始 Login Attempt。Platform 将该展示信息随 Login Attempt 与 Account Session 持久化；`currentInstallation()` 只为已鉴别 Mobile Installation 返回它。Personal Pairing 从完成请求中删除设备元数据，并把已鉴别 Installation 展示复制到待确认与已确认配对记录。Mobile Relay credential 通过不含内容的 fingerprint 绑定到该配对。每个已鉴别 attachment 拥有一条会过期的连接 token lease；close 只删除自己的 token，进程丢失会到期，只要任一 lease 存在，当前 presence 就为在线。已鉴别 attach、heartbeat 与 ciphertext 访问会推进 `lastAccessAt`。Desktop Settings 读取这些权威字段，并展示名称、平台、配对时间、当前在线状态与最后访问时间。两个 Mobile Installation 保留不同记录，撤销任意一个配对都不改变另一个。

Mobile 页面通过浏览器 `getUserMedia` 与受维护的 ZXing 浏览器 decoder 扫描 QR。它显示实时相机预览，优先选择后置相机，并让取消与等待中的相机权限竞速。成功、失败、取消或卸载会停止 decoder 重试调度，以及当前或稍后返回的全部媒体 track。不支持的 API、权限拒绝、无相机、空 QR 结果与畸形完整链接都会成为可见配对错误。相机值与粘贴值都会先进入 `parsePairingInvitationLink()`，随后使用同一握手路径；不存在短码或 QR 专用邀请 parser。

## Alternatives considered

**在配对请求中保留设备元数据，并用 Installation 密钥签名。** 拒绝，因为 Account provider 已拥有已鉴别 Installation 投影。在后续 operation 中重复身份字段会产生两个权威来源，并允许两者漂移。

**保留原生 scanner hook。** 拒绝，因为捆绑的 Web 入口可能显示扫描按钮，却没有任何实现。浏览器媒体捕获加浏览器 QR decoder 为 Capacitor WebView 与普通安全浏览上下文提供同一个可观察的权限与清理生命周期。

**只使用 `BarcodeDetector`，不引入 decoder 依赖。** 拒绝，因为 Mobile 产品使用的主要浏览器中有一部分不支持该实验性 API。ZXing 使用成熟的浏览器媒体 API，同时只增加一个有界解码依赖。

## Consequences

当 Device 信息不能识别 iOS 或 Android Installation，或名称无效时，Mobile 登录会在 OAuth 流量前失败。缺少持久展示信息的既有 Mobile Account Session 可以通过 PostgreSQL 解析，随后 Account core 会在验证证明后撤销它并返回 `SESSION_REVOKED`；客户端清除本地授权，新登录会记录原生展示。完成重放会保留已鉴别账号、Mobile Installation、完整邀请与 Mobile 握手的 SHA-256 commitment，因此 id 碰撞无法替换其中任一值。配对事务格式版本 1 会记录这项 commitment；迁移时，不含该值的无版本记录会失去重放权限，但已确认配对与清理责任会保留。解除配对会尝试全部自有清理并汇总失败；只有全部成功才发布 ready，否则保留明确且已报告的失败。账号激活会等待先前 Companion 释放与 Relay 撤销。产品 Mobile 新增 `@capacitor/device` 与 `@zxing/browser`；相机访问要求安全上下文与用户授权。发布入口在收到已鉴别 Desktop resync 前不会显示写死的 Desktop 身份或本地 Session。keyless Loader snapshot 仍是开发证据，不是产品链路验收。
