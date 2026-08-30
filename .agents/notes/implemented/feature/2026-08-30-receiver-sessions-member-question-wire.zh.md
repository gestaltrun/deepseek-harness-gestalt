# Agent Note：接收会话与路由成员问题的线上接受

Status: implemented

[English](2026-08-30-receiver-sessions-member-question-wire.md) | 中文

## 问题

工单 #344 M2 是成员问题路由的接收侧。T5 发送方编码的 `member-question` 请求携带由 T4 codec 定界的决策简报（发起方身份、背景、材料引用、过期时刻），但接收侧的线上协议只接受裸的 `member-question` 标签：路由来的请求沦为匿名泛型问题——没有简报、没有接收会话、没有过期、没有 supersede。

## 决策

携带字段挂在 intent 上，而不是另立帧字段。`AskUserQuestionIntent` 的 `member-question` 变体增加 `questionId`、`originSessionId`、`toProjectMember`、`origin`（T4 定界的公开身份）、`background`、`references` 与 `expiresAt`；`askUserQuestionItemSchema` 逐字段镜像且全部必填，因此不完整的简报或未知标签在帧处 fail-loud，而不是退化为泛型渲染。发送方 `MemberQuestionSendPayload` 的词汇不变——intent 就是同一份简报，一套编码，没有第二套协议。

接收会话是纯渲染层身份。dsh-client-runtime 中的 `ReceivingQuestionBook` 将被认领的批次（每个问题携带同一简报）路由到一个本地会话：会话 id 由路由键 `<originSessionId>::<toProjectMember>` 确定性推导，标题取简报首条来源行（`项目 — 来源会话`）。不创建 host 会话、不构建 Session 实例，因此接收会话在结构上不可能携带本地模型输出。SessionManager 把 book 行合并进列表快照，并按合成 id 跟踪待答圆点；被认领的帧不再向本端永远不会实例化的来源会话 id 缓冲。

每个路由键只有一张卡。更新的请求会把仍 pending 的旧问置为 `superseded`（带终态时刻）；已达终态的旧问不会被改标。`question/resolved` 将 `answered` 映射为已回答、`cancelled` 映射为已撤回；`decline()` 与 `markAnsweredElsewhere()` 覆盖接收方拒绝与跨设备结算。携带的 `expiresAt` 仍是两端共用的过期时刻，[仅渲染接收 Session face](2026-08-30-web-receiving-experience-assembly-fixes.zh.md) 负责当前唯一的最早截止时刻 timer 与已结算 wait 发布。旧问倒计时已过时，过期优先于 supersede。

## 已否决的替代方案

**把简报挂在 `question/requested` 帧上、批次旁边。** 否决：M1b 的 slots 已经从批次上取每请求的呈现面，字段放在 item intent 上让请求自包含——转发一个问题时其完整简报随之而行。

**在接收方创建真实 host 会话。** 否决：host 会话拥有 agent 与模型循环；接收会话是决策界面，"零本地模型输出"必须是结构性保证而非约定。

**每张接收卡片一个 timer。** 否决：book 只需要最早的活跃截止时刻，并在记录变化时重新计算。

## 后果

泛型与 plan-review 请求的 host 会话流程不变。接收会话行不进入 `session.list`，并保持客户端本地。它们的仅渲染 Session face 会暴露真实的 pending 响应载体，却不创建 Host Session；接收成员身份的 boot 装配（当前为 `'self'` 默认值）与跨安装投递仍是分立的组合工作。

## 测试

`packages/host/apiproxy/tests/rpc-schemas.spec.ts` 固定 item 与帧对携带简报的接受，并拒绝未知标签及每个必填字段缺失或越界。`packages/client/runtime/tests/receiving.client.spec.ts` 固定 intent 收窄、路由键与确定性 id、单待答 supersede、注入 timer 过期、撤回传播，以及真实 `SessionRuntime` 的对外 `SessionFace`。`packages/interaction/user-questions/tests/user-questions.spec.ts` 固定携带 intent 通过 `ask()`。
