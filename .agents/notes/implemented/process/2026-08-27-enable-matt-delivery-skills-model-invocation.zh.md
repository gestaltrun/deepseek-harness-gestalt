# Agent Note：放开 Matt 交付技能批次的模型调用

Status: implemented

[English](2026-08-27-enable-matt-delivery-skills-model-invocation.md) | 中文

## 问题

编排派发的票写入者都是全新子代理，需要自行执行交付工作流；但 `implement`、`to-spec`、`to-tickets` 带着 `disable-model-invocation: true`，写入者既不能正式调用该工作流，也只能凭提示词模仿技能文本。

## 决策

`implement`、`to-spec` 与 `to-tickets` 在两种受支持产品中都由模型调用。它们的 `SKILL.md` 不含 `disable-model-invocation`，Codex 的 `agents/openai.yaml` 则设置 `policy.allow_implicit_invocation: true`。写入者自行进入工作流及其 `/tdd`、`/code-review` 步骤；仓库覆盖规则（`dsh-pre-push-checks`、testing policy）继续裁剪通用全量建议。`tdd` 与 `code-review` 继续由模型调用。

## 验证

- `verify-skill-invocation-metadata` 要求每个带 Codex 元数据的技能在 Claude Code 与 Codex 中采用相同策略。
- 技能校验器会解析这三个技能入口与 Codex 元数据文件。

## 后果

这三个 description 会保留在模型的发现上下文中，使路由与交付工作流无需把技能正文复制进交接即可调用它们。调用元数据检查会拒绝产品间漂移。该批次之外的技能保留各自现有的调用策略。

## 已考虑的替代

**一次性放开全部 22 个带标技能** —— 拒绝。其余十九个（grilling 变体、handoff、teach、retro、writing 系列）是有意保留给人触发的会话面，与票务交付无关，放开属未经请求的行为变更。

**保留标记、由根任务把工作流文本贴进每次交接** —— 曾作为临时补救先行；作为长期做法被拒，因为它让权威在受跟踪的技能文件与随漂移的交接散文之间分叉。
