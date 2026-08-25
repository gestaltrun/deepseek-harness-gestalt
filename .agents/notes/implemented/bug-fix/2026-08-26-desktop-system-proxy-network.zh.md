# Agent Note：Desktop Platform 流量使用 Electron 系统代理

状态：已实现

[English](2026-08-26-desktop-system-proxy-network.md) | 中文

## 问题

Desktop Platform Account 与 Remote Access HTTP 使用 Node 全局 Fetch，Relay WSS 使用直连 Node socket。这些路径不会采用 Electron 选择的操作系统代理。在有效的 macOS 系统代理配置下，即使同一个生产 Platform 通过已配置代理保持健康，打包 Desktop 仍会在 GitHub 登录前显示 `fetch failed`。

## 决策

Desktop 持有的 Platform Account、Remote Access 与附件 HTTP 使用会跟随当前 Electron session 网络策略的 Electron `net.fetch`。每次新的 Relay WSS 建连都会针对实际运行的 WSS URL 调用 `Session.resolveProxy`。`DIRECT` 保留经过验证的直连 TLS 路径；`PROXY` 与 `HTTPS` 指令会创建受维护的 `https-proxy-agent` CONNECT agent，并且只传给该 socket。不支持的代理指令会明确失败，不会静默绕过策略。

## 考虑过的替代方案

**读取 `HTTP_PROXY` 与 `HTTPS_PROXY`。** 未采用，因为打包 GUI 应用不会可靠继承 shell 变量，而且这些值可能与当前 Electron session 不一致。

**要求用户关闭代理。** 未采用，因为这会让实际运行产品依赖本地网络绕行方式，并且不符合同一应用中 Chromium 的行为。

## 结果

Desktop HTTP 与 Relay WSS 共享操作系统路由决策，无需在产品产物中嵌入代理地址或凭据。Mobile 继续使用原生 WebView 网络栈。WSS adapter 在 CONNECT 后仍会校验 Platform 证书。

## 测试

单元覆盖会证明 Electron Fetch 转发、`DIRECT`、HTTP 与 HTTPS 代理选择、不支持指令拒绝，以及 WSS agent 注入。实际运行验收使用启用 macOS 系统代理的打包 Desktop 与生产 Platform origin。
