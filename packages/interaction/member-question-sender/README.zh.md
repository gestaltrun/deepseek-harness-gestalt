# @deepseek-ai/dsh-member-question-sender

[English](README.md) | 中文

成员提问的 Service Definition 与基于 codec 的 Provider。`ctx.memberQuestionSender.send(payload)` 通过 T4 remote-protocol codec 将一次 Companion `member-question` 操作编码，并经注入的适配器投递字节。对端凭证通过注入的 B 侧检索，走 Remote Access 的 `getProjectPeerGrant`。

## 服务：`MemberQuestionSenderService`（ctx 键：`memberQuestionSender`）

### 公开 API

- `ctx.memberQuestionSender.send(payload): Promise<{ questionId, encoded }>` 将一份决策简报（origin、background、问题批次、参考材料）编码为 Companion `member-question` 操作，并投递编码后的字节。

### 关键类型

- `MemberQuestionSendPayload`：`{ toProjectMember, projectId, background, questions, references, origin }`。origin、questions 与 references 复用 T4 Companion 词汇；本包不发明第二种协议。
- `MemberQuestionDelivery`：带 `deliver(encoded)` 的注入适配器。跨机注册表传输被推迟，因此组合注入该适配器；测试使用 `MemoryMemberQuestionDelivery`。
- `ProjectPeerGrantLookup`：注入的 B 侧检索，取回发给该成员的密封项目对等授权。
- `MemberQuestionSenderError`：`HarnessError` 子类，包含 `DELIVERY_UNAVAILABLE`、`GRANT_UNAVAILABLE` 和 `ENCODE_FAILED` 代码。

### 注入的接口

- `delivery`：成功发送所必需。缺失时，`send()` 返回 `DELIVERY_UNAVAILABLE`。
- `lookupGrant`：可选。存在时，拒绝会在编码前返回 `GRANT_UNAVAILABLE`。缺失时仍进行编码，以便无密钥装配在没有 Platform Instance 的情况下完成 codec 往返。

## 职责

本包是成员提问发送器 seam 的 Service Definition 与基于 codec 的 Provider。编码由 [`dsh-remote-protocol`](../../platform/remote-protocol/README.zh.md) 拥有；授权记录由 [`dsh-remote-access`](../../platform/remote-access/README.zh.md) 拥有。面向模型的 Consumer 是 [`dsh-tool-ask-user`](../tool-ask-user/README.zh.md)。

## Model Experience

Indirectly, through `dsh-tool-ask-user`, which routes `to_project_member` onto `send()` and retains the sender's stable errors as ordinary tool results.

#### KV Cache effect

不会直接使 KV Cache 失效；请求前缀的任何变更均由上述消费方负责。

## Known Limitations and Deferred Work

- **跨机投递依赖被推迟的项目注册表传输**：编码与投递接口已经定义；默认组合注入内存 stub。在收件人安装上打开密封对等授权，以及跨机携带该授权，仍是 [Remote Access 已知限制](../../platform/remote-access/README.zh.md#known-limitations-and-deferred-work)。本包不发明新协议。
- **运行期资格过滤、离线快速失败与持久 ask/outcome 事件属于后续里程碑**：本 Provider 编码并投递一份 payload；成员资格过滤、在线状态与会话日志结算仍由后续工单负责。
