# Agent Note: Filed-domain Platform cutover to beikejiedeliulangmao.top

Status: proposed

English | [中文](2026-09-05-filed-platform-domain-cutover.zh.md)

## Problem

The operated Platform serves `https://www.gestaltrun.com/` from `apps/platform/public` through one ALB HTTPS listener while the gestaltrun.com ICP filing is pending. A filed domain, `beikejiedeliulangmao.top`, is now approved under 辽ICP备19017854号-1 for the authenticated Aliyun account that operates the deployment. Until the origin moves onto the filed domain, production service in mainland China carries filing risk on the current name.

Moving the origin is not a single DNS edit. `PLATFORM_ORIGIN` in Environment `production` is the input the Desktop config writer, the Mobile build, and the Platform listen process all derive their identity from: the Desktop config writer derives the Relay WSS URL as `wss://<origin>/v1/remote-access/relay`, the Mobile bundle bakes `VITE_PLATFORM_ORIGIN`, `VITE_PLATFORM_CALLBACK_URL`, and `VITE_REMOTE_RELAY_WSS_URL` at build time, the Platform listen process derives CORS allowed origins and the `/pair` link origin from the same value, and `production-env.ts` enforces that `PLATFORM_ORIGIN` and `PLATFORM_GITHUB_CALLBACK` share one HTTPS origin with callback path `/v1/account/oauth/github/callback`. Installed Desktop clients and published Mobile builds carry the old origin, and the GitHub OAuth App's callback URL is registered outside the repository.

#480 records that the current ALB/TLS boundary rejects Android System WebView 83 with `net_error -101`. The cutover changes the TLS certificate presented at that boundary, so #480's diagnosis must be revalidated against the new-domain certificate rather than carried over as either evidence or blocker. #415 tracks a release-train alignment and stays open until its own release evidence completes.

## Proposal

Cut the operated Platform over to `https://www.beikejiedeliulangmao.top` with apex (`beikejiedeliulangmao.top`) support, through the staged sequence below. The user has approved replacing both old DNS A records (`120.77.49.2`) and the formal Desktop/Mobile reissue, but neither this note nor its PR performs any mutation: all steps below are the durable plan a separately authorized release executes.

Canonical authority after cutover:

- `PLATFORM_ORIGIN` (Environment `production`) becomes `https://www.beikejiedeliulangmao.top`; `PLATFORM_GITHUB_CALLBACK` becomes `https://www.beikejiedeliulangmao.top/v1/account/oauth/github/callback`.
- Environments `desktop-release` and `mobile-release` update the `VITE_PLATFORM_ORIGIN` / `VITE_PLATFORM_CALLBACK_URL` / `VITE_REMOTE_RELAY_WSS_URL` set to the same www origin, keeping `VITE_REMOTE_RELAY_WSS_URL = wss://www.beikejiedeliulangmao.top/v1/remote-access/relay` consistent with the Desktop-derived relay URL.
- The GitHub OAuth App (client id `Ov23lip9LTmnFuFpFeeV`) callback URL is re-registered to the new callback path. This App is distinct from the repository's automation GitHub Apps and is not replaced.
- Unchanged, exactly: `PLATFORM_POSTGRES_DATABASE` (database identity), `PLATFORM_IDENTITY_NAMESPACE`, `PLATFORM_TOKEN_SIGNING_KEY`, `PLATFORM_POLLING_SIGNING_KEY`, both ECS instances, the ALB server group, and all other production names. Accounts, installations, pairings, and durable state survive because the identity that keys them is preserved.
- The three TXT records and any other DNS records on the zone are preserved verbatim; only the two old A records (`120.77.49.2`, apex and www) are replaced, with recorded pre-change values for rollback.
- The brand name, READMEs, historical release notes, and docs that reference gestaltrun.com are not renamed. The homepage SEO canonical remains `https://www.gestaltrun.com/` by default pending an explicit decision, because `apps/platform/public/index.html` and its discovery metadata are served on both hostnames and a premature canonical switch would drop the indexed origin before the new domain accumulates standing.

Apex behavior: the apex hostname gets a valid certificate and DNS reachability so that apex HTTPS does not fail, but the canonical authority is the www origin. Whether apex serves a redirect to www, or serves the product directly, is decided during Stage 1 verification after observing listener and certificate behavior on the existing ALB; OAuth POST callbacks and Relay WSS are never pointed at the apex.

## Staged cutover

Stage 0 — Freeze and record (no production mutation). Record current apex/www A values (`120.77.49.2`, TTL 600 s), the three TXT records, the ALB listener id and its current certificates, server group, ECS instance ids, and the current GitHub OAuth App callback URL. Re-fetch `origin/master` and confirm the release-train state (PR #584 / plan 0012 selecting Desktop 0.1.16) so this cutover does not interleave with that train.

Stage 1 — Certificate and DNS (Aliyun console, authorized operator). Issue one HTTPS certificate covering both `beikejiedeliulangmao.top` and `www.beikejiedeliulangmao.top` (DCV on the existing DNS), attach it to the existing ALB HTTPS listener alongside the current gestaltrun.com certificate (multi-certificate listener, not a replacement), then replace only the two old A records on the new zone so apex and www resolve to the existing ALB front address. Preserve TXT records and TTL values in the record. Verify: authoritative and public DNS resolution for both names, TLS handshake and hostname validation for both names from an ordinary client, and continued gestaltrun.com service during this stage (old certificate still attached).

Stage 2 — Platform origin switch (GitHub Environment `production` only; no deploy yet). Update `PLATFORM_ORIGIN` and `PLATFORM_GITHUB_CALLBACK` vars; re-register the OAuth App callback. Run the platform-deploy validate job (source CLI `production-env-cli.ts` rejects mismatched origin/callback before any ECS apply). Verify `/readyz` on the new www origin against the still-running old deployment before proceeding. This stage is reversible by restoring the two Environment variables and the OAuth App callback URL.

Stage 3 — Platform deploy (protected workflow, explicit approval). Dispatch platform-deploy with the candidate SHA, preserving the ECS two-instance rolling replacement, rollback record, and attachment-storage cutover the workflow already owns. Verify account login on the new origin, old-client behavior (installed clients still pointing at gestaltrun.com keep working until their own update), and Relay WSS on the new origin.

Stage 4 — Client reissue (formal Desktop and Mobile releases from one reviewed candidate). Bump Desktop and Mobile versions through a new Product Release Plan on `master`; the new origin is baked into the Desktop operated config and both Mobile builds at that candidate. Desktop publishes through desktop-release (signed, notarized, `--latest`). Mobile requires a candidate-bound Mobile Companion Acceptance run, publishes the signed APK as a durable GitHub prerelease, and only reports TestFlight as shipped when `upload_testflight` was requested and a validated build number exists; a GitHub prerelease alone is not formal Mobile publication. Before any Mobile publication, verify new-domain TLS/readiness from the physical Android path (WebView, not only desktop browsers), because #480's failure lived exactly there.

Stage 5 — Physical acceptance and stabilization. Phone-side: valid TLS, fresh GitHub login preparation, same-account authentication, WSS attachment, explicit-link pairing, Remote Online, and phone-originated ping/pong — preserving user devices and Desktop instances, with sanitized evidence published through `gif-assets`. Desktop-side: update from an installed old-origin build to the new release and confirm the reissued channel. Rollback at every stage: Stage 1 restores old A values and detaches the new certificate; Stage 2 restores the two Environment variables and the OAuth App callback; Stage 3 uses the workflow's own rollback record; Stage 4 does not unpublish old releases — old installers remain valid download targets, and rollback is re-pointing origin variables plus reissuing from the prior candidate.

## Sequencing against the in-flight release train

PR #584 carries Product Release Plan 0012 selecting Desktop 0.1.16 from `automation/product-release`. That PR is not modified by this specification. No collision rule: this cutover's Product Release Plan (Stage 4) is created on `master` only after plan 0012 has merged or been explicitly dispositioned, because two open plans over `product-releases/` would contend for `nextSequence` and the release-intent ledger, and the Desktop reissue must build on 0.1.16's updater fix rather than precede it. Platform-deploy dispatches (Stage 3) do not contend with a Desktop-only plan; if 0012 has already promoted Desktop, Stage 3 may run before or after Stage 4's plan merges, but the mobile acceptance run (Stage 4) must bind to the exact new-domain candidate SHA.

## Alternatives considered

**Keep serving gestaltrun.com until its filing completes.** Rejected: the filing timeline is unbounded, the user has explicitly approved the move, and production service carries filing risk meanwhile.

**Serve the new domain without moving `PLATFORM_ORIGIN` (proxy or redirect only).** Rejected: OAuth callbacks and Relay WSS must terminate on the origin the clients and listen process actually validate; redirecting OAuth POSTs or WSS indiscriminately breaks both, and the issue text forbids it.

**Replace the ALB certificate instead of attaching a second one.** Rejected for Stage 1: multi-certificate attachment keeps gestaltrun.com serving during staging, which the rollback plan depends on; the old certificate is detached only after Stage 5 stabilizes.

**Point `PLATFORM_ORIGIN` at the apex.** Rejected: the www hostname is the issued canonical authority; apex support exists so bare-domain HTTPS does not fail, not as a second authority. Two origins would double the CORS and callback surface for no benefit.

**Rename brand surfaces and historical docs to the new domain.** Rejected: the change is an origin migration, not a rebrand; brand name and historical URLs stay. The homepage canonical stays gestaltrun.com pending an explicit SEO decision, recorded here as undecided rather than silently switched.

**Reissue clients before the Platform serves the new origin.** Rejected: baked client authority must point at an origin that already passes `/readyz` and login, or every updated install breaks at first run.

## Acceptance criteria

- One valid HTTPS certificate covering both apex and `www.beikejiedeliulangmao.top` is attached to the existing ALB listener; the existing Platform identity, databases, signing keys, namespace, server group, ECS instances, and accounts are preserved (no new identity system, no re-keying).
- Apex and www resolve publicly through the Aliyun DNS mechanism chosen in Stage 1; the three TXT records and all unrelated DNS records are verbatim; old A-record values are recorded for rollback; certificate hostname validation passes for both names.
- `PLATFORM_ORIGIN` and `PLATFORM_GITHUB_CALLBACK` in Environment `production`, the operated Desktop config, and the Mobile build variables all name `https://www.beikejiedeliulangmao.top` with the fixed callback path; WSS and `/pair` links derive from that origin; the OAuth App `Ov23lip9LTmnFuFpFeeV` callback matches it.
- New formal Desktop and Mobile versions publish from one reviewed candidate: Desktop with signed/notarized installers and a `--latest` GitHub Release; Mobile with a signed APK prerelease, a candidate-bound acceptance run, and TestFlight reported shipped only with a validated build number — never claimed from the prerelease alone. Release manifests, signing artifacts, update channels, and baked-in authority are verified separately per unit.
- Physical Android acceptance passes on the new domain before formal Mobile publication: TLS, GitHub login preparation, same-account authentication, WSS, explicit-link pairing, Remote Online, phone-originated ping/pong; user devices and Desktop instances are preserved; sanitized evidence publishes through `gif-assets`.
- Old-client transition and rollback are demonstrated: an installed old-origin Desktop updates to the reissued channel, and each stage's rollback path is recorded with exact pre-change values.
- Homepage SEO canonical remains `https://www.gestaltrun.com/` unless the user explicitly decides otherwise; brand name and historical docs are unchanged.
- #480 and #415 are not closed by this change; #480's ALB/TLS diagnosis is revalidated against the new certificate and its own evidence, and #415 closes only on its own release evidence.

## Risks

- DNS TTL 600 s bounds, but does not eliminate, propagation overlap: both names may resolve during a window when the OAuth App callback accepts only one origin. Stage ordering (certificate and DNS before the Environment switch) keeps every interval serveable.
- The physical Android WebView path (#480) may fail on the new certificate for reasons distinct from the old diagnosis; Stage 4 gates publication on that path, so the risk is a blocked reissue, not a broken published build.
- Two hostnames serving one product page split SEO standing; the default canonical keeps the indexed origin, at the cost of the new domain accumulating standing more slowly.
- Preserved identity means preserved blast radius: a bad Stage 3 deploy touches the same production instances and durable state the old domain served. The workflow's existing rollback record and two-instance replacement own this; no new mechanism is added here.
- Multi-certificate listeners have quota and evaluation-order behavior on ALB; Stage 1 verification observes the actual listener state before DNS is cut, and the plan does not assume SNI behavior beyond what that observation confirms.
