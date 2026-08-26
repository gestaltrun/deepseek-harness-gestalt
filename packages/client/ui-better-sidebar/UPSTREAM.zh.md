# 上游快照

[English](UPSTREAM.md) | 中文

本包是 [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的钉死源码快照。它不是 `vendor/` 下的 Cordis 包。

- 仓库：`https://github.com/omdsh-dev/DSH-better-sidebar.git`
- 分支：`main`
- 提交：`f9153dfc1ce47cf43445c1b351ee3ae47b4ad9f1`
- 上游版本标签：`0.16.1`（`dsh.plugin.json`）
- 前缀：`packages/client/ui-better-sidebar/`

更新：

```sh
git fetch https://github.com/omdsh-dev/DSH-better-sidebar.git main
git diff --binary f9153dfc1ce47cf43445c1b351ee3ae47b4ad9f1..FETCH_HEAD \
  -- dsh.plugin.json src tsdown.config.ts \
  | git apply --3way --index --directory=packages/client/ui-better-sidebar
```

导入会有意排除上游的仓库基础设施、清单、文档和测试；这些文件由本仓持有。应用源码差异后，重放 [LOCAL-MODIFICATIONS.md](LOCAL-MODIFICATIONS.md) 中的每一条，更新本文件中的 SHA，并把产品行为留在 [`dsh-client-ui-workbench`](../ui-workbench/README.zh.md)。
