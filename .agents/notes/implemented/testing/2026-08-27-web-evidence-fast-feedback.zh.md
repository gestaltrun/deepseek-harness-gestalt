# Agent Note: Web 证据提前失败，并在录制前冻结

Status: implemented

[English](2026-08-27-web-evidence-fast-feedback.md) | 中文

## 问题

本地 Web 验证可能完成一次完整构建并进入 Chromium 后，才发现 Playwright executable 缺失、Replay fixture 错误或 Session fixture 不规范。贡献者还必须手工重新拼装 built Server、一次性 Workspace、实际服务 commit 校验、重启和清理步骤。若语义 review 排在真实模型 smoke 或 GIF 捕获之后，review 修复会让昂贵证据失效并迫使流程重跑。

## 决策

根命令提供三个明确的早期检查。`test:web:setup` 安装 Web workspace 所声明的 Playwright 精确 headless Chromium revision。`test:web:focus` 只接受 Web 快照清单中的一个仓库相对路径，完整构建一次，并以只读回放模式只执行该文件。`assertReplayFixture()` 使用与运行时相同的规则解析主脚本和子脚本，要求脚本数与调用数准确匹配，并可只通过按序 `text-delta` 分片比较浏览器可见的 Assistant 文本。

规范 Session fixture 校验是只读的核心 preflight 门禁。`verify-session-fixture-layout` 在构建与浏览器 job 之前扫描整个仓库清单；Web 快照车道不再重复持有这个较晚失败的全局不变量。

`accept:web` 是唯一的 built-Web acceptance Supervisor。它要求 worktree 干净且已提交，只复用 revision 与 artifact digest 都匹配 HEAD 的构建记录，否则执行完整构建；随后在一个自有临时根目录中，以隔离的 Home、Agents、bundled skills 和 Workspace 目录启动构建后的 CLI。它通过受支持的 Host API 注册 Workspace，验证实际提供的 Sidebar bundle 中嵌入的 revision，保留准确的子进程对象，支持 `status`、`restart [port]` 与 `stop`，且只删除自己创建的临时状态。默认运行无密钥。显式的 `--copy-model-config` 选项只盲复制两个获准的普通配置文件并使用仅所有者权限；Browser 与 Ego profile 状态绝不复制。

GUI 交付按成本与失效风险排列证据：确定性检查、不录制的 smoke、Standards 与 Spec 语义 review、修复与重新 review、冻结准确 head，最后才执行真实模型 GIF 录制与发布。冻结后若代码变化，必须先重新 review，才能再次录制。首次真实模型调用或捕获画面前，先验证实际提供的 revision。

## 考虑过的替代方案

**隐式安装浏览器。** 缺失或不匹配的缓存 executable 会在无关准备工作之后才表现为测试失败，本机已有浏览器也可能不是 Playwright 实际启动的 revision。

**只在快照车道校验 fixture 布局。** 这能保留不变量，却会在构建之后才报告全仓 fixture 损坏，并让 Web 专用 job 拥有源码全局格式规则。

**使用 shell 片段进行验收。** 分离的 PID 查找、临时路径、RPC 调用与清理很容易重启错误进程、提供陈旧 artifact，或让正常应用状态承载测试。

**在 review 前录制。** Review 修复会改变被演示的代码，使录制结果不再证明 PR head。

## 后果

Fixture 与本地环境问题会在 Chromium 之前变成聚焦诊断。一个命令即可创建可复现的 built-Web 界面，其 commit、进程、Workspace 与清理所有权均明确。最终 GIF 录制开始得更晚，但因语义修复先于模型调用和画面捕获落地，重复次数会减少。

Acceptance Supervisor 有意不选择 Ego profile、不驱动 UI、不授权凭据，也不发布媒体。这些仍是外部动作，并继续遵守原有授权与证据要求。
