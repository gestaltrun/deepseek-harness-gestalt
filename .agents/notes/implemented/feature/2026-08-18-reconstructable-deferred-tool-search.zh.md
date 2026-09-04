# Agent Note：可重建的 deferred 工具搜索

Status: implemented

[English](2026-08-18-reconstructable-deferred-tool-search.md) | 中文

## 问题

大型动态工具目录会在模型知道自己需要哪项能力之前就消耗请求 token。省略 schema 可以降低成本，但仅存在于执行过程中的搜索结果会让下一次请求依赖临时注册表状态，并在 Session 恢复后失效。把搜索视为激活还会在 `dsh-tools` 解析的 allow-only 资格之外，制造第二份可见注册表状态。

## 决策

`ToolDefinition.deferLoading` 标记不会进入初始请求的已注册定义。随仓交付的 base bundle 启用 `dsh-tools.toolSearch`，由它贡献保留的 `tool_search` 基础设施 schema。搜索索引根据调用 Agent 当前解析后的视图重新构建，只包含合资格的 deferred 定义。其规范结果是精确匹配的 `ToolSchema[]`；它绝不会注册、启用或以其他方式激活工具。模型生成的搜索输入会在建立索引前验证：`query` 必须包含非空白文本，`limit` 必须是配置上限范围内的整数。参数 schema 在省略 `$schema` 时使用 draft-07，并接受显式 draft-07 或 MCP 的 JSON Schema 2020-12 dialect；不受支持的 dialect 标识与格式错误 schema 都会使发现失败。必填的部署设置 `maxResultBytes` 会限制包含渲染内容与 `loadedTools` 元数据的准确持久结果块。

agent loop 会把匹配 schema 存到持久 `tool-result` 块。每次提示词组装都会把这些恢复结果当作文件输入，并从 `Session.deriveMessages()` 读取。它会在检查 record 前拒绝 Proxy 候选项，只安全提取每个候选项自有、可枚举的字符串 `name`，丢弃不存在于当前合资格 deferred 视图的名称，并在不读取嵌套 schema 数据的情况下对其余原始候选项去重。进入规范序列化前，保留候选项必须是不含 accessor 的 lossless JSON；该检查会在不调用 trap 或 getter 的情况下拒绝嵌套 Proxy 与 accessor。随后，组装把原始合资格集合序列化为一个规范重建发现块，应用当前字节预算，再在投影前完整校验每个保留的 `ToolSchema`。无效或超限的当前 schema 会使组装失败，而不会抵达模型；格式错误、使用不支持 dialect 或体积巨大的过期项无法污染组装或消耗发现预算。因此下一次请求携带搜索实际返回的精确 schema；工具移除或更窄的 allow-only 贡献会阻止旧历史恢复或分发它。`request/header` 继续记录完整的已组装请求工具，使回放只有一份权威请求快照。

`schemas()` 表示初始模型请求，会省略 deferred 定义。`catalogSchemas()` 表示 Host 与检查接口使用的当前完整合资格末端工具目录。MCP 实例通过 `deferLoading` 按服务器选择加入；发现期间，其完整实时世代始终保持注册；如果 `toolSearch` 已禁用，客户端会在连接前拒绝该配置。PTC 模式会把嵌套 `tool_search` 子分发得到的 schema 带到外层 `run_code` 结果。同一个由 package 持有的预算函数会度量每次直接搜索、最终合并后的外层结果，以及重建出的合资格集合。聚合超限会在通知或记录日志前成为外层规范失败，并且不能保留部分 `loadedTools`。

发现元数据只描述最终提交给模型可见的成功结果。post-execute 或 around-execute 替换、阻止、错误，以及定义自有的内容替换，都会清除该执行的候选 `loadedTools`；策略结果不能保留来自更早主体结果、且其值或内容已被替换的 schema。

provider-neutral 适配器收到普通 `tool_search` 调用、其 JSON schema 结果和扩展后的下一次请求工具列表。pi-ai 桥还会把持久结果映射为 `addedToolNames`；支持原生工具搜索的 OpenAI Responses 模型会收到等价的 `tool_search_call` 与 `tool_search_output` 历史，其中 schema 带 `defer_loading`。两条路径都从同一份 provider-neutral Session 日志派生。

## 验证

注册表测试证明模型输入与恢复文件校验、draft-07 与 JSON Schema 2020-12 兼容性、直接结果／PTC 模式组合结果／重建结果上的配置数量与字节上限、初始省略、合资格目录保留、精确 schema 结果、最终结果元数据、持久的下一次请求与恢复重建、PTC 模式 binding 执行、不同模式下的提示词排序、保留名称冲突拒绝，以及 allow-only 资格变化后先过滤再计算恢复结果预算。MCP 生命周期测试证明按服务器延迟加载和发现配置错误会明确失败。pi-ai 测试证明 provider-neutral 元数据转换与原生 OpenAI Responses 请求载荷。无密钥 headless 快照把确定性回放与 MCP 覆盖应用到随仓交付的 headless profile，发现并调用官方 MCP 服务器的 deferred `echo` 工具，持久化规范 JSONL，释放 Loader 树，再重新加载同一 Session 并验证重建后的请求 header。一项负向组合检查会移除随仓交付的 `toolSearch` patch，并要求同一场景失败。

## 曾考虑的替代方案

**改变每个 Agent 的活动工具集合。** 否决，因为发现是返回给模型的证据，不是授权或注册状态变化。可变活动集合会重复资格，并要求一套新的持久状态机。

**搜索后从当前注册表重新计算匹配 schema。** 否决，因为搜索与续轮之间的 schema 变化会使请求不同于模型读到的结果。日志存储实际返回的 schema，只使用当前注册表重新检查持续资格。

**只持久化匹配名称。** 否决，因为名称无法重建精确的模型可见 schema，还会使恢复依赖 provider 的当前输出。

## 后果

部署可以让大型 MCP 世代保持注册且可执行，同时不承担完整的初始 schema 成本。搜索结果会把 schema JSON 加入历史并改变后续请求工具，因此发现仍有 token 成本。模型如果猜到一个已注册且合资格的名称，可以不经搜索直接调用它；这是有意行为，因为搜索不会激活工具。资格仍是发现与分发的唯一权威。

MiniSearch 提供维护良好的名称与描述排序检索，避免仓库自行维护搜索实现。Ajv 提供了解 JSON Schema draft 的生成与恢复 schema 校验，包括超出第一方作者 DSL 较窄范围的 MCP schema。可运行的 headless 示例会直接声明其执行的官方 MCP 服务器，因此 plain-Node 构建产物解析不依赖其他 workspace 包的开发依赖。
