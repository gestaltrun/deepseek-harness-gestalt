# Agent Note: Mobile WebView 83 兼容性

Status: implemented

[English](2026-08-31-mobile-webview-83-compatibility.md) | 中文

## Problem

Android 应用接受 API 24 及以上版本，但其打包浏览器代码使用了一台已操作物理手机的 Android 10 出厂 WebView 之后才引入的 API。缺少 `crypto.randomUUID` 会拒绝产品初始化，而启动错误渲染器本身又调用了缺失的 `Element.replaceChildren`；因此，用户看到的是空白 WebView，而不是账号界面或可操作的错误。

## Decision

Android System WebView 83 是 Mobile 的浏览器运行时下限。生产构建和 bundled-entry 快照构建都以 Chrome 83 语法为目标。入口会在产品初始化前加载由 core-js 维护的 `Object.hasOwn`、`Array.prototype.at`、`String.prototype.replaceAll` 与 `AggregateError` 实现，再安装该运行时缺少的 DOM `Element.prototype.replaceChildren` 和密码学 `crypto.randomUUID` API。UUID 生成委托给 Mobile 自有的 `randomUuid()` helper；该实现使用 `crypto.getRandomValues`，并设置 RFC 4122 版本与 variant 位。入口不会使用 `Math.random`、Web 存储或其他可预测来源。

启动错误渲染器使用 `textContent` 与 `append`，因此当兼容安装器无法提供所需系统密码学时，错误仍然可见。持久 Companion Host 失败会按 discriminant 重建，不再依赖 `structuredClone`。

## Alternatives considered

**要求用户在启动前更新 Android System WebView。** 并非每个 OEM 应用商店都提供 Google 签名的 WebView 更新，独立更新的系统组件不应让其他方面受支持的 Android 版本变成无说明白屏。

**打包不受限制的兼容 preset。** 签名 bundle 只导入其已审计运行时表层所需的 core-js 模块。通用 legacy preset 会在没有当前 Consumer 的情况下增加字节与行为。

**使用本地伪随机 fallback 生成标识符。** Installation、proof、Relay 与 Companion operation 标识符是安全敏感的关联值。只有系统密码学随机字节能满足这项义务。

## Testing

聚焦测试会验证兼容 API、符合标准的 replacement token、DOM 子节点替换以及确定性 UUID 的版本与 variant 位。受保护存储测试要求密码学字节，并会在重启后保留 Installation id。以 Chrome 83 为目标的 bundled-entry 快照会在导航前移除每个兼容 API，再证明真实入口会在渲染已认证产品界面前安装这些 API。产品入口测试还要求缺失随机字节时渲染双语启动错误。

一台使用 Android 10 / MIUI 12.5.2 与 Google System WebView 83 的物理手机会通过 Mobilewright 启动 operated Debug bundle，并渲染 Platform Account 隐私页。同一设备仍无法连接生产 ALB，因为 WebView TLS 以 `net_error -101` 失败；这个 transport 结果与已修复的白屏渲染缺陷分开。

## Consequences

Mobile bundle 携带一个小型早期兼容模块，并可在不削弱标识符生成的情况下，在 WebView 83 上运行当前账号与 Companion 代码。新增到签名 bundle 的浏览器 API 必须满足该下限，或扩展同一聚焦兼容 owner 与物理设备测试。浏览器运行时现在可直接暴露生产 transport 不兼容，而不是将其隐藏在白屏之后。
