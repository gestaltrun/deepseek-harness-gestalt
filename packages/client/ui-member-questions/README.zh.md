# ui-member-questions — 成员提问 composer dock

[English](README.md) | 中文

本包把成员导向的 `ask_user_question` 请求呈现为一张组合卡片：远端决策简报横幅（远端标记、提问人身份与角色、项目、来源会话、到期倒计时、截断的背景、材料芯片）叠加在共享问题呈现之上，后者原生气持分页、多选、推荐徽标、自定义回答与结算行为。

本包在产品 composer 上方注册一个叠加式 `conversation.input.dock` 入口。当待处理请求的整批问题都声明 `member-question` 呈现意图时，Decision Brief 在此渲染；`plan-review` 与普通请求仍使用共享问题接管面。观察到共享呈现自身的最小化开关时，整卡折叠为一条「远端 · 发起人」窄条并标记为已收起；呈现保持挂载，因此其草稿得以保留。

材料芯片只通过 Better Sidebar Files 打开 receiver 所有的缓存副本。Host 把传输 bytes 写到 `.dsh/member-questions/<questionId>/`，因此同名 Workspace 文件不会被覆盖或误打开。点击芯片会用 receiving Session id 与缓存 path 调用 `ctx.betterSidebar.openFile`；缺少 `cachedPath` 时芯片是 no-op。markdown、沙箱 HTML 与不受支持的类型复用普通 Files viewer。Files editor 标签未注册时，芯片回退到 `ctx.workspaces.openPath` 与 Host 系统打开器。不存在成员提问专用文档 dock。

`ReceivingQuestionBook` 只依据 Host receiver snapshot 与 change feed 构建卡片。倒计时仅用于展示；expiry、supersession、withdrawal 与全部 terminal 状态均来自 Host。回答和拒绝动作经共享呈现调用 Host settlement RPC。

pending 卡片消失后，answered、declined、expired、withdrawn 与 superseded 记录仍以被动条带显示。另一个 Installation 赢得的回答会显示为 elsewhere answered，并带获胜设备名与 settlement time。未被替换的产品 composer 经 receiving face 的单次 admission RPC 提交；卡片不会再挂载第二个 textarea，renderer 也不会分别发起 Session creation 与 prompt。

## Model Experience

无，本包是浏览器侧的作曲卡界面：选择器路由卡片只是呈现共享 ask-user 呈现已携带的问题并经其结算回传答案，自身不注册任何提示词、模式或工具。

#### KV Cache effect

无；本包既不组装也不发送 Provider 请求。

## Known Limitations and Deferred Work

- **Dock 路由以整批为单位** —— 仅当待处理请求中的每个问题都声明 `member-question` 意图时本卡才渲染；只要混入一个普通或 `plan-review` 问题，整批就交给共享问题 composer，不存在按问题拆分。
- **材料芯片需要 Files viewer 或 Host 系统打开器** —— 已注册的 Files editor 标签会在 receiving Session 中打开 receiver 所有的缓存 path；缺少 `cachedPath` 时芯片是 no-op，同名 Workspace 文件不会被打开；否则使用 Host 系统打开器。不存在第二个产品内文档 dock。
- **Admission 失败会保留在 receiving card** —— 共享 input state 保留 draft 并暴露 Host diagnostic。只有 Host materialization 成功后，普通 model、command 与 skill route 才会开放。
