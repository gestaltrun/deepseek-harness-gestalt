# Agent Note: Platform 公网就绪检查先于切换提交

Status: implemented

[English](2026-08-24-platform-public-readiness.md) | 中文

## 问题

Platform 部署只通过 ECS loopback 路由检查每个 candidate 与 replacement。因此，即使生产 DNS、TLS、ALB listener 或后端组让产品 origin 无法访问，workflow 仍可能报告成功。

## 决策

两台滚动 replacement 都通过 loopback 就绪检查后，workflow 会从 GitHub runner 请求生产 HTTPS `/readyz`，并核对所选 attachment storage 与两个预期的非敏感 instance id。该检查执行时，error trap 与已停止的 predecessor container 仍然存在。有界重试耗尽会触发现有的全主机回滚。

## 考虑过的替代方案

**删除 rollback container 后再检查公网路由。** 否决，因为外部路由故障会在可恢复的 replacement 窗口结束后才被发现。

**把 ECS loopback 就绪视为部署成功。** 否决，因为 Mobile、Desktop、OAuth 与 Relay client 使用公网 origin，而不是主机 loopback。

**只检查 ALB TCP 端口。** 否决，因为 listener 端口开放不能证明证书、HTTP 路由、后端健康或当前 attachment-storage phase。

## 后果

无法访问、粘性、只注册部分实例或路由错误的产品 origin 现在会在 predecessor 被删除前让部署失败。部署检查保持有界，也不会自动修改 ALB 或 DNS 配置。

## 测试

Workflow contract 测试要求公网就绪检查使用生产 origin、观察两个预期实例，并在 rollback 清理前执行。可执行 shell 测试会让公网路由失败、返回错误 storage 或只暴露一个 backend，并验证两个 predecessor host 均被恢复；成功场景会观察到两个实例，不会 rollback，并能进入 cleanup。实际运营部署会针对真实 HTTPS origin 提供运行时证明。
