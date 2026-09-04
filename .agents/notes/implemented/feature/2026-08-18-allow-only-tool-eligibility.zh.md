# Agent Note：Allow-only 工具资格

Status: implemented

[English](2026-08-18-allow-only-tool-eligibility.md) | 中文

## 问题

agent preset 可以组合工具目录，但用户还需要 Workspace 与 Session 专属的添加项。既有 `ctx.tools.restrict()` 原语同时接受 allow 与 deny 筛选，服务于受信任的内部组合。把它直接投影到用户 settings 会产生两套策略词汇，使后续注册在 allow 与 deny 下表现不同，并违背产品的正向配置要求。

资格还必须在模型组装和执行间保持为同一个事实。只筛选请求 schema 会让过期或伪造调用仍可执行；只筛选分发则会向模型宣告它无法使用的工具。只持久化配置名称也不足以回放，因为动态注册决定某次请求当时存在哪些 schema。

## 决策

`dsh-tools` 按作用域持有正向资格贡献。preset 到 Agent 的作用域链上的贡献取并集。没有贡献时保留既有的不受限目录；已声明且并集为空的作用域链不允许任何末端工具。一旦启用，同一份解析视图会为 `schemas()`、`get()` 和 `execute()` 筛选继承与作用域本地定义。声明时不校验名称，因此 preset 或 setting 可以早于动态工具注册。内部 allow/deny `restrict()` 接口继续供受信插件使用，不进入用户配置。

`dsh-agent-tool-eligibility` 是 preset 配置行，只公开一个必填 `allow` 列表。`dsh-tools-eligibility` 注册 allow-only 的 `tool-eligibility` settings 分节，其中含 `workspaces` 与 `sessions` 两张映射。它为每个实时 Agent 持有一条可变条目，用于贡献匹配的 Workspace 与 Session 列表；这些条目由解析器 fiber 持有。每次刷新都会先提交所有受影响条目，再开始扇出，并为每个受影响 Agent 尝试关系 publication 与注册表变化通知。普通实时 Settings 更新会在完整扇出后传播一个 `AggregateError`。Settings provider 分离或 HMR 会提交 composition 回退值并尝试同样的完整扇出，但把聚合错误记录到日志，使 provider 卸载得以完成。因此观察者只能看到完整提交后的 Agent 集合，不会看到新旧条目并存或部分刷新的集合。解析器卸载和 Agent 销毁会移除对应条目。Workspace 匹配先找到规范路径等于 `session.header.cwd` 的 Workspace，再使用其稳定 id。

解析后的工具视图是唯一运行时权威。Agent loop 从中取得请求 schema，`session.toolEligibility` 也直接读取该视图。执行创建会在策略运行前拒绝已注册但已被资格排除的定义。分发会在前置策略之后、环绕分发包装层之前重新检查资格。任一种资格拒绝都是终止结果：环绕分发包装层、工具主体、post-execute 监听器与已捕获的定义 finalizer 都不会运行，但规范的 `UNKNOWN_TOOL` 结果仍会到达 `tools/result` 和循环持久化的 `tool/result`。未知或尚未加载的名称仍保留常规包装层路径。解析器的运行时接口只负责 settings 到注册表的生命周期，不发布独立的解析服务。解析器在每次 settings 贡献提交后发出非持久关系 publication，让 invariant companion 对比预期并集与实时注册表。持久 `request/header` 事件会记录每次组装请求的全部工具，因此仍可重建精确的模型可见 schema；不会用持久资格事件重复记录该结果。

PTC 模式 保留 `run_code` 作为呈现基础设施。正向资格筛选其 SDK 使用的末端工具定义；该传输不是一项可单独配置的能力。

## 验证

工具注册表测试覆盖作用域链并集、显式 allow-none、继承与作用域本地 schema 筛选、在环绕分发短路前拒绝、前置策略期间的终止式资格收窄、未知名称包装层兼容性、工具主体与 finalizer 未执行、规范结果通知和分阶段贡献通知。Agent-loop 覆盖还证明晚期拒绝会跳过 post-execute 并持久化规范的 `UNKNOWN_TOOL` 结果。解析器测试覆盖 preset、Workspace 与 Session 添加；publication 或注册表观察者失败时的双 Agent 批量可见性与完整通知扇出；解析器卸载/HMR；Agent 销毁；动态注册；以及用户配置中不存在 deny 字段。invariant 负控会拒绝与实时注册表不一致的 publication。API 测试覆盖 `session.toolEligibility` 对 `ctx.tools` 的直接投影。Web minimal-preset 无密钥回放把 preset allowance 设为空，通过 Loader composition 中真实的 Session settings namespace 添加 `bash`，在持久请求 header 中只记录该工具，执行它，并证明过期 `str_replace_editor` 调用在执行前失败。

## 曾考虑的替代方案

**把 `restrict()` 公开为 settings。** 否决，因为 deny 是内部组合机制，而已接受的用户配置只允许正向表达。

**把资格编译为每个 Agent 的内部 restriction。** 否决，因为内部 restriction 有意豁免 delegation 机制使用的作用域本地注册。资格必须判断每个模型可见的末端工具，包括直接注册在 Agent 自身作用域的定义。

**新增持久资格事件。** 否决，因为 `request/header.tools` 已记录精确的模型可见结果。settings 事件记录的只是输入，可能与请求时的动态目录不一致，并会形成第二个重建来源。

## 后果

preset 作者和用户只配置增量 allow 列表，而模型、Host API 与执行器共用同一目录。未声明资格的既有组合保持不受限。最终并集为空时会有意移除所有末端工具；拼错或当前不存在的名称不会授予任何内容，直到精确同名工具注册。settings 文档按稳定 id 组织条目，因此通用 settings 编辑器需要这些 id；未来更丰富的 Workspace 与 Session 交互仍可写入同一 namespace，无需改变策略模型。
