# Agent Note: Host-owned member-question receiver ledger

Status: implemented

[English](2026-08-31-host-owned-member-question-receiver-ledger.md) | 中文

## Problem

最初的接收实现由浏览器派生 `mq-recv:<originSessionId>::<member>`，并且只在 `ReceivingQuestionBook` 中保存 pending 与 terminal 状态。这能渲染合成卡，但 reconnect、进程重启、多 Installation 与显式 human turn 都没有 Host authority。浏览器 countdown 可能决定 expiry，后到 frame 可能复活本地遗忘的 pending 卡，而物化真实 Session 会迫使调用方把 Session 创建与 prompt admission 协调成两个可独立重试的操作。

## Decision

`@deepseek-ai/dsh-member-question-receiver` 在 Host 上拥有 receiver authority。Service Definition 暴露四个 deep operation：认证 `ingest`、完整 `snapshot` 加 change feed、terminal `settle` 与单调用 `admitHumanTurn`。文件 Provider 和认证 ingress Consumer adapter 保持折叠在同一包内，因为当前交付只有一个存储机制与一个 endpoint callback concern；拆成三个包不会产生独立演进的角色。

`ingest` 在解码后的加密 operation 旁接收 receiver Account authority。authority 来自认证 endpoint，不存在于成员提问明文。每条 `(originSessionId, receiving Account)` 路线在首次 arrival 时取得 Host 生成并持久化的 opaque `ReceivingSessionId`。payload 内容不能选择另一个 Account，也不会从 renderer 的 `mq-recv` 拼写组装 Host identity。

Decision Brief 继续放在每个提问的 `member-question` intent 上，而不是放在同级 request frame 上。因此，任一被转发的 item 都是自包含的；Host receiver snapshot 只增加 authority 所有的 routing、revision 与 terminal 字段。

环境 ledger 是 pending 与 terminal projection 的 authority。它存 Companion codec 已接纳的有界 Decision Brief 字段、reference path/reason 元数据、routing identity、terminal 元数据，以及由 text 与持久 attachment reference 组成、受 request digest 保护的 reserved human action；不存参考文档正文或浏览器原始图片 bytes。启动通过当前 Companion codec 校验完整文档，并对外来格式、畸形记录、悬空引用、不一致 terminal 或 admission digest 不匹配失败。

一个串行 transaction owner 强制 publication order。幂等 arrival 返回已记录 identity。新同路线提问成为 pending 前，旧 pending 提问的 `expired` 或 `superseded` candidate 必须通过注入的全局 first-claim authority，canonical 保留 terminal 随后提交到 ledger。Decline 是与 initiator withdrawal 不同的 human terminal，并携带获胜的 `InstallationId`、设备名与 settlement epoch。本地 claim 失败时提交返回的 canonical terminal，而不是 candidate。Change listener 只观察提交后的完整 projection，callback exception 会被隔离。

Host clock 与唯一 earliest-deadline scheduler 决定 expiry。scheduler 先 claim terminal，再持久化；publication 或文件失败会让 pending 行保持可重试。启动会在 read 可用前结算所有逾期 pending 行，因此 reopen 不会复活已过期提问。dispose 会关闭 notification 与 timer admission，再等待 transaction tail，不清空持久状态。

随发行版交付的 Web Host 挂载 receiver，并暴露精确的 `memberQuestion.snapshot` 与 `memberQuestion.settle` RPC，以及完整的 `host/member-question-snapshot` 基线／变更帧。settlement 校验持久化 `ReceivingSessionId`、revision 与 question id，并使用 Host Installation identity；receiver 缺失、tuple 陈旧或 identity 缺失时都会 fail loud。开发环境可以选择 keyless 本地 terminal authority；生产环境在认证跨机器 publication 完成组合前保持 deferred 与 fail closed。

`ReceivingQuestionBook` 只把 revision 更高的 Host 帧投影成使用持久化 Host id 的 identity-stable receiving Session face。断连保留最近的投影；重连通过完整基线替换它，不会丢失 pending 或 terminal 记录。Client 经 Host RPC 发送回答与拒绝；expiry、supersession、withdrawal 与 canonical terminal winner 只来自 Host。Terminal 记录在 conversation snapshot 中公开保留；Client Installation 与获胜回答不同的情况下，会根据获胜设备名与 settlement time 派生 `answered-elsewhere`。materialization 之前唯一的 prompt route 是 `memberQuestion.admitHumanTurn`；后续 snapshot 携带 `hostSessionId` 时，同一 face 会绑定到普通 Host Session。

`admitHumanTurn({ receivingSessionId, revision, rpcId, content, mode })` 是唯一 materialization interface。API Proxy 先通过普通 attachment service 提升浏览器图片，随后 receiver 在调用高层 adapter 前持久保留 `rpcId`、规范化 content、mode 与 digest。adapter 解析唯一的本地 Workspace，复用 opaque receiving id 作为 Host `SessionId`，关联 Workspace，追加可忽略的 `member-question/received` 与 `member-question/settled` record，以稳定 plugin message id 注入每条有界 brief，接纳稳定 human message，并 flush 普通 Session log。adapter 返回后才提交 materialization 与 admission。失败会保留 reservation；重试必须提供相同 action 与 `rpcId`，稳定 Session／message identity 和日志会识别已完成阶段。该机制闭合 adapter 成功与 ledger commit 之间的 crash interval，而不向调用方暴露 `session.create` 后再 `prompt`。arrival 永远不会调用 adapter。

## Supersession check

本记录拥有 receiver persistence、Host API projection、recovery、expiry、settlement 与 human admission。较早的 renderer-authority 决策已完整并入本记录；[renderer-only Session-face note](../feature/2026-08-30-web-receiving-experience-assembly-fixes.zh.md) 继续拥有对外 face 与合成卡装配。[member-question sender note](../feature/2026-08-28-member-question-sender.zh.md) 继续拥有 asking-side 单 pending promise 与 first-claim publication。

## Alternatives considered

**保留 `ReceivingQuestionBook` authority 并持久到 browser storage。** 拒绝，因为浏览器不拥有认证 Account authority、全局 first claim、进程重启、Host Session materialization 或能让所有 Installation 一致禁用的 clock。

**在提问 arrival 时创建 Host Session。** 拒绝，因为 arrival 是 collaboration notification，不是运行本地 agent 的 human intent。提前创建 Session 与 agent 会削弱零模型保证，并为被忽略的提问增加空 durable conversation。

**分别暴露 `createReceivingSession()` 与 `prompt()`。** 拒绝，因为两次调用之间的 crash 或 retry 会创建重复 Session、丢失第一条 human message 或重复 admit。一个处于 durable `rpcId` reservation 下的高层 adapter 拥有两个动作。

**在 receiver ledger 中存参考文档正文或浏览器原始图片 bytes。** 拒绝，因为 Companion document transfer 与 attachment service 拥有这些 bytes。crash-safe admission 只保留重放 reserved action 所需的有界 human text 与持久 attachment reference。

**把 renderer countdown 当作 expiry authority。** 拒绝，因为暂停或断连的 renderer 无法结算全局状态，并可能在 Installation 间产生分歧。Host clock、canonical terminal authority 与 durable commit 建立唯一 outcome。

**把 Decision Brief 放在 `question/requested` 旁边。** 拒绝，因为字段放在 item intent 上能让任一被转发的提问保持自包含，并避免为同一 sender payload 建立第二套编码。

## Consequences

Receiver 状态可在 Host 重启后恢复，并以稳定 Host identity 暴露唯一权威 pending/terminal projection。同路线 replacement、expiry、answer、decline 与跨设备 winner 按一个顺序提交。浏览器 reload 与 reconnect 会保留相同 id 与记录，且不创建 Host Session 或模型路径。普通提问与 plan-review 提问保留现有 Host-session 流程。

显式 human admission 无需两跳 client protocol 即可重试，Web Host 通过 API Proxy 挂载该 adapter。跨机器 first-claim publication 在 project-registry transport 存在前仍由注入提供，因此生产环境中需要它的转换会 fail closed。文件格式为预发布版本 `0`，没有 compatibility shim。

## Testing

Focused public-interface tests 覆盖幂等与冲突 arrival、环境 persistence、restart recovery、expiry 与 supersession ordering、reservation retry、callback containment、严格 wire 字段和 invalid durable state。Client Runtime 测试固定高 revision projection、双 Installation terminal presentation、admission RPC 与 materialized route binding。真实 Web composition 证明 arrival 不创建 Session 或模型请求，显式提交只创建一个 Host Session 与一个 turn，post-create／post-record／post-prompt 失败使用相同 `rpcId` 恢复，后续同路线 arrival 保留 record，receiver 与 Session persistence 在 restart 后仍可恢复。归属 built-Web 的 keyless snapshot 固定 bounded received record 以及 brief 先于 human 的模型 transcript。可运行的 TypeScript SDK snapshot 与 Python client expected-output test 都保留这两个 ignorable event envelope。
