# Agent Note: 关闭最后一个 Desktop 窗口会立即发布 Offline

Status: implemented

[English](2026-09-02-member-presence-last-window-offline.md) | 中文

## Problem

Presence 已经表示实时 Installation 连接，见[项目成员权威 Agent Note](2026-08-27-project-membership-core.zh.md)。[心跳 presence Agent Note](2026-08-28-member-presence-heartbeats.zh.md) 中的心跳注册表会让成员在最后一次心跳的 TTL 过期前保持 Online，因此关闭最后一个 Desktop 窗口会让队友等待宽限期，路由提问仍可能看到 Online。

## Decision

最后窗口关闭是同一心跳条目的显式 presence close。Desktop 在销毁窗口前用当前 Installation 证明 POST `/v1/projects/presence/close`；注册表立即清除该安装，之后任一其他在线 Installation 的花名册读取都会显示 Offline。重新打开窗口通过既有心跳推导恢复 Online。TTL 过期仍是崩溃与分区路径。关闭后的路由提问以 `MEMBER_OFFLINE` 快速失败，且不写入任何队列。

## Alternatives considered

**继续把 Offline 放在最后一次心跳的 TTL 过期。** 拒绝：产品约定是实时连接而非宽限期，队友不应等待已离开的同事。

**从 Relay 套接字拆除推导最后窗口 Offline。** 拒绝：成员 presence 独立于 Mobile Access，没有 Relay 的 Desktop 仍有最后一个窗口。

**把提问排队直到成员返回。** 拒绝：成员权威已禁止离线队列；数小时后的过期回答比稳定的快速失败更糟。

## Consequences

没有 close POST 的崩溃与休眠仍等待 TTL；当 Installation 无法发言时，这仍是诚实答案。无密钥装配覆盖从窗口关闭而非时钟推进断言 Offline 转换，并钉住 `MEMBER_OFFLINE` 的无队列提问。
