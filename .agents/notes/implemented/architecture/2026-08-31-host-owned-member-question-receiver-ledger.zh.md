# Agent Note: Host-owned member-question receiver ledger

Status: implemented

[English](2026-08-31-host-owned-member-question-receiver-ledger.md) | 中文

## Problem

最初的接收实现由浏览器派生 `mq-recv:<originSessionId>::<member>`，并且只在 `ReceivingQuestionBook` 中保存 pending 与 terminal 状态。这能渲染合成卡，但 reconnect、进程重启、多 Installation 与显式 human turn 都没有 Host authority。浏览器 countdown 可能决定 expiry，后到 frame 可能复活本地遗忘的 pending 卡，而物化真实 Session 会迫使调用方把 Session 创建与 prompt admission 协调成两个可独立重试的操作。

## Decision

`@deepseek-ai/dsh-member-question-receiver` 在 Host 上拥有 receiver authority。Service Definition 暴露四个 deep operation：认证 `ingest`、完整 `snapshot` 加 change feed、terminal `settle` 与单调用 `admitHumanTurn`。文件 Provider 和认证 ingress Consumer adapter 保持折叠在同一包内，因为当前交付只有一个存储机制与一个 endpoint callback concern；拆成三个包不会产生独立演进的角色。

`ingest` 在解码后的加密 operation 旁接收 receiver Account authority。authority 来自认证 endpoint，不存在于成员提问明文。每条 `(originSessionId, receiving Account)` 路线在首次 arrival 时取得 Host 生成并持久化的 opaque `ReceivingSessionId`。payload 内容不能选择另一个 Account，也不会从 renderer 的 `mq-recv` 拼写组装 Host identity。

环境 ledger 是 pending 与 terminal projection 的 authority。它只存 Companion codec 已接纳的有界 Decision Brief 字段、reference path/reason 元数据、routing identity、terminal 元数据与 admission request digest；不存参考文档正文或 human-turn content。启动通过当前 Companion codec 校验完整文档，并对外来格式、畸形记录、悬空引用或不一致 terminal 失败。

一个串行 transaction owner 强制 publication order。幂等 arrival 返回已记录 identity。新同路线提问成为 pending 前，旧 pending 提问的 `expired` 或 `superseded` candidate 必须通过注入的全局 first-claim authority，canonical 保留 terminal 随后提交到 ledger。Decline 是与 initiator withdrawal 不同的 human terminal，并携带获胜的 `InstallationId`、设备名与 settlement epoch。本地 claim 失败时提交返回的 canonical terminal，而不是 candidate。Change listener 只观察提交后的完整 projection，callback exception 会被隔离。

Host clock 与唯一 earliest-deadline scheduler 决定 expiry。scheduler 先 claim terminal，再持久化；publication 或文件失败会让 pending 行保持可重试。启动会在 read 可用前结算所有逾期 pending 行，因此 reopen 不会复活已过期提问。dispose 会关闭 notification 与 timer admission，再等待 transaction tail，不清空持久状态。

`admitHumanTurn({ receivingSessionId, revision, rpcId, content, mode })` 是唯一 materialization interface。receiver 在调用注入的高层 adapter 前，先持久保留 `rpcId` 与 content/mode digest；该 adapter 在需要时物化 Host Session 并 admit turn。adapter 返回后才提交 materialization 与 admission。失败会保留 reservation；重试提供相同 request 与 `rpcId`。adapter 必须按 `rpcId` 幂等，从而闭合 adapter 成功与 ledger commit 之间的 crash interval，而不向调用方暴露 `session.create` 后再 `prompt`。arrival 永远不会调用 adapter。

## Supersession check

[renderer-only receiving-session note](../feature/2026-08-30-receiver-sessions-member-question-wire.zh.md) 在 Host/API Proxy wiring 缺失时仍拥有当前浏览器 projection 与合成卡 carrier。它的确定性 `mq-recv` identity 不再是 receiver authority，并必须在该 adapter 落地时被 Host projection 替换。[member-question sender note](../feature/2026-08-28-member-question-sender.zh.md) 继续拥有 asking-side 单 pending promise 与 first-claim publication；本记录拥有 receiver persistence、recovery、expiry 与 human admission。本次变更没有完全 superseded 或应归档的 active note。

## Alternatives considered

**保留 `ReceivingQuestionBook` authority 并持久到 browser storage。** 拒绝，因为浏览器不拥有认证 Account authority、全局 first claim、进程重启、Host Session materialization 或能让所有 Installation 一致禁用的 clock。

**在提问 arrival 时创建 Host Session。** 拒绝，因为 arrival 是 collaboration notification，不是运行本地 agent 的 human intent。提前创建 Session 与 agent 会削弱零模型保证，并为被忽略的提问增加空 durable conversation。

**分别暴露 `createReceivingSession()` 与 `prompt()`。** 拒绝，因为两次调用之间的 crash 或 retry 会创建重复 Session、丢失第一条 human message 或重复 admit。一个处于 durable `rpcId` reservation 下的高层 adapter 拥有两个动作。

**在 receiver ledger 中存参考文档正文或 human-turn content。** 拒绝，因为 Companion document transfer 与普通 Session log 拥有这些 bytes。receiver 需要有界 display metadata 与 admission digest，而不是第二个 content store。

**把 renderer countdown 当作 expiry authority。** 拒绝，因为暂停或断连的 renderer 无法结算全局状态，并可能在 Installation 间产生分歧。Host clock、canonical terminal authority 与 durable commit 建立唯一 outcome。

## Consequences

Receiver 状态可在 Host 重启后恢复，并以稳定 Host identity 暴露唯一权威 pending/terminal projection。同路线 replacement、expiry、decline 与跨设备 winner 按一个顺序提交。显式 human admission 无需两跳 client protocol 即可重试，而 arrival 保持 model-silent。

本包尚未实现 SessionRuntime/API Proxy adapter，也没有把浏览器 renderer-only projection 接到该 Host feed。跨机器 first-claim publication 在 project-registry transport 存在前仍由注入提供，因此需要它的转换会 fail closed。文件格式为预发布版本 `0`，没有 compatibility shim。

## Testing

Focused public-interface tests 覆盖幂等与冲突 arrival、环境 persistence、restart recovery、expired-before-newer ordering、supersede publication failure、decline 与 withdrawal、first-claim loser、timer retry 与 dispose quiescence、reservation retry、admission 后 persistence failure、callback containment、invalid durable state 与完整逐文件 coverage。真实 Loader composition 会挂载 Service Definition、Provider、Consumer adapter 与 invariant companion，dispose provider fiber，再以同一 ledger remount。
