# Agent Note：真实进程覆盖率独占执行

Status: implemented

[English](2026-08-24-exclusive-real-process-coverage.md) | 中文

## 问题

单 worker 的 Vitest 分区可以隔离 JavaScript 测试 worker，但多个同时活跃的分区仍会在同一个托管 runner 上启动多个外部 PowerShell 进程树。一次四分区 Linux 运行暴露了两项同时发生的真实 PowerShell 故障，并据此把上限设为两个进程。后来一次双进程运行仍让一个基础 `Write-Output` 命令返回 null 退出结果，而同轮所有非 PowerShell lane 均通过。若把整个覆盖率协调器降为单进程，会为了保护 6 个外部进程套件而取消数百项测试的有效并行。

## 决策

分区覆盖率从每个普通 shard 中排除 6 个会启动真实 PowerShell 进程的测试文件。全部普通 shard 结算后，协调器用一个专属的插桩 Vitest 命令执行这些文件；该命令只使用 1 个 worker，并且不与任何分区进程重叠。专属命令写出自己的 blob，像局部 shard 一样关闭阈值，并通过 `coverage.reportOnFailure` 保留普通测试失败输出与覆盖率。

拥有第一分区的协调器同时拥有专属命令。因此，单 job 的 Linux 运行会在合并阈值检查前执行它一次。拆分后的原生 Windows 覆盖率把它交给包含第一分区的 shard job；该 job 会把专属 blob 与自己的分区 blob 一同上传，既有合并 job 再下载完整集合。最终合并仍是仓库逐文件 100% 阈值的唯一所有者。

专属清单包含 `pwsh-local`、`pwsh-sandbox`、`tool-pwsh`、`tool-pwsh-persistent` 的真实进程文件，以及 `terminal-bash` 中的 PowerShell 部分。与这些套件同文件的纯测试会随之迁移；没有测试变成无插桩或可选。没有 PowerShell 的宿主继续使用既有显式源码排除和跳过行为，而 CI 继续设置 `DSH_TEST_REQUIRE_PWSH=1`，可执行文件不可用时必须失败。

## 验证

`scripts/coverage-partitions.spec.ts` 固定普通并发分区之后的执行顺序、单 worker 插桩参数、不使用 shard 选择器、跨工作流子集的第一分区所有权、专属 blob 发布、失败诊断、失败测试合并，以及最终阈值合并。既有配置与工作流契约继续固定 PowerShell 可用性、固定分区数、普通并发上限和跨 job blob 合并。

## 曾考虑的替代方案

**串行全部覆盖率分区。** 不予采用，因为资源约束属于外部 PowerShell 进程树，不属于普通测试清单。这样会让托管 Linux 覆盖率延迟接近翻倍，却不会为受影响套件提供比专属命令更多的隔离。

**重试 null PowerShell 退出结果。** 不予采用，因为这会掩盖无法确定的真实进程结果，并让产品行为测试在命令未经验证成功时通过。套件继续保持 fail-closed；调度负责阻止相互竞争的插桩分区制造资源饥饿条件。

**把 PowerShell 套件放在覆盖率旁边无插桩运行。** 不予采用，因为这些套件负责覆盖 PowerShell provider 中的可执行分支。它们的 blob 必须参与同一份逐文件阈值证明。

## 后果

普通覆盖率保留已经实测的托管 Linux 双进程调度，以及每个原生 Windows worker 双进程调度。专属尾段增加一次 Vitest 启动和真实 PowerShell 套件耗时，但它替代的是相互重叠的外部进程工作，而不是串行完整清单。新增真实进程套件时，必须显式判断它是否属于这个独占资源类别。
