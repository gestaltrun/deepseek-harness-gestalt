# Agent Note: 悬挂的 agent 安装上限证明

Status: implemented

[English](2026-09-01-phone-hung-agent-install-ceiling.md) | 中文

## 问题

不带 `force` 的 `installAgent` 先跑一次性 `agent status` 子进程，再跑一次性 `agent install` 子进程，两者共用同一个 `agentTimeoutMs` 上限。若悬挂安装的证明把该上限压到接近负载主机的 spawn 成本，即使 fake 的 status 路径没有延迟，超时也可能落在 status 探测上，而不是安装子进程。

## 决策

`packages/phone/phone-runtime/tests/agent.spec.ts` 中的悬挂安装用例调用 `installAgent(id, { force: true })`，因此不跑 status 探测。2 秒的 `agentTimeoutMs` 只约束悬挂的 `agent install` 子进程。断言点名 `agent install`，因为这才是该用例要证明的子进程；生产仍对每个子进程使用同一个 `agentTimeoutMs`。

## 已考虑的替代方案

**保留先探测 status 的路径并抬高共享上限。** 拒绝：无延迟的 status 探测在 CI spawn 负载下仍会输掉 2 秒竞态，更大的共享上限会同时等待两个子进程，而不是隔离安装。

**匹配 `agent status` 或 `agent install`。** 拒绝：这会把 status 探测超时当成悬挂安装的证明。

**给 status 与 install 分开的产品上限。** 拒绝：生产已经用同一配置字段分别约束每个子进程；flake 是测试的探测，不是缺少产品截止时刻。

## 后果

悬挂安装证明不再覆盖先探测再安装的路径。相邻用例仍覆盖探测，本用例仍然点名安装子进程。
