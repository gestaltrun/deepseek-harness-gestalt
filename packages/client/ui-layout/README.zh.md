# @deepseek-ai/dsh-client-ui-layout

[English](README.md) | 中文

外壳插件：三栏 AppFrame（拖动手柄与让步链）加 `ctx.layout` 面板几何服务；它注册到运行时拥有的 `root` slot，并声明 `sidebar`、`conversation`、`details` 和 `shell.overlay`。侧边栏的缩放边界是不可见命中条带，详情栏边界则保留其浮动胶囊；让步期间只有详情栏会收缩并随后自动关闭流内轨道。关闭的侧边栏仍保留 56px 控制栏；关闭的详情偏好为零宽度，而无法把 Session Surface 保持在 640px 的打开偏好会画成右侧浮层。该包还提供主题呈现器：它消费解析后的 `ctx.theme` 快照，并将其投影到 document（用 `html { color-scheme }` 驱动原生 UA 控件，依据当前配色方案设置 `body[data-ds-dark-theme]`，并将主题的别名 token 设为 body 上的内联变量，同时拥有一个 `<meta name="theme-color">`，其内容随计算后的 body 背景色更新）。在应用调色板和 token 后进行测量，可确保渲染后的背景成为唯一的颜色依据；呈现器在 dispose（资源释放）时会移除其自有的元数据节点，并一并清除其写入的其他全局状态。

AppFrame 挂载会话栏和详情栏，Desktop 原生 overlay 文档除外——该文档只渲染 `sidebar`，以便设置叠在官方页面之上；已连接 Session 通过 `SessionProvider` 渲染。在 Desktop 组合中，macOS 与 Windows chrome 标记都会让中间 Session 栏下移 36px，使 Session 顶栏留在无边框拖动条下方；浏览器组合仍从默认顶边开始。布局 store 是瞬时状态，侧边栏以默认宽度启动，详情栏则保持关闭，且该 store 从不读写 `localStorage`。详情占用方通过 `ctx.layout.openDetails({ minimum, default, maximum })` 打开；省略范围时，普通详情仍使用 300/360/520px 几何，而占用方可以声明 960px 最大宽度。重复传入当前范围会保留已打开且拖动后的宽度；切换范围会采用新范围的默认值；关闭后重开则恢复当前默认值。让步解析器按当前范围夹取宽度，在保留 640px Session Surface 最小宽度的前提下将详情栏收缩到其最小值，随后通过推导自动关闭流内轨道，且不会改写存储的偏好。当该偏好仍为打开时，AppFrame 会把占用方画成覆盖 Session Surface 的右侧浮层，使收起控件保持可及。hero 和其他未选中状态同样会将流内详情宽度派生为零，但不会改变该偏好。AppFrame 会跨越这些状态保留最后一个非 blank 会话 id：首个会话保持关闭；返回同一会话时恢复其未改变的宽度；选择不同会话时，详情栏会在绘制前关闭。会话 owner share 为空，侧边栏 owner share 只包含 `collapsed` 和 `width`；注册方通过标准钩子获取业务数据，并从各自的 inject 接口获取操作。

`/client` 导出表层包含插件主体（`apply`／`inject`）、`LayoutController`、`DetailsWidthRange` 和 owner-share 接口。AppFrame、面板 store 与让步求解器仍属于包内部。

## 模型体验

无。布局外壳管理浏览器查看状态；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **面板几何信息是瞬时状态**：重新加载会恢复侧边栏默认值，并使详情栏保持关闭；在不同会话 id 之间切换同样会关闭详情栏，并忘记拖动后的宽度，而未选中表面会以零宽度渲染详情栏，但不会修改几何信息。
- **让步链自动关闭通过推导零流内宽度实现，不会改动宽度偏好**：打开的偏好仍会画成右侧浮层；窗口变宽时恢复流内轨道；消费方禁止把 store 中的详情宽度当作实际渲染状态。
- **挤压重排期间不提供滚动锚定**：布局变化可能移动读者的 viewport。
