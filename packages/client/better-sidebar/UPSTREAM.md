# Upstream snapshot

English | [中文](UPSTREAM.zh.md)

This package is a pinned source snapshot of [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar). It is not a `vendor/` Cordis package.

- Repository: `https://github.com/omdsh-dev/DSH-better-sidebar.git`
- Branch: `main`
- Commit: `50a888845fc614f63dfbf4d2b3704cc1004cd5c0`
- Upstream version label: `0.14.1` (`dsh.plugin.json`)
- Prefix: `packages/client/better-sidebar/`

Refresh:

```sh
git fetch https://github.com/omdsh-dev/DSH-better-sidebar.git main
git subtree pull --prefix=packages/client/better-sidebar \
  https://github.com/omdsh-dev/DSH-better-sidebar.git main
```

After a pull, replay every row in [LOCAL-MODIFICATIONS.md](LOCAL-MODIFICATIONS.md), keep this SHA current, and leave product behavior in [`dsh-client-ui-workbench`](../ui-workbench/README.md).
