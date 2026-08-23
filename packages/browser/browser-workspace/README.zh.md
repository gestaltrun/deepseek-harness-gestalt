# @deepseek-ai/dsh-browser-workspace

[English](README.md) | 中文

这是 Session 持有的 Browser Workspace binder。`ctx.browserWorkspace` 把 Browser Runtime 身份绑定到一条 Session 日志，使每个 Session 独立拥有零个或多个 Workspace、实例与标签页。

## 服务 API

`create`、`navigate`、`observe`、`screenshot`、`focus`、`input` 与 `close` 都要求提供所属 `Session`。`create` 同时是 `@Remote('create')`，因此 Client `remote.browserWorkspace.create` 可以新建 Session 持有的标签页。创建会串行执行；省略 attach 时，共享 Profile 或具名持久 Profile 会复用当前 Session 内已打开的匹配浏览器实例，临时 Profile 则保持独立。匹配期间，若当前 Runtime 对已记录 target 返回 `BROWSER_NOT_FOUND`，Binder 会先遗忘该 target 再继续创建；其他 observe 失败仍会拒绝 create。这样下一次 create 可以替换随 Runtime 进程重启而丢失的页面，而不会把持久所有权当作 live 页面。缺少 Session 所有权会以 `BROWSER_SESSION_MISMATCH` 拒绝。已被另一个 live Session 拥有的 target 会以 `BROWSER_TRANSFER_UNSUPPORTED` 拒绝。显式附加到另一 live Session 的 Workspace 或实例也会以 `BROWSER_TRANSFER_UNSUPPORTED` 拒绝，附加到本 Session 未知的层级则以 `BROWSER_SESSION_MISMATCH` 拒绝。锁是修订号；每条标签页记录保存最近一次提交的 Runtime 修订号。Binder 监听 `browser/runtime-state`，并为已持有且未关闭的标签页写入修订号前进，包括从未进入 Binder 动词的前进。对已关闭标签页的 `observe` 会遗忘该列表行。`snapshot` 与 `foldBrowserWorkspace` 返回最后记录的完整 Workspace；在首次变更前返回空 Workspace。`listBrowserWorkspacePages` 是 Client Consumer 展平层级的规范 helper。`cleanup` 会关闭遗留的 live Runtime 标签页、从 Session 快照中遗忘它们，并作为 `session/disposed` 返回的工作。

`browser/workspace` 是仅日志、后写覆盖的 `SessionEventMap` 成员。当组合挂载 `ctx.sessionProjections` 时，本包注册 `browserWorkspace` 投影单元。不支持跨 Session 页面转移。

## 模型体验

当调用 Agent Session 存在时，通过 dsh-tool-browser 间接影响模型。Binder 自身不增加模型 token。

#### KV 缓存影响

已记录的 Workspace 快照不进入派生模型历史。

## 已知限制与后续工作

- Dock chrome、宽度与折叠状态属于 Client 包。本包只持久化 Session 所有权、活动身份，以及每个标签页最近一次提交的修订号。
- 无密钥 Browser Runtime 快照只组合 Runtime 与 Consumer。Session 隔离由 Binder 持有，这些不含 Binder 的轨迹不宣称该隔离。
