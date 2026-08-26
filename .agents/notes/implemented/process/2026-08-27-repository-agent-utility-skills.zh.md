# Agent Note: 仓库级智能体实用技能

Status: implemented

[English](2026-08-27-repository-agent-utility-skills.md) | 中文

## Problem

仓库智能体需要共享的可视化讲解、技能评估、复盘、文字清理和浏览器操作工作流。个人目录中的技能安装不能让每个仓库检出获得相同指引。浏览器自动化还需要稳定选择账号：ego Task Space 从用户 Profile 继承登录状态，而 Profile ID 和当前默认值都可能独立于本仓库发生变化。

## Decision

仓库在 `.agents/skills` 下保存 `show-me`、`skill-doctor`、`retro`、`unslop` 和 `ego-browser`。这些是仓库智能体工作流，不会增加 DeepSeek Harness 运行时包，也不会改变已发布的 Bundle。

仓库内的 `ego-browser` 要求使用名为 `DSH` 的 ego Profile。其 Task Space helper 每次操作都通过 `listProfiles()` 解析该 Profile，将返回的 ID 传给 `globalThis.ego.createTaskSpace(name, profileId)`，并拒绝复用属于其他 Profile 的同名 Task Space。如果该名称不存在或不唯一，helper 会失败。

解释器生成的缓存和本地技能报告不进入版本控制。`pierre-diffs.js` 渲染器 Bundle 的模板字符串含有字面空白，因此其路径会关闭 Git 的 `blank-at-eol` 检查，不会削弱其他文件的空白检查。

## Verification

仓库技能元数据和文档检查覆盖已安装文件。真实 ego 运行时检查会创建一个临时 Task Space，验证 `profileName` 为 `DSH`，并在断言后删除该 Space。

## Alternatives considered

**只把技能安装到各智能体的个人目录。** 这样会让仓库行为取决于某台机器的配置，变更也没有仓库评审路径。

**使用 ego 当前默认 Profile。** GUI 默认值可以变更，可能选中与本仓库无关的账号。

**保存当前的 `Profile 2` ID。** Profile 变化后或换一台机器时，ego 可能分配不同 ID。按唯一的 `DSH` 名称解析，可以保留目标账号，而不把本地标识符当成配置。

## Consequences

在本仓库中运行的智能体会获得相同的五个工作流。浏览器操作会在 Profile 配置错误时停止，不会静默使用其他账号。以后从上游更新 ego Skill 时，必须保留或有意修订仓库专用的 `DSH` 规则。
