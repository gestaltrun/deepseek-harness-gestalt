# Agent Note: 托管 Windows 完整通道使用 2 个顶层门禁工作进程

Status: implemented
Archived: 2026-08-23

[English](2026-08-20-hosted-windows-two-gate-workers.md) | 中文

## 问题

原生 Windows 完整清单会运行 45 个门禁，其中包括逐文件 100% 覆盖率的一对门禁。顶层工作进程为 1 时，这些门禁在 `windows-latest` 上严格串行，墙钟时间等于每个门禁之和。一次成功的托管运行里，插桩覆盖率花费 1,113 秒，随后的免覆盖率较重门禁花费 238 秒。缩减该清单不可用：原生 Windows 仍须按受支持源码分母强制覆盖率。

## 决策

`windows-native` 在托管的 `windows-latest` 和故障切换池 `dsh-win-ci` 上都把 `DSH_GATE_CONCURRENCY` 设为 `2`。托管路径的 `DSH_COVERAGE_MAX_WORKERS` 仍为 `1`，因此这两项覆盖率门禁重叠时各自仍只有 1 个 Vitest 工作进程。两项覆盖率门禁都 `needs: ['build']`，避免插桩 Vitest 在 tsdown 仍在写 `lib/` 时加载它。生产站点与 Electron runtime e2e 可以和 build 重叠。免覆盖率较重用例不得设置短于 `DSH_COVERAGE_TEST_TIMEOUT_MS` 的单测超时；#210 之后首次重叠的托管运行里，20 秒的 `change-scope` 预算超时了。Windows 上的插桩 Vitest 扇出上限仍由 [原生 Windows 拉取请求 CI](2026-08-08-native-windows-pull-request-ci.md) 约束。必需的 Wine 作业和 `all-checks-passed` 图保持不变。

## 考虑过的替代方案

**把托管路径的 `DSH_COVERAGE_MAX_WORKERS` 提高到 2 或更大。** 预算为 2 时，两项覆盖率门禁仍各分到 1 个 Vitest 工作进程。预算为 3 才第一次让插桩门禁得到 2 个工作进程；而 16 核主机上 2 个及以上并发插桩工作进程已经出现退出或触发 Node 24 的 CJS lexer 致命故障。

**从 `check:ci:windows-complete` 中去掉覆盖率。** 这是通过省略 Windows 覆盖率清单来缩短托管作业，而不是让同一组门禁更多重叠。

**托管 Windows 继续使用 1 个顶层工作进程。** 这会保留完整通道约 32 分钟的串行运行。故障切换池已经在 2 个顶层工作进程下重叠过同一组门禁。

**让覆盖率与 build 不同步。** 否决：首次托管 concurrency=2 运行在 tsdown 仍占用 `lib/` 时启动了插桩覆盖率，随后一个 Vitest 工作进程意外退出。

## 后果

两个运行器池上的就绪门禁在声明的依赖满足后才会重叠。覆盖率等待 `build`；两项覆盖率门禁随后可以互相重叠，并掩盖其后的观察性工作。受支持源码 100% 清单、单测试 30 秒预算，以及托管路径上 1 个插桩 Vitest 工作进程均不变。[标准托管主 CI](2026-08-18-standard-hosted-primary-ci.md) 仍负责 `windows-latest` 选择器。
