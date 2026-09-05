# Agent Note: 同源手机 IO 与采集反代

Status: implemented

[English](2026-08-28-phone-same-origin-stream-channel.md) | 中文

## 问题

移动设备 dock（#355）需要在浏览器里播放实况画面并转发 tap/swipe/text/button，但 mobilecli 监听回环 `:12000`。页面直连该端口会绕过 Host 信任栅栏泄漏设备群；LAN Host 若反代未签名的采集 URL，则同一网络上的任意浏览器都能读到视频流。

## 决策

`packages/phone/phone-stream`（`@deepseek-ai/dsh-phone-stream`）是承载于 `ctx.phoneStream` 的 Host Consumer。它注入 `phoneDevices` 与 `webServer`，并且永不让浏览器直连 `:12000`。

- IO 走精确路径 WebSocket 升级 `/phone/ws/io`，并先经过 `/api` 信任栅栏（Host 为 loopback 或已声明的 `trustedHosts`、同源 Origin、拒绝 cross-site Fetch-Metadata）。帧为 JSON-RPC `tap` / `swipe` / `text` / `button`，转发到 `phoneDevices.io`。
- 采集走签名的 Host 同源 URL `/phone/stream/<id>/<mjpeg|h264>?token=`。签发入口是 `sessionFor` / `POST /phone/session`。对清单中的 iOS 真机，mint 在应答前安装可恢复的缺失控制 agent，由 [mint 自动安装笔记](../bug-fix/2026-09-03-phone-ios-real-mint-autoinstall.zh.md) 持有。每个 token 是覆盖 `deviceId`、格式与过期时间的 HMAC-SHA256，有效期为 `tokenTtlMs`（默认 30 秒）。采集还拒绝非 loopback Host，因此能调用 `/api` 的受信任 LAN 权威仍不能播放视频。
- `phone-runtime` 追加 `io` 与 `startCapture`，不改变 `listDevices` / `boot` / `shutdown`。`startCapture` 将 `h264` 映射为上游 `avc`，并且只约束等待响应头的时间；未读 body 属于 Host 反代，浏览器断开时由其取消。

画面布局由 GUI Consumer 按当前采集实测值绑定；占位比例不具备输入权威。本包签发流 URL 并转发帧；它不渲染 `react-device-view`。

## Alternatives considered

**浏览器直连 `:12000`。** 否决：页面会绕过 Host 信任栅栏，把 mobilecli JSON-RPC 暴露给任何能到达 loopback 的 origin。

**采集 URL 只复用 `/api` 信任栅栏。** 否决：在明文 HTTP 上，被 DNS 重绑定的 image 或 `<video>` 请求可能既没有 Origin 也没有 Fetch-Metadata。采集额外要求 loopback 加上短时效 HMAC，这样 LAN Host 才不会变成未签名的 MJPEG 端点。

**把 IO 与采集方法只放在 `phoneDevices` 上、不另立 sibling 包。** 否决：设备群清单与 spawn 已经在折叠 Service 上；Host HTTP/WebSocket 反代是该 Service 与 `webServer` 的 Consumer，因此属于 `phone-stream`。

## Consequences

GUI 票可以消费同源 IO 与签名 MJPEG/H264 URL，而不在本变更中改动 `ui-phone`。采集在后续票补上已鉴权远程路径之前保持仅限 loopback。`phone-runtime` 仍要求用户安装 mobilecli；没有该 Service 时本 Consumer 无法组合。
