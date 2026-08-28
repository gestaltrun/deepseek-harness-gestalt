# Agent Note: 产品发布编排

Status: implemented

[English](2026-08-28-product-release-orchestration.md) | 中文

## 问题

Desktop Bundle 发布、Mobile Companion 签名与 TestFlight 分发，以及受运营 Platform 部署分别使用独立工作流和版本输入。仓库无法从一项已评审变更中统一判断这些发布单元是否需要联动，因此一个单元成功发布后，受影响的对端或生产服务可能仍停留在旧实现。

GitHub 工作流路径过滤器不理解 pnpm 依赖、被打包的构建输入或 wire 兼容性。可变 Environment 变量还会使 Mobile Marketing Version 和构建号脱离已评审的源码候选。

## 决策

将 Desktop、Mobile 与 Platform 视为三个独立产品发布单元，由一份纳入源码管理的 Product Release Plan 统一治理。现有 [dsh、vendor 与 native npm 发布族](../../implemented/process/2026-08-10-npm-release-sequences.zh.md)、[Desktop Personal Release Channel](../../implemented/architecture/2026-08-16-deepseek-gestalt-desktop-host.zh.md) 和[仅生产环境 Platform 部署](../../implemented/process/2026-08-20-platform-production-release-ci.zh.md)继续保持独立。

每个影响产品的 PR 添加一条带版本的 release-intent 记录，包含经过校验的中英文摘要，以及三个产品发布单元各自的 `major`、`minor`、`patch` 或 `none`。仓库脚本将新增、唯一且未消费的 intent 与变更路径、每个应用包的 workspace 依赖闭包，以及原生工程、打包、工作流、锁文件和部署输入的显式目录进行比较。Pull request 通常新增一条 intent，merge group 会确定性汇总其中的全部新增记录。CI 拒绝修改、重复、已消费或少报的 intent，并允许保守多报。

Intent 合并到 `master` 后，`Product Release Plan` 会创建或更新 `automation/product-release`。Draft Product Release PR 只消费每条 intent 一次，为每个选中单元应用最高请求 bump，递增由源码管理的 Mobile 构建号，按选中的发布单元过滤双语摘要，并在 `product-releases/` 下提交发布说明与带序号的精确计划。CI 根据基线 ledger、版本、Mobile build 和未消费 intent 重算整个事务，并拒绝伪造的 plan、state、版本、tag、bump、摘要、build 或 Desktop note。应用版本继续存放在各自拥有的 package manifest 中。`apps/mobile/release.json` 拥有单调递增的 Mobile 构建号；原生打包从 `apps/mobile/package.json` 读取 Marketing Version，并从该受跟踪文件读取构建号，不再依赖 GitHub Environment 变量。

一个 `Product Release` 协调工作流会 checkout 显式提供的完整候选 commit，验证它仍是可从 master 到达的 ledger 中最新有效 plan，校验每个由源码管理的版本，然后调用相互独立、可复用的 Desktop、Mobile、Platform Image 与 Platform Deploy 工作流。协调器与每条可以推广或推送的工作流都会独立要求当前执行工作流的 `github.sha` 与请求候选是当前可从 `origin/master` 到达的完整 commit；只有 `push=false` 的 Platform Image 非推广校验构建可以豁免。每条工作流在计划 commit 上只构建一次，记录产物或完整 OCI digest，并在所属 GitHub Environment 批准发布动作后推广这些精确字节。恢复由显式输入选择。每个先前 run 都必须在同一仓库中通过受允许工作流完成，同时精确命名的生产 job 必须成功，候选命名产物也必须未过期。工作流 head 还必须独立成为当前可从 `origin/master` 到达的完整 commit；等于请求候选不会获得例外。未合并分支无法提供可信工作流代码，后续可信协调器或 lane 失败也不会否定已经生成的字节。下载的 manifest 与重新计算的 digest 会单独把 Desktop 和 Mobile 产物绑定到请求候选；Mobile 可以上传经过校验的先前 IPA，并保留经过校验的先前 TestFlight 证据。Platform 只从对应的成功生产 job 与绑定候选的元数据恢复 image 和 deployment 身份；请求身份绝不构成证据。请求的渠道发布失败会让直接 lane 工作流失败，而协调器通过最终 `always()` job 记录已发布、已跳过和受阻单元，要求每个受阻单元提供原因，区分 Actions run URL 与 Release URL，并且只在存在上传证据时记录 TestFlight build。

Desktop 保留 `gestalt-v*` Personal Release Channel，以及原子发布的安装包、blockmap 与更新 feed 资产集合。Mobile 发布独立 prerelease，包含签名 Android APK、`SHA256SUMS`、TestFlight 链接、候选 commit、构建身份与验收证据；App Store IPA 继续作为受控发布证据，而不是公开安装资产。Platform 发布绑定 image build 所记录源码 commit 的完整不可变 GHCR digest，并单独记录生产部署；生产推广绝不接受 tag、短 digest 或候选不匹配的 image。

## 曾考虑的替代方案

**使用同一版本并且每次发布全部三个单元。** 这会省去影响分析，但会产生不必要的签名与生产部署，耦合无关发布节奏，并模糊实际发生变化的产物。

**使用 GitHub Actions 路径过滤器决定发布。** 路径过滤器可以避免创建 run，却无法证明传递应用影响或协议兼容性，因此不能拥有失败关闭的发布决策。

**让 Release Please 或 Changesets 接管整个仓库的版本。** 两者都提供成熟的 Release PR 模型，但替换已经验证的 dsh、vendor、native、Desktop、Mobile 与 Platform 发布序列，会先引入第二个迁移问题。当前实现保留现有发布序列，并由显式 intent 与版本 PR 模型提供产品编排。

**把受影响单元和版本放进 agent skill。** Skill 不是可执行且可评审的状态机，无法提供确定性 CI 拒绝、候选绑定、Environment 保护或可重试的产物推广。

**批准后重新构建。** 重新构建可能推广与已验证候选不同的字节。已批准操作必须消费同一次计划执行记录的产物或 image digest。

## 测试

- [`product.spec.ts`](../../../../scripts/release/product.spec.ts) 固定双语 release-intent 解析、未知字段拒绝、应用依赖闭包、显式输入映射、少报拒绝、汇总例外作用域、唯一且未消费的新增记录、merge-group 汇总、基线 ledger plan 与 state 重算、生成字段隔离、最新 master 候选校验、命名生产 job 与产物来源、签名候选 digest、逐端摘要、Mobile 构建号递增、绑定候选的完整 Platform digest 与最终 manifest 渲染。
- [`product-workflows.spec.ts`](../../../../scripts/release/product-workflows.spec.ts) 固定 CI 校验、不产生发布副作用的 Product Release PR 生成、可复用工作流的最小权限、可信执行版本、精确候选与版本输入、命名产物恢复、直接渠道失败传播、持久 Mobile prerelease、Platform 部署与仅发布恢复、选中 lane 调用与最终 manifest 产物。
- 现有 Desktop、Mobile 与 Platform 工作流测试继续固定安装包与更新资产、原生身份与签名输入、生产 readiness、回滚与恢复行为。

## 后果

依赖闭包不会推导每一种兼容或运营发布理由。显式 intent 继续拥有所请求的 SemVer 影响，而计算出的集合是防止漏发的保守下限。未知生产路径会选中全部单元；评审通过的兼容例外会在 intent 中携带原因。

自动创建 Product Release PR 使用专用 GitHub App 安装，并只授予仓库 Contents 与 Pull requests 写权限和 Issues 读权限，因此其 branch 与 PR 事件会触发普通 CI。发布凭证与生产权限继续隔离在受保护 Environment 中，不会授予规划工作流。

Product Release PR 在推广前增加一次评审，源码历史会保留带序号的计划与已消费 intent。每个发布单元继续拥有独立版本与审批节奏。可复用工作流的调用 job 只授予各 lane 所需的 token 权限，签名与部署凭据继续保留在受保护 Environment 中。协调器可以在部分单元受阻时结束；维护者读取 manifest 后，通过先前产物、image 或 deployment 身份在所属手动工作流中重试，无需重新构建或改变已批准候选。
