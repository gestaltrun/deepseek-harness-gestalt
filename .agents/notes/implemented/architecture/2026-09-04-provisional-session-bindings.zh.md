# Agent Note: Controller 持有的临时 Session binding

Status: implemented

[English](2026-09-04-provisional-session-bindings.md) | 中文

## 问题

显式 Session 挂载必须在 Host Session 存在之前渲染调用方提供的身份，并在 Host 发布后保持同一身份，同时不改变外壳选中项。上游 `ClientSessions.binding(id)` 只解析已列出或当前选中的 id，`followCurrent()` 又把历史打开耦合到 `list.current`。临时的 client-runtime 实现把暂存、发布、冷打开与功能准入路由放在一起，因此 renderer 或产品插件否则会再造一份 Session list 投影。

## 决策

`@deepseek-ai/dsh-api-session-controller` 在 `ctx.sessions` 上拥有 Client 临时身份生命周期。`binding(id)` 保持渲染安全的查找：它可为合格 id 铸造本地 scope，但绝不会打开 Host 历史或刷新 catalog。`stageProvisional()` 用一条调用方提供的空白 subagent 行扩展 controller 持有的 list 资格，铸造普通 `SessionBinding`，且不改变 `list.current`。对仍在暂存或已列出的同一身份重复暂存会失败并报错；没有共享的第二持有者。Host list 刷新会保留未发布的临时行；当 Host baseline 已列出该 id 时，会原地发布并保持同一 binding。`openForRender(id)` 是显式渲染的 Host I/O：身份仍为临时时跳过历史请求；Host 发布后则打开该 Session 的历史并刷新其 subagent catalog，同样不选中它。SessionManager 销毁会先标记自身、中止每个 catalog AbortController、忽略迟到的 catalog 与 list 写入、不启动 trailing catalog 刷新、等待这些 catalog promise，然后在不通知的情况下重建 list snapshot。SessionManager 销毁后 `refreshList()`、`handleConnected()`、catalog 刷新、list mutation 以及 control/queue/projection sink 均为 no-op。ClientSessions root 销毁后，命令方法（`open`、`openSubagent`、`clear`、`search`、`create`、`fork`、`refresh`、`refreshSubagents`、`setSubagentCatalogOpen`、`stageProvisional`、`resolveAgentScope`）在 Host I/O 或 mutation 之前抛出 `sessions.<op>: ClientSessions is disposed`。`binding()`/`scope()`/`sessionOf()` 不会再铸造，`openForRender()` 为 no-op，竞态中的临时 disposer 无操作。调度到 microtask 的 catalog 刷新会在 `subagents.list` 之前再次核对 inflight 身份。`refreshSubagents` 传入 controller signal，且只在同一 inflight 身份仍有效时写入。选中路径的 catalog 成员更新保持不变。未知身份是 no-op，与先前显式渲染打开一致。发布会删除临时标记，并复用同一 manager Session、scope 与 binding。返回的 disposer 会恰好一次移除未发布行及其 Agent scope，包括首次成功 Host list baseline 之前，并在发布或先前释放后变为 no-op。临时身份的 list mutation 与普通 upsert 分开标记。进行中的 list 拉取里，这些带标记的 upsert 与 remove 不会替换或删除随后由 Host 发布的同一 id 行；普通 create upsert 仍会回放。Host 字段仍是发布结果。

拓宽公开 `ISessions` 还会更新 test-support 的 `TestSessions` double 和一个 `satisfies ISessions` 的 UI conversation fake，以保持 compiler face 闭合。`TestSessions.stageProvisional()` 铸造普通 fixture binding 与 scope；conversation fake 只 stub 新方法。生产 Host 发布仍由 ClientSessions 拥有。

renderer 只消费 `UiSession.adapter.resolve(sessionId)`。功能自有的准入、model、command 与 skill 路由仍在此生命周期之外。[显式 Session slot 挂载](2026-08-23-explicit-session-slot-mounts.zh.md) 拥有挂载树；[Client Session 所有权](2026-08-20-client-session-conversation-ownership.zh.md) 拥有普通 binding 与 scope fiber。

## 考虑过的替代方案

**把暂存留在 `dsh-client-runtime`。** 拒绝，因为 Client Session list、scope 与 binding 已在 Session Controller 中；第二套 store 会重造发布与 prune 竞态。

**渲染前选中显式 Session。** 拒绝，因为次级挂载不得替换外壳选中的 Session、工作区或 workbench 状态。

**为重复暂存共享一个静默持有者。** 拒绝，因为两个功能暂存同一身份会隐藏冲突；失败并报错才能标出冲突 id。

**为临时身份打开 Host 历史。** 拒绝，因为发布前不存在 Host Session 或日志；历史请求会失败，或造出 disposer 无法持有的空持久窗口。

## 后果

Side Chat 与其他显式挂载可以暂存预分配 id、解析普通 Session-scoped source，并在 Host 发布后保持该 binding，而无需第二套 Session store。准入适配器、首条 prompt 的 Host 创建以及 renderer slot 挂载仍留在各自所属的 package。插件卸载仍会随其余 Client Sessions 服务一起丢弃残留的临时 scope。

## 验证

聚焦的 ClientSessions 测试固定不改变选中项的暂存、`binding()` 不发起 Host I/O、跳过 Host 历史、list 刷新存续、Host list 发布身份、进行中刷新竞态（含过期临时 upsert 或 remove 对发布 baseline）、pending 阶段释放、未知 `openForRender()` no-op、发布时身份稳定、恰好一次释放与发布后 no-op、重复暂存失败、已发布冷 `openForRender()`、HMR/插件卸载，以及挂起的 catalog RPC 在 dispose 时无需 Host 响应即可中止。test-support 的 `TestSessions` double 会暂存可解析 binding，并在发布后把后续 disposer 视为 no-op。
