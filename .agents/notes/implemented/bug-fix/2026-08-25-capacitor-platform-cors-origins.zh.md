# Agent Note: Platform HTTP 路由上的 Capacitor 元组 Origin

Status: implemented

[English](2026-08-25-capacitor-platform-cors-origins.md) | 中文

## 问题

打包后的 Android 与 iOS 应用分别从 `https://localhost` 和 `capacitor://localhost` 调用 Platform，而 Platform Account、Personal Pairing 与加密附件路由只准入 Platform 公网 origin。因此浏览器预检会在 GitHub 授权前拒绝第一项原生 Account 请求，后续配对与附件路由也会因同一原因被拒绝。

自定义 scheme origin 必须按精确元组处理。标准 URL origin 归一化会把 `capacitor://localhost` 变成 opaque 值 `null`；放行该值还会准入无关的 opaque 文档。

## 决策

每个 Platform HTTP 消费方都接收非空的显式 `origins` 列表。`CorsOriginPolicy` 会在插件加载时校验并去重完整的序列化 origin，将请求的原始 Origin 与该列表精确匹配，并返回配置值用于 `Access-Control-Allow-Origin`。它会拒绝路径、credential、查询字符串、fragment、畸形值与 opaque 的 `null` 值。

实际运行的 Platform 组合只准入自身公网 HTTPS origin、Android 的 `https://localhost` 与 iOS 的 `capacitor://localhost`。两个本地 origin 由已发布的 Capacitor 容器固定，而不是由请求或 Pairing Challenge 提供。这项决策细化了 [GitHub Platform Account 与 Installation Session](../feature/2026-08-17-platform-account-installation-sessions.zh.md)记录的 Account HTTP 绑定。

## 已考虑的替代方案

**用 `*` 允许所有 origin。** 已拒绝，因为即使存在其他授权检查，Account proof、Personal Pairing 操作与附件 capability 仍然属于安全敏感内容。

**为 iOS 允许 `Origin: null`。** 已拒绝，因为 `null` 可以代表许多 opaque 文档，无法保留已配置的 Capacitor 元组 origin。

**通过新的 Capacitor 插件代理原生请求。** 已拒绝，因为原生 HTTP 会重复共享 TypeScript 客户端已经拥有的请求、proof、错误与生命周期行为。

**把 iOS 本地 scheme 改成 HTTPS。** 已拒绝，因为 WKWebView 将 HTTP 和 HTTPS 保留给网络加载；Capacitor 通过自定义 scheme 提供打包后的 iOS 资源。

## 后果

打包后的 Mobile Installation 可以通过实际运行的 ALB/WAF endpoint 到达 Account、Personal Pairing 与加密附件 HTTP 路由。增加另一种已发布容器 origin 需要显式修改组合并增加精确 origin 测试；任意 localhost 端口、suffix 匹配、请求提供的 origin 与 opaque origin 仍然不可用。

共享策略使三个消费方使用完全一致的自定义 scheme 解析。包测试覆盖每条公开 HTTP 路由，实际运行的组合测试在组装路由集合上覆盖两种原生 origin，并证明 `Origin: null` 仍会被拒绝。
