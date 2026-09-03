# Agent Note: Workspace settings page and retracted invitation wizard

Status: implemented

[English](2026-09-03-workspace-settings-page-and-invite-retract.md) | 中文

## Problem

Workspace settings 以紧凑的 `min(480px)` 对话框上线，而验收产品是设置页：带名称的标题、路径、作为代码行的 Git remote，以及协作卡片。与此独立，邀请向导会继续出示已撤回的邀请。`pendingInvitations()` 仍返回该 id，确认仍 POST `decide`，409 `INVITATION_NOT_PENDING` 则以 `Error invoking remote method 'projectMembership:decide'` 呈现。关联候选项还可能显示 Host 的父目录标题（例如 `IdeaProjects`），而不是 checkout basename。

## Decision

设置对话框是无默认 chrome 的页面：`min(820px, calc(100vw - 64px))` × `min(760px, calc(100vh - 64px))`，带名称的标题、可选路径、代码行中的 Git remote、协作卡片。无 Git 创建仍只看名称；Project 与 origin 仍独立加载。Modal `className` 保持 `string`；缺少 `.settingsDialog` 时 owner 抛错。

向导不再提交或再次出示已离开 pending 池的邀请。`decide` 失败若带 `INVITATION_NOT_PENDING`、`INVITATION_NOT_FOUND` 或已撤回／非 pending 文案，则关闭向导、记录该 id，并在后续轮询中跳过。其他 decide 失败映射为短字典文案，不再保留 Electron IPC 前缀。关联候选项使用 checkout basename。

花名册在线状态是 16px、overflow hidden 的槽：绿点／离线点可见，`members.online` / `members.offline` 只放在 `.visuallyHidden` 与 `title` 提示里。不裁切时，两字标签会在槽内换行，竖排挤在 GitHub 登录名旁边。

## Supersession check

[无 Git 创建与 byRemote 404 note](2026-09-03-workspace-upgrade-gitless-create-and-byremote-404.zh.md) 仍拥有只看名称的创建、独立加载以及 404-as-unbound。本 note 只替换紧凑对话框外观与已撤回邀请的轮询。[邀请角色选择 note](../feature/2026-09-02-invitation-granted-role.zh.md) 仍拥有授予策略。

## Alternatives considered

**保留紧凑对话框，只加宽。** 否决：验收表面是带页头和卡片的页面，不是同一表单的更大卡片。

**原样复制 t7 页面，包括必须有 remote 的创建与 access gate。** 否决：无 Git 创建与独立 origin 加载已经上线；baseline 不传入 `access` / `openSignIn`。

**向导保持打开，只把 409 映射成短文案。** 否决：已撤回邀请不再 pending，向导必须关闭并丢掉该 id，而不是再提交一次。

## Consequences

重开设置是一页，且不要求 origin。已撤回邀请不能留在屏幕上，也不能被轮询再次打开。Host 的父目录标题不再出现在向导候选项中。

## Testing

- `packages/client/ui-workspace/tests/workspace-settings.client.spec.tsx` 钉住页面 chrome、无 Git 创建、映射后的 decide 文案，以及 409 后不再重开的已撤回 id。

## Related

- Issue #531
- [Workspace settings Git-less Cloud Project create and byRemote 404](2026-09-03-workspace-upgrade-gitless-create-and-byremote-404.zh.md)
