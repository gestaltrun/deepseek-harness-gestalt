# DeepSeek Gestalt

[English](README.md) | 中文

<div align="center">
  <p><strong>让智能体工作可持续、可检查，也始终由人掌控。</strong></p>
  <p>
    <a href="https://www.gestaltrun.com/">网站</a> ·
    <a href="https://github.com/gestaltrun/deepseek-harness-gestalt/releases/latest">下载</a> ·
    <a href="docs/user/guide/index.zh.md">Web 指南</a> ·
    <a href="docs/architecture.zh.md">架构</a>
  </p>
</div>

DeepSeek Gestalt 是建立在 [DeepSeek Harness](https://www.deepseek.com/harness/)（`dsh`）上的桌面端、Web 端与移动端工作空间。编码工作保存在持久 Session 中，你可以检查和恢复 Session，把一部分工作拆进专门的 Side Chat，也可以在配对的手机上继续处理。

DeepSeek Harness 是由 [DeepSeek AI](https://deepseek.com) 开发的开源智能体框架。它运行在 [Cordis](https://github.com/cordiverse/cordis) 之上，并将同一条规则贯彻到整个系统：**一切皆插件**。

## 愿景

智能体工作不应受限于一次提示、一个窗口或一台设备。Gestalt 正在构建一个连续工作空间，让模型、工具、文件、审批和客户端共享持久 Session，而不是依赖不可见的聊天状态。

模型可见的每项输入都会记录进 Session 日志。需要人做出的决定保持明确。模型、工具、沙箱、浏览器、子智能体、持久化和客户端等能力均可替换或扩展，不必修改某个特权核心。

## 实际运行效果

### 在完整仓库上下文中工作

Workbench 把对话、文件、仓库、终端和自由窗口放在一起。Better Sidebar 提供 Markdown 渲染、多仓库 Git 视图、文件导航和由智能体操作的侧边栏动作。

<p align="center">
  <img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/5ea5bae18c9083d1c200173ed8bb05e903fc3e1d/better-sidebar-v0.16.1-pr317-16311605.gif" alt="DeepSeek Gestalt Workbench 展示真实模型回复和 Better Sidebar 仓库工具" width="900">
</p>

### 拆出专门任务，稍后继续

Side Chat 是真正的子 Session，不是临时面板。已经发布的 Side Chat 会保留历史记录和模型路由，在 Host 重启后恢复，并在关闭时归档。

<p align="center">
  <img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/3e32d89ee0e28a15cb099e6b90114601dfc537ce/issue-324-sidechat-restore-8469fa6eb8.gif" alt="Side Chat 在重启后恢复，使用原模型路由继续，并在归档后保持关闭" width="900">
</p>

### 在手机上继续同一个 Session

Mobile Companion 通过正式 Platform 和加密 Relay 与桌面端配对。手机可以浏览由桌面端管理的 Session、渲染其对话、处理待确认交互并提交工作，不会产生第二份事实来源。

<p align="center">
  <img src="https://raw.githubusercontent.com/gestaltrun/deepseek-harness-gestalt/3c711b7f0bc934d55f10dcdb9ee71e91850278f0/mobile-real-provider-98438f2.gif" alt="Mobile Companion 通过加密产品链继续桌面端管理的 Session" width="360">
</p>

## 当前已经实现

- **持久 Session：** 仅追加事件可重建模型历史、工具轨迹、回放、分支和客户端投影；持久化 Session 还支持搜索。
- **智能体工作空间：** 文件编辑、Shell 与终端执行、LSP、浏览器控制、Web 搜索、计划、目标、后台任务和可继续的子智能体均通过插件组合。
- **人的控制权：** 审批、提问、工具准入、设置和凭据引用不受模型控制。
- **多种客户端：** 浏览器 UI、Desktop Host、加密 Mobile Companion、CLI、ACP server、JSON-RPC client，以及 TypeScript 和 Python SDK 会按各自用途投影同一个 agent loop。
- **可替换能力：** Profile 与 Bundle 通过配置选择模型提供方、工具、存储、沙箱、策略和 UI 贡献。

[架构文档](docs/architecture.zh.md)介绍插件树、Session 生命周期和能力接缝。生成的[工具目录](docs/tool-catalog.zh.md)与[配置目录](docs/config-catalog.zh.md)列出当前运行时接口。

<a id="run"></a>

## 运行 Gestalt

### 桌面端

从 [GitHub Releases](https://github.com/gestaltrun/deepseek-harness-gestalt/releases/latest) 下载最新的 macOS 或 Windows 版本。

### Web 端

安装 [Node.js](https://nodejs.org/)，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会自动打开页面。进入 **Settings → Models** 添加模型提供方，选择工作空间，然后开始一个 Session。[Web 指南](docs/user/guide/index.zh.md)介绍首次使用与 SSH 启动方式。

<a id="run-from-source"></a>

### 从源码运行

```sh
git clone https://github.com/gestaltrun/deepseek-harness-gestalt.git
cd deepseek-harness-gestalt
pnpm install
pnpm run build
pnpm dsh web
```

仓库开发流程见[开发指南](docs/development.zh.md)，面向智能体的说明见 [AGENTS.md](AGENTS.md)。

## 项目状态

DeepSeek Harness 目前处于开发者预览阶段，版本升级可能包含破坏兼容性的变更。

## 社区与支持

- 通过 [GitHub Issues](https://github.com/gestaltrun/deepseek-harness-gestalt/issues) 报告 bug 或提交功能建议。
- 为插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于其他人发现。
- 添加企微小助手并填写问卷，即可加入 DeepSeek Harness 企微群。

<details>
  <summary>社区二维码</summary>
  <table>
    <thead>
      <tr>
        <th align="center">企微小助手</th>
        <th align="center">入群问卷</th>
        <th align="center">微信公众号</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
        <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
        <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
      </tr>
    </tbody>
  </table>
</details>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
