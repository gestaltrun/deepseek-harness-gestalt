# Optional CLIProxyAPI delegation profile

English | [中文](delegation-routing-cliproxyapi.zh.md)

This profile supplements [the provider-neutral routing reference](delegation-routing.md) for installations that currently expose these exact `cliproxyapi` model ids. Read the live catalog before dispatch because availability and mappings can change. Preserve a working local id unless the provider documents its backend mapping.

| Task tier | `cliproxyapi` model candidates | Constraint |
| --- | --- | --- |
| Simple bulk extraction | `gpt-5.6-luna` | High-throughput tier; do not let it decide architecture or security alone. |
| Bounded routine edits | `gpt-5.6-terra`, `glm-5.3-flash` | Verify the changed behavior with owning checks. |
| General backend and terminal implementation | `glm-5.3` | Text-only input; do not send screenshots. |
| Long autonomous implementation | `grok-4.6`, `kimi-k3` | Bound the objective and require reproducible evidence. |
| Broad evidence integration | `kimi-k3` | Keep source claims separate from repository evidence. |
| Frontend and visual work | `gemini-3.8-flash-high`, `glm-5.3-flash` | `gemini-3.8-flash-high` is the working local id; its backend mapping is unknown. Verify image input on the active route. |
| Difficult architecture, lifecycle, security, or high-risk review | `gpt-5.6-sol` or a proven equivalent | Use an independent route for review when risk warrants it. |

`gpt-6-astra` is never a silent fallback when the user excludes it. `codex-auto-review` is not a candidate. `glm-5.3` accepts text only; `glm-5.3-flash` is the visual candidate. Image and video generation ids do not enter the text-agent pool.

The subagent tools accept provider and model selection but no reasoning-effort argument. Do not claim an effort setting, persistent KV cache, or proxy billing from vendor documentation. Official model pages support tier and capability statements only; acceptance depends on the task result and repository checks.

## Official capability sources

- OpenAI: [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), and [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) define flagship, balanced, and high-throughput product tiers.
- xAI: [Grok 4.6](https://docs.x.ai/developers/models/grok-4.6) describes coding, agentic, and knowledge-work positioning.
- Moonshot AI: [Kimi K3](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart) describes long-horizon engineering and multimodal input.
- Z.ai: [GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3) documents text-only input; [GLM-5.3-Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash) documents visual input.
- Google: [Gemini 3.8 Flash](https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/) supports the product's agentic-coding positioning, not the local `-high` mapping.
