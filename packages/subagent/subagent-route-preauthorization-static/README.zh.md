---
description: "贡献部署所有精确子 LLM 路由的静态 Provider。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-route-preauthorization-static

[English](README.md) | 中文

## 概述

本包是 `ctx.subagentRoutePreauthorization` 的静态 Provider。必填的 `allowedModels` 数组属于部署配置，与用户 Settings 相互独立。

## 使用本包

用非空 provider 与 model ID 挂载此默认导出的 Service Provider。直接程序构造与 Loader 配置都会拒绝畸形条目。Provider 在发布不可变服务快照前复制、去重并排序路由。

Consumer 先加载或 Provider 先加载都通过 Consumer 的 Cordis injection 正确收敛。dispose 此 Provider 会移除服务及部署启用的 Consumer 注册；重新安装会发布一份全新快照。

## 模型体验

通过把贡献路由快照记录进全新顶层 Session 的 Consumer 间接影响模型。

#### KV Cache 影响

Provider 本身不增加 token。Provider 被替换后，已记录的 Session 策略仍让 Consumer 的路由选择 schema 保持稳定。

## 已知限制与延期工作

- **静态生命周期配置** — 修改路由需要替换 Provider fiber；已有 Session 策略保持不变。
