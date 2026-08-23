# @deepseek-ai/dsh-client-ui-schedule

[English](README.md) | 中文

面向持久化 Schedule 提醒的 Session 头部当前状态任务板。插件以顺序 30 向 `conversation.session.header.actions` 贡献 `schedule-list`，紧接在后台任务之后。它仅在 Client 同时拥有标准 Session projection hook 与 Host 挂载的 `remote.schedules` 命名空间时激活。

当 `schedules` projection 不存在或为空时，触发器不显示。其计数包含等待中与待补跑的记录，但排除已暂停记录；计数旁显示最近的活跃目标。任务板保持创建顺序，并展示等待中、待补跑和已暂停行。暂停、恢复和删除调用 Host Remote 命名空间；删除需要行内二次确认，变更错误保留在对应行。创建仍通过面向模型的 `schedule_create` 完成，因此本包不提供创建表单。

本包只读取独立的 `schedules` Session projection。它不在浏览器中折叠 `schedule/change`，也不从 transcript 或工具调用渲染推断提醒状态。Client 时钟根据 `scheduledAt` 推导等待中或待补跑展示；持久化的 `paused` 标志来自 projection。Escape 会关闭任务板并将焦点还给触发器，点击外部会关闭任务板，空 projection 会在入口消失前关闭任务板。

行为由 [Session Schedule 任务板 Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-session-schedule-board.zh.md) 规定。

## 模型体验

无，因为这个面向人的当前状态 projection 不增加工具、消息、提示词或 provider 请求；暂停与恢复刻意不提供面向模型的工具。

#### KV Cache 影响

无；本包从不组装或发送 provider 请求。

## 已知限制与延后工作

- **仅管理在线 Session**——Remote 变更解析精确的在线根 Agent；任务板不会唤醒冷 Session，也不提供外部调度器。
- **不是投递回执**——等待中、待补跑和已暂停是提醒管理状态，并不证明后续模型回合成功或已被阅读。
