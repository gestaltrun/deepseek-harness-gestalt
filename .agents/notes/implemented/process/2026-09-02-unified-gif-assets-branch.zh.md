# Agent Note: 单一 GIF 资产分支

Status: implemented

[English](2026-09-02-unified-gif-assets-branch.md) | 中文

## 问题

GUI 演示 GIF 不能进入任何会合入 `master` 的分支，否则每个 clone 都会带上这些二进制。录制流程因此为每个 pull-request 系列单独发布一条孤儿 `*-assets` 分支。远端分支随之增多，媒体没有统一布局，清理也显得不安全，因为已合并 pull request 正文会永久引用那些分支名。

GitHub 网页可以把 GIF 当作用户附件上传，但 `gh` 与公开 API 做不到，所以 agent 仍然需要一个 git 托管的 URL。

## 决策

全部演示 GIF 放在一条名为 `gif-assets` 的孤儿分支上。该分支没有父 commit，且只包含媒体。隔离靠目录前缀，而不是新分支：

- `pr/<number>/<name>.gif` 用于 pull request 录制
- `issue/<number>/<name>.gif` 用于仅挂在 issue 上的录制

[`record-browser-gif`](../../../skills/record-browser-gif/SKILL.md) 在浅克隆的 scratch checkout 里向 `gif-assets` 追加 commit 来发布。它不再创建另一条 `*-assets` 分支，不把 GIF 提交到产品分支，也不 force-push 或改写 `gif-assets`。嵌入使用带 `?raw=true` 的 blob URL：

```markdown
![<alt text>](https://github.com/<owner>/<repo>/blob/gif-assets/pr/<number>/<name>.gif?raw=true)
```

历史系列分支只在仍有在线 pull request 或 issue 正文点名它们时保留。那些 URL 迁到 `gif-assets` 之后，空的系列分支可以删除。

[证据链决策](2026-08-08-browser-gif-evidence-chain.zh.md) 仍然拥有录制隔离、精确 head 钉住和经身份验证的发布检查。本注记拥有字节存放位置。

## 曾考虑的替代方案

**继续为每个 pull-request 系列保留一条孤儿分支。** 这已经能把二进制挡在 `master` 之外，但每个系列都会留下一条永久远端分支，往往只为三张 GIF 服务。

**通过 GitHub 的 issue 附件界面上传。** 人可以把 GIF 粘贴进 pull request 正文。Agent 做不到：没有稳定的公开上传 API，因此 `gh pr edit` 只能写 URL。

**把 GIF 提交到产品 pull request 分支。** 评审者会在 diff 里看到该文件，之后每次 clone `master` 都会带上这段二进制历史。

**用 GitHub Releases 托管媒体。** Release 是带独立批准停点的发布事件。未发布 pull request 的演示证据不能等待那条列车。

## 后果

远端分支列表只显示一个媒体归宿，而不是不断增长的 `*-assets` 集合。pull-request 系列靠路径隔离，两份录制不会因文件名互相覆盖。`gif-assets` 仍然不能改写，因为在线 Markdown URL 钉住每条路径的当前 blob。`master` 的 clone 体积继续不含演示二进制。
