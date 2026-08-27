# Agent Note: 子代理提示词图片 block

Status: implemented

[English](2026-08-27-subagent-prompt-image-blocks.md) | 中文

## Problem

委派平面没有图片通道。`tool-subagent` 的 schema 只声明 `prompt: string`，execute 硬编码 `[{ type: 'text', text }]`，因此父模型永远无法把图片交给子代理——无论是会话中粘贴的图片还是工作区里的图表。LLM 词表早已携带基于持久 `ImageAttachmentRef` 的角色中立 `ImageBlock`，`SubagentStartRequest.prompt` 也早已是 `ContentBlock[]`；缺的只有工具层与后端保证。模型无法把像素重打成 base64，也不持有附件 id，因此任何方案都必须从模型确实持有的引用——工作区文件路径——结构化地搬运字节。

## Decision

`SubagentCapabilities` 新增 `images` 标志，由服务的 `assertCapabilities` 校验：未声明该标志的后端收到含 `ImageBlock` 的提示词以 `UNSUPPORTED_CAPABILITY` 拒绝。工具 schema 新增可选的 `images` 工作区路径数组，仅在所绑定提供方声明该能力时出现；execute 在任何 I/O 之前复查，因为校验器允许未声明键。

每个路径经调用会话的文件系统策略解析，并且必须指向常规的 PNG、JPEG、WebP 或 GIF 文件。工具按单图字节上限读入完整有序批次，再由 `attachments.saveImages` 执行单消息图片数量和总字节上限、验证所有成员，并在委派启动前提交批次。后台 Job 在读取文件或提交附件前完成准入。前台和可继续调用会先提交附件，再启动提供方；后续启动失败可能留下未被任何子提示词引用的不可变内容寻址对象。生成的 `ImageBlock` 跟在文本之后进入 `request.prompt`；进程内驱动器把提示词 block 原样作为子代理首条用户消息交付，因此子代理自身的请求组装会解析这些持久引用。

只有 `spawn` 和 `fork` 声明 `images: true`：两者都在进程内针对同一附件存储运行子代理。进程外后端（`acp`、`codex`、`claude-code`、经 `NO_START_CAPABILITIES` 的 `dsh-sdk`，以及 `subagent-acp` 的内联声明）保持 `false`，直到其传输协议被证明能端到端保留 image block；这些后端的 schema 省略该参数，execute 响亮拒绝。fork 种子子代理本就通过日志复制继承粘贴的图片——不变。

子模型路由是否接受图片输入，由子代理自身的请求组装决定，与任何其他用户内容一致；工具不预判无法解析的子路由。

## Alternatives considered

**在工具参数中接受内联 base64。** 模型从不持有原始字节；无法为只是"看过"的像素生成它们。

**按 id 引用附件。** id 从不出现在模型可见文本中，模型无法指名。

**现在就在所有后端声明。** 每条进程外传输都需要先有自己的端到端证明；在未验证的传输上静默丢弃 block，正是能力体系要防止的"先接受后忽略"失败。

**同时扩展 `send_message`。** 暂缓：可继续委派的后续消息可以在文本中引用工作区路径，直到同一通道被证明适用于后续轮次。记录在工具 README 的 Known Limitations。

## Consequences

在进程内后端上，父代理可以为委派附上截图、示意图与图表；子代理看到图片本身。新增可选参数改变了有 capability 后端上组装出的工具 schema，因此同一变更中以 `DSH_SNAPSHOT=refresh` 重录了受影响的无密钥快照期望；生成的工具目录不变，因为其夹具后端不声明任何能力。包测试锁定 block 管道、schema 门控、I/O 前拒绝、缺失服务拒绝与非图片路径；各提供方套件锁定每个后端的新能力标志。
