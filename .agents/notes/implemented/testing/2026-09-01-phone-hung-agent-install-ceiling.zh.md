# Agent Note: 悬挂的 agent 安装上限证明

Status: implemented

[English](2026-09-01-phone-hung-agent-install-ceiling.md) | 中文

## 问题

不带 `force` 的 `installAgent` 先跑一次性 `agent status` 子进程，再跑一次性 `agent install` 子进程，两者共用同一个 `agentTimeoutMs` 上限。若悬挂安装的证明把该上限压到接近负载主机的 spawn 成本，即使 fake 的 status 路径没有延迟，超时也可能落在 status 探测上，而不是安装子进程。

## 决策

`packages/phone/phone-runtime/tests/agent.spec.ts` 中的悬挂安装用例保持无延迟的 status 探测，并使用仍然短于生产默认、但能覆盖负载主机 status spawn 的共享 `agentTimeoutMs`，同时让 fake 的安装子进程悬挂超过该上限。断言点名 `agent install`，因为这才是该用例要证明的子进程；生产仍对每个子进程使用同一个 `agentTimeoutMs`，而不是跨两次子进程共享一个截止时刻。

## 已考虑的替代方案

**用 `force: true` 跳过 status 探测。** 拒绝：生产安装路径在不带 `force` 时总是先探测，而 flake 正是负载下的这次探测。

**匹配 `agent status` 或 `agent install`。** 拒绝：这会把 status 探测超时当成悬挂安装的证明。

**给 status 与 install 分开的产品上限。** 拒绝：生产已经用同一配置字段分别约束每个子进程；flake 是测试余量，不是缺少产品截止时刻。

## 后果

该用例在负载 CI 上会比 2 秒上限等得更久，但仍然点名安装子进程。把 `agentTimeoutMs` 重新压到接近 spawn 成本，会再次出现 status 探测超时。
