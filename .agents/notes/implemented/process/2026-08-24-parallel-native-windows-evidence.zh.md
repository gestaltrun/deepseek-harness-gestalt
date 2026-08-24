# Agent Note：并行原生 Windows 证据

状态：已实施

[English](2026-08-24-parallel-native-windows-evidence.md) | 中文

## 问题

完整原生 Windows 清单此前在一个托管 job 中串行运行。一次成功的实测 run 从 job 开始到完成花费 44 分 01 秒，因此评审者会在必需 Wine verdict 结束后继续等待很久，而且一个较晚的 gate 可能掩盖其他所有表面的状态。此前提高进程内并发已经暴露过 Windows worker 与 fixture 不稳定。

## 决策

原生清单按独立 artifact 所有权拆成 3 个普通 Windows job。`native build and runtime` 负责 workspace build、生产站点、Electron runtime、基于构建产物的 doc typecheck、package 发布检查、NodeNext 声明、构建 package invariant 和构建二进制冒烟。`native coverage` 负责两项完整覆盖率 gate，保留每文件 100% 阈值和 8 个隔离的单 worker shard。`native static portability` 负责源码静态 policy、除已归属站点与构建 doc typecheck 之外的文档检查、module graph、Knip 和 duplication。

两个标准 hosted Windows worker 各自拥有 8 个 single-worker 覆盖率分区中的 4 个，每次运行 2 个分区进程，并且只发布 Vitest blob。两个 worker 合计 4 个并发分区进程，在保留并行覆盖的同时，不会让单台 runner 内的 SQLite 与子进程测试因资源匮乏而超时。第三个 Windows worker 独立运行 coverage-exempt heavy 清单。两个 blob owner 成功后，一个 hosted Linux reducer 下载完整的自包含报告集合，在不执行测试或产品代码的情况下应用全仓阈值。现有故障切换池负责相同的 Windows shard 与 exempt-heavy 工作；纯数据 reducer 保持 hosted Linux。构建/runtime 与静态可移植性继续作为独立标准 hosted job。每个执行 job 都有独立的 immutable install 和 20 分钟 timeout，因此 setup 重复换来了互不共享可变构建产物的独立时钟。

`windows node 24 / native verdict` 会在构建/runtime、两个 coverage shard、coverage-exempt heavy 清单、coverage reduction 与静态可移植性全部结束后运行；任一 owner 失败、取消或跳过时都会失败。各 owner job 与 verdict 都保留普通且未掩盖的结论。verdict 仍位于必需 `all checks passed` aggregate 之外，而 Wine job 保持必需且不变。

完整本地 aggregate 是 3 个分区清单的精确拼接。gate 清单测试会拒绝重复或缺失 id、删除覆盖率阈值、丢失构建产物 doc typecheck，或意外转为允许失败。

## 备选方案

**在一个 job 内提高顶层并发。** 拒绝，因为各 gate 仍共享一个 job 时钟与可变 tree，而且此前高并发试验已经复现 worker 与 linker 故障。

**在 Windows 上保留 coverage reduction。** 拒绝，因为 Vitest blob reduction 不执行平台代码，而第二轮 Windows setup 会把阈值计算与 coverage-exempt suites 串行放在两个 shard owner 之后。

**删除与 Linux 重复的原生 Windows 证据。** 拒绝，因为平台特有的文件系统、进程、声明、文档和 package 行为会直接消失，而不是变快。

**让原生 verdict 成为 branch protection 必需项。** 拒绝，因为 Wine 仍是有界的必需 win32 信号，Windows 容量不应阻塞每次合并。

## 后果

原生 verdict 会在最慢的 Windows 执行 owner 加一次纯数据 reduction 后得出，不再承担第二段 Windows 执行尾巴。每个 owner 都会发布独立的结构化 gate 报告，因此失败会标识首个 gate 与已完成的同级证据。在托管 CI 证明一次成功的原生 verdict 不超过 15 分钟之前，不能认为延迟目标已经达成；仅有本地拓扑不是证明。
