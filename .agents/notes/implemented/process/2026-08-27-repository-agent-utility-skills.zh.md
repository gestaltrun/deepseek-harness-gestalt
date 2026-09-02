# Agent Note: 仓库级智能体实用技能

Status: implemented

[English](2026-08-27-repository-agent-utility-skills.md) | 中文

## Problem

仓库智能体需要共享的可视化讲解、技能评估、复盘、文字清理和浏览器操作工作流。个人目录中的技能安装不能让每个仓库检出获得相同指引。浏览器自动化还需要稳定选择账号：ego Task Space 从用户 Profile 继承登录状态，而 Profile ID 和当前默认值都可能独立于本仓库发生变化。

## Decision

仓库在 `.agents/skills` 下保存 `show-me`、`skill-doctor`、`retro`、`implement-spec`、`unslop`、`ego-browser` 和 `dsh-desktop-test-instance`。这些是仓库智能体工作流，不会增加 DeepSeek Harness 运行时包，也不会改变已发布的 Bundle。[`.agents/skills/SOURCES.json`](../../../skills/SOURCES.json) 会固定各自的上游来源并记录本地适配，每个上游 Skill 目录则保留对应上游的 MIT 声明。生成的[第三方声明](../../../../THIRD_PARTY_NOTICES.md)会披露同一组记录。

仓库内的 `ego-browser` 要求使用名为 `DSH` 的 ego Profile。其 helper 会在创建、复用、claim、takeover 或 completion 前通过 `listProfiles()` 解析该 Profile；创建时将返回的 ID 传给 `globalThis.ego.createTaskSpace(name, profileId)`；遇到属于其他 Profile 的同名 Task Space 时则拒绝继续。如果该名称不存在或不唯一，helper 会失败。同一用户目标通过 gitignore 的[运行时备忘](2026-09-02-desktop-test-instance-and-runtime-memo.zh.md)复用一个 DSH Task Space。安装由用户自行下载并经过 macOS 信任流程；Skill 不会下载安装器、替换应用、删除 quarantine 元数据，也不会以 root 身份调用安装器。

解释器生成的缓存和本地技能报告不进入版本控制。`skill-doctor` 使用自包含 HTML 渲染建议 diff，不会提交第三方 JavaScript Bundle。

## Verification

仓库技能元数据和文档检查覆盖已安装文件。真实 ego 运行时检查会创建一个临时 Task Space，验证 `profileName` 为 `DSH`，并在断言后删除该 Space。负向运行时检查会在另一个 Profile 下创建临时 Space，并验证 DSH resolver 在 claim 或 takeover 前拒绝该 Space。

## Alternatives considered

**只把技能安装到各智能体的个人目录。** 这样会让仓库行为取决于某台机器的配置，变更也没有仓库评审路径。

**使用 ego 当前默认 Profile。** GUI 默认值可以变更，可能选中与本仓库无关的账号。

**保存当前的 `Profile 2` ID。** Profile 变化后或换一台机器时，ego 可能分配不同 ID。按唯一的 `DSH` 名称解析，可以保留目标账号，而不把本地标识符当成配置。

**保留打包后的 diff 渲染器。** 该 Bundle 会给仓库工作流带来不透明的依赖闭包和许可证负担。原生转义 HTML 同样能让报告保持本地、自包含，而无需复制该运行时。

## Consequences

在本仓库中运行的智能体会获得相同的共享工作流。浏览器操作会在 Profile 配置错误时停止，不会静默使用其他账号。以后更新上游 Skill 时，必须刷新 `SOURCES.json`、保留许可证，并保留或有意修订仓库适配。
