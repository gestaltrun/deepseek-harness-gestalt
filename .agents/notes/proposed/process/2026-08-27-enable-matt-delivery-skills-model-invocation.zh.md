# Agent Note：放开 Matt 交付技能批次的模型调用

Status: proposed

[English](2026-08-27-enable-matt-delivery-skills-model-invocation.md) | 中文

## 问题

编排派发的票写入者都是全新子代理，需要自行执行交付工作流；但 `implement`、`to-spec`、`to-tickets` 带着 `disable-model-invocation: true`，写入者既不能正式调用该工作流，也只能凭提示词模仿技能文本。

## 提案

仅从 `.agents/skills/{implement,to-spec,to-tickets}/SKILL.md` 删除该标记。写入者自行进入工作流及其 `/tdd`、`/code-review` 步骤；仓库覆盖规则（`dsh-pre-push-checks`、testing policy）继续裁剪通用全量建议。`tdd` 与 `code-review` 原本就对外开放，保持不变。

## 验收标准

- 三个点名的 `SKILL.md` 不再含 `disable-model-invocation` 前置字段。
- 被派发的票写入者能进入 implement 工作流，根任务不必把技能正文贴进交接。
- 未点名的技能保持原有调用策略。

## 风险

上游同步若静默恢复该标记，写入者会退回模仿路径；交付契约必须在派发时因标记再现而大声失败，删除的恢复记入该次同步的本仓修改清单。把变更扩大到其余十九个带标技能会在无人请求的情况下把面向人的会话面暴露给模型调用。

## 已考虑的替代

**一次性放开全部 22 个带标技能** —— 拒绝。其余十九个（grilling 变体、handoff、teach、retro、writing 系列）是有意保留给人触发的会话面，与票务交付无关，放开属未经请求的行为变更。

**保留标记、由根任务把工作流文本贴进每次交接** —— 曾作为临时补救先行；作为长期做法被拒，因为它让权威在受跟踪的技能文件与随漂移的交接散文之间分叉。
