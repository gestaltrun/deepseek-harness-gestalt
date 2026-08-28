# Agent Note: member-directed ask_user_question routes through an injectable codec sender

Status: implemented

[English](2026-08-28-member-question-sender.md) | 中文

## Problem

工单 #343 需要 `ask_user_question` 能向一名项目成员提问。T4 Companion codec 已经拥有 `member-question` 操作，Remote Access 已经拥有项目对等授权，但两者都不是面向模型的 Consumer：工具必须继续用 `ctx.userQuestions` 处理本地提问，而新的发送器必须编码并投递，且不能发明第二种协议。跨机注册表传输仍是已记录的 T4 缺环，因此直接调用 Relay 的发送器要么谎称已投递，要么卡住本里程碑。

## Decision

`ask_user_question` 保留静态 schema，并新增 `to_project_member`、`background` 和 `references`。`to_project_member` 与本地提供方互斥：存在时，工具绝不调用 `ctx.userQuestions.ask()`，而是调用 `ctx.memberQuestionSender.send()`。提示组装会在 `boundProjectResolver` 未返回云端项目 id 时过滤掉该参数；`ctx.tools.schemas()` 与生成的目录仍保留静态 schema。`background` 仅在路由模式必填，构建期按 T4 的 600 码点上限以 `BACKGROUND_REQUIRED` 或 `BACKGROUND_TOO_LONG` 拒绝。`references` 是本地与路由提问的常态参数；每个 `path` 必须存在于提问会话工作区内，每个 `reason` 至多 100 个码点，否则工具抛出 `REFERENCES_INVALID` 并指出失败项。

发送器是新的 interaction 包 `@deepseek-ai/dsh-member-question-sender`，暴露 `ctx.memberQuestionSender`。它同时是 Service Definition 与基于 codec 的 Provider：`send(payload)` 通过 T4 codec 编码 Companion `member-question` 操作，把字节交给注入的 `MemberQuestionDelivery`，并等待已回答或已拒绝结算。对端凭证通过注入的 B 侧 `lookupGrant` 取回，组合将其接到 Remote Access 的 `getProjectPeerGrant`。因为注册表传输尚不存在，投递可注入，测试使用 `MemoryMemberQuestionDelivery`；README 已知限制指向同一处 Remote Access 缺环，而不是新协议。

生命周期错误是一等 `MemberQuestionSenderError` 代码，并作为普通工具结果保留：发送时在线状态为 offline 则 `MEMBER_OFFLINE`（不排队），Config `ttlMs`（默认 30 分钟）到期则 `QUESTION_EXPIRED`，发起方取消 turn 则 `QUESTION_WITHDRAWN`，同一 `(originSessionId, member)` 路由键上的新问替换待答问则 `QUESTION_SUPERSEDED`，等待期间成员资格被撤则 `REVOKED_DURING_FLIGHT`。发送器对该路由键最多保留一次待答提问。

当 `send()` 被给予提问会话时，它会追加仅写入日志的 `member-question/asked` 与 `member-question/outcome` 事件。这些记录已经作为工具调用与工具结果对模型可见，因此它们不是 surface 事件，也不会重新进入派生历史；它们保持 required-on-read，使较旧的 harness 拒绝包含它们的日志。

origin 身份（项目名、提问者账号、角色、显示名、头像）不由工具编造。路由提问需要注入的 `originResolver`；缺少发送器或该解析器时，工具返回 `SENDER_UNAVAILABLE`。本地提问忽略这些接口，因此现有组合继续工作。

## Supersession check

[项目成员关系权威 note](2026-08-27-project-membership-core.zh.md) 与 [名册工具 note](2026-08-28-project-members-roster-tool.zh.md) 均未被取代。成员关系仍拥有名册权威；名册工具仍拥有面向模型的成员查询。本 note 只拥有 `ask_user_question` 发送侧到 T4 codec 的路由，包括资格过滤、生命周期错误与持久提问记录。

## Alternatives considered

**经 `ctx.userQuestions` 增加新提供方来路由。** 否决：本地 UI 提供方每个上下文只能有一个，将被迫变成扇出路由器；成员提问走 Companion 操作，而不是 user-questions 词汇。

**把发送器放进 `packages/platform/`。** 否决：编码是协议的 Consumer，不是 Platform 身份，而且面向模型的工具已经在 `packages/interaction/`。发送器与 `tool-ask-user` 相邻，避免把 Remote Access 拖进每个本地提问组合：工具依赖发送器 Service Definition，没有 Provider 的组合仍可服务本地提问。

**发送器直接调用 Remote Access Relay，不注入投递适配器。** 否决：跨机注册表传输是已记录的 T4 缺环；假装字节已经投递等于发明其余栈打不开的协议。

**注册两个 `ask_user_question` 变体并按资格切换。** 否决：现有工具资格机制是按名称的允许列表，而不是按参数可见性。在 `system-prompt/assemble` 过滤组装后的 schema，可以保留一个已注册定义和一份静态目录，同时仍对非绑定工作区隐藏该参数。

**把 ask/outcome 事件标为 `ignorable`。** 否决：提问摘要与结果已经是模型可见事实，记录在工具调用之后。较旧的 harness 若跳过它们，会重建一份 transcript 仍含路由提问的会话，因此 required-on-read 是更安全的默认。

## Consequences

本地 `ask_user_question` 行为不变，只是现在接受并校验 `references`。路由提问需要已组合的发送器、origin 解析器和投递适配器；在注册表传输落地之前，真实部署以 `DELIVERY_UNAVAILABLE` 或 `SENDER_UNAVAILABLE` 失败关闭，而不是排队。内存投递 stub 是 codec 复用的往返测试，不是生产投递的证据。非绑定工作区在组装后的提示中看不到 `to_project_member`；随后的绑定会在下一次组装时重新检查。

## Testing

`packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts` 固定 schema 矩阵（`background` 缺失／超限、`references` 越出工作区、路由提问必须有 `background`），本地提问仍到达 user-questions 提供方，以及组装后的提示按绑定项目解析器包含或省略 `to_project_member`。`packages/interaction/member-question-sender/tests/member-question-sender.spec.ts` 固定经 T4 解码器的 codec 往返、内存 stub 投递、每个稳定生命周期错误，以及同路由键 supersede 竞态。
