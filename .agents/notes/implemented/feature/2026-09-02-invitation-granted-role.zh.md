# Agent Note: 邀请向导授予所选项目角色

Status: implemented

[English](2026-09-02-invitation-granted-role.md) | 中文

## 问题

T1 的成员操作已经区分 owner、admin 与 member，但 T6 的邀请接受后一律加入为 `member`。owner 若需要同事代为邀请，只能在接受后再提升；admin 若在传输层伪造更高角色，也没有执行器拒绝。待确认邀请卡还不展示被邀方将获得的角色，因此关闭关联步骤无法证明仍待确认的邀请保留了该选择。

## 决策

邀请本身就是授予：`InviteInput.grantedRole` 必填，存于邀请行，出现在待确认与已签发 presentation 上，并在原子接受并关联工作区时原样写入成员行。owner 可授予 `admin` 或 `member`；admin 只能授予 `member`；member 不能邀请。加入时永不授予 owner——提升仍是对已有成员执行后续 `changeRole`。该门由成员操作拥有；HTTP、Desktop IPC 与设置选择器只呈现或解析请求的角色。关闭关联步骤仍不做决定，因此待确认邀请保持同一 `grantedRole`。持久文档在 `formatVersion 1` 下记录该字段；缺失或为 `owner` 的 `grantedRole` 是损坏，而不是默认值。

可授予角色辅助函数位于 `@deepseek-ai/dsh-project-membership/invite-role`，让设置选择器与执行器共用同一策略。选择器只提供当前操作者名册行可授予的角色，从不发明隐藏的更高选项。

## 备选方案

**一律加入为 `member`，再提升。** 否决，因为接受与提升之间被邀方会显示为 member，中断的提升会把错误角色落盘。工单要求所选角色在接受时就成为成员角色。

**让被邀方在关联步骤选择角色。** 否决，因为授予权属于邀请人。被邀方自选 `admin` 会绕过邀请人的权限。

**把省略的 `grantedRole` 默认成 `member`。** 否决，因为新文档缺少该字段与忘记选择无法区分。传输与持久文档都要求该字段，执行器拒绝操作者不能授予的任何角色。

## 后果

伪造的 `owner` 或 admin 签发的 `admin` 邀请在 `invite` 内部以 `ROLE_REQUIRED` 失败，且永不落盘。被邀方在选择工作区前就能看到授予角色，关闭该步骤后邀请仍待确认且角色不变。既有 `formatVersion 0` 文档会装载失败，而不是静默加入为 `member`；本能力尚无生产语料，因此这次版本提升沿用存储面对结构变更的响亮失败。
