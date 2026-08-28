# Agent Note：使用捆绑的官方 Node 运行时承载 Desktop Relay WSS

Status: implemented

[English](2026-08-28-system-node-desktop-relay-carrier.md) | 中文

## 问题

在捆绑的官方 Node 运行时中，实际运行的 Relay WSS endpoint 可以通过当前系统 HTTP CONNECT 代理完成连接；但 Electron 41 与 44 会在同一 TLS 连接进入 WebSocket 协商之前将其重置。代理解析、显式 SNI、HTTP/1.1 ALPN、TLS 1.2、直连和 Electron 升级都无法消除这个与进程相关的故障。因此，如果继续让 WSS 留在 Electron 内，即使 Desktop 已发布 Mobile 设备在线，已认证 Mobile 设备仍会显示离线。

## 决策

Electron 继续拥有 Platform Account、Personal Pairing、Snow 密钥与 codec、Companion operation、生命周期和原生系统代理解析。针对每个已解析候选，Electron 使用 Web Host 已捆绑的同一官方 Node 可执行文件 fork 一个捆绑的 CommonJS helper，再通过 advanced-serialization IPC 只发送不含凭据的 Relay WSS URL、可选的不含凭据的 HTTP(S) 代理 URL，以及加密 Relay frame 字节。缺少代理 URL 表示 `DIRECT`。helper 只拥有一个 `ws` 连接，并且只返回二进制 frame 以及不含内容的生命周期或失败元数据。

helper 只继承证书和临时目录环境字段。IPC 两个方向都校验消息 tag 与 Relay wire 字节上限。Electron 保留有界入站队列与 allowlist 候选回退策略。建连取消会终止并等待子进程退出；正常关闭 socket 时先请求关闭 WebSocket，一秒后升级为强制终止，并在 Relay teardown 完成前等待子进程退出。打包应用将自包含 CommonJS helper 作为 extra resource 安装，因为 `ws` 依赖仍使用 CommonJS 运行时导入，且 helper 不应依赖打包应用的模块图。

## 曾考虑的替代方案

- **关闭 TLS 校验或扩大受信证书范围**：否决。该故障发生在证书策略能够安全解释它之前，而且削弱 Relay 身份验证不是可接受的传输绕行方案。
- **绕过系统代理**：否决。在这个环境中，Electron 和 Node 直连都无法访问实际运行的 endpoint，而已配置代理是明确的 host 策略。
- **只升级 Electron**：否决。Electron 44 会复现相同重置。
- **把 Snow 或 Companion 协议权威移入 helper**：否决。这会把配对凭据和应用状态暴露给另一个进程，并重复既有 Desktop 生命周期 owner。helper 仍然只是字节载体。

## 后果

Desktop 的每个 Relay 传输候选会增加一个短生命周期子进程。该进程边界避开 Electron 中失败的 TLS 运行时，同时保留 Electron 的原生代理顺序与所有已认证协议权威。测试覆盖经过本地 HTTP CONNECT 代理的真实 WSS 二进制交换、有界 IPC、等待 teardown 完成、运行时路径选择、代理候选投影、bundle 自包含和打包资源位置。失败只暴露稳定的 stage、name 和 code 元数据；endpoint、proxy、frame 和 credential 内容永远不会进入诊断信息。
