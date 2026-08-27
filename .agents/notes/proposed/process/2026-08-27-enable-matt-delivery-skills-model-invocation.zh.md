# Agent Note：放开 Matt 交付技能批次的模型调用

Status: proposed

## 问题

编排派发的票写入者都是全新子代理，需要自行执行交付工作流；但 `implement`、`to-spec`、`to-tickets` 带着 `disable-model-invocation: true`，写入者既不能正式调用该工作流，也只能凭提示词模仿技能文本。

## 决策

仅从 `.agents/skills/{implement,to-spec,to-tickets}/SKILL.md` 删除该标记。写入者自行进入工作流及其 `/tdd`、`/code-review` 步骤；仓库覆盖规则（`dsh-pre-push-checks`、testing policy）继续裁剪通用全量建议。`tdd` 与 `code-review` 原本就对外开放，保持不变。

## 已考虑的替代

**一次性放开全部 22 个带标技能** —— 拒绝。其余十九个（grilling 变体、handoff、teach、retro、writing 系列）是有意保留给人触发的会话面，与票务交付无关，放开属未经请求的行为变更。

**保留标记、由根任务把工作流文本贴进每次交接** —— 曾作为临时补救先行；作为长期做法被拒，因为它让权威在受跟踪的技能文件与随漂移的交接散文之间分叉。

## 后果

写入者获得正式入口；面向聊天助手能保持用户所有。若上游同步带回该标记，交付契约会在派发时大声失败而非悄悄退化为模仿——届时按该次同步的本仓修改清单恢复删除。

必要验证：下张票的派发中由写入者确认工作流入口可用；未点名的技能行为零变化。
