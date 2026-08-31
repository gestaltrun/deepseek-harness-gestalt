# @deepseek-ai/dsh-tool-ask-user

[English](README.md) | 中文

模型侧 `ask_user_question` 工具，基于 `ctx.userQuestions` 实现。当模型需要确认、选择结果或缺失的信息才能继续时，它可以借此向用户提出简明问题。

## 工具

`ask_user_question` 接受以下参数：

- `questions`：必填的非空问题对象数组。
- `id`：每个问题必填的稳定 id，会原样包含在回答中。
- `question`：每个问题必填的问题文本。
- `header`：可选的简短标题。
- `options`：可选选项，包含 `label` 和 `description`。如需推荐某个选项，请将其置于首位，并在该标签末尾追加 `(Recommended)`。
- `multi_select`：该问题是否可以返回多个选中的选项。
- `to_project_member`：可选的单收件人。存在时，调用经 `ctx.memberQuestionSender` 路由，不会进入本地 user-questions 提供方。运行期资格过滤会在组装后的提示中隐藏该参数，除非 `boundProjectResolver` 返回云端项目 id；静态注册表 schema 仍保留它。
- `background`：agent 撰写的决策简报文本。与 `to_project_member` 一起时必填；1 到 600 个 Unicode 码点，构建期以 `BACKGROUND_REQUIRED` 或 `BACKGROUND_TOO_LONG` 拒绝。
- `references`：可选的 `{ path, reason? }[]`，本地与路由提问均可使用。每个 `path` 必须解析为提问会话工作区内的现存文件；每个 `reason` 至多 100 个码点。路由提问会在同一工作区围栏内读取每个已校验文件，在校验与读取之间文件身份变化时拒绝，并把字节与对应 reference 一同传递。失败会抛出 `REFERENCES_INVALID` 并指出具体项。本地提问接受 references 且不改变路由；将 details 面板聚焦到被引用文件被推迟。

没有 `to_project_member` 时，工具调用 `ctx.userQuestions.ask()`，并返回规范的 `{ answers: [{ id, selected, custom? }] }`。`selected` 包含选项标签；`custom` 携带自由填写的回答，对于多选题会补充 `selected`，对于单选题则会覆盖它。Native 渲染器会保留紧凑的 JSON 文本形式 `{ "answers": [{ "id": "...", "selected": ["..."], "custom": "..." }] }`。无法到达已组合发送器的路由提问会以 `SENDER_UNAVAILABLE` 失败。发送器生命周期失败（`MEMBER_OFFLINE`、`QUESTION_EXPIRED`、`QUESTION_WITHDRAWN`、`QUESTION_SUPERSEDED`、`REVOKED_DURING_FLIGHT`）仍作为普通工具结果保留。

## 职责

此包是用户交互 seam 与成员提问发送器 seam 的 Consumer 包。它不渲染 UI，也不了解输入的收集方式；本地提问将模型参数转换为 `AskUserQuestionRequest`，路由提问则把已校验的 payload 转发给 `ctx.memberQuestionSender.send()`。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型会看到生成的 [`ask_user_question` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-ask-user)，其中包含问题 id、提示语、标题、选项、多选标志、`background` 和 `references`。仅当提问工作区绑定到云端项目时，才会出现 `to_project_member`。

#### Token 影响

工具可见时，每个请求都会产生常态 schema token 开销：`background` 与 `references` 保留在组装后的 schema 中。`to_project_member` 仅在 `boundProjectResolver` 返回云端项目 id 时额外增加 schema 开销；非绑定组装会省略该属性，从而保持原先的 schema 宽度。

#### KV Cache 影响

只要定义以及 `to_project_member` 的绑定项目可见性保持不变，前缀即可稳定复用。绑定或解除绑定工作区、插件生命周期变化或作用域限制会改变组装后的 schema，并使从此前缀起的缓存复用失效。

### 工具调用历史与结果

#### 模型看到的内容

模型提出的完整问题保留在 assistant 工具调用参数中。路由提问还会在那里保留 `to_project_member`、`background` 和 `references`。用户或成员回答后，下一步会看到精确采用 `{"answers":[{"id":"<id>","selected":["<label>"],"custom":"<text>"}]}` 形式的紧凑 JSON；不使用 `custom` 时会省略该字段，`selected` 可以包含零个、一个或多个标签。发送器生命周期失败作为普通工具结果文本返回。调用等待期间的 UI 交互不属于模型上下文。

#### Token 影响

参数、`background`、`references`、回答 JSON 以及生命周期错误文本是依数据而定的保留 token；等待用户或成员时不会产生 token 开销。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## Known Limitations and Deferred Work

- **待处理问题会阻塞工具调用，直至用户作答**：该工具未声明 `timeout-policy` 预算；取消仅沿用当前轮次的 `exec.signal`。
- **运行时中归属于其他 agent 的 subagent 不能向用户提问**：`ask_user_question` 会以 `DELEGATED_CALLER` 拒绝归属于另一个 agent 的存活子级；该子级必须在最终结果中包含尚未解决的问题或决策。持久谱系不能决定这一边界，因此带有谱系的会话恢复为运行时根后可以正常提问。
- **Native 回答渲染为 JSON 文本**：规范值仍为结构化数据，但模型侧结果使用紧凑 JSON，而非更丰富的内容块词汇。
- **`to_project_member` 保留在静态 schema 中**：提示组装会从组装后的工具列表中为非绑定工作区省略该参数；`ctx.tools.schemas()` 与生成的目录仍记录静态参数。
- **本地参考材料聚焦被推迟**：本地提问会接受并校验 `references`，但将 details 面板打开到被引用文件由后续工单落地。
- **路由投递依赖 T4 注册表传输缺环**：编码与发送器接口已经存在；在收件人安装上打开密封对等授权，以及跨机携带该授权，仍是 [Remote Access 已知限制](../../platform/remote-access/README.zh.md#known-limitations-and-deferred-work)。在该传输落地之前，没有投递适配器的组合以 `SENDER_UNAVAILABLE` 或 `DELIVERY_UNAVAILABLE` 失败关闭，而不是排队。
