# Agent Note：Draft 影响面证据

状态：已实施

[English](2026-08-24-draft-impacted-evidence.md) | 中文

## 问题

即使仓库能够识别一个很小的 package 改动及其 consumer，每次 Draft 改动仍要承担完整的平台、artifact、SDK 和 Windows 矩阵。仅按路径过滤并不充分，因为它可能遗漏下游 package、变更源文件覆盖率或组装态行为，同时把未知输入静默当成低风险。

## 决策

CI Planner 提供两个级别。Ready PR 和所有非 PR 事件选择 `exhaustive`。只有在 diff、package graph 和风险目录均可用、所有路径都已知且没有命中升级规则时，Draft 才选择 `impacted`。

package graph 将变更 package 路径映射为直接 package，并沿反向 peer dependency consumer 传递闭包。Draft 影响面命令会在这些 package 目录上运行 Vitest。仍存在的变更源文件会成为显式 coverage include，因此仓库的每文件 100% 阈值可以生效，而不会测量无关源码。只改测试或文档的 package 仍运行相同的 package 与反向 consumer 测试，但不会凭空引入全仓覆盖率要求。

文档路径会选择静态文档 lane。GUI 和模型可见路径除了 package 影响面外，还会选择组装态 consumer lane。Electron Browser Runtime 路径会选择 macOS runtime lane。workflow、lockfile、toolchain、vendor、protocol、session lifecycle、agent loop、构建系统、跨产品 area、空集合、不可用和未知改动都会选择穷尽证据。

稳定的 aggregate verdict 只评估计划选中的 lane。在 impacted Draft 中，它要求 preflight、存在时的 package 影响面，以及被选中时的组装态 consumer lane。在 exhaustive 计划中，它要求完整的阻塞清单。被选中的 lane 只要失败、取消或跳过，verdict 就会失败；未选中的 lane 保持 skipped，不会形成误报。

## 备选方案

**只按变更目录过滤。** 拒绝，因为直接路径无法识别反向 consumer，也不能证明 package 接口上的行为。

**运行 package 测试但不显式指定 coverage include。** 拒绝，因为发生变更但未被加载的源文件可能从覆盖率总体中消失。

**对 Ready review 使用 impacted 路由。** 拒绝，因为合并候选需要完整的集成与平台证据，不能依赖 Draft 迭代历史。

## 后果

低风险 Draft 迭代可以获得聚焦证据，而不消耗完整矩阵。本地也可以从显式 base 与 head ref 使用同一个 Planner 和影响面命令。package manifest 改动会改变该决策使用的 graph；graph 不可用时会升级。新增产品可见或高风险路径时，必须增加风险 fixture，证明其组装态 lane 或穷尽升级行为。
