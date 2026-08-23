# Upstream snapshot

English | [中文](UPSTREAM.zh.md)

This package is a pinned source snapshot of [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar). It is not a `vendor/` Cordis package.

- Repository: `https://github.com/omdsh-dev/DSH-better-sidebar.git`
- Branch: `main`
- Commit: `d9b8f15d9eab018742f97d67e54b2398504894cd`
- Upstream version label: `0.15.2` (`dsh.plugin.json`)
- Prefix: `packages/client/ui-better-sidebar/`

Refresh:

```sh
git fetch https://github.com/omdsh-dev/DSH-better-sidebar.git main
git diff --binary d9b8f15d9eab018742f97d67e54b2398504894cd..FETCH_HEAD \
  -- dsh.plugin.json src tsdown.config.ts \
  | git apply --3way --index --directory=packages/client/ui-better-sidebar
```

The import deliberately excludes upstream repository infrastructure, manifests, documentation, and tests; this repository owns those files. After applying the source delta, replay every row in [LOCAL-MODIFICATIONS.md](LOCAL-MODIFICATIONS.md), keep this SHA current, and leave product behavior in [`dsh-client-ui-workbench`](../ui-workbench/README.md).
