# Agent Note: Platform Readiness 使用产品 HTTPS 客户端族

Status: implemented

[English](2026-08-25-platform-readiness-node-client.md) | 中文

## 问题

生产 ALB 包含 WAF。其公网路由接受产品所用的 JavaScript 与 OpenSSL TLS 客户端，却会重置通用命令行 HTTP 客户端的 TLS 连接。两台 replacement instance 都健康，deploy gate 仍把这个客户端特定 reset 判成产品 origin 不可用并执行回滚。

## 决定

deploy job 固定使用 Node 24，并通过其原生 Fetch 实现请求公网 `/readyz`。重定向会被视为错误，因此必须由原始生产 HTTPS 路由直接响应。现有门禁仍要求响应成功、attachment storage 与所选值一致，并在移除 rollback container 前观察到两个预期的非敏感 instance id。

## 考虑过的替代方案

**从 ALB 移除 WAF。** 拒绝，因为 release probe 不应削弱生产入口的安全配置。

**loopback 成功后忽略公网 readiness。** 拒绝，因为 DNS、证书、listener 与 backend group 故障仍是发布阻塞。

**只接受一个 backend 响应。** 拒绝，因为实际运行的服务必须证明两个非粘性 instance 都能经公网 origin 到达。

## 影响

发布门禁使用与已发布 JavaScript 应用相同的 TLS 客户端族，同时保留外部路由和双实例断言。deploy job 会显式提供 Node，不依赖 runner image 的隐式环境。

## 测试

可执行 shell harness 会替换 Node request，并覆盖不可达、重定向、storage 错误、只有一个 backend 和两个 backend 成功响应。本地 HTTP server 会执行真实 helper，并覆盖成功、HTTP 失败、重定向、超时与连接拒绝。workflow contract 要求 deploy 使用 Node 24。精确 request helper 也会访问实际运行的 HTTPS health route；同时通用命令行客户端可复现 WAF reset。
