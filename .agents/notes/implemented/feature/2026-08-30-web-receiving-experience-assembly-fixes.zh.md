# Agent Note: 成员提问接收方的 identity-stable Session face

Status: implemented

[English](2026-08-30-web-receiving-experience-assembly-fixes.md) | 中文

## 问题

manager 层的 selection 对接收 Session 列表行并不足够：没有对外 `SessionFace` 时，`SessionRuntime` 会构造 Host 支撑的 `Session`，打开历史，刷新 subagent，并暴露模型、命令、skill、队列与 prompt 路由。此时决策简报在 renderer seam 上没有真实的 `PendingWait<'question'>`。该 face 必须适配 Host receiver 状态，而不取得 expiry 或 settlement authority。

成员提问卡片需要在动态插件行之间使用 `QuestionPresentation` 值。动态 client 行的跨插件值必须经由供应方的 `/client` 模块表行，而不是静态 presentation 子路径。

## 决策

`ReceivingQuestionBook` 为每个 Host `ReceivingSessionId` 持有一个身份稳定的 `SessionFace`，并为每条 pending 记录持有一个真实的 `PendingWait<'question'>`。materialization 之前，该 face 发布一个已打开、非 blank 的对话快照：Chat、队列、投影值与历史均为空，并携带 pending wait 与公开 terminal record band。重复读取快照会复用同一 wait 对象。回答或拒绝使用精确的 Host settlement RPC；revision 更高的 Host 状态会先结算并替换 wait，再发布后续 pending 或 terminal projection。

book 只应用 revision 更高的完整 Host snapshot。断连会保留已有行与 wait，不会虚构 terminal；重连或浏览器 reload 会接纳 Host baseline，包括从未在本地 materialize 的 terminal-only 行。Expiry、supersession、withdrawal 与 canonical settlement winner 都是 Host fact。卡片 countdown 仅用于展示。

`SessionRuntime` 把每个可寻址 id 绑定到对外 `SessionFace`，并可选持有具体 Host `Session`。只有 materialized face 会绑定 Agent scope dispatch point，打开或翻页历史，执行重同步，刷新 subagent，并参与 scope prune 的实例拆卸。materialization 之前，选中接收 Session 与重连会跳过 subagent 刷新，model／command／skill routing 返回不可用，prompt 只调用 member-question admission RPC。snapshot 携带权威 `hostSessionId` 时，现有 face 会绑定到 Host-backed Session，不替换 row、pending wait 或 terminal record。

已有 Host Workspace 成员资格的接收行出现在该 Workspace 下。Workspace 浏览器按到达边沿观察 pending 身份，并为每个新 pending 身份打开绑定 Workspace（若 Host 列表尚未关联 Session 则打开 Ungrouped）一次，而不更改当前 Session。人类随后可以折叠它；同一 pending 身份的普通更新不会再次打开。

跨插件值导入使用供应方的动态模块表行。`dsh-client-ui-user-questions/client` 导出 `QuestionPresentation`；`dsh-client-ui-member-questions` 导入该行，并在 `dsh.client.external` 中声明。runtime 将 `dsh-user-questions` 类型依赖声明为 peer 与开发输入，而 `ui-member-questions` 的静态 `ui-slots` 编译输入仅留在开发依赖中。

## 已考虑的替代方案

**只在 `SessionManager.select` 中接纳 receiving id。** 否决：selection 不是 renderer seam。`SessionRuntime.currentProvideInfo` 仍会暴露 Host 支撑 Session，并触发历史与 subagent RPC。

**创建 Host Session，再用约定保持模型沉默。** 否决：每个普通 Session 都携带 Host 变更与模型路由。仅渲染 face 从结构上确保没有本地模型输出。

**让浏览器结算 expiry 或 supersession。** 否决，因为断连的 Client 可能产生分歧，也无法发布 canonical cross-Installation result。Host receiver 拥有 clock、first claim 与 durable terminal。

**向 `PendingWait` 增加结算状态。** 否决：pending 列表的成员资格仍是 renderer contract。现有私有 settled guard 已能让延迟响应 fail-loud。

## 后果

标准 Session renderer 通过与 Host 问题相同的对外 face 和 `PendingWait` 接口观察成员提问，但不获得业务 authority。receiving card 挂载共享 input state；显式提交调用单次 Host admission RPC，失败会保留 draft 并展示可操作 diagnostic。新的接收行会在侧边栏中变得可见，同时用户当前的 Session 保持选中。

浏览器 E2E 与必需的演示 GIF 仍是分立的验收证据；本决策只记录不依赖 React 的 runtime 与 client 装配行为。

## 测试

`packages/client/runtime/tests/receiving.client.spec.ts` 使用 `FakeApiClient` 驱动真实 `SessionRuntime` 实例，选中 Host-id 行，并观察 `currentProvideInfo.hooks.session.getSnapshot()`。测试固定 Host revision 顺序、answer 与 decline RPC、断连保留、terminal projection、双 Installation answered-elsewhere 派生、产品 composer admission、reserved `rpcId` 恢复，以及 renderer `session.create` 调用为零。`packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx` 固定到达边沿展开与到达后的人类折叠。`apps/web/tests/member-question-receiving.e2e.ts` 驱动认证 ingress，经过随发行版交付的 Host receiver、API Proxy、WebSocket Host stream、Client Runtime、动态模块表、叠加式 Decision Brief dock、产品 composer、共享问题呈现、exceptional terminal band、restart 与 reload；它断言恢复完全相同的 pending／terminal record，绑定 Workspace 中有一个 Host Session，且到达不产生模型请求。`pnpm run build:lib:client` 与 `pnpm run verify-client-packages` 覆盖 client 模块行与 package 声明。
