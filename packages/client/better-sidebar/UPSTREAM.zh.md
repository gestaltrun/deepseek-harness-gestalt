# 上游快照

[English](UPSTREAM.md) | 中文

本包是 [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的钉死源码快照。它不是 `vendor/` 下的 Cordis 包。

- 仓库：`https://github.com/omdsh-dev/DSH-better-sidebar.git`
- 分支：`main`
- 提交：`d9b8f15d9eab018742f97d67e54b2398504894cd`
- 上游版本标签：`0.15.2`（`dsh.plugin.json`）
- 前缀：`packages/client/better-sidebar/`

更新：

```sh
git fetch https://github.com/omdsh-dev/DSH-better-sidebar.git main
git diff --binary d9b8f15d9eab018742f97d67e54b2398504894cd..FETCH_HEAD \
  -- dsh.plugin.json src tsdown.config.ts \
  | git apply --3way --index --directory=packages/client/better-sidebar
```

导入会有意排除上游的仓库基础设施、清单、文档和测试；这些文件由本仓持有。应用源码差异后，重放 [LOCAL-MODIFICATIONS.md](LOCAL-MODIFICATIONS.md) 中的每一条，更新本文件中的 SHA，并把产品行为留在 [`dsh-client-ui-workbench`](../ui-workbench/README.zh.md)。
