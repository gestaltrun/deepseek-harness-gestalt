# Agent Note: CI 故障切换手册 — 托管池 → 自有池

Status: implemented

[English](2026-07-26-ci-failover-runbook.md) | 中文

## 问题

[CI](../../../../.github/workflows/ci.yml) 中三个必需的 Linux 工作作业（`node 24 / static`、`node 24 / coverage`、`node 24 / snapshots and artifacts`）、聚合它们的必需判定作业（`all checks passed`）以及独立的原生 Windows 证据作业默认运行在标准 GitHub 托管运行器上。[标准托管主路径决策](2026-08-18-standard-hosted-primary-ci.zh.md)负责这些选择器及其工作进程上限。当某个平台的托管池发生故障时，所有匹配的拉取请求都可能因无法运行的检查而无法合并。**适用范围：两个独立开关，每个平台一个。**`DSH_CI_FAILOVER_LINUX` 恢复托管 Linux 池故障（三个必需的 Linux 工作作业加 `all checks passed` 判定作业）；`DSH_CI_FAILOVER_WINDOWS` 恢复托管 Windows 池故障（原生 Windows 分区）。Linux 池故障无需重定向原生 Windows 作业，反之亦然。判定作业的其余必需依赖（`node-compat`、`python-sdk`、`windows`）按设计留在标准托管运行器上；若更大范围的 GitHub 托管容量发生故障，这些依赖仍会阻塞 `all checks passed`。因此，故障需要一个任何具备仓库写权限的响应者都能在不合并任何代码的情况下触发的开关。

## 决策

三个必需的 Linux 工作作业、独立的原生 Windows 作业，以及 `all checks passed` 判定作业（若不随切换，即使全部工作作业通过，它仍会滞留在故障池的队列中）——各自通过仓库变量解析运行器池，且开关按平台拆分，使一个平台的故障不会重定向另一个平台。三个 Linux 工作作业与 `all checks passed` 判定作业通过 `DSH_CI_FAILOVER_LINUX` 解析；原生 Windows 分区通过 `DSH_CI_FAILOVER_WINDOWS` 解析。变量不存在（正常）时它们运行在 `ubuntu-latest` 或 `windows-latest` 上；由任何具备写权限的协作者设为 `selfhosted` 时，对应作业切换到公司自有池。每个开关都是写者可管理的仓库状态而非一次合并，因此在所有检查都是红色时仍然有效。自有池会在每次 master push 后运行有界的 Linux 与 Windows standby smoke，并按日或通过 `standby-exhaustive` dispatch 运行完整的非分片清单；该证据由[分层就绪决策](2026-08-24-tiered-standby-readiness.zh.md)负责。

`ci-master.yml` 为每个作业设置 `PNPM_CONFIG_OPTIONAL=true`，删除 checkout 内被忽略和未跟踪的状态，并用 `--force` 执行 standby 安装。持久化 Runner 只保留内容寻址的依赖下载与受控机器工具；每次演练都会按仓库自有设置重建 `node_modules` 与 workspace 输出。

`ci-master.yml` 只豁免一个事件不做取消（`${{ github.event_name != 'push' }}`），因此一次 master push 不会取消上一次 push 留下的有界就绪 smoke。按日和手动 dispatch 的工作仍可被更新的非 push 运行替换。

这项豁免不保证每次 push 都会完成：GitHub 在每个并发组中只保留一个待运行条目，而非 push 运行会把该表达式求值为 `true`，并可能替换更早的按日或手动运行。下一次 master push 会恢复有界 smoke 证据；下一次每日计划或显式 dispatch 会恢复 exhaustive 证据。

这个决定必须放在工作流级：取消作用于被取代的整个运行，作业级 `concurrency` 组并不能豁免其所属作业。否定式写法会让重复派发的基准测试和 exhaustive 演练保持可替换。`ci-master.yml` 的一次 master push 只承载 `wine-apt-cache` 和两条有界 smoke；`scripts/ci-workflow.spec.ts` 会锁定这个 push 可达集合，使新的作业无法悄悄累积未取消的运行。

### 自有池是什么

`vm-backup`：一台 64 核虚拟机，6 个常驻 systemd 管理的运行器实例。其镜像必须预装 Playwright Chromium 的 Linux 系统软件包；CI 会下载锁文件选定的浏览器，但绝不在这台持久化共享主机上运行 `apt`。切换前查看最近的 `standby smoke / linux (self-hosted)` 结果与 `standby-linux-exhaustive` artifact。

#### Windows 池

`dsh-win-ci`：公司内部 Windows CI 服务器（一台 96 核 / 580 GB 机器）上 32 个常驻运行器实例（计划任务 `GH-Runner-01`…`GH-Runner-32`）。标签：`[self-hosted, dsh-win-ci, windows]`。镜像必须预装 Node 24、pnpm、Git（Git Bash 在 `PATH` 上，即 `C:\Program Files\Git\bin`——`bash` 工具按名称 spawn `bash`）、PowerShell 7，并为符号链接支持启用开发人员模式。切换前查看最近的 `standby smoke / windows (self-hosted)` 结果与 `standby-windows-exhaustive` artifact。

### 切换步骤（任何具备写权限的协作者，约 1 分钟，无需合并）

两个开关相互独立：只切换发生故障的那个平台。

1. 仓库 **Settings → Secrets and variables → Actions → Variables → New repository variable**：名称 `DSH_CI_FAILOVER_LINUX`（Linux 池故障）或 `DSH_CI_FAILOVER_WINDOWS`（Windows 池故障），值 `selfhosted`。
2. 重新触发必需作业，使其重新解析运行器池。已经为托管标签**排队**的作业不会重定向，也无法原地 re-run，因此对于本手册所述的无限排队故障，应取消卡住的运行并 re-run all jobs，或推送一个新提交；“Re-run failed jobs”只有在作业真正失败（而非仍在排队）时才有用。
3. 切换到此完成。Linux 故障切换状态下，工作流还会把 `DSH_SNAPSHOT_MAX_CONCURRENCY` 从 8 提高到 12、提高其他有界工作进程设置，并跳过托管路径的 pnpm 缓存恢复，因为虚拟机的持久 store 会直接提供热安装。覆盖率在两个 Linux 池上都使用 4 个单 worker 插桩分区与 2 个豁免 worker。Windows 故障切换状态下，原生作业的豁免覆盖率工作进程会从 1 提高到 2，分区并发会从 1 提高到 8，publint 工作进程会从 1 提高到 8；插桩覆盖率仍使用 8 个单 worker 分区。

#**Dependabot 例外。**两个开关的选择器都刻意排除了 `dependabot[bot]`：故障切换期间，Dependabot 拉取请求继续在托管池排队，而不是把依赖项提供的代码放到持久化虚拟机上执行。故障期间 Dependabot PR 持续排队是预期行为而非切换失败；托管池恢复后它会自行完成。

**谁能扳动这个变量。**GitHub 的 API 允许任何具有写权限的协作者管理仓库变量，因此每个开关实际是写者级而非严格的管理员级。在本仓库的信任模型下这并不构成升权：runner group 接纳本私有、禁 fork 仓库的全部工作流（这是让 PR 引用的故障切换得以成立的刻意取舍），因此任何写者本就可以通过推送分支工作流触达这台虚拟机。抵御不可信代码的边界是仓库成员资格；变量只是为成员路由工作。

## 切换期间的容量

6 个常驻实例可承接正常 PR 流量；该池平时的 master 稳态负载是一条有界 Linux smoke，exhaustive 工作按日或手动运行。若仍出现排队，用组织级注册 token（组织 Settings → Actions → Runners → New runner）追加注册实例。复制现有 runner 目录时**必须排除身份文件**——`rsync -a --exclude '.runner*' --exclude '.credentials*' --exclude '_diag' --exclude '_work' <src>/ <dst>/`（通配同时排除 `.runner_migrated`/`.credentials_migrated`——GitHub 会在迁移过的运行器上写入这些文件，它们同样会触发 already-configured 拒绝）——再跑 `config.sh`（原样拷贝 `.runner`/`.credentials` 会使其以 "already configured" 拒绝），然后**启动监听器**：`sudo ./svc.sh install ubuntu && sudo ./svc.sh start`。仅注册不会上线；只有启动了服务的 runner 才会增加容量。每个约一分钟。


### 切回

删除 `DSH_CI_FAILOVER_LINUX` 或 `DSH_CI_FAILOVER_WINDOWS` 变量（或改为 `selfhosted` 以外的任何值），新的运行即解析回标准 GitHub 托管池。若故障期间追加注册过实例，将其移除。

### 信任边界

这些变量是写者可管理的仓库状态；`pull_request` 事件本身既不能设置它们，也不能让不同的值生效，选择器表达式存在于工作流定义中。需要注意：故障切换期间，`pull_request` 运行执行的是 PR merge 引用自带的工作流定义——抵御不可信代码的边界是仓库成员资格（私有、禁 fork、选择器排除 Dependabot），而非该变量。关于 runner group 策略的说明：把 runner group 绑定到 master 引用的工作流与本故障切换机制**不兼容**——五个故障切换作业是从 PR merge 引用求值的 `pull_request` 运行，master 绑定的组会让它们持续排队（2026-07-27 实际故障中亲历；当时将组放宽为本仓库全部工作流才疏通了切换）。更严格的运行器侧策略以牺牲 PR 故障切换为代价；当前采用的形态是仓库范围、全工作流的组访问。

## 曾考虑的替代方案

**通过合并一次工作流改动来切换池。** 否决，因为触发切换的故障状态恰恰是任何 PR 都无法合并的状态：必需检查正是失败的那些。仓库变量是写者可管理的状态，重跑即生效，无需合并。

**让自托管池长期处于必需路径中。** 否决，因为这是拿托管池的可用性去换自有虚拟机的可用性，只是搬移了单点故障而非增加回退。这些变量让托管池保持主路径，自托管池作为一个经过验证、一步即可启用的热备；按平台拆分意味着一个平台的故障不会重定向另一个平台。

## 后果

从托管池故障中恢复只需切换受影响平台的变量（任何写者可设）加一次重跑，关键路径上没有合并。代价是每个平台都要维护第二套运行器拓扑：有界 smoke 会在每次 master push 后演练它，每日/手动 exhaustive 演练保留完整证据；而 `ci.yml` 中的快照并发与缓存恢复分支带有一条 `selfhosted` 支路（仅 Linux），必须与托管支路保持同步。按平台拆分会把每个开关的影响范围限定在单个平台。
