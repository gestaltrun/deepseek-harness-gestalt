# Agent Note: Remove the local Companion product substitute

Status: implemented

[English](2026-08-23-remove-local-companion-product-substitute.md) | 中文

## Problem

在实际运行的 Platform 链路建立前，Mobile 与 Desktop 曾可选择一套长期运行的本地 Companion composition，让模拟器执行 Account 恢复、Personal Pairing、Relay 与呈现。该 composition 同时使用固定公共身份、内存 Account 与配对 store、捆绑测试证书、固定 Relay attachment id、一字节同步帧和进程内 Companion authority。它的产品 selector 容易让本地成功运行被误述为实际运行产品的证据。

该 composition 还拥有有用的待完成登录恢复行为。如果只删除本地 server 而不分离这项恢复，系统浏览器返回重新创建的 WebView 后，Mobile authorization attempt 会丢失。

## Decision

打包后的 Desktop 与 Mobile 入口只选择实际运行的生产身份、真实 Platform Account 与 Personal Pairing client、credential 绑定 Relay，以及 Snow 加密 Companion channel。`examples/local-companion-platform`、development Companion channel、固定开发 attachment id、一字节同步帧、page-origin 改写、捆绑 Companion 证书和 development 产品 flag 都不存在。5173、5174 端口与 `prototype-companion` 不能作为产品验收 origin。

`PlatformAccountInstallation.load()` 仍会把有效的已持久化 authorization attempt 恢复为 polling，并清除已过期 attempt。打包 Mobile 的 authorization 会从准备完成的授权按钮调用 Capacitor 系统浏览器 adapter。这项恢复属于 Account client，不需要本地 Platform、假身份、自定义 URL token 或产品 development mode。

Keyless test 可以通过测试专用 composition input 注入内存 transport、确定性 handshake fixture 或 authenticated projection fixture。`main.tsx`、Desktop 生产配置与 release build 都无法选择这些 fixture。`verify-companion-product-entry` 与 Mobile 产品纯度测试会拒绝产品入口文件中的 development 产品 selector、仅供证明的 Companion example、禁用的 prototype 端口、固定 attachment id、一字节同步帧和明文 Relay authority。

## Alternatives considered

**用 development flag 保留本地 composition。**不采用，因为产品入口与 release bundle 仍会保留另一套身份、信任根、协议判别器和 authority implementation。flag 无法阻止该链路被误作实际运行验收，也无法防止它偏离发布协议。

**仅为待完成登录恢复保留本地 server。**不采用，因为 authorization 恢复是持久 Account-client state。把它耦合到内存 server 与测试证书会保留无关的产品替代实现，并让浏览器返回行为依赖 development deployment。

**保留单命令本地端到端产品排练。**不采用，因为它放弃了确切的实际运行身份、持久 store、credential authority 与网络拓扑。component test 与协议 fixture 继续提供快速本地证据；产品排练使用真实 Platform 与原生 package。

## Verification

产品入口 verifier 会扫描每个 Desktop 与 Mobile 入口依赖闭包，而不是只检查一个指定文件。Mobile test 会证明有效 pending attempt 可以恢复、过期 attempt 会清除、系统浏览器 adapter 由用户激活打开，且产品 composition 不含 development selector。仓库内确切的 Snow JS/WASM 包会在 Node 22 与 24、iOS Simulator WKWebView 和 Android Emulator WebView 上运行。实际运行验收会让打包 Mobile 经生产 Platform 与打包 Desktop 配对；本地 Vite 与注入式 snapshot 不满足这项证据。

## Consequences

开发者失去了原有的单命令环回产品替代实现及其离线假 Account 身份。本地测试仍通过显式 fixture 覆盖恢复、协议、呈现与失败行为，而发布证据必须使用与发布应用相同的身份、store、authorization、Relay 和加密 channel。

未来的本地场景只能作为无法进入任一产品依赖闭包的隔离 test 或 example，不能复用生产身份，不能增加固定 attachment id 或同步哨兵，也不能计入 release 验收。重新引入可选择的本地产品 mode 时，必须用新决策解释为什么实际运行的 staging 无法提供所需证据。
