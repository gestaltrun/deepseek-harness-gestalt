# Agent Note: Phone quality-gate lint, coverage, and clone repair

Status: implemented

[English](2026-09-05-phone-quality-gates.md) | 中文

## Problem

#566 之后，Draft Phone CI 仍有三处确定性红灯：`phone-stream` 路由测试中两处 `JSON.parse` 的 `any`，`phone-stream`、`ui-phone` invariant/registry 与 `phone-environment` 的逐文件覆盖率不足，以及 jscpd 克隆（Desktop overlay 手机图标与 Phone tab 图标；agent 与 screenshot 的进程树等待；iOS 正立与旋转手势投影；phone-stream session/agent/devices 的 JSON-API 准入）。

## Decision

路由测试把 HTTP JSON 解析为 `unknown`，并在访问成员前收窄为对象清单。覆盖率测试驱动 #566 之后仍存活的分支：嵌套/浮动 Phone tab 查找、Android H264 采集超时与意外采集失败，以及 io socket 上不完整或畸形的采集证据。invariant 伴生的占位 chrome 保持惰性（`component` 返回 null；`gate.subscribe` 为空操作订阅）；未使用的 body 工厂不会被调用，因此该路径并不能补上 `invariant.ts` 剩余的覆盖缺口。16 网格手机图标只在 ui-primitives 的 `IconPhoneOutline16` 中存在一次。一次性 agent 与 screenshot 命令共用 `awaitMobilecliTreeExit`：它在调用 `tree.stop()` 之前先挂上一个 deferred Promise（含已经 aborted 的 budget），再吸收该次调用的结算、收住同步 `stop()` 抛错、等待子进程退出，并在所有路径上移除 abort listener。`stop()` 期间再次 `budget.abort()` 不会变成第二次 abort 回调：listener 是 `{ once: true }`，且 `AbortSignal.abort()` 是幂等的。exit 之后不会再 stop 一次。halt 分类与 join 之后的包装仍由调用方负责。iOS 坐标 IO 通过同一个 `iosPortraitGesture` 投影 tap 与 swipe：正立 tap 仍是 tap，非正立 tap 是同一肖像点上的零长度 swipe，swipe 仍是两端点投影后的 swipe。session、agent 与设备列表 handler 共用 `admitTrustedJsonApi`，在路径或 body 工作之前处理关闭 503、未信任 403 与方法 405。Owner teardown 先置 `this.closing` 再关闭 HTTP 准入（先 `await fence` 再 `await http`），因此 `PhoneHttpTransactions.run` 在围栏之后仍可进入 handler；该 handler 必须 503 且不得调用后端。公开的 owner 与 transactions 生命周期测试钉住 `{ closing: true, handlerEntered: true }` 且无后端调用。capture 准入仍是 loopback 专用。await 之后的关闭检查仍保留。`cleanupDeadline` 在竞态之前分配 timeout Promise 与 timer，并始终清除该 timer。

## Alternatives considered

**保留无类型 `JSON.parse` 或关闭该 lint。** 拒绝：该 gate 就是缺陷。

**忽略剩余覆盖率行或降低阈值。** 拒绝：仓库逐文件 100% 就是约定。

**只改写表面语法以规避 jscpd。** 拒绝：overlay 与 tab strip 必须共用同一字形，两个一次性 runner 必须共用同一 abort 等待，iOS 正立与旋转手势必须共用同一投影器，三个 JSON-API handler 必须共用同一准入检查。

## Consequences

Host 与 Desktop overlay 绘制同一手机图标。agent 与 screenshot 仍各自分类退出；只共享等待。iOS 正立 tap 与旋转零长度 swipe 共用同一投影器。session、agent 与 listing 路由共用同一 JSON-API 准入；capture 仍受 loopback 围栏。#566 的语义 IO 与采集身份测试仍是权威。#572 的隐藏呈现与 native containment 不纳入本次修复。
