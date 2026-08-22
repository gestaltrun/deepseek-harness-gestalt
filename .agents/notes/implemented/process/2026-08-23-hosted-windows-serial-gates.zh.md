# Agent Note: 原生 Windows 完整通道串行执行顶层门禁

Status: implemented

[English](2026-08-23-hosted-windows-serial-gates.md) | 中文

## 问题

原生 Windows 完整通道在同一台主机上运行完整的构建、runtime、覆盖率、重型测试和发布清单。两个顶层门禁工作进程会让插桩覆盖率清单与免覆盖率重型清单重叠。串行化这些门禁消除了重叠，但插桩门禁在标准托管 Windows 上仍会同时启动全部 8 个单 worker shard。两种调度都会耗尽 runner：互不相关的进程 hook 和轮询测试超过各自预算，已经执行的分支从 V8 覆盖率中消失，而且相同代码的不同运行会出现不同失败集合。单独提高测试超时无法让过载运行变得确定。

## 决策

`windows-native` 在托管 `windows-latest` 和故障切换池 `dsh-win-ci` 上都设置 `DSH_GATE_CONCURRENCY=1`。完整清单保持不变，每次只执行一个已经就绪的顶层门禁。它保留作业内 8 个覆盖率 shard，但在标准托管容量上设置 `DSH_COVERAGE_PARTITION_CONCURRENCY=1`；16 核故障切换池保留实测的 8 路 shard 扇出。`DSH_COVERAGE_MAX_WORKERS`、30 秒覆盖率测试预算、完整历史检出和 120 分钟作业上限继续作为相互独立的边界。

此前的[双工作进程决策](../../archived/process/2026-08-20-hosted-windows-two-gate-workers.md)作为墙钟时间取舍的历史证据保留。完整通道继续保留受支持源码的完整分母；串行化改变的是调度，不是覆盖范围或平台支持。

## 考虑过的替代方案

**保留两个顶层工作进程并提高测试超时。** 两项清单重叠时会产生空或不完整的观察结果、hook teardown 失败，并在不同运行中漏掉不同的覆盖率分支。更大的预算会保留资源竞争，只会让失败更慢。

**提高 `DSH_COVERAGE_MAX_WORKERS`。** 增加插桩工作进程会进一步提高内存和进程压力。此前 Windows 在超过托管路径单覆盖率工作进程时已经出现 worker 退出和 Node lexer 故障。

**从完整通道删除覆盖率或重型测试。** 这会通过删除原生 Windows 证据来缩短作业，而不是让同一组证据变得可靠。

**把清单拆成更多 workflow 作业。** 独立 runner 可以恢复并行，但会重复检出和安装，并需要新的聚合拓扑。作业内串行调度是在保留当前清单与失败归属的前提下最小的改动。

## 后果

托管通道耗时约等于两项覆盖率清单耗时之和，且 8 个插桩 shard 会依次运行，因此延迟会增加，但仍受 120 分钟 job 截止时间约束。作为回报，每次只有 1 个插桩进程占用 runner，覆盖率会反映已经完成的测试，测试自有的超时也会重新表示局部缺陷，而不是调度器资源饥饿。必需的 Wine job 和 `all-checks-passed` 图保持不变；`windows-native` 仍是独立的原生内核信号。
