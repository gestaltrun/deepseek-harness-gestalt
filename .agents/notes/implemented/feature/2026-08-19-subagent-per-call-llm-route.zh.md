# Agent Note: 按次为 subagent 指定 LLM provider 和 model

Status: implemented

[English](2026-08-19-subagent-per-call-llm-route.md) | 中文

## Problem

父级模型无法把单个委派子 agent 送到另一条 LLM 路由。每个 `dsh-tool-subagent` 实例要么继承父会话当前的 provider 和 model，要么使用部署钉死的 `agentOptions`。workflow 已经通过 `request.agentOptions` 转发每个子 agent 的 `provider` 和 `model`；面向模型的工具没有。进程外后端会静默忽略该字段。

## Decision

`SubagentCapabilities.agentOptions` 是 `request.agentOptions` 的启动期标志。进程内 spawn 和 fork 声明该能力。ACP、Codex、Claude Code 和 SDK 后端通过 `NO_START_CAPABILITIES` 将其声明为 false。标志为 false 时，一次性 `start` 只要带上 `agentOptions` 就会以 `UNSUPPORTED_CAPABILITY` 拒绝。

在具备该能力的后端上，面向模型的工具公开可选的 `provider` 和 `model` 字符串。这两个名字是 LLM 适配器路由和模型 id（例如 `deepseek-official` 和 `deepseek-v4-pro`），不是工具配置的 subagent 后端。两个字段都可以单独传入。调用值覆盖部署 `agentOptions`；省略的字段保留该默认值，然后再继承父会话路由。空值或纯空白会在启动前失败。不具备该能力的后端会省略这些字段，在挂载时拒绝部署钉死，并在执行时拒绝未声明的额外键。

传输后端选择仍属于配置：一个工具实例仍然只绑定 spawn、fork、ACP 等其中之一。[能力 seam 说明](2026-06-21-subagent-capability-seam.zh.md) 记录了这一区分。显式 `request.agentOptions` 仍然优先于[父会话当前路由继承](../bug-fix/2026-08-18-subagent-inherits-live-parent-model.zh.md)。

## Alternatives considered

**始终展示 `provider`/`model`，并在 ACP/Codex 上忽略它们。** 违反 seam 规则：不受支持的启动期选项必须被拒绝，绝不能先接受再忽略。

**把新字段当成传输选择器。** 会把 spawn 与 fork 收进同一个 schema 枚举，并撤销“一个工具绑定一个后端”的约定。

**在 schema 里枚举 `listProviders()`/`listModels()`。** catalog 条目只是建议，且会随适配器拓扑变化，从而抖动父级 KV-cache 前缀。无效路由仍通过现有的适配器缺失路径失败。

**同一切片附带 `effort`。** 推理强度由适配器拥有且绑定具体模型；workflow 已经把它延期。

## Consequences

具备该能力的 `subagent` 或 `subagent_fork` 调用可以把 Flash 工作交给 Pro 父级，或反过来，而不需要另一个工具实例。部署 `agentOptions` 钉是默认值，不是上限。对不具备该能力的后端调用 workflow `agent({ provider, model })` 现在会明确失败。更换路由的 fork 子 agent 仍会收到继承来的已完成轮次种子；不承诺在新路由下复用前缀。

## Testing

`packages/subagent/subagent/tests/service.spec.ts` 在提供方启动前拒绝不受支持的 `agentOptions`。`packages/subagent/tool-subagent/tests/tool-subagent.spec.ts` 固定 schema 是否出现、调用覆盖配置的合并、只传 provider 或只传 model、挂载拒绝、额外键拒绝，以及空字段拒绝。无密钥组装的 tool-schema 快照会记录 spawn/fork 工具上的新可选字段，以及产品后端上它们的缺席。
