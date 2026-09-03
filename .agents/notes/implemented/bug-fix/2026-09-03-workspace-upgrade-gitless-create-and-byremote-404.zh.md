# Agent Note: Workspace settings Git-less Cloud Project create and byRemote 404

Status: implemented

[English](2026-09-03-workspace-upgrade-gitless-create-and-byremote-404.md) | 中文

## Problem

Desktop 的 Workspace settings 无法完成 Cloud Project 创建。云项目名称字段没有可见输入框，Git remote 只在获得焦点时出现环，对话框使用了未定义的 `--ds-bg-input` / `--ds-border` token。设置弹窗是 `min(380px)` 且 `overflow: hidden`，升级区块却是 `min-width: 420px`，文案和名称字段被裁切。打开设置会调用 `projectByRemote`；生产 Platform 对缺失 membership 返回 HTTP 404，而客户端只把 204 当作未绑定。设置里的 `Promise.all` catch 随后清掉已成功读到的 Git origin，并显示 `ProjectMembershipClientError … HTTP_404`。没有 origin 的 Workspace 无法创建 Cloud Project。

## Decision

`projectByRemote` 把 HTTP 204 与生产环境的 HTTP 404 视为未绑定。其他非 OK 应答仍会拒绝。`pendingInvitations` 把 HTTP 204 与生产环境的 HTTP 404 视为空列表。Desktop 的官方 Node HTTPS helper 用 null Fetch body 重建 204/205/304，因此 heartbeat 与未绑定 `by-remote` 不会抛出 `Invalid response status code 204`。Workspace settings 独立加载当前 Account 的 Project 与本地 Git remote，因此未绑定的 404 不会清掉已成功读到的 origin。`createBlocked` 只看名称：Git remote 为可选项，有值时只读。

没有 origin、或其 origin 未通过 `normalizeGitRemoteUrl` 的 Workspace，通过 `localWorkspaceRemoteUrl(workspaceId)` 创建并恢复，即规范化的 Platform remote `local://workspace/<id>`。identity 保持大小写原样；空 id 以及包含 `/`、`?` 或 `#` 的 id 仍是 `INVALID_REMOTE_URL`。浏览器 bundle 从 `@deepseek-ai/dsh-project-membership/remote-url` 导入该构造函数。创建仍会在名册渲染前持久化 founder 的 Account／Project／Workspace binding。在同一 Workspace 上重开设置时，优先用 origin 恢复，否则用该哨兵。

设置对话框为 `min(480px, 100%)`，错误会换行。输入使用 `--dsw-alias-border-l2`、`--dsw-alias-bg-layer-1` 与 `--dsw-alias-brand-primary`。

## Supersession check

[项目成员权威 note](../feature/2026-08-27-project-membership-core.zh.md) 仍拥有唯一性、角色与 Platform 放置；本 note 把无 Git 哨兵纳入该唯一 remote 属性，并记录客户端的 404 映射。[邀请角色选择 note](../feature/2026-09-02-invitation-granted-role.zh.md) 仍拥有授予策略。两者均未被取代。

## Alternatives considered

**创建前必须有 Git origin。** 否决：无 Git 的 Workspace 是有效产品 checkout，生产验收也在该路径失败。有 origin 时仍用它作为恢复键。

**把生产 404 当作传输失败并在对话框展示。** 否决：生产 Platform 用 404 表示未绑定 membership；当作失败会阻断每个未绑定 Git checkout 的创建，并清掉已成功读到的 origin。

**继续用一次 `Promise.all` 同时加载 Project 与 Git remote。** 否决：单一 catch 把独立事实耦合在一起，未绑定 404 会清掉 origin。

**在唯一 remote 之外另设第二套 Project identity。** 否决：`PROJECT_REMOTE_TAKEN` 已经要求每个 Project 只有一个规范化 remote。哨兵扩展该唯一属性，而不是增加平行键。

## Consequences

无 Git 创建通过 `local://workspace/<id>` 绑定本地 Workspace，重开时无需 origin 即可恢复。生产环境未绑定的 404 不再阻断对话框或擦除 origin。可见的 `--dsw-alias` 输入样式与更宽对话框让名称和 remote 可读。Platform 仍把 remote 视为跨 Git origin 与哨兵的唯一属性；两个 Workspace 不能共用同一哨兵 identity。

## Testing

- `packages/platform/project-membership-client/tests/membership-client.client.spec.ts` 钉住生产 404 为未绑定，并把 pending 204/404 钉为空列表。
- `apps/desktop/tests/system-node-fetch-helper.spec.ts` 用无 Fetch body 重建 membership heartbeat 的 HTTP 204。
- `packages/platform/project-membership/tests/remote-url.spec.ts` 钉住 `local://workspace/<id>`，并拒绝空 identity 或嵌套 identity。
- `packages/client/ui-workspace/tests/apply.client.spec.ts` 钉住无 Git 创建与哨兵恢复。
- `packages/client/ui-workspace/tests/workspace-settings.client.spec.tsx` 钉住只看名称的 `createBlocked`、独立 remote 加载，以及可见的无 Git 创建。

## Related

- Issue #531
- [项目成员权威](../feature/2026-08-27-project-membership-core.zh.md)
