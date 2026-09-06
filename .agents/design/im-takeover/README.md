# IM account takeover design archive

English | [中文](README.zh.md)

This directory preserves the design inputs for the IM account takeover project so the specification and implementation tickets can reference them. It is not product code and does not recreate the `.design/` workspace.

## Contents

- `scheme-source.md` is the approved-direction technical scheme source. The fixed base is `96d33581128676a469a1587ea85e0339e4853cf0`; its source interfaces remain unreviewed.
- `review-pack.html` is the self-contained human review pack.
- `prototype/` contains the accepted high-fidelity React prototype source, fixtures, theme token snapshots, and package metadata; `prototype/README.md` documents how to run it.
- `screenshots/` contains selected example-only design screenshots.

## Later decision overrides

The archive preserves review history, but these later decisions override older content in it: the first release covers DingTalk through DWS and Wangwang only; Feishu has no placeholder driver or UI promise; a new trigger takes effect at the nearest safe step boundary without forcibly interrupting the model or a running tool; restart behavior follows the ordinary Session default; group triggers are three multi-select conditions, and the scheme uses OR, one submission per overlapping batch, counting messages not yet submitted, a fixed interval only when new messages exist, and progress advancement after successful submission; HiQ is a mechanism and bug reference only, not a source to copy, and its license is not a blocker.

## Privacy and portability limits

The prototype source comes from the archive previously held at `/tmp/dsh-im-takeover-approved-20260906-232805/`. This directory does not copy `node_modules`, caches, or the formal GUI reference captures; `references/gui/` could contain real conversations and is deliberately absent. Accounts, groups, buyers, messages, and example credentials in the prototype are demonstration data, not real identities or usable credentials.

`prototype/package.json` uses a `file:` reference to UI primitives inside the formal application checkout, so it is not a portable package. No lockfile is committed because npm encodes `file:` links relative to checkout depth; run `npm install` (not `npm ci`) as documented in `prototype/README.md`. When the application path or version changes, refresh the design tokens and component snapshots according to `prototype/manifest.json`. The limit is stated explicitly; the prototype is not presented as runnable on another machine.
