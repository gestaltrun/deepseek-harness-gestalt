# Agent Note: One GIF assets branch

Status: implemented

English | [中文](2026-09-02-unified-gif-assets-branch.zh.md)

## Problem

GUI demonstration GIFs must stay out of any branch that merges into `master`, or every clone carries the binaries. The recorder therefore published each pull-request series onto its own orphan `*-assets` branch. That multiplied remote branches, mixed media with no shared layout, and made cleanup feel unsafe because merged pull-request bodies referenced those branch names forever.

GitHub's web UI can attach a GIF as a user upload, but `gh` and the public API cannot, so an agent still needs a git-hosted URL.

## Decision

All demonstration GIFs live on one orphan branch named `gif-assets`. The branch has no parent commit and contains media only. Isolation is a directory prefix, not a new branch:

- `pr/<number>/<name>.gif` for a pull-request recording
- `issue/<number>/<name>.gif` for an issue-only recording

[`record-browser-gif`](../../../skills/record-browser-gif/SKILL.md) publishes by appending a commit to `gif-assets` in a shallow scratch clone. It never creates another `*-assets` branch, never commits a GIF onto a product branch, and never force-pushes or rewrites `gif-assets`. Embeds use the blob URL with `?raw=true`:

```markdown
![<alt text>](https://github.com/<owner>/<repo>/blob/gif-assets/pr/<number>/<name>.gif?raw=true)
```

Historical series branches remain only while a live pull-request or issue body still names them. After those URLs move onto `gif-assets`, the empty series branch may be deleted.

The [evidence-chain decision](2026-08-08-browser-gif-evidence-chain.md) still owns recording isolation, exact-head pinning, and authenticated publication checks. This note owns where the bytes live.

## Alternatives considered

**Keep one orphan branch per pull-request series.** That already kept binaries off `master`, but each series left a permanent remote branch whose only job was three GIF files.

**Upload through GitHub's issue-attachment UI.** A human can paste a GIF into the pull-request body. Agents cannot: there is no stable public upload API, so `gh pr edit` can only write a URL.

**Commit GIFs onto the product pull-request branch.** Reviewers would see the file in the diff, and every future clone of `master` would carry the binary history.

**Use GitHub Releases as a media host.** A release is a publication event with its own approval stop. Demonstration evidence for an unreleased pull request must not wait on that train.

## Consequences

Remote branch lists show one media home instead of a growing `*-assets` set. Pull-request series stay isolated by path, so two recordings cannot clobber each other by filename. `gif-assets` still cannot be rewritten, because live Markdown URLs pin the current blob of each path. Clone size of `master` stays free of demonstration binaries.
