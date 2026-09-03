# 产品发布

[English](product-releases.md) | 中文

本参考定义 Desktop、Mobile 与 Platform 版本如何从普通 pull request 进入持久公开或生产证据。它不治理相互独立的 dsh、vendor、native 或 Python 发布族。

## 发布单元与版本所有者

Desktop、Mobile 与 Platform 是相互独立的产品发布单元。`apps/desktop/package.json`、`apps/mobile/package.json` 和 `apps/platform/package.json` 分别拥有各自的 SemVer 版本。`apps/mobile/release.json` 另行拥有正数且单调递增的构建号，并把它投影到 Android `versionCode` 与 iOS `CFBundleVersion`。

Desktop 使用 `gestalt-v<version>`，Mobile 使用 `mobile-v<version>`，Platform 使用 `platform-v<version>`。一份 Product Release Plan 可以选择任意子集；它不会强制共享版本或发布日期。

## Product Release PR

当 `master` 上仍有未消费的可选 `.release-intents/*.json` 记录时，`Product Release Plan` 会运行 `pnpm product-release:prepare --write`，并创建或更新 Draft `automation/product-release` pull request。普通产品 pull request 不再添加或校验这些记录。仓库变量 `DSH_RELEASE_APP_CLIENT_ID` 与 secret `DSH_RELEASE_APP_PRIVATE_KEY` 标识一个对仓库 Contents 和 Pull requests 具有写权限、对 Issues 具有读权限的 GitHub App 安装；与工作流 `GITHUB_TOKEN` 产生的变更不同，它的 commit 与 PR 事件会触发普通 CI。生成器只消费每条已合并 intent 一次，为各发布单元应用最高请求 bump，在选中 Mobile 时只递增一次构建号，按每条 intent 选中的端过滤双语摘要，并提交带序号的 `product-releases/NNNN.json` 计划与 `product-releases/state.json`。

选中的 Desktop 版本只有在 `gestalt-v<version>` tag 存在后，才能成为下一份 Desktop 发布说明的基线。未发布的已选版本不是有效基线：准备操作会在修改任何版本、plan、state 或发布说明文件前失败，并指示维护者先发布或恢复上一项 Desktop 发布。规划工作流会把生成器失败传播出输出捕获流水线，并在 `git add`、commit、push 或修改 pull request 之前停止；成功的 JSON 输出仍可用于 pull request 正文与证据。

CI 会根据基线 ledger、基线版本、受跟踪的 Mobile build 和全部未消费 intent 重算生成的 Product Release PR。提交的 plan、选中端、bump、版本、tag、摘要、已消费 intent 状态、Mobile build 与 Desktop notes 必须与重算结果一致；手工修改生成事务不能漏掉或伪造发布。

合并 Product Release PR 会批准版本、发布说明和选中集合。它不会授权签名、TestFlight 上传、GitHub Release 发布、镜像发布或生产部署。

## 推广与证据

派发 `Product Release` 时提供完整候选 commit 与其受跟踪的 plan 路径。在任何发布 lane 启动前，协调器会 checkout 该 commit，验证它可从 `master` 到达，并拒绝 Desktop、Mobile 或 Platform 版本、Mobile build、ledger 序号或已消费 intent 状态与最新有效 master ledger 不一致的计划。没有 product intent 的后续 commit 不会使候选失效；任何后续未消费 product intent 都会使其失效。Desktop 保留原子的安装包、blockmap 与 updater feed 事务。Mobile 消费计划中的精确版本与 build，只产生一份签名 APK 与 IPA，可选择把 IPA 上传到滚动的 [TestFlight beta](https://testflight.apple.com/join/pKCZtn7q)，然后通过先 draft 后发布的 GitHub prerelease 提供 APK 与 `SHA256SUMS`。Platform 只构建一个绑定候选的 image，把完整 OCI digest 与记录的源码 commit 传给生产部署，并且永不推广 tag 或短 digest。

`desktop-release`、`mobile-release` 和 `production` Environment 分别保留自己的凭据与审批。可复用工作流的调用 job 只授予各 lane 所需的最小 token 权限。协调器会上传 `product-release-manifest-<sequence>`，其中包含每个发布单元的已选中、已跳过、已发布或受阻状态；每个受阻状态的原因；版本与 tag；精确候选 commit；产物或 image digest；GitHub Actions run URL；独立的 GitHub Release URL 与部署证据。只有当前或经过校验的先前上传实际运行时才会出现 `testFlightBuild`。GitHub Release asset 是持久公开下载；Actions 产物只用于临时构建与证据传递。

## 恢复与回滚

手动 `Desktop Release`、`Mobile Release`、`Platform Image` 与 `Platform Deploy` dispatch 继续作为恢复入口。Desktop 恢复要求显式版本且不提供可变默认值；候选中受跟踪的 package manifest 拥有该值，plan 将此版本绑定到候选。恢复由显式类型化模式选择，绝不根据触发事件推断。Product Release 协调器以及每条可以推广或推送的 lane 都会先证明当前执行工作流的 `github.sha` 与请求候选是当前可从 `origin/master` 到达的完整 commit；只有 `push=false` 的 Platform Image 非推广校验构建可以豁免。每项先前 run 恢复还会通过 GitHub API 校验仓库相同、工作流受允许、run 已完成、命名生产 job 成功且候选命名产物未过期，并独立证明工作流 head 是当前可从 `origin/master` 到达的完整 commit。后续可信协调器因此可以生成可复用字节，未合并分支则无法伪造候选或工作流证据。后续 lane 失败不会否定已经成功生成的字节。下载的候选 manifest 与重新计算的 digest 会单独把将被推广的精确字节绑定到请求候选。Mobile 可以用经过校验的 IPA 重试 TestFlight；不请求新上传时会保留经过校验的先前 TestFlight 证据。Platform Image 恢复校验绑定候选的完整 digest 元数据，绝不把请求提供的 digest 当作证据。Platform 仅发布恢复会在创建 Release 前校验命名部署产物及其精确候选、image、版本和部署元数据。请求的 GitHub Release、TestFlight 上传或 Platform 发布在外部渠道失败时会让直接工作流失败；Product Release 协调器仍通过最终 manifest 汇总 lane 失败。中断的 Platform 部署继续使用持久生产阶段与滚动回滚事务。
