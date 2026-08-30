# Agent Note: 成员提问接收方的仅渲染 Session face

Status: implemented

[English](2026-08-30-web-receiving-experience-assembly-fixes.md) | 中文

## 问题

manager 层的 selection 对接收 Session 列表行并不足够：没有对外 `SessionFace` 时，`SessionRuntime` 会构造 Host 支撑的 `Session`，打开历史，刷新 subagent，并暴露模型、命令、skill、队列与 prompt 路由。此时决策简报在 renderer seam 上没有真实的 `PendingWait<'question'>`。由读取触发的过期同样不足，因为没有后续投递或快照读取时，已挂载的卡片可能在携带的截止时刻之后仍可作答。

成员提问卡片需要在动态插件行之间使用 `QuestionPresentation` 值。动态 client 行的跨插件值必须经由供应方的 `/client` 模块表行，而不是静态 presentation 子路径。

## 决策

`ReceivingQuestionBook` 为每个路由键持有一个身份稳定的仅渲染 `SessionFace`，并为每条 pending 记录持有一个真实的 `PendingWait<'question'>`。该 face 发布一个已打开、非 blank 的对话快照：Chat、队列、投影值与历史均为空，仅含该 pending wait。重复读取快照会复用同一 wait 对象。wait 保留 requested 帧原始的 `sessionId` 与 rpc id 用于协议响应，face 则保留确定性 `mq-recv:*` id 用于渲染与导航。解决、supersession、拒绝、跨设备结算与过期都会先调用 `markSettled()` 并移除 wait，再发布终态。

book 只在最早的活跃 `expiresAt` 上安排一个可注入 timer。添加、替换或结算记录都会重新计算该截止时刻；timer 无需另一次渲染或 wire 帧即可发布过期。连接代次结束时，book 结算已暴露的 wait 并取消 timer，但不虚构业务终态；只有下一代仍报告 pending 的请求才会在回放时新建载体。runtime 拆卸会取消同一个自有 timer。该 timer 决策部分取代[接收 Session 与成员提问 wire 接受](2026-08-30-receiver-sessions-member-question-wire.zh.md)中由读取触发的 sweep；后者仍对携带的 intent、路由键、确定性 renderer id 与终态记录状态具有权威。

`SessionRuntime` 把每个可寻址 id 绑定到对外 `SessionFace`，并可选持有具体 Host `Session`。只有 Host 变体绑定 Agent scope dispatch point，打开或翻页历史，执行重同步，刷新 subagent，并参与 scope prune 的实例拆卸。选中接收 Session 与重连都跳过 subagent 刷新，模型、命令与 skill 路由返回不可用。调用接收 face 的 prompt、取消、队列、重命名、附件、历史或命令行为会 fail-loud，而不会回退到 Host RPC。

接收行没有 Host Workspace 成员资格，因此位于浏览器的 Ungrouped 记账中。Workspace 浏览器按到达边沿观察 pending Ungrouped 身份，并为每个新 pending 身份打开该记账一次，而不更改当前 Session。人类随后可以折叠它；同一 pending 身份的普通更新不会再次打开。

跨插件值导入使用供应方的动态模块表行。`dsh-client-ui-user-questions/client` 导出 `QuestionPresentation`；`dsh-client-ui-member-questions` 导入该行，并在 `dsh.client.external` 中声明。runtime 将 `dsh-user-questions` 类型依赖声明为 peer 与开发输入，而 `ui-member-questions` 的静态 `ui-slots` 编译输入仅留在开发依赖中。

## 已考虑的替代方案

**只在 `SessionManager.select` 中接纳合成 id。** 否决：selection 不是 renderer seam。`SessionRuntime.currentProvideInfo` 仍会暴露 Host 支撑 Session，并触发历史与 subagent RPC。

**创建 Host Session，再用约定保持模型沉默。** 否决：每个普通 Session 都携带 Host 变更与模型路由。仅渲染 face 从结构上确保没有本地模型输出。

**只在投递或快照读取时过期。** 否决：截止时刻不保证发生读取。一个最早截止时刻 timer 能更新已挂载的 subscriber，且避免为每张卡片创建 timer。

**向 `PendingWait` 增加结算状态。** 否决：pending 列表的成员资格仍是 renderer contract。现有私有 settled guard 已能让延迟响应 fail-loud。

## 后果

标准 Session renderer 通过与 Host 问题相同的对外 face 和 `PendingWait` 接口观察成员提问，但不获得 Host 权限。接收 face 刻意不接受普通人类 prompt；从接收 Session 唤醒本地 agent 需要另外归属的 admission 设计。新的接收行会在侧边栏中变得可见，同时用户当前的 Session 保持选中。

浏览器 E2E 与必需的演示 GIF 仍是分立的验收证据；本决策只记录不依赖 React 的 runtime 与 client 装配行为。

## 测试

`packages/client/runtime/tests/receiving.client.spec.ts` 使用 `FakeApiClient` 驱动真实 `SessionRuntime`，选中合成行，并观察 `currentProvideInfo.hooks.session.getSnapshot()`。测试固定 wait 身份、原始协议 Session 身份、解决、supersession、timer 过期、断连结算与回放，不可用的模型／命令／skill／prompt 路由，以及 `session.create`、历史、subagent、模型、skill 与 prompt 调用均为零。`packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx` 固定到达边沿展开与到达后的人类折叠。`apps/web/tests/member-question-receiving.e2e.ts` 让一个 mock remote Agent 经过 shipped user-questions provider、api-proxy pending registry、WebSocket mux、Client Runtime、动态模块表、组合卡片、共享问题呈现、文档聚焦与 response POST；它断言不会增加 Host Session，也不会调用 `session.create`、`session.history` 或模型。`pnpm run build:lib:client` 与 `pnpm run verify-client-packages` 覆盖 client 模块行与 package 声明。
