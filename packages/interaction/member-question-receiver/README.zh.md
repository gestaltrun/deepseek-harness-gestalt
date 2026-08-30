# @deepseek-ai/dsh-member-question-receiver

[English](README.md) | 中文

Host 所有的成员提问接收状态 Service Definition、文件 Provider 与认证 ingress Consumer adapter。`ctx.memberQuestionReceiver` 负责到达、路线线程、终态投影、到期与首次显式 human turn admission；提问到达不会创建 Host Session，也不会花费模型 token。

## Service：`MemberQuestionReceiverService`（ctx key：`memberQuestionReceiver`）

### Public API

- `ingest(envelope)` 只在认证 endpoint 已建立的接收 Account authority 旁接收解码后的 `member-question` operation。同一提问重放幂等；authority 或内容冲突会失败。Host 为 `(originSessionId, receiver Account)` 创建并持久化 opaque `ReceivingSessionId`，绝不从 `mq-recv` 派生 id，也不信任明文中的收件人。
- `snapshot()` 返回含 pending 提问与 terminal 记录的完整已提交 revision。`changes(listener)` 只在原子持久替换后发布同一权威投影；一个抛错 listener 不会阻塞其他 listener。
- `settle(questionId, settlement)` 通过已配置的 first-claim authority 提议显式 `answered` 或 `declined` 终态，或者应用 transport 提供的权威 claim。保留的终态始终 canonical，包括本地 claim 失败的情况；human terminal 保留类型化 Installation id、设备名、时间与 answered value，`expired`、`withdrawn`、`superseded` 仍是 system terminal。
- `admitHumanTurn({ receivingSessionId, revision, rpcId, content, mode })` 先持久保留稳定 `rpcId`、规范化 content、mode 与 digest，并投影该 reservation 的 id 与 mode 供 Client 重启恢复，再调用一次注入的高层 materialize-and-admit adapter，成功后提交。adapter 失败或 admission 后文件提交失败都会保留可精确重试的 action；同一 `rpcId` 下的不同 content 会被拒绝。adapter 必须按 `rpcId` 幂等；调用方永远看不到 Session-create 与 prompt 两个独立操作。
- `createAuthenticatedMemberQuestionIngress(receiver)` 是包内折叠的未来认证 endpoint Consumer adapter。它只接受 `AuthenticatedMemberQuestionEnvelope`；认证仍由 endpoint 负责。

## Persistence and ordering

Provider 通过随机同目录临时文件原子替换，把一个仅所有者可读写的 JSON 文档写到 `<storagePath>/<environment>/member-question-receiver.json`。格式存有界 origin、background、question/options、reference path/reason 元数据、路线 identity、terminal 元数据，以及由 text 与持久 attachment reference 组成、受 SHA-256 request digest 保护的 reserved human action。参考文档正文与浏览器原始图片 bytes 不进入该 ledger。

一个串行 transaction owner 对 load、arrival、terminal publication、file commit、admission reservation、materialization 与 admission commit 排序。同路线新提问只有在旧 pending 提问的 canonical `superseded` 或已到期 `expired` terminal 提交后才会成为 pending。唯一 earliest-deadline scheduler claim 并持久化到期；publication 失败会在 `terminalRetryMs` 后重试。启动会在 read 可用前结算逾期行，因此重启不会复活已过期卡片。dispose 会清理 timer 与 listener、等待 transaction tail，并保留 ledger。

## Configuration

- `storagePath` — receiver ledger 的非空根目录。
- `environment` — `development` 或 `production`；每个环境拥有独立文档 namespace。
- `maxRecords` — 正数持久提问记录上限。耗尽时拒绝 arrival，不删除 terminal 历史。
- `terminalRetryMs` — 权威到期 publication 失败后的正数重试延迟。
- `terminalAuthorityMode` — `deferred` 在缺少 transport authority 时保持 settlement fail closed；`development-local` 仅在 `environment` 为 `development` 时启用 keyless 单 Host authority。
- `terminalAuthority` — 可选 first-claim adapter。没有它仍能保留未来 pending arrival，但需要 publication 的任何转换都 fail closed。
- `admitter` — 可选高层 materialize-and-admit adapter。缺失时 human-turn admission fail closed。
- `clock`、`timer` 与 `stateWriter` — 确定性 composition 与存储边界测试注入的时间、调度与原子存储接口；生产使用系统 clock/timer 与仅所有者可读写的原子替换。

## Model Experience

None, as 认证 arrival、receiver projection、terminal settlement 与 reservation 记账都不会进入模型请求；只有之后的显式 human turn 会进入普通 Host admission adapter。

#### KV Cache effect

Arrival 与 terminal 浏览没有 token 成本或 cache invalidation。只有显式提交 human message 后，Host admission adapter 才会产生一次普通 Session request，并在 human prompt 之前记录每条尚未 admission 的有界 brief。

## Known Limitations and Deferred Work

- **Admission 需要唯一且权威的本地 Workspace binding** — Host 通过组合提供的 binding 或 project-membership link 解析 receiver Account 与 Project。缺失或有歧义的关联会让单次 admission RPC 失败，Client 不会获得 Session creation 或 prompt compensation 接口。
- **跨机器 terminal authority 仍由注入提供** — 真实多 Installation first-claim publication 依赖 project-registry transport。没有该 authority 的 composition 可以保留未来 pending arrival，但会在 decline、expiry 或 supersession 前 fail closed。
