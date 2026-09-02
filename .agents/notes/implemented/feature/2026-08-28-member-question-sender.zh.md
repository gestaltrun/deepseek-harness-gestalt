# Agent Note: member-directed ask_user_question routes through an injectable codec sender

Status: implemented

[English](2026-08-28-member-question-sender.md) | 中文

## Problem

工单 #343 需要 `ask_user_question` 能向一名项目成员提问。T4 Companion codec 已经拥有 `member-question` 操作，Remote Access 已经拥有项目对等授权，但两者都不是面向模型的 Consumer：工具必须继续用 `ctx.userQuestions` 处理本地提问，而新的发送器必须编码并投递，且不能发明第二种协议。跨机注册表传输仍是已记录的 T4 缺环，因此直接调用 Relay 的发送器要么谎称已投递，要么卡住本里程碑。

## Decision

面向成员的提问通过扩展 `ask_user_question` 的参数完成，而不是再注册一个面向模型的工具。新工具会把同一套提问词汇拆成两个名字，迫使模型在兄弟工具之间选择，却仍要共用本地回答 JSON。因此现有 `ask_user_question` schema 增加 `to_project_member`、`background` 和 `references`。`to_project_member` 与本地提供方互斥：存在时，工具绝不调用 `ctx.userQuestions.ask()`，而是调用 `ctx.memberQuestionSender.send()`。`background` 仅在路由模式必填，构建期按 T4 的 600 码点上限以 `BACKGROUND_REQUIRED` 或 `BACKGROUND_TOO_LONG` 拒绝。`references` 是本地与路由提问的常态参数；每个 `path` 必须存在于提问会话工作区内，每个 `reason` 至多 100 个码点，否则工具抛出 `REFERENCES_INVALID` 并指出失败项。

运行期资格是提示组装过滤器，而不是第二个已注册定义。名称级 `tools-eligibility` 允许列表无法隐藏一个存活工具的单个属性，因此 `tool-ask-user` 监听 `system-prompt/assemble`，调用 `boundProjectResolver`，并在该解析器未返回云端项目 id 时从组装后的 schema 省略 `to_project_member`。拒绝或缺失的解析器视为未绑定。`ctx.tools.schemas()` 与生成的目录仍保留静态 schema，因此随后的绑定不会把过期参数泄漏进下一次请求，非绑定工作区也看不到路由参数。

发送器是新的 interaction 包 `@deepseek-ai/dsh-member-question-sender`，暴露 `ctx.memberQuestionSender`。它同时是 Service Definition 与基于 codec 的 Provider：`send(payload)` 通过 T4 codec 编码 Companion `member-question` 操作，把字节交给注入的 `MemberQuestionDeliveryPort`，并等待已回答或已拒绝结算。操作携带品牌化云端项目和发起 Session id，以及绝对过期 epoch，使接收方无需把 `toProjectMember` 当作 authority 即可重建路由。对端凭证通过注入的 B 侧 `lookupGrant` 取回，组合将其接到 Remote Access 的 `getProjectPeerGrant`。因为注册表传输尚不存在，投递可注入，测试使用 `MemoryMemberQuestionDelivery`；README 已知限制指向同一处 Remote Access 缺环，而不是新协议。

生命周期错误是一等 `MemberQuestionSenderError` 代码，并作为普通工具结果保留：发送时在线状态为 offline 则 `MEMBER_OFFLINE`（不排队），Config `ttlMs`（默认 30 分钟）到期则 `QUESTION_EXPIRED`，发起方取消 turn 则 `QUESTION_WITHDRAWN`，同一 `(originSessionId, toProjectMember)` 路由键上的新问替换待答问则 `QUESTION_SUPERSEDED`，等待期间成员资格被撤则 `REVOKED_DURING_FLIGHT`。发送器按该路由键和 question id 索引在途提问，并对每个键最多保留一次待答提问：`registerPending` 先安装较新的单元，再以 `QUESTION_SUPERSEDED` 和持久 `superseded` 结果结算先前挂起的 Promise。被替换提问随后的回答、拒绝、到期、撤回或撤销都会被忽略，因为该单元已经结算。

`MemberQuestionDeliveryPort` 通过 `deliver`、`publishTerminal` 与 `queryTerminal` 拥有操作投递和首个 claim 的终态保留。answered 与 declined 终态携带品牌化结算 Installation、其面向用户的设备名和绝对结算 epoch；到期、发起方撤回与取代只携带 epoch。回答、拒绝、到期、撤回、取代或在途成员移除都会先发布，再结算本地 Promise。`publishTerminal` 原子返回 `{ claimed, terminal }`；失败的 claimant 消费已保留终态，因此两个 Installation 不会提交不同结果，重连也能重放获胜结果。成员移除发布接收端可见的 `withdrawn`，并在该 claim 获胜时为发起调用方保留 `REVOKED_DURING_FLIGHT`。

当 `send()` 被给予提问会话时，它会追加仅写入日志的 `member-question/asked` 与 `member-question/outcome` 事件。这些记录已经作为工具调用与工具结果对模型可见，因此它们不是 surface 事件，也不会重新进入派生历史；它们保持 required-on-read，使较旧的 harness 拒绝包含它们的日志。

Project 与 origin 身份不由工具编造。路由提问需要注入的 `routeResolver`，仅当当前权威 Project 名册包含 `to_project_member` 时才返回这些事实以及匹配到的 Account id。公开登录名匹配大小写不敏感。成员缺失时在投递前返回稳定的 `INELIGIBLE_ADDRESSEE`；缺少发送器或 resolver 时返回 `SENDER_UNAVAILABLE`。工具取消信号会传递到这次权威读取。本地提问忽略这些接口，因此现有组合继续工作。该 resolver 的 Desktop 装配记录在[Desktop 名册路由 note](2026-09-02-desktop-roster-routing.zh.md)。

## Supersession check

两篇 2026-08-28 协作笔记均未被取代。[名册工具 note](2026-08-28-project-members-roster-tool.zh.md) 仍拥有经 `project_members` 及其注入的账号、绑定、名册与 presenter 接口的面向模型成员枚举；本发送器对模型选定的收件人另做一次当前名册资格读取，不把该名册作为模型输出。[Desktop 名册路由 note](2026-09-02-desktop-roster-routing.zh.md) 拥有真实 Desktop 组合上的 Installation 取样身份与公开登录名匹配。[项目对等授权 note](2026-08-28-project-peer-relay-grants.zh.md) 仍拥有按对端密封的 Relay 凭证，以及投递止于密封信封的已记录 T4 缺环；本发送器在 B 侧查找该授权并注入投递，而不签发、打开或传输信封。[项目成员关系权威 note](2026-08-27-project-membership-core.zh.md) 仍拥有名册权威与不排队的离线立场；[presence 心跳 note](2026-08-28-member-presence-heartbeats.zh.md) 仍拥有存活心跳如何成为 `online`/`offline`。本 note 只拥有参数扩展后的 `ask_user_question` 到 T4 codec 的路由，包括运行期 schema 过滤、单待答占用、生命周期错误与持久提问记录。

## Alternatives considered

**再注册一个面向模型的工具（例如 `ask_project_member`）。** 否决：问题项、回答 JSON 与 Native 紧凑文本渲染器已经属于 `ask_user_question`。兄弟工具会把同一套词汇拆成两个名字，迫使模型选择，却仍要共用这些约定。扩展现有 schema 可保持本地提问不变，并让运行期组装只隐藏路由参数。

**经 `ctx.userQuestions` 增加新提供方来路由。** 否决：本地 UI 提供方每个上下文只能有一个，将被迫变成扇出路由器；成员提问走 Companion 操作，而不是 user-questions 词汇。

**把发送器放进 `packages/platform/`。** 否决：编码是协议的 Consumer，不是 Platform 身份，而且面向模型的工具已经在 `packages/interaction/`。发送器与 `tool-ask-user` 相邻，避免把 Remote Access 拖进每个本地提问组合：工具依赖发送器 Service Definition，没有 Provider 的组合仍可服务本地提问。

**发送器直接调用 Remote Access Relay，不注入投递 port。** 否决：跨机注册表传输是已记录的 T4 缺环；假装字节或终态已经发布，等于发明其余栈无法打开或重放的协议。

**注册两个 `ask_user_question` 变体并按资格切换。** 否决：现有工具资格机制是按名称的允许列表，而不是按参数可见性。在 `system-prompt/assemble` 过滤组装后的 schema，可以保留一个已注册定义和一份静态目录，同时仍对非绑定工作区隐藏该参数。

**把 ask/outcome 事件标为 `ignorable`。** 否决：提问摘要与结果已经是模型可见事实，记录在工具调用之后。较旧的 harness 若跳过它们，会重建一份 transcript 仍含路由提问的会话，因此 required-on-read 是更安全的默认。

## Consequences

本地 `ask_user_question` 行为不变，只是接受并校验 `references`。路由提问需要已组合的发送器、权威 route resolver 和投递 port；模型不能把当前名册未收录的任意或过期 Account id 当作收件人。在注册表传输落地之前，没有投递适配器的组合以 `DELIVERY_UNAVAILABLE` 或 `SENDER_UNAVAILABLE` 失败关闭，而不是排队。内存投递 stub 证明 codec 复用、首个 claim 保留与重放，但不构成生产投递证据。非绑定工作区在组装后的提示中看不到 `to_project_member`；随后的绑定会在下一次组装时重新检查。

## Testing

`packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts` 固定 schema 矩阵（`background` 缺失／超限、`references` 越出工作区、路由提问必须有 `background`）、投递前的 `INELIGIBLE_ADDRESSEE`，本地提问仍到达 user-questions 提供方，以及组装后的提示按绑定项目解析器包含或省略 `to_project_member`。`packages/interaction/member-question-sender/tests/member-question-sender.spec.ts` 固定经 T4 解码器的 codec 往返、内存 port 投递、每条终态发布路径、重放、后到的本地回答消费外部已保留到期结果、每个稳定生命周期错误，以及同路由键 supersede 竞态。
