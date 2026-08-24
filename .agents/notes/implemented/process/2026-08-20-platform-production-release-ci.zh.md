# Agent Note: Platform 仅生产环境的发布 CI

Status: implemented

[English](2026-08-20-platform-production-release-ci.md) | 中文

## 问题

Platform 监听进程及其 GitHub Actions 工作流只需要一套实际运行的环境。再准备一套开发用 origin、OAuth App、数据库和身份命名空间，只会增加 staging 选择器和第二套凭证空间，而没有人会去运营它们。生产应用还必须在不分配公网地址、也不把长期阿里云凭证存入 GitHub 的前提下到达私网 ECS 实例。

## 决策

实际运行的 Platform 只有生产环境。[`apps/platform/src/production-env.ts`](../../../../apps/platform/src/production-env.ts) 列出监听进程所需密钥，将未设置的 `PLATFORM_ENVIRONMENT` 视为 production，并在 [`boot.ts`](../../../../apps/platform/src/boot.ts) 加载唯一完整的已运营身份前拒绝其他选择。监听入口没有 development 身份，也没有 credential、database 或 namespace fallback。

GitHub Actions 只使用 Environment `production`。[Platform Image](../../../../.github/workflows/platform-image.yml) 会在拉取请求和匹配的 master 推送上构建，仅在 `workflow_dispatch` 且 `inputs.push` 为真时推送到 GHCR。[Platform Deploy](../../../../.github/workflows/platform-deploy.yml) 会先安装锁定的工作区依赖且禁用生命周期脚本，再通过从源码启动的 [`production-env-cli.ts`](../../../../apps/platform/src/production-env-cli.ts) 校验生产和 ECS 名称。两个 job 都会把 GitHub 的 Environment-scoped OIDC token 换成短期阿里云角色，并校验恰好两个私网 ECS instance id 上的云助手。role trust 钉住不可变 GitHub subject `repo:gestaltrun@320476671/deepseek-harness-gestalt@1335215887:environment:production`；每个 ECS API 调用都会同时携带显式全局 region 和对应的 API 专用 region 参数。deploy job 只在 `inputs.deploy` 为真时运行。

RAM deploy role 的 `MaxSessionDuration` 至少为 21,600 秒；role 上限更低时 credential exchange 会在执行任何 ECS 操作前失败。deploy 与 recovery step 会把 action 提供的短期 `ALIBABA_CLOUD_*` 凭证映射为 ossutil 读取的 `OSS_*` 名称，不创建 OSS profile 或持久凭证文件。deploy job 会先在 runner 上拉取私有 GHCR 镜像，再取得六小时阿里云 session；它用每次运行独立的密钥加密运行环境，并把镜像、加密环境和 [`platform-host-deploy.sh`](../../../../apps/platform/scripts/platform-host-deploy.sh) 暂存到私有且仅属于本次运行的 OSS prefix。有效期六小时的内网签名 URL 让临时云助手 command 无需向 ECS 披露 GitHub token 即可取回文件。workflow 在每次 job 退出时删除 OSS object；云助手在执行后删除每条 command。[`platform-cloud-assistant.sh`](../../../../apps/platform/scripts/platform-cloud-assistant.sh) 要求 invocation 到达终态且退出码为零，不会把 API 已受理当成完成。prepare command 最长三十分钟，普通 action 最长五分钟，rollback 或 recovery 最长三十五分钟以等待 active preparation lock，因此远程事务有界且短于凭证寿命。

workflow 会验证配置的 ALB server group 恰好包含两个处于 Available 状态且端口为 80 的 ECS instance id。host script 会在全局 contract 前逐实例启动并校验 candidate，要求每台实例都有 live predecessor，逐实例替换并让另一台保持可用，并且只恢复存在已 rename rollback container 的实例。每个 host action 都会持有 `/run/dsh-platform-deploy.lock`；rollback 与独立 recovery 会等待 active action 或其云助手 timeout，不会并发修改同一批容器。一个稳定的私有 OSS record 会绑定有序 instance id，在生产 HTTPS readiness 通过前把部署标为 `rollbackable`，在 rollback cleanup 与 attachment-authority cutover 期间标为 `commit-pending`，并在 cutover 后标为 `committed`。recovery 会在没有管道的情况下读取完整 record 并构建 instance-id JSON，拒绝已经变化的 target variable，在第一 phase 恢复 predecessor，在第二 phase 完成 cleanup 与 cutover，在第三 phase 完成最终 cleanup，并只在两台实例都处理完成后删除 record 与本次运行 artifact。新的 deploy 会拒绝覆盖尚未解决的 record。附件 storage 使用两次调用：`postgres` 建立原子 bridge；随后 `oss` 要求每个 predecessor readiness response 都报告该 bridge。runner 会经过生产 HTTPS origin 与 ALB 核对所选 mode 和两个部署序号，再清理 rollback。该 CLI 入口不会打进 `boot.mjs`。

Desktop 与 Mobile 解析同一套生产身份，并在产品工作开始前拒绝 localhost（见[已运营 Companion Platform 身份](../architecture/2026-08-22-operated-companion-platform-identity.zh.md)）。通用环境 pair 校验只保留给有界 capability 测试，不进入产品入口。

## 考虑过的替代方案

**再运营一套 development Platform。** 否决：产品运营不会再准备第二套 origin、OAuth App、数据库或身份命名空间。staging 选择器也会重新打开 Companion 打包已经禁止的任意端点选择。

**在同一主机上跑 development 以保留成对校验。** 否决：共享主机会把成对校验要隔开的身份命名空间叠在一起，监听进程仍需要一套 development 密钥。

**只在工作流里用 bash 清单校验生产名称。** 否决：监听进程与工作流会漂移。名称由一个 TypeScript 入口拥有；工作流调用它，测试同时钉住函数与 YAML。

**每次 master 构建都推送镜像。** 否决：推送到 GHCR 属于发布变更，必须显式派发。

**为每台 ECS 分配 EIP 并通过 SSH 部署。** 否决：ALB 已经能到达 VPC backend。实例公网地址和入站管理与服务流量无关，只会扩大生产攻击面。

**给 ECS 一枚 GitHub package token 并直接拉取 GHCR。** 否决：云助手 command 会携带第二个控制面的凭证。经 Environment 授权的 runner 已有 package 访问权，可以通过私有 OSS 暂存经过内容摘要校验的镜像归档。

**把阿里云 AccessKey 存到 GitHub。** 否决：GitHub OIDC 与 RAM 可以把短期 session 绑定到仓库受保护的 `production` Environment。长期 key 不提供必需能力，却增加轮换成本和泄露影响。

## 后果

缺少生产名称时校验失败，且不会打印值。设置 `PLATFORM_ENVIRONMENT=development` 会使监听进程失败。镜像发布和 ECS 应用仍是手动、受 Environment 保护的步骤。ECS 不需要 EIP、公网 SSH、GitHub credential 或持久 deploy command。OIDC role 只需要执行和读取云助手结果、读取 ALB server group，以及访问本次运行的 OSS 部署 prefix。每次运行的加密密钥只存在于 GitHub job 与临时 command content；加密 OSS object 和 command 会自动删除，但阿里云控制面的审计记录仍属于受信任的生产管理面。错误或 runner 终止会向两台实例排队 rollback；host lock 能避免 rollback 与云助手已经启动的 action 发生竞态。如果 runner 在 handler 运行前消失，独立的 `recover` dispatch 会使用全新凭证和 checkout 中的 host script；持久 phase 能防止 recovery 回退已经开始清理 rollback 的部署。candidate 或 preflight 失败时所有 predecessor 保持 active；contract 失败时恢复每个已触碰的 predecessor，并保持未触碰实例不变。监听进程把启动和错误行写到容器 stdout/stderr；Docker `json-file` 轮转（`20m` × `3` 个文件）限制每台 ECS 实例上的体积。应用步骤还会以用户自定义标识 `gestalt-platform` 启动 LoongCollector，把这些行送到 SLS 项目 `gestalt` 的 Logstore `application`。采集器从加固模式 ECS 元数据 `100.100.100.200` 读取阿里云账号 ID，元数据为空时回退到 Environment `production` 的 `PLATFORM_SLS_ACCOUNT_ID`。

## 测试

[`apps/platform/tests/production-env.spec.ts`](../../../../apps/platform/tests/production-env.spec.ts) 钉住运行环境选择、缺失名称顺序、ECS instance id 校验、从源码启动校验 CLI 前的依赖安装、只列出名称不打印值的 CLI stderr、OIDC permission 与固定 action identity、OSS STS 环境映射、加密暂存、云助手空结果轮询与终态结果校验、终止取消、独立恢复、全实例 finalization、candidate readiness、bridge 前置条件、contract 顺序、逐实例 rollback、SSH 名称缺席、`json-file` 轮转选项与 LoongCollector 注册。它也钉住 Platform Image 在 master 推送上构建但不推送到 GHCR。
