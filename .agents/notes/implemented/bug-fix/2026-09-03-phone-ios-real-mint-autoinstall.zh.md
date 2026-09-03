# Agent Note: 在 Host mint 时安装 iOS 真机 agent

Status: implemented

[English](2026-09-03-phone-ios-real-mint-autoinstall.md) | 中文

## 问题

打开在线 iOS 真机面板时，第一条路径是铸造 `POST /phone/session`。`agentStatus.installed` 为 false 时，Host 直接返回 `409 PHONE_AGENT_MISSING`，并不调用 `installAgent`。GUI `PhoneConnectionController.recoverAgent` 只在该错误相之后运行，因此可恢复的缺失 agent 会挡住画面，即使同一台真机上 `device_act` 已经成功。

## 决策

Host mint 持有第一次可恢复安装。对清单中的 iOS 真机，`POST /phone/session` 先跑 `agentStatus`；agent 缺失时调用不带 `force` 的幂等 `installAgent`，复检 status，再签发画面会话。仅当这次安装后 agent 仍缺失时才保留 `PHONE_AGENT_MISSING`。抛出的安装失败沿用既有 Host 映射：`PHONE_AGENT_PROFILE_REQUIRED`（包括 Host 未配置 `provisioningProfilePath`）、`PHONE_REAL_DEVICE_ISSUE` 分支，以及经 `PHONE_UPSTREAM` 透出的 `INSTALL_FAILED_USER_RESTRICTED`。iOS Simulator mint 保持 agent-not-managed，永不安装。`recoverAgent` 仍是 GUI 处理残留缺失、强制重装与受限失败的路径。

## Alternatives considered

**只在 GUI 错误卡上安装。** 拒绝：打开面板总是先 mint，因此即使可恢复，用户看到的第一失败仍是 `PHONE_AGENT_MISSING`。

**mint 时总是 `force` 重装。** 拒绝：对已安装 agent，mint 必须幂等；强制重装是显式恢复动作。

**未配置 `provisioningProfilePath` 时跳过安装。** 拒绝：缺失 profile 是 `PHONE_AGENT_PROFILE_REQUIRED`，不是静默跳过。

**在 iOS Simulator mint 时安装。** 拒绝：模拟器 agent 操作保持 `agent-not-managed`；模拟器 agent 安装归准备流程。

## 后果

任何受信任的 mint 调用方（不限于 GUI）都能在可恢复的缺失 agent 上完成安装。不可恢复失败保持结构化，不会签发会话。打开真机面板可能在安装期间等待 `agentTimeoutMs`。包测试固定缺失 → 安装 → 200 会话、安装失败错误码、残留 `PHONE_AGENT_MISSING`，以及不变的模拟器 mint。
