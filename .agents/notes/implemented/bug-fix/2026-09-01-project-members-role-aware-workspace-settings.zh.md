# Agent Note: 根据当前成员身份派生 Workspace Settings 管理权限

Status: implemented

[English](2026-09-01-project-members-role-aware-workspace-settings.md) | 中文

## Problem

每位项目成员都可以读取名册，但已发邀请和名册变更要求 admin 或 owner。恢复后的 Project 投影若省略当前 Account id，Workspace Settings 就无法区分当前 Account 与其他名册行，因此普通 member 会发起仅邀请方可用的读取、收到 `ROLE_REQUIRED`，同时看到注定失败的操作控件。

## Decision

Workspace Project 投影保留 Project 创建或按 remote 恢复返回的已鉴权 `receivingAccountId`。读取权威名册后，Workspace Settings 定位该 Account 的成员记录并判断行为方是否为 admin 或 owner。Admin 和 owner 可读取邀请并使用名册变更控件；普通 member 读取同一份带 presence 的名册，但角色和职能标签以只读值显示。无法识别或缺失的行为方成员记录按只读方式失败关闭，也不会发起仅邀请方可用的请求。

Project Membership 服务仍然裁决每次读取和变更。客户端投影只移除不可能成功的入口和预期的鉴权失败，不放宽服务端角色检查。

Presence 文本通过模块内的视觉隐藏样式继续供辅助技术读取。该标签不得占用名册行的布局空间，也不得与成员身份重叠。

## Alternatives considered

- **捕获并隐藏已发邀请请求的 `ROLE_REQUIRED`**——拒绝，因为未经授权的请求仍会发生，变更控件也仍然展示不可能成功的操作。
- **把协作角色加入 Platform Account access 状态**——拒绝，因为角色属于单个 Project membership，且可能随 Project 不同；名册已经持有该事实。
- **允许普通 member 读取已发邀请**——拒绝，因为邀请管理有意仅限 admin 和 owner，并且可能暴露无关受邀人。

## Consequences

每位有效成员都能使用 Workspace Settings，而不会看到鉴权错误。Account 的管理控件与成员显示来自同一次名册读取，因此角色变更会在下一次权威重载时生效。聚焦 UI 覆盖验证普通 member 可看到两位名册身份，presence 标签不参与布局，同时不发起管理读取，也不渲染邀请、角色、标签或移除控件。
