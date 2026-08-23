# Agent Note: 首次运行不预置官方 DeepSeek

Status: implemented

[English](2026-08-22-first-run-does-not-mint-official-deepseek.md) | 中文

## Problem

首次运行的 Models 会列出从未写入的官方 DeepSeek（`deepseek-official`），引导弹窗也会索要该适配器的 API 密钥。添加 pi-ai 目录路由 `deepseek` 会写入 `DEEPSEEK_API_KEY`，与官方 DeepSeek 联接的是同一引用，于是未占用的官方行会出现在用户刚添加的目录行旁边。

用户需要「添加提供方」里的目录 `deepseek`。他们不希望首次运行预置官方 DeepSeek。

这翻转了 [首次运行官方 DeepSeek 列表](2026-08-20-first-run-official-deepseek-listing.md) 中从未写入即列出的规则。占用、残留 `user: {}` 以及删除折入仍在该记录中。

## Decision

`listedProviderRows` 只在占用或联接报告 `credential.configured === true` 时绘制一行。从未写入的官方分节不出现在列表中。目录 `deepseek` 已配置时，即使共享的 `DEEPSEEK_API_KEY` 已存储，未占用的官方行也不出现。

「添加提供方」仍提供目录 `deepseek`，从不提供 `deepseek-official`。

引导步骤 `configure-models` 不再收集官方密钥。没有可用提供方时打开「设置 → 模型」；「稍后配置」完成本步骤且不打开设置。

## Alternatives considered

**官方 DeepSeek 已挂载时不提供目录 `deepseek`。** 否决：用户会故意添加该目录路由；藏起它并不能去掉 `deepseek-official`。

**继续列出从未写入的官方 DeepSeek，以便首次运行有密钥字段。** 否决：那就是在用户没有添加的情况下预置官方 DeepSeek。

## Consequences

首次运行的 Models 页除「添加提供方」外是空的。官方 DeepSeek 只在占用之后，或已存凭据尚未被已配置目录 `deepseek` 占用时出现。`llm-deepseek` 设置分节已注册且未占用时，会话模型目录也不再提供官方 DeepSeek，因此新会话不会把该适配器的模型当成可选项。官方适配器仍作为组合事实保持挂载。

## Testing

`packages/client/ui-settings-models/tests/components.client.spec.tsx` 钉住从未写入的官方 DeepSeek 不在列表中、目录 `deepseek` 仍可添加，以及已配置目录 `deepseek` 隐藏未占用官方 DeepSeek。`packages/client/ui-settings-models/tests/onboarding-dialog.client.spec.tsx` 钉住「去配置」调用 `openSection('models')`，「稍后配置」完成且不打开设置。`packages/client/ui-settings-models/tests/readiness.client.spec.ts` 钉住没有任何可用提供方时为 `needs-config`。`packages/host/apiproxy/tests/api-proxy-config.spec.ts` 钉住 `llm-deepseek` 未占用时模型目录省略官方 DeepSeek，占用后保留。
