# Agent Note: 基于证据的委派指导

Status: implemented

[English](2026-09-05-evidence-based-delegation-guidance.md) | 中文

## Problem

仓库工作流缺少一套共享规则来选择适合任务的模型，以及判断可继续子会话是否仍保留有用上下文。部分指令依赖隐式继承父级路由，通用技能还可能要求只能由用户启动的入口，或强加与仓库 owner 冲突的术语、目录、hook 和测试范围。根规则与 Web 客户端规则也承载了条件性流程，却不能保证所有适用目录都能发现它们。

## Decision

[`docs/agents/delegation-routing.md`](../../../../docs/agents/delegation-routing.zh.md) 是委派路由与子会话上下文复用的 provider 无关 owner。调度者在当前用户限制下显式选择可用 provider 和模型，区分配置能力、官方产品声明与仓库任务证据，并只通过可观察检查验收工作。该参考把确定性工作交给直接工具，并为抽取、常规编辑、后端实现、长程自主工作、广域综合、视觉工作以及高风险架构或审查定义条件式档位。

调度者在新建子会话前检查直属可继续子会话。同一产物的后续工作可以继续使用证据、模型、范围与权限仍匹配的子会话。独立审查、模型变更、陈旧假设或无关工作使用新会话。只有任务确实依赖父会话多个已完成回合时才 fork。差量 brief 只携带变化事实和完成证据。继续会话不会改变固定路由、重定向正在运行的回合、暴露全部 workspace 历史或保证 provider 侧 KV cache。

[`docs/agents/delegation-routing-cliproxyapi.md`](../../../../docs/agents/delegation-routing-cliproxyapi.zh.md) 是可选安装 profile。它保留本地可运行的精确 id 与能力限制，但不要求其他环境提供 CLIProxyAPI。它排除已移除的候选，不把 Astra 作为静默 fallback，区分纯文本 GLM-5.3 与视觉 GLM-5.3-Flash，并记录 `gemini-3.8-flash-high` 的后端映射未知。

当目标技能只能由用户启动时，其他技能把共享流程作为普通参考读取。通用工作流服从仓库术语、决策记录、源码布局、hook owner 与按变更行为选择测试的政策。代码审查区分仅提交与进行中两种模式，使 staged、unstaged 和 untracked 工作都保持可见。YAML 保持标准 plain scalar 语义：未引用的 ` #` 会开始注释。因此，带井号的技能描述使用引号或 block scalar，聚焦 metadata 回归证明最终解析后的 catalog description 保留完整触发词；parser 不会保留错误编写的 plain scalar 文本。

条件式客户端脚手架流程位于由客户端常驻规则指向的 cookbook，`apps/web/AGENTS.md` 提供缺失的发现入口。cookbook 保留注册失败事实：三个注册面各自缺失时在不同的后续阶段失败；profile 裸行名只能经修复后的 `$DSH_HOME/profiles/node_modules` 回退目录解析，没有任何应用或 bundle manifest 声明的包会 import 失败。根指令链接路由 owner，为子 agent 描述与 todo 内容定义用户可见语言优先级且不改变标识符或内部 prompt，并按格式 owner 是否声明兼容来表述不稳定格式政策，而不是按仓库标签是否存在。tag 创建与 GitHub Release 保持在每次发布需显式批准的约束内。GitHub runner 细节服从当前 workflow 表达式。

会话复盘规则位于 [`docs/agents/session-retro.zh.md`](../../../../docs/agents/session-retro.zh.md) 这一普通共享参考。`retro` skill 保持为用户启动的入口，交付工作流链接该共享标准，协调者因此可以请求每个 writer 对自己会话复盘，而不必通过自动调用要求 user-only skill。候选只覆盖运行它的会话，不读取其他会话日志，任何内容落地前都到达用户显式的 keep-or-drop 门。每个变更文件恰好以一个换行符结尾；聚焦检查按字节复核，因为暂存 diff 空白检查抓不到全新文件缺失的末尾换行。

## Alternatives considered

**把模型 id 直接写进根指令。** 未采用，因为每个会话都会承担上下文成本，而且没有 CLIProxyAPI 的安装会得到不可用政策。根文件只保留条件指针，provider 映射保持可选。

**实现运行时模型路由器或自动检查用户设置。** 未采用，因为本变更治理贡献者工作流，不改变产品路由或凭据。可用工具与部署 catalog 仍是运行时事实，用户限制仍有最高优先级。

**始终新建或始终继续。** 未采用，因为独立审查和路由变化需要干净上下文，而相关修复可以复用高价值证据。决策依据范围、证据时效、模型适配、权限和独立性，而不是任意 token 阈值。

**把通用工程模板复制为仓库政策。** 未采用，因为项目 Agent Notes、术语、源码布局、hook 与测试 owner 才是权威。通用技能通过服从这些 owner 保持可复用。

## Consequences

委派拥有一份可发现的 provider 无关政策与一份可选具体 profile。工具支持时，派发 brief 更小、路由选择更明确，后续复用能保留有效证据且不削弱独立审查。模型能力与成本声明保持在来源能支持的范围内。

条件式客户端脚手架移到 cookbook 指针后，常驻指令上下文缩小；安全、凭据、生命周期、测试、发布与日志义务仍留在常驻 owner。仅文档的工作流指导不会改变组装后的产品输出或模型可见运行时输出，因此不需要 keyless 运行时快照变更；聚焦脚本测试固定描述解析回归，文档 gates 固定链接、配对、格式和预算。

该政策仍依赖调度者判断与逐步积累的任务证据。它不提供跨 parent 子会话接管、任意会话历史检索、effort 选择、cache telemetry、计费数据或通用模型排名。交付仍要求精确 pull request head 通过 `all checks passed`，随后 merge queue candidate 通过 `candidate verdict`；两项检查不能互相替代。
