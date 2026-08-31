# `@deepseek-ai/dsh-project-membership`

[English](README.md) | 中文

云端项目的成员 Service Definition:一个项目将规范化后的 git remote 作为已验证的唯一属性绑定,以三种权限角色 `owner|admin|member` 承载成员,并支持项目自定义功能标签。一个 remote 在同一环境中至多归属一个 Project(`PROJECT_REMOTE_TAKEN`),因此恢复不会任意选择 association。角色只治理这一协作层面;它不从 Git 平台权限派生,Git 权限也不从它派生。

邀请沿 `pending → accepted | declined | retracted` 流转。接受与链接唯一本地工作区原子提交,因此不存在"已加入但未链接"的中间态;对已持有成员身份或待决邀请的账户重复发出邀请,会在并发下也被原子拒绝并返回 `DUPLICATE_INVITEE`。每次变更的角色门都在操作内部执行:管理员可邀请但不能触碰 owner 行、不能移除 owner;只有 owner 能授予 owner 角色;最后一名 owner 不可降级或移除(`LAST_OWNER`)。功能标签是自由格式的展示与路由元数据——最多 8 个互不相同的标签、每个不超过 32 个可见字符——随每个 roster 视图携带且永不承载权限;编辑它们需要 admin 或 owner。

读取同样有门:`roster` 要求调用者持有有效成员身份,被移除账户即刻丧失枚举能力。每次改变 roster 视图结果的变更都会在落盘之后发布一条 `project-membership/roster-invalidated` 事件,携带前后两个投影版本;消费方以 `rosterVersion(projectId)` 作缓存键,根据事件重建而非信任旧视图。

## 服务面

`createProject(actor, {name, remoteUrl})`(创建者成为创始 owner)· `invite` · `retractInvitation`(发起人或 owner)· `acceptInvitation` · `declineInvitation`(仅收件人;收件人身份保持私密,其他账户只会看到 `INVITATION_NOT_FOUND`)· `changeRole` · `setMemberTags` · `removeMember` · `roster` · `pendingInvitationsFor` · `pendingInvitationsIssuedBy`(admin 或 owner)· `projectByRemote` · `rosterVersion`。

稳定错误码:`DUPLICATE_INVITEE`、`ROLE_REQUIRED`、`NOT_A_MEMBER`、`PROJECT_NOT_FOUND`、`MEMBERSHIP_NOT_FOUND`、`INVITATION_NOT_FOUND`、`INVITATION_NOT_PENDING`、`PROJECT_NAME_TAKEN`、`INVALID_PROJECT_NAME`、`INVALID_REMOTE_URL`、`INVALID_TAGS`、`LAST_OWNER`、`INVALID_LINK`。

`normalizeGitRemoteUrl` 将 `https://host/path[.git]` 与 scp 形式的 `user@host:path[.git]` 规范化为唯一绑定形态:scheme/host 小写,忽略大小写地去掉一个末尾 `.git` 后缀,修剪尾部斜杠,路径中段保持原样。只需要该纯操作的浏览器 bundle 会导入 `@deepseek-ai/dsh-project-membership/remote-url`;该 subpath 不携带 Service 或 registry identity。

## Model Experience

无:项目成员权威数据从不进入智能体会话与模型请求。

#### KV Cache effect

无。

## Known Limitations and Deferred Work

- 本包只定义词汇与门;不拥有存储。文件持久化的开发 Provider 位于 [`dsh-project-membership-core`](../project-membership-core/README.zh.md),运营部署需自行提供后端。
- 成员提问路由与在线推导消费本能力但不属于本能力;路由提问的生产激活仍受[放置决策 Agent Note](../../../.agents/notes/implemented/feature/2026-08-27-project-membership-core.zh.md) 所记录的现行加密评审门约束。
