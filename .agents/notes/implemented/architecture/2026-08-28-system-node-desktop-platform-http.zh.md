# Agent Note：使用有界单请求 Node worker 承载 Desktop Platform HTTPS

Status: implemented

[English](2026-08-28-system-node-desktop-platform-http.md) | 中文

## 问题

把 Relay WSS 移到捆绑的官方 Node 运行时后，加密 Mobile 传输得到恢复，但 Desktop 的全新 GitHub 登录仍然失败：Electron 的 `net.fetch` 会关闭经同一原生系统代理连接的实际运行 Platform TLS。该故障还覆盖当前 Installation 刷新、Personal Pairing HTTP 和加密附件 consume。与此同时，官方 Node 24 通过该代理完成 TLS 校验并收到 HTTP 200。

## 决策

Electron 继续拥有系统代理解析、Platform Account 与签名密钥、Personal Pairing、Snow、Session operation、附件授权和生命周期。每个实际运行的 Platform HTTPS 请求都会使用捆绑的官方 Node 可执行文件 fork 一个自包含 CommonJS worker。IPC 只提供该次请求的不含凭据 HTTPS URL、`GET`/`POST`/`DELETE` method、有界 header 与 body、一个不含凭据的代理候选或 `DIRECT`，以及 response 上限。worker 关闭压缩协商、不跟随 redirect、返回有界的 status/header/body response，然后退出。Electron 在请求结束前取消并等待 worker 退出，并且只按原生代理顺序重试 allowlist connection failure。

请求授权 header 必须为该次请求跨越这个进程边界。它们绝不进入 argv 或环境变量、绝不写入日志，并随已等待退出的 worker 一起消失。长期账号记录、签名密钥、配对密钥、Snow 状态、Session 数据与附件密钥仍留在 Electron。IPC 两个方向都校验消息 tag 与字节上限；worker 只继承证书与临时目录环境字段。

## 曾考虑的替代方案

- **保留 Electron `net.fetch` 并重试**：否决。连续的全新登录请求都在 HTTP 之前失败，而官方 Node 同时成功。
- **绕过系统代理**：否决。实际运行的 host 策略要求该代理，且直连不可用。
- **把 Account、配对或附件权威移入持久服务**：否决。这会重复生命周期所有权，并跨请求保留 credential。
- **关闭 TLS 校验或跟随 redirect**：否决。任一做法都可能泄露授权信息或削弱 Platform 身份。

## 后果

Desktop 的每个 Platform HTTP 候选会增加一个短生命周期子进程。本地回归覆盖通过真实 TLS endpoint 与 HTTP CONNECT 代理发送带授权信息的 JSON、校验 response，并证明不支持的 scheme、method、body 与 redirect 会在代理解析前失败。实际运行证据证明改动后完成全新 GitHub 登录，并恢复两台同时在线的手机配对。附件字节传输仍是独立产品验收动作，不能从 HTTP 传输覆盖推断得到。
