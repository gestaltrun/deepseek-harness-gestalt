# Agent Note: 融入现有页面的高保真 UI prototype 变体

Status: implemented

[English](2026-09-02-fused-ui-prototype-variants.md) | 中文

## Problem

本仓库的 UI prototype 沿用上游 Matt 默认：若干套结构完全不同的皮肤，常常画在真空路由上，并把旁白和切换条当成页面的一部分。Gestalt 的新功能几乎都会嵌进现有的 Settings、Desktop 或账号池外壳，平行组件库会教错密度。智能体还在协调会话里画这些稿，并打开有窗口实例来判断稿是否就绪，既撑满上下文，也留下残留 Electron。

## Decision

[`prototype/UI.md`](../../../skills/prototype/UI.md) 仍然要求若干交互变体。每个变体都把新功能融入宿主页面和当前组件库。默认是 sub-shape A：现有路由、在该路由上用 `?variant=`、新功能使用 mock 数据。旁白、grilling 注释和切换条是脚手架；有窗口评审只展示高保真构图。

prototype 会话不是协调会话。[`orchestrate-dsh-delivery`](../../../skills/orchestrate-dsh-delivery/SKILL.md) 派发隔离的 Codex worktree 任务或 DSH subagent，并附上短 brief。该会话通过 [`dsh-desktop-test-instance`](../../../skills/dsh-desktop-test-instance/SKILL.md) 无头自检每个变体，只有请用户评审时才启动有窗口实例。[`to-spec`](../../../skills/to-spec/SKILL.md) 链接冻结稿和可丢弃分支；没有该稿就不得发布 UI spec。

## Alternatives considered

**保留上游「结构完全不同的皮肤」默认。** 这能回答「还能长成什么样」，但会丢掉功能真正上线时的外壳。交互多样性仍在布局和主操作上；视觉语言跟宿主页面。

**只画一份高保真稿，不要变体。** 这会欠探索新功能。变体仍在；它们必须融入现有页面。

**在协调 grill 会话里画 prototype。** 该会话已经装着 tracker 状态和实现上下文。独立 worktree 才让稿便宜可丢。

**先开有窗口实例做自检。** 可见窗口是给用户的。智能体在无头模式下就能判断外壳和组件是否融合。

## Consequences

prototype 分支仍是规划输入，不是生产历史。实现票按测试和生命周期规则重写获胜变体。规格引用冻结稿，而不是复述布局。协调会话更小，因为它不再承载绘制循环。
