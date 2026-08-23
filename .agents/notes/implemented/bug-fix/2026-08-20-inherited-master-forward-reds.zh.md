# Agent Note: 修复基线前移带入的 CI 红灯

Status: implemented

[English](2026-08-20-inherited-master-forward-reds.md) | 中文

## Problem

把 `origin/master` merge-forward 进 Mobile Companion 交付基线时，带入了三处并非任何在途票级 PR 引入的红色车道。Linux coverage 漏掉 `packages/subagent/tool-subagent/src/index.ts:283` 上 `requireRouteField` 的 true 臂（`field === 'provider' ? 'adapter route' : 'model id'`）。consumers 车道的 oxlint 拒绝 `packages/subagent/subagent-spawn-in-process/tests/spawn-in-process.e2e.ts` 里包在 `tool/call` `arguments` 外的无用 `String()`。jscpd 报告 `packages/browser/browser-runtime-tandem/src/index.ts` 中 navigate、focus、input 共用一段六行的 `assertBrowserNotAborted` + `exclusive` + `openPage` + `expectRevision` 前奏克隆。原生 Windows coverage 随后在同一 tandem 文件上失败：测试通过后仍漏计 unexpected-exit 调度（`processExited` 553–555）以及 reconnect / catch 路径（`scheduleRecovery` 578、582、592–595）；该文件的 Linux coverage 已经是 100%。master 推送车道不跑 PR 的 coverage、lint 或 duplication，因此这两处红灯原样出现在余下两张票级 PR 上。[此前的基线红灯修复](2026-08-19-inherited-ci-baseline-reds.zh.md) 与 [票级重跑握手说明](2026-08-20-ci-ticket-rerun-flakes.zh.md) 记录的是另一些失败。

## Decision

**空的 LLM 路由字段对两个名字都拒绝。** `requireRouteField` 仍对空或仅空白的 `provider` 与 `model` 抛错。tool-subagent 套件现在钉死三元表达式的两臂：`provider` 使用 `adapter route`，`model` 使用 `model id`。[按次路由说明](../feature/2026-08-19-subagent-per-call-llm-route.zh.md) 仍拥有这条拒绝规则。

**`tool/call` 的 arguments 保持为 string。** spawn-in-process e2e 直接断言 `call.data.arguments`。session 事件类型已经是 `string`；再包一层 `String()` 不改变值，却会触发 oxlint。

**一段 `mutateOpenPage` helper 拥有 mutation 前奏。** navigate、focus、input 调用该 helper，再执行各自的 HTTP 体。helper 没有被第四次复制；screenshot / close 保留各自不同的前奏。

**unexpected-exit recovery 在测试线程上调用。** `runtime.spec.ts` 使用两套 fixture：一套在把 `reconnect` stub 成拒绝后用仍存活的子进程 handle 调用 `processExited`，另一套在仍打开的页面上调用 `scheduleRecovery(..., true)`。这些调用跑在 Vitest 进程内，Windows v8 才能把它们记上。子进程 `done` 回调在 Linux 上已经到达同一批方法，但不作为 Windows coverage 排除项。[worker-thread 的 Windows 排除](2026-08-20-windows-worker-thread-coverage.zh.md) 保持不动；本文件不加入 `windowsRunnerCoverageExclusions` 或 `windowsOnlyCoverageExclusions`。`#171` 的 `remote-access` index 排除保持不动。

## Testing

`packages/subagent/tool-subagent/tests/tool-subagent.spec.ts` 拒绝空与仅空白的 `provider` 和 `model`，并匹配对应错误文本。`packages/browser/browser-runtime-tandem/tests/runtime.spec.ts` 与 `runtime-invariant.spec.ts` 维持 `src/index.ts` 的 Linux per-file 100%，并增加进程内 unexpected-exit / 被拒绝 reconnect 用例。spawn-in-process e2e 文件上的 oxlint 与 `pnpm run duplication` 分别拥有 lint 与克隆车道。

## Alternatives considered

**把 `browser-runtime-tandem/src/index.ts` 从 Windows coverage 排除。** 否决：漏计的是测试进程可以直接调用的普通方法，不是 [Windows worker-thread 说明](2026-08-20-windows-worker-thread-coverage.zh.md) 记录的那种 worker 归因缺口。排除会藏掉以后真正的漏计。

**保留 `String()` 并关掉这条 oxlint 规则。** 否决：这次转换是空操作。去掉它既保留断言，也满足规则。

**给 tandem 前奏加 `jscpd:ignore`。** 否决：三处调用共享同一份约定。helper 删掉克隆，而不是再批准第四份拷贝。

**把 `requireRouteField` 改成单一错误字符串。** 否决：两个字段名是 [按次路由说明](../feature/2026-08-19-subagent-per-call-llm-route.zh.md) 里模型可见的用词。覆盖率来自跑过两臂，而不是折叠诊断。

## Consequences

只合并本基线的票级 PR 不再继承这些 coverage、oxlint 与 duplication 红灯。Linux tandem coverage 保持 per-file 100%。Windows 对 recovery 方法的覆盖依赖进程内调用，而不是子进程退出回调。worker-thread 与 remote-access 的 Windows 排除不变。
