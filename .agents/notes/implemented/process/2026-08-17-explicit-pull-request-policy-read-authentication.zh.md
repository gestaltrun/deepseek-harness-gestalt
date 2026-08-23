# Agent Note: 显式配置 PR 策略读取认证与激活

Status: implemented

[English](2026-08-17-explicit-pull-request-policy-read-authentication.md) | 中文

## 问题

PR 策略会读取 PR 元数据、被引用 Issue，并可选读取 Issue field 值。个人 tracker 的普通未认证 PR 与 Issue 读取曾间歇返回 `504`。其工作流已经声明 PR 与 Issue 读取权限，工作流 token 是这些读取经过验证的授权路径。认证仍是显式部署选择，因为其他 tracker 可能有不同的访问要求。

被请求 reviewer 与 review 只提供激活信号，并不参与元数据校验。把它们作为激活的必要条件会增加端点可用性与授权要求，却不会增强校验结果。

PR 策略读取、Issue Priority 集成与 Project 生命周期自动化具有不同的可用性和授权要求。一项能力的认证方式不能安全地决定另外两项能力的认证方式。

## 决策

`.github/issue-management/config.json` 要求 `pullRequestReadAuthentication` 严格取值为 `anonymous` 或 `token`。`pr` 命令会把该选择传给所有读取 PR 或被引用 Issue 数据的 REST 请求。即使环境中存在 token，匿名模式也不会发送 `Authorization`。token 模式会把 `GH_TOKEN` 或 `GITHUB_TOKEN` 作为 Bearer token 发送；两项变量都未设置时，会在首次 API 请求前失败。

同一配置要求 `pullRequestPolicyActivation` 严格取值为 `non-draft` 或 `review-activity`。两种模式都会从首次 PR 响应中识别 Draft、Bot 与 App PR，并在读取 review 活动、被引用 Issue 或 Priority 前返回。`non-draft` 会对其余所有 PR 应用元数据策略，且绝不请求被请求 reviewer 或 review。`review-activity` 保留在出现 review request 或 review 后激活的行为，并读取这两个端点。非法值或空白值会在启动时失败。

个人 tracker 选择 `token`，因为工作流授予了所需的读取权限，而且该路径已经通过普通 PR 与 Issue 读取验证。它独立选择 `non-draft`，因为 review 活动不参与元数据校验。这些选择不表示 API 访问永不失败；失败仍会明确暴露。

每种认证与激活组合下的 API 错误都是致命错误。策略绝不会在认证请求失败后匿名重试，也不会把 `404` 转换为元数据缺失。

通用 API 客户端默认继续使用 token 认证。生命周期、Project GraphQL 与审计读写操作不使用 `pullRequestReadAuthentication`；它们要求生命周期工作流提供的 GitHub App token。[Issue Priority field 决策](2026-08-17-explicit-issue-priority-field-deployment.zh.md)与[仓库相对生命周期决策](2026-08-17-repository-relative-issue-policy.zh.md)分别负责这些独立的部署选项。

## 验证

Issue management 测试通过本地 fake GitHub API 执行真实的 `policy.mjs pr` 与 `policy.mjs lifecycle` 命令。测试检查两种激活模式的确切请求列表与请求头，证明 Draft、Bot 与 App PR 在首次读取 PR 后停止，证明符合条件的 `non-draft` 请求无需 review 端点即可成功，验证缺少 token 与非法配置在零请求时失败，保留 API 失败，并执行一次使用 token 认证的生命周期 mutation。

## 考虑过的替代方案

**个人 tracker 使用 `anonymous` 与 `non-draft`。** 否决，因为该组合虽可避开 review 端点，却会让普通读取继续依赖仅适用于公开资源的访问方式，而此部署已经观察到间歇 `504`。其他部署验证所需端点后仍可使用匿名模式。

**存储 personal access token secret。** 否决，因为工作流 token 已能读取所需的普通 PR 与 Issue 资源，而 PAT 会扩大 secret 所有权与轮换义务。

**要求或扩大 GitHub App 的 Pull requests 权限。** 否决，因为生命周期授权与只读 PR 策略相互独立，而且仓库配置无法验证已安装 App 的权限集合。

**遇到 `404` 时改用未认证请求重试。** 否决，因为相同响应可能表示私有仓库、缺少权限、仓库错误或资源不存在。认证降级会使配置错误变成含义不清的行为。

**个人 tracker 继续用 review activity 作为激活信号。** 否决，因为 review 数量不校验元数据，读取它们只会增加授权依赖，不会增强策略结果。

## 后果

个人 tracker 从首个非 Draft 人类 PR 事件起使用工作流 token 强制执行元数据策略，且不读取 review 端点。选择 `review-activity` 的部署保留 review 驱动时机及其端点要求。匿名模式仅限已经验证所有所需端点均支持该模式的部署用于 `pr` 读取；生命周期与审计操作始终要求 token。
