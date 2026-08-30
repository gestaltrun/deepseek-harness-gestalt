# @deepseek-ai/dsh-member-question-sender

[English](README.md) | 中文

成员提问的 Service Definition 与基于 codec 的 Provider。`ctx.memberQuestionSender.send(payload)` 通过 T4 remote-protocol codec 将一次 Companion `member-question` 操作编码，经注入的 port 投递字节，并等待权威的首个终态。对端凭证通过注入的 B 侧检索，走 Remote Access 的 `getProjectPeerGrant`。

## 服务：`MemberQuestionSenderService`（ctx 键：`memberQuestionSender`）

### 公开 API

- `ctx.memberQuestionSender.send(payload, options?): Promise<MemberQuestionSendResult>` 将一份决策简报（origin、background、问题批次、参考材料）编码为 Companion `member-question` 操作，投递编码后的字节，并等待已回答或已拒绝结算。生命周期失败以 `MemberQuestionSenderError` 拒绝。
- `ctx.memberQuestionSender.settle(questionId, settlement): Promise<void>` 发布带 claimant `InstallationId`、面向用户的设备名和绝对结算 epoch 的已回答或已拒绝结算。投递 port 保留首个 claim；后到的本地结算改为应用已保留的终态。
- `ctx.memberQuestionSender.withdraw(questionId): Promise<void>` 以发起方取消的方式撤回一次待答提问。
- `ctx.memberQuestionSender.queryTerminal(questionId): Promise<CompanionMemberQuestionSettledResult | undefined>` 查询投递 port 保留的首个终态，用于重连重放。

### 关键类型

- `MemberQuestionSendPayload`：`{ toProjectMember, projectId, background, questions, references, origin, originSessionId }`。`projectId` 与 `originSessionId` 使用既有的品牌化 Platform 和 Companion id；发送器根据 `ttlMs` 推导操作的绝对 `expiresAt`。origin、questions 与 references 复用 T4 Companion 字段；本包不发明第二种协议。
- `MemberQuestionSendResult`：`{ questionId, encoded, outcome: 'answered', answers }` 或 `{ questionId, encoded, outcome: 'declined' }`。
- `MemberQuestionDeliveryPort`：带 `deliver(encoded)`、原子 `publishTerminal(terminal)` 与 `queryTerminal(questionId)` 的注入 port。`publishTerminal` 返回 `{ claimed, terminal }`，其中 `terminal` 始终是已保留的首个 claim。跨机注册表传输被推迟，因此组合注入该 port；测试使用 `MemoryMemberQuestionDelivery`。
- `ProjectPeerGrantLookup`：注入的 B 侧检索，取回发给该成员的密封项目对等授权。
- `MemberPresenceLookup`：注入的实时在线状态判定。`offline` 结果会在编码前以 `MEMBER_OFFLINE` 失败；不会排队。
- `MemberMembershipWatch`：注入的在途成员资格监视。兑现时以 `REVOKED_DURING_FLIGHT` 失败。
- `MemberQuestionSenderError`：`HarnessError` 子类，包含 `DELIVERY_UNAVAILABLE`、`GRANT_UNAVAILABLE`、`ENCODE_FAILED`、`MEMBER_OFFLINE`、`QUESTION_EXPIRED`、`QUESTION_WITHDRAWN`、`QUESTION_SUPERSEDED` 和 `REVOKED_DURING_FLIGHT` 代码。

### 注入的接口

- `delivery`：成功发送与终态发布所必需。缺失时，`send()` 返回 `DELIVERY_UNAVAILABLE`；终态发布被拒绝时也以该代码失败关闭。
- `lookupGrant`：可选。存在时，拒绝会在编码前返回 `GRANT_UNAVAILABLE`。缺失时仍进行编码，以便无密钥装配在没有 Platform Instance 的情况下完成 codec 往返。
- `presenceLookup`：可选。存在时，`offline` 判定会在编码前返回 `MEMBER_OFFLINE`。缺失时跳过离线快速失败，以便无密钥装配在没有在线状态注册表的情况下完成往返。
- `watchMembership`：可选。存在时，待答期间兑现会返回 `REVOKED_DURING_FLIGHT`。
- `ttlMs`：路由提问寿命，单位毫秒，默认 `1_800_000`（30 分钟）。到期返回 `QUESTION_EXPIRED`。

### 会话事件

当 `send()` 被给予提问会话时，它会追加仅写入日志的 `member-question/asked` 摘要以及匹配的 `member-question/outcome`。该配对记录已经对模型可见的事实（工具调用参数与工具结果）；它不是 surface 事件，也不会重新进入派生历史。

发送器对每个 `(originSessionId, toProjectMember)` 路由键最多保留一次待答提问。回答、拒绝、到期、发起方撤回、同路由取代与成员移除都会先发布终态候选，再结算本地 Promise。同键的新发送为旧提问 claim `superseded`；成员移除 claim 接收端可见的 `withdrawn` 终态，而该本地 claim 获胜时，发起调用方仍得到 `REVOKED_DURING_FLIGHT`。

## 职责

本包是成员提问发送器 seam 的 Service Definition 与基于 codec 的 Provider。编码由 [`dsh-remote-protocol`](../../platform/remote-protocol/README.zh.md) 拥有；授权记录由 [`dsh-remote-access`](../../platform/remote-access/README.zh.md) 拥有。面向模型的 Consumer 是 [`dsh-tool-ask-user`](../tool-ask-user/README.zh.md)。

## Model Experience

Indirectly, through `dsh-tool-ask-user`, which routes `to_project_member` onto `send()` and retains the sender's stable errors as ordinary tool results.

#### KV Cache effect

不会直接产生 token 开销，也不会使 KV Cache 失效。`dsh-tool-ask-user` 拥有 `to_project_member`、`background` 与 `references` 的 schema 增长，以及已回答批次与发送器生命周期错误作为工具结果保留的 token。

## Known Limitations and Deferred Work

- **跨机投递依赖被推迟的项目注册表传输**：编码与投递接口已经定义；无密钥测试注入内存实现，缺少生产 port 的组合则失败关闭。在收件人安装上打开密封对等授权，以及跨机携带该授权，仍是 [Remote Access 已知限制](../../platform/remote-access/README.zh.md#known-limitations-and-deferred-work)。生产密封仍受那里记录的独立加密评审约束。本包不发明新协议。
- **被引用文档停留在 `member-question` 的 path 元数据上**：T4 codec 拥有 `document-chunk` 帧，并将重组视为消费方职责；本发送器只编码 `member-question` 操作，不传输文件字节。
