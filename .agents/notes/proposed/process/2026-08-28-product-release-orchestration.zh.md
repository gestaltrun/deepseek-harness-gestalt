# Agent Note: 产品发布编排

Status: proposed

[English](2026-08-28-product-release-orchestration.md) | 中文

## 问题

Desktop Bundle 发布、Mobile Companion 签名与 TestFlight 分发，以及受运营 Platform 部署分别使用独立 workflow 和版本输入。仓库无法从一项已评审变更中统一判断这些发布单元是否需要联动，因此一个单元成功发布后，受影响的对端或生产服务可能仍停留在旧实现。

GitHub workflow 路径过滤器不理解 pnpm 依赖、被打包的构建输入或 wire 兼容性。可变 Environment 变量还会使 Mobile Marketing Version 和构建号脱离已评审的源码候选。

## 提案

将 Desktop、Mobile 与 Platform 视为三个独立产品发布单元，由一份源码所有的 Product Release Plan 统一治理。现有 [dsh、vendor 与 native npm 发布族](../../implemented/process/2026-08-10-npm-release-sequences.zh.md)、[Desktop Personal Release Channel](../../implemented/architecture/2026-08-16-deepseek-gestalt-desktop-host.zh.md) 和[仅生产环境 Platform 部署](../../implemented/process/2026-08-20-platform-production-release-ci.zh.md)继续保持独立。

每个影响产品的 PR 添加一条带版本的 release-intent 记录，包含面向用户的摘要，以及三个产品发布单元各自的 `major`、`minor`、`patch` 或 `none`。仓库脚本将 intent 与变更路径、每个应用包的 workspace 依赖闭包，以及原生工程、打包、workflow、锁文件和部署输入的显式目录进行比较。CI 拒绝遗漏可能受影响单元的 intent，并允许保守多报。

Intent 合并到 `master` 后，Product Release PR 消费这些记录，为每个选中单元应用最高请求 bump，递增源码所有的 Mobile 构建号，并记录发布说明和精确计划。应用版本继续存放在各自拥有的 package manifest 中。Mobile 原生元数据从已评审的仓库状态读取 Marketing Version 和单调递增构建号，而不再依赖 GitHub Environment 变量。

一个协调 workflow 读取已合并计划，并调用相互独立、可复用的 Desktop、Mobile 与 Platform workflow。每条 workflow 在计划 commit 上只构建一次，记录 artifact 或 OCI digest，并在所属 GitHub Environment 批准发布动作后推广这些精确字节。手动 dispatch 继续作为恢复入口。协调器记录已发布、已跳过和受阻单元，不会把尚未推广的 image 或候选描述为已发布。

Desktop 保留 `gestalt-v*` Personal Release Channel，以及原子发布的安装包、blockmap 与更新 feed 资产集合。Mobile 发布独立 prerelease，包含签名 Android APK、`SHA256SUMS`、TestFlight 链接、候选 commit、构建身份与验收证据；App Store IPA 继续作为受控发布证据，而不是公开安装资产。Platform 发布不可变 GHCR digest，并单独记录生产部署；生产推广绝不接受 `latest` 作为候选身份。

## 曾考虑的替代方案

**使用同一版本并且每次发布全部三个单元。** 这会省去影响分析，但会产生不必要的签名与生产部署，耦合无关发布节奏，并模糊实际发生变化的 artifact。

**使用 GitHub Actions 路径过滤器决定发布。** 路径过滤器可以避免创建 run，却无法证明传递应用影响或协议兼容性，因此不能拥有失败关闭的发布决策。

**让 Release Please 或 Changesets 接管整个仓库的版本。** 两者都提供成熟的 Release PR 模型，但替换已经验证的 dsh、vendor、native、Desktop、Mobile 与 Platform 发布序列，会先引入第二个迁移问题。该提案先在现有仓库脚本后采用显式 intent 与版本 PR 模型。

**把受影响单元和版本放进 agent skill。** Skill 不是可执行且可评审的状态机，无法提供确定性 CI 拒绝、候选绑定、Environment 保护或可重试的 artifact 推广。

**批准后重新构建。** 重新构建可能推广与已验证候选不同的字节。已批准操作必须消费同一次计划执行记录的 artifact 或 image digest。

## 验收标准

- Release-intent 解析、应用依赖闭包、显式输入映射、少报拒绝、bump 汇总、Mobile 构建号递增与最终计划渲染均具有聚焦的正反测试。
- PR CI 校验 release intent；master workflow 创建或更新 Product Release PR，但不发布产品。
- Desktop、Mobile 与 Platform workflow 接受类型化 reusable-workflow 输入，并保留手动恢复 dispatch。
- 协调器仅调用选中单元，并生成机器可读的最终 manifest，包含版本、tag、候选 commit、artifact 或 image digest、run 链接、TestFlight build、部署状态，以及显式跳过或受阻结果。
- Mobile 发布版本来自受跟踪仓库文件；Android `versionCode` 与 iOS `CFBundleVersion` 共用受跟踪的单调递增构建号。
- GitHub Release 按 draft、完整上传资产、校验 digest、再发布的顺序执行。TestFlight 被记录为滚动 beta 渠道；Actions artifact 不是长期公开下载面。
- Platform 生产部署接受不可变 image 身份，并保留 Environment 审批、滚动 readiness、回滚与恢复。
- 当前 Desktop、Mobile 与 Platform 发布文档和 agent 指令链接仓库拥有的计划，不重复其决策。

## 风险

依赖闭包无法推导每一种兼容或运营发布理由。显式 intent 继续拥有所请求的 SemVer 影响，而计算出的集合是防止漏发的保守下限。

自动创建 Product Release PR 需要仓库写权限。发布凭证与生产权限继续隔离在受保护 Environment 中，不会授予规划 workflow。

Workflow 转换如果在批准后重新构建或丢失恢复路径，可能削弱已验证的发布事务。每条现有 lane 在改变调用接口时，必须保留当前签名、smoke、资产、readiness、回滚与恢复证据。
