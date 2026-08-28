# @deepseek-ai/dsh-member-question-sender

[English](README.md) | 中文

成员提问的 Service Definition 与基于 codec 的 Provider。`ctx.memberQuestionSender.send(payload)` 通过 T4 remote-protocol codec 将一次 Companion `member-question` 操作编码，经注入的适配器投递字节，并等待终态结算。对端凭证通过注入的 B 侧检索，走 Remote Access 的 `getProjectPeerGrant`。

## 服务：`MemberQuestionSenderService`（ctx 键：`memberQuestionSender`）

### 公开 API

- `ctx.memberQuestionSender.send(payload, options?): Promise<MemberQuestionSendResult>` 将一份决策简报（origin、background、问题批次、参考材料）编码为 Companion `member-question` 操作，投递编码后的字节，并等待已回答或已拒绝结算。生命周期失败以 `MemberQuestionSenderError` 拒绝。
- `ctx.memberQuestionSender.settle(questionId, settlement): Promise<void>` 将已回答或已拒绝结算应用到待答提问。未知或已结算的 id 会被忽略。
- `ctx.memberQuestionSender.withdraw(questionId): Promise<void>` 以发起方取消的方式撤回一次待答提问。

### 关键类型

- `MemberQuestionSendPayload`：`{ toProjectMember, projectId, background, questions, references, origin, originSessionId }`。origin、questions 与 references 复用 T4 Companion 词汇；本包不发明第二种协议。`originSessionId` 是 supersede 路由键的一半。
- `MemberQuestionSendResult`：`{ questionId, encoded, outcome: 'answered', answers }` 或 `{ questionId, encoded, outcome: 'declined' }`。
- `MemberQuestionDelivery`：带 `deliver(encoded)` 的注入适配器。跨机注册表传输被推迟，因此组合注入该适配器；测试使用 `MemoryMemberQuestionDelivery`。
- `ProjectPeerGrantLookup`：注入的 B 侧检索，取回发给该成员的密封项目对等授权。
- `MemberPresenceLookup`：注入的实时在线状态判定。`offline` 结果会在编码前以 `MEMBER_OFFLINE` 失败；不会排队。
- `MemberMembershipWatch`：注入的在途成员资格监视。兑现时以 `REVOKED_DURING_FLIGHT` 失败。
- `MemberQuestionSenderError`：`HarnessError` 子类，包含 `DELIVERY_UNAVAILABLE`、`GRANT_UNAVAILABLE`、`ENCODE_FAILED`、`MEMBER_OFFLINE`、`QUESTION_EXPIRED`、`QUESTION_WITHDRAWN`、`QUESTION_SUPERSEDED` 和 `REVOKED_DURING_FLIGHT` 代码。

### 注入的接口

- `delivery`：成功发送所必需。缺失时，`send()` 返回 `DELIVERY_UNAVAILABLE`。
- `lookupGrant`：可选。存在时，拒绝会在编码前返回 `GRANT_UNAVAILABLE`。缺失时仍进行编码，以便无密钥装配在没有 Platform Instance 的情况下完成 codec 往返。
- `presenceLookup`：可选。存在时，`offline` 判定会在编码前返回 `MEMBER_OFFLINE`。缺失时跳过离线快速失败，以便无密钥装配在没有在线状态注册表的情况下完成往返。
- `watchMembership`：可选。存在时，待答期间兑现会返回 `REVOKED_DURING_FLIGHT`。
- `ttlMs`：路由提问寿命，单位毫秒，默认 `1_800_000`（30 分钟）。到期返回 `QUESTION_EXPIRED`。

### 会话事件

当 `send()` 被给予提问会话时，它会追加仅写入日志的 `member-question/asked` 摘要以及匹配的 `member-question/outcome`。该配对记录已经对模型可见的事实（工具调用参数与工具结果）；它不是 surface 事件，也不会重新进入派生历史。

发送器对每个 `(originSessionId, toProjectMember)` 路由键最多保留一次待答提问。同键的新发送会以 `QUESTION_SUPERSEDED` 结算先前挂起的 Promise。

## 职责

本包是成员提问发送器 seam 的 Service Definition 与基于 codec 的 Provider。编码由 [`dsh-remote-protocol`](../../platform/remote-protocol/README.zh.md) 拥有；授权记录由 [`dsh-remote-access`](../../platform/remote-access/README.zh.md) 拥有。面向模型的 Consumer 是 [`dsh-tool-ask-user`](../tool-ask-user/README.zh.md)。

## Model Experience

Indirectly, through `dsh-tool-ask-user`, which routes `to_project_member` onto `send()` and retains the sender's stable errors as ordinary tool results.

#### KV Cache effect

不会直接产生 token 开销，也不会使 KV Cache 失效。`dsh-tool-ask-user` 拥有 `to_project_member`、`background` 与 `references` 的 schema 增长，以及已回答批次与发送器生命周期错误作为工具结果保留的 token。

## Known Limitations and Deferred Work

- **跨机投递依赖被推迟的项目注册表传输**：编码与投递接口已经定义；默认组合注入内存 stub。在收件人安装上打开密封对等授权，以及跨机携带该授权，仍是 [Remote Access 已知限制](../../platform/remote-access/README.zh.md#known-limitations-and-deferred-work)。生产密封仍受那里记录的独立加密评审约束。本包不发明新协议。
- **被引用文档停留在 `member-question` 的 path 元数据上**：T4 codec 拥有 `document-chunk` 帧，并将重组视为消费方职责；本发送器只编码 `member-question` 操作，不传输文件字节。
