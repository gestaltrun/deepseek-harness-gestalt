# Agent Note：分层 standby 就绪验证

状态：已实现

[English](2026-08-24-tiered-standby-readiness.md) | 中文

## 问题

持久化 Linux 与 Windows standby 池会在每次 master push 后运行完整的非分片清单。这些长时间演练可能与普通合并流量重叠，而保留的 workspace 输出和依赖树会让绿色结果依赖可变的 Runner 状态。即使必需的 hosted 路径健康，其失败看起来也像产品回归。

## 决策

每次 master push 会在两个 standby 平台上各运行一次有界 smoke。每个 job 都会清理全部被忽略和未跟踪的 workspace 状态，在启用 optional dependency 的情况下重建 `node_modules`，并且只在 checkout 外保留内容寻址的 pnpm store。仓库自有的 `supportedArchitectures` 将普通安装限定到当前 OS、CPU 和 libc，因此持久 Runner 的全局 pnpm 配置不能把依赖树扩张到全部平台；隔离的 Wine 快照会显式把 Windows 加入该矩阵。每个 standby job 会在安装后立即执行当前平台的 Codex 与 Claude Code 载荷，让 optional download 缺失在 build 或完整清单开始前就失败。随后 Smoke 会验证 optional dependency import、官方 package 与 Web build、Browser Runtime 行为，以及平台特定的文件系统、进程、Session 或 Electron fixture。每个 job 的 timeout 为 20 分钟，并发布结构化就绪报告；summary 会标出独立的 failover 开关。

完整的非分片 Linux 与 Windows 清单按日运行，也可以通过显式的 `standby-exhaustive` workflow dispatch 启动。它们会在运行现有串行聚合流程前执行相同的干净安装，timeout 为 120 分钟。其报告会把失败分类覆盖为 `failover-readiness`；有界 smoke gate 则直接携带该 failure domain。因此 CI 指标会保留这些证据，但不会把 standby 失败计为产品回归。

Linux 与 Windows failover 变量仍相互独立。响应者在只把受影响平台的变量设为 `selfhosted` 并重跑被阻塞的 PR 前，需要查看该平台最近的 smoke 与 exhaustive artifact。

## 考虑过的替代方案

**在每次 master push 上运行两套完整清单。** 拒绝，因为重复的长时间串行工作会延迟就绪结论，并与其本应保持可用的池争用资源。

**只运行每日完整清单。** 拒绝，因为 master 变更破坏 checkout、install、build、Browser Runtime 或平台 fixture 后，最长一天内都可能无法发现。

**在演练之间保留 `node_modules` 与 build 输出。** 拒绝，因为这些可变树可能掩盖 optional dependency 缺失，或使结果依赖前一次 checkout。只有内容寻址的依赖下载与受控的机器工具可以保留。

## 后果

每次 master 变更都会获得有界的平台就绪证据，而较慢的完整性证明拥有明确的每日与手动 owner。首次 master push 与手动 exhaustive dispatch 必须在真实 Runner 上证明两个平台；本地执行只能证明 Linux smoke 清单，不能代替该真实证据。
