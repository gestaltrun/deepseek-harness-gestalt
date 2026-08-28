# @deepseek-ai/dsh-tool-project-members

[English](README.md) | 中文

面向模型的 `project_members` 工具，构建在 `ctx.projectMembership` 之上：一次读取即返回一个云项目的完整成员名册——每位成员的账号引用、公开展示身份、权限角色、项目定义的职能标签与在线状态——查询不受任何角色限制。

## 工具

`project_members` 接受一个可选参数：

- `projectId` — 要查询的云项目。省略时，工具向组合注入的工作区绑定解析当前工作区归属的项目；显式传入的 id 优先。

调用先解析会话绑定账号，再解析项目绑定，最后通过 `ctx.projectMembership.roster()` 读取存储的名册。规范结果为按加入顺序排列的成员数组 `[{ accountId, displayName?, avatarRef?, role, tags, presence }]`；要么返回全部存储成员，要么调用失败——不存在部分名册。

## 注入的提供方接口

本包只依赖成员关系 Service Definition——从不依赖平台包。组合注入三个可选的 Config 函数，平台提供方一侧将它们接到 Account Service Definition、工作区 remote 与在线状态注册表：

- `currentAccountResolver` — 解析当前会话绑定的账号。缺失、抛错或解析为 `undefined` 时，返回稳定的 `ACCOUNT_UNAVAILABLE` 错误。
- `boundProjectResolver` — 为省略 `projectId` 的调用解析工作区绑定的项目。无法解析时返回稳定的 `PROJECT_UNBOUND` 错误。
- `rosterPresenter` — 为一次读取附加在线状态与公开展示身份。缺失时，所有成员读作 `presence: "offline"` 且不带身份字段——与已组合但无任何活跃心跳的在线状态注册表给出的结论一致。

## 渲染

Native 渲染器保持规范值的紧凑 JSON 形态。本工具不声明自定义 UI presenter：名册是纯数据，通用卡片（标题 = 工具名，原始参数）就是预期的渲染意图。

## 角色

这是 project-membership 接缝读取面的 Consumer 包。它不持有任何权限判定：查询不受角色限制，而成员关系服务继续强制"读取账号须持有有效成员关系"。稳定错误的存在让模型可以分支处理——提示用户登录，或将工作区关联到项目——而不是徒劳重试。

## Model Experience

### Tool schema

#### What the model sees

模型看到生成的 [`project_members` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-project-members)：一个可选的 `projectId` 字符串与数组输出契约。

#### Token effect

在工具可见的每个请求上产生固定的 schema 开销。

#### KV Cache effect

在定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使基于该 schema 的复用失效。

### Tool-call history and result

#### What the model sees

调用参数很小——通常为空。成功时返回精确形态的紧凑 JSON `[{"accountId":"…","displayName":"…","avatarRef":"…","role":"owner|admin|member","tags":["…"],"presence":"online|offline"}]`；组合未解析身份时省略 `displayName` 与 `avatarRef`，`presence` 在同样条件下读作 `offline`。稳定失败逐字固定：`Error: PROJECT_UNBOUND: no cloud project is bound to this workspace; link the workspace to a project or pass projectId explicitly` 与 `Error: ACCOUNT_UNAVAILABLE: no account is bound to the current session; sign in before querying project members`。成员关系服务的拒绝（例如 `NOT_A_MEMBER`、`PROJECT_NOT_FOUND`）经同一错误通道透出，并携带其稳定代码。

#### Token effect

结果的增量随所查名册的成员数增长，这些 token 保留至压缩为止。schema 与参数小而形态固定。

#### KV Cache effect

只追加；新可见内容跟随可复用的请求前缀，不会使既有 KV-cache 条目失效。

## Known Limitations and Deferred Work

- **在线状态与展示身份依赖平台提供方一侧** — 未注入 `rosterPresenter` 的组合会将所有成员报告为 `offline` 且不带身份字段；装配完成的提供方接线随 project-members 工作的平台组合侧落地。
- **设计上只读** — 本工具不暴露任何成员关系变更；邀请、角色调整与标签编辑留在 project-membership HTTP 面之后，不进入模型工具集。
- **工作区绑定由组合定义** — 工具自身无法解析绑定的项目；未注入 `boundProjectResolver` 时，所有省略 `projectId` 的调用都返回 `PROJECT_UNBOUND`。
