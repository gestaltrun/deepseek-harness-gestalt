---
description: "部署所有的精确子 LLM 路由授权 Service Definition 与注册表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-route-preauthorization

[English](README.md) | 中文

## 概述

本包声明抽象的 `ctx.subagentRoutePreauthorization` Service Definition，表示一份部署所有的精确子 LLM 路由快照。Consumer 只在组合全新顶层 Session 时采样；该服务不读取或写入用户 Settings。

## 使用本包

挂载一个 Provider，例如 [`dsh-subagent-route-preauthorization-static`](../subagent-route-preauthorization-static/README.zh.md)。Provider 持有服务生命周期。Consumer 只在组合全新顶层 Session 时，从 Agent 或 preset 作用域采样一次 `snapshot()`；它不会 inject 该 Provider，也不会在 detach 或替换后再采样。

`snapshot()` 返回分离不可变的 `{ provider, model }` 记录。Consumer 把部署快照与已启用的用户授权取并集、排序、去重，并在公开路由选择前持久记录。恢复 Session 和子 Session 只读取已记录策略。

## 模型体验

通过把快照记录为 Session 路由选择策略的 Consumer 间接影响模型。

#### KV Cache 影响

服务本身不增加模型 token。Consumer 可以根据持久 Session 策略公开稳定的路由选择 schema。

## 已知限制与延期工作

- **每个服务作用域一个 Provider** — 在 Provider 配置中合并部署路由；用户授权仍是 Consumer 所有的独立并集输入。
