# ui-member-questions — 成员提问作曲卡接管

[English](README.md) | 中文

本包把成员导向的 `ask_user_question` 请求呈现为一张组合卡片：远端决策简报横幅（远端标记、提问人身份与角色、项目、来源会话、到期倒计时、截断的背景、材料芯片）叠加在共享问题呈现之上，后者原生气持分页、多选、推荐徽标、自定义回答与结算行为。

本包在共享问题作曲卡之前注册 `conversation.composer` 链的一个选择器路由入口：当待处理请求的整批问题都声明 `member-question` 呈现意图时，由本包装器当选；`plan-review` 与普通请求仍选举共享作曲卡。观察到共享呈现自身的最小化开关时，整卡折叠为一条「远端 · 发起人」窄条并标记为已收起；呈现保持挂载，因此其草稿得以保留。

材料芯片是聚焦按钮：点击一枚芯片会通过可选的 `detailsFocus` 服务把该文档写入会话的详情面板，`conversation.details.document` 席位按扩展名分发——markdown 正文走 MarkdownText，html 正文走沙箱化受限预览，其余一律作为纯文件标签。详情面板打开时卡片先折叠；点击窄条可在不关闭面板的情况下恢复卡片，让文档与决策并排显示。

`ReceivingQuestionBook` 只依据 Host receiver snapshot 与 change feed 构建卡片。倒计时仅用于展示；expiry、supersession、withdrawal 与全部 terminal 状态均来自 Host。回答和拒绝动作经共享呈现调用 Host settlement RPC。

pending 卡片消失后，answered、declined、expired、withdrawn 与 superseded 记录仍以被动条带显示。另一个 Installation 赢得的回答会显示为 elsewhere answered，并带获胜设备名与 settlement time。仅含 terminal 记录的接收 Session 仍占用 composer chain，因此在 human-turn admission 可用前，普通消息 composer 保持隐藏。

## Model Experience

无，本包是浏览器侧的作曲卡界面：选择器路由卡片只是呈现共享 ask-user 呈现已携带的问题并经其结算回传答案，自身不注册任何提示词、模式或工具。

#### KV Cache effect

无；本包既不组装也不发送 Provider 请求。

## Known Limitations and Deferred Work

- **接管以整批为单位** —— 仅当待处理请求中的每个问题都声明 `member-question` 意图时本卡才当选；只要混入一个普通或 `plan-review` 问题，整批就交给共享作曲卡，不存在按问题拆分。
- **材料芯片依赖组合层的 `detailsFocus` 服务** —— 缺少该可选服务时芯片仍然渲染，但不会向详情面板写入任何文档，被引用材料只能以列表形式查看。
- **接收 Session 不接纳普通消息** —— pending 回答与拒绝已受支持，但从自由文本消息物化本地 Host Session 属于暂缓的 human-turn admission adapter。
