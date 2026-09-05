# 可选 CLIProxyAPI 委派 profile

[English](delegation-routing-cliproxyapi.md) | 中文

本 profile 为当前暴露以下精确 `cliproxyapi` 模型 id 的安装补充 [provider 无关路由参考](delegation-routing.zh.md)。派发前读取实时 catalog，因为可用性与映射会变化。除非 provider 记录了后端映射，否则保留已运行验证的本地 id。

| 任务档位 | `cliproxyapi` 模型候选 | 限制 |
| --- | --- | --- |
| 简单批量抽取 | `gpt-5.6-luna` | 高吞吐档；不要让它单独决定架构或安全。 |
| 边界清楚的常规编辑 | `gpt-5.6-terra`、`glm-5.3-flash` | 使用 owner 检查验证变更行为。 |
| 通用后端与终端实现 | `glm-5.3` | 仅文本输入；不要发送截图。 |
| 长程自主实现 | `grok-4.6`、`kimi-k3` | 限定目标并要求可重放证据。 |
| 广域证据综合 | `kimi-k3` | 区分来源声明与仓库证据。 |
| 前端与视觉工作 | `gemini-3.8-flash-high`、`glm-5.3-flash` | `gemini-3.8-flash-high` 是可运行本地 id，其后端映射未知；在当前路由验证图片输入。 |
| 困难架构、生命周期、安全或高风险审查 | `gpt-5.6-sol` 或经实测的等价模型 | 风险需要时用独立路由审查。 |

用户排除 `gpt-6-astra` 时，它绝不是静默 fallback。`codex-auto-review` 不是候选。`glm-5.3` 只接受文本；`glm-5.3-flash` 是视觉候选。图片与视频生成 id 不进入文本 agent 候选池。

subagent 工具接受 provider 与模型选择，但没有 reasoning-effort 参数。不得从厂商文档声称已设置 effort、存在持久 KV cache 或得知 proxy 计费。官方模型页只支持档位与能力陈述；验收依赖任务结果与仓库检查。

## 官方能力来源

- OpenAI：[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)、[Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) 和 [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) 定义旗舰、平衡与高吞吐产品档位。
- xAI：[Grok 4.6](https://docs.x.ai/developers/models/grok-4.6) 说明编码、agent 与知识工作定位。
- Moonshot AI：[Kimi K3](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart) 说明长程工程与多模态输入。
- Z.ai：[GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3) 记录纯文本输入；[GLM-5.3-Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash) 记录视觉输入。
- Google：[Gemini 3.8 Flash](https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/) 支持产品的 agentic coding 定位，不支持本地 `-high` 映射声明。