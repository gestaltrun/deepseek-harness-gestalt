# Agent Note: Host-owned member-question receiver ledger

Status: implemented

[English](2026-08-31-host-owned-member-question-receiver-ledger.md) | 中文

## Problem

最初的接收实现由浏览器派生 `mq-recv:<originSessionId>::<member>`，并且只在 `ReceivingQuestionBook` 中保存 pending 与 terminal 状态。这能渲染合成卡，但 reconnect、进程重启、多 Installation 与显式 human turn 都没有 Host authority。浏览器 countdown 可能决定 expiry，后到 frame 可能复活本地遗忘的 pending 卡，而物化真实 Session 会迫使调用方把 Session 创建与 prompt admission 协调成两个可独立重试的操作。

## Decision

`@deepseek-ai/dsh-member-question-receiver` 在 Host 上拥有 receiver authority。Service Definition 暴露五个 deep operation：认证 `ingest`、完整 `snapshot` 加 change feed、terminal `settle`、单调用 `admitHumanTurn`，以及精确 Account／Project Workspace `bind` 加 `resolve`。文件 Provider 和认证 ingress Consumer adapter 保持折叠在同一包内，因为当前交付只有一个存储机制与一个 endpoint callback concern；拆成三个包不会产生独立演进的角色。

`ingest` 在解码后的加密 operation 旁接收 receiver Account authority。authority 来自认证 endpoint，不存在于成员提问明文。每条 `(originSessionId, receiving Account)` 路线在首次 arrival 时取得 Host 生成并持久化的 opaque `ReceivingSessionId`。payload 内容不能选择另一个 Account，也不会从 renderer 的 `mq-recv` 拼写组装 Host identity。

Decision Brief 继续放在每个提问的 `member-question` intent 上，而不是放在同级 request frame 上。因此，任一被转发的 item 都是自包含的；Host receiver snapshot 只增加 authority 所有的 routing、revision 与 terminal 字段。

环境 ledger 是 pending 与 terminal projection、已传输 reference 文档及本地 Workspace association 的 authority。它存 Companion codec 已接纳的有界 Decision Brief 字段、reference path/reason 元数据、规范 base64url 文档字节、routing identity、terminal 元数据、每组 Account／Project 所选择的精确 Workspace id，以及由 text 与持久 attachment reference 组成、受 request digest 保护的 reserved human action。只有 transport 重组并校验所有分块后，ingest 才会以完整且 path 一一对齐的集合接纳文档字节。Markdown 与 HTML 把已解码 UTF-8 投影到 details 面板；任意其他文件类型保持字节精确且没有文本投影。不存浏览器原始图片 bytes。启动通过当前 Companion codec 校验完整文档，并对外来格式、畸形记录、重复 binding、悬空引用、文档不对齐、不一致 terminal 或 admission digest 不匹配失败。

一个串行 transaction owner 强制 publication order。幂等 arrival 返回已记录 identity。新同路线提问成为 pending 前，旧 pending 提问的 `expired` 或 `superseded` candidate 必须通过注入的全局 first-claim authority，canonical 保留 terminal 随后提交到 ledger。Decline 是与 initiator withdrawal 不同的 human terminal，并携带获胜的 `InstallationId`、设备名与 settlement epoch。本地 claim 失败时提交返回的 canonical terminal，而不是 candidate。Change listener 只观察提交后的完整 projection，callback exception 会被隔离。

Host clock 与唯一 earliest-deadline scheduler 决定 expiry。scheduler 先 claim terminal，再持久化；publication 或文件失败会让 pending 行保持可重试。启动会在 read 可用前结算所有逾期 pending 行，因此 reopen 不会复活已过期提问。dispose 会关闭 notification 与 timer admission，再等待 transaction tail，不清空持久状态。

随发行版交付的 Web Host 挂载 receiver，并暴露精确的 `memberQuestion.workspaceBinding`、`memberQuestion.ensureWorkspaceBinding`、`memberQuestion.bindWorkspace`、`memberQuestion.snapshot` 与 `memberQuestion.settle` RPC，以及完整的 `host/member-question-snapshot` 基线／变更帧。Project 创建从精确本地 Workspace 规范化后的 `origin` 派生 bound remote；界面中的任意输入都不能选择另一个 remote。Project 创建与邀请接受会经 binding RPC 提交精确的认证 Account、Project 与本地 Workspace id；该 RPC 会先证明 Workspace 仍在 registry 中。本地提交成功后才执行 Platform invitation acceptance。设置恢复会按 Workspace origin 解析当前 Account 的唯一 Project，再要求 Host 确保持久化的精确 binding。Host 保留 live binding，通过 compare-and-bind 原子修复 missing 或 stale binding，并把另一个 live checkout 作为冲突返回；因此并发恢复不能仅因两个 checkout 同源就迁移第一个 live winner。Binding 的校验与提交和 Workspace registry 的 create／delete 共用 mutation order，因此已接受的 candidate 在持久提交完成前会保持 live。settlement 校验持久化 `ReceivingSessionId`、revision 与 question id，并使用 Host Installation identity；receiver 缺失、tuple 陈旧、binding 未解析或 identity 缺失时都会 fail loud。开发环境可以选择 keyless 本地 terminal authority；生产环境在认证跨机器 publication 完成组合前保持 deferred 与 fail closed。

`ReceivingQuestionBook` 只把 revision 更高的 Host 帧投影成使用持久化 Host id 的 identity-stable receiving Session face。断连保留最近的投影；重连通过完整基线替换它，不会丢失 pending 或 terminal 记录。Client 经 Host RPC 发送回答与拒绝；expiry、supersession、withdrawal 与 canonical terminal winner 只来自 Host。Terminal 记录在 conversation snapshot 中公开保留；Client Installation 与获胜回答不同的情况下，会根据获胜设备名与 settlement time 派生 `answered-elsewhere`。materialization 之前唯一的 prompt route 是 `memberQuestion.admitHumanTurn`；后续 snapshot 携带 `hostSessionId` 时，同一 face 会绑定到普通 Host Session。

`admitHumanTurn({ receivingSessionId, revision, rpcId, content, mode })` 是唯一 materialization interface。API Proxy 先通过普通 attachment service 提升浏览器图片，随后 receiver 在调用高层 adapter 前持久保留 `rpcId`、规范化 content、mode 与 digest。receiver 在持有 transaction 时解析持久化 Account／Project binding，并通过 admission context 传递精确本地 Workspace id；adapter 不会重入查询 receiver service。adapter 复用 opaque receiving id 作为 Host `SessionId`，关联 Workspace，追加可忽略的 `member-question/received` 与 `member-question/settled` record，以稳定 plugin message id 注入每条有界 brief，接纳稳定 human message，并 flush 普通 Session log。adapter 返回后才提交 materialization 与 admission。失败会保留 reservation；重试必须提供相同 action 与 `rpcId`，稳定 Session／message identity 和日志会识别已完成阶段。该机制闭合 adapter 成功与 ledger commit 之间的 crash interval，而不向调用方暴露 `session.create` 后再 `prompt`。arrival 永远不会调用 adapter。

## Supersession check

本记录拥有 receiver persistence、Host API projection、recovery、expiry、settlement 与 human admission。较早的 renderer-authority 决策已完整并入本记录；[renderer-only Session-face note](../feature/2026-08-30-web-receiving-experience-assembly-fixes.zh.md) 继续拥有对外 face 与合成卡装配。[member-question sender note](../feature/2026-08-28-member-question-sender.zh.md) 继续拥有 asking-side 单 pending promise 与 first-claim publication。

## Alternatives considered

**保留 `ReceivingQuestionBook` authority 并持久到 browser storage。** 拒绝，因为浏览器不拥有认证 Account authority、全局 first claim、进程重启、Host Session materialization 或能让所有 Installation 一致禁用的 clock。

**在提问 arrival 时创建 Host Session。** 拒绝，因为 arrival 是 collaboration notification，不是运行本地 agent 的 human intent。提前创建 Session 与 agent 会削弱零模型保证，并为被忽略的提问增加空 durable conversation。

**分别暴露 `createReceivingSession()` 与 `prompt()`。** 拒绝，因为两次调用之间的 crash 或 retry 会创建重复 Session、丢失第一条 human message 或重复 admit。一个处于 durable `rpcId` reservation 下的高层 adapter 拥有两个动作。

**只存 reference path，再从 receiver Workspace 取文档正文。** 拒绝，因为 sender 文件才是 authority，而 receiver Workspace 的同一路径可能包含不同文件。ledger 保留有界传输字节，使 restart 与 details 聚焦保持精确决策材料。浏览器图片 attachment 仍在该 ledger 外，因为 attachment service 拥有它们。

**把 renderer countdown 当作 expiry authority。** 拒绝，因为暂停或断连的 renderer 无法结算全局状态，并可能在 Installation 间产生分歧。Host clock、canonical terminal authority 与 durable commit 建立唯一 outcome。

**把 Decision Brief 放在 `question/requested` 旁边。** 拒绝，因为字段放在 item intent 上能让任一被转发的提问保持自包含，并避免为同一 sender payload 建立第二套编码。

## Consequences

Receiver 状态可在 Host 重启后恢复，并以稳定 Host identity 暴露唯一权威 pending/terminal projection。同路线 replacement、expiry、answer、decline 与跨设备 winner 按一个顺序提交。浏览器 reload 与 reconnect 会保留相同 id 与记录，且不创建 Host Session 或模型路径。普通提问与 plan-review 提问保留现有 Host-session 流程。

显式 human admission 无需两跳 client protocol 即可重试，Web Host 通过 API Proxy 挂载该 adapter。Workspace selection 与已传输决策材料能在 Host restart 后恢复，也不会按 display title 猜测或读取 receiver 本地文件。跨机器 first-claim publication 在 project-registry transport 存在前仍由注入提供，因此生产环境中需要它的转换会 fail closed。文件格式为预发布版本 `2`，没有 compatibility shim。

## Testing

Focused public-interface tests 覆盖幂等与冲突 arrival、环境 persistence、Workspace binding replacement 与 restart recovery、expiry 与 supersession ordering、reservation retry、callback containment、严格 wire 字段和 invalid durable state。Client Runtime 测试固定高 revision projection、双 Installation terminal presentation、founder 与 invitee binding、按 remote 恢复 Project、admission RPC 与 materialized route binding。Keyless Host 测试通过清理凭据的受管理 process-tree 边界执行本地 Git clone 与 origin inspection，拒绝陈旧 Workspace id，并清理本次操作拥有的 partial clone。真实 Web composition 证明 arrival 不创建 Session 或模型请求，显式提交只创建一个 Host Session 与一个 turn，post-create／post-record／post-prompt 失败使用相同 `rpcId` 恢复，后续同路线 arrival 保留 record，receiver 与 Session persistence 在 restart 后仍可恢复。归属 built-Web 的 keyless snapshot 固定 bounded received record 以及 brief 先于 human 的模型 transcript。可运行的 TypeScript SDK snapshot 与 Python single-executable expected output 都保留这两个 ignorable event envelope。
